import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PlytixError, type PlytixProduct } from '../types.js';
import type { PricingStore } from './store.js';
import { label } from './model.js';

const KEY = 'workflow.json';
const text = z.string().trim().min(1).max(200);
const sourceContext = z.object({ supplier: text.optional(), source_namespace: text.optional() }).strict();
const sourceRef = z.string().trim().min(1).max(500);
const status = z.enum(['active', 'retired']);
export const guidanceInstruction = z.object({
  id: label, title: text, text: z.string().trim().min(1).max(3000),
  scope: z.object({ family_ids: z.array(text).max(20).default([]), source_context: sourceContext.optional() }).strict().default({ family_ids: [] }),
  priority: z.enum(['required', 'recommended']), status, source_ref: sourceRef,
}).strict();
const predicate = z.object({
  attribute: label, operator: z.enum(['equals', 'in']),
  values: z.array(z.union([text, z.number().finite()])).min(1).max(20),
}).strict().refine(value => value.operator !== 'equals' || value.values.length === 1, 'Equality requires exactly one value')
  .refine(value => new Set(value.values.map(item => typeof item)).size === 1, 'Predicate values must use one scalar type');
export const guidanceExclusion = z.object({
  id: label, title: text, status,
  family_ids: z.array(text).min(1).max(20),
  // Empty targets deliberately protect every numeric pricing-workflow target.
  // This does not prohibit unrelated catalog edits or supply write permission.
  target_attributes: z.array(label).max(30).default([]),
  all: z.array(predicate).min(1).max(5),
  reason: z.string().trim().min(1).max(1500), source_ref: sourceRef,
}).strict();
const snapshotFields = {
  revision: z.number().int().nonnegative(), updated_at: z.string(),
  instructions: z.array(guidanceInstruction).max(100),
  exclusions: z.array(guidanceExclusion).max(32),
};
const guidanceHistory = z.object(snapshotFields).strict();
export const guidanceDocument = z.object({
  version: z.literal(1), ...snapshotFields,
  history: z.array(guidanceHistory).max(20).default([]),
}).strict();
export type GuidanceDocument = z.infer<typeof guidanceDocument>;
export type GuidanceInstruction = z.infer<typeof guidanceInstruction>;
export type GuidanceExclusion = z.infer<typeof guidanceExclusion>;
export const guidanceGetInput = z.object({
  family_ids: z.array(text).max(20).optional(), source_context: sourceContext.optional(),
  include_retired: z.boolean().default(false),
}).strict();
export const guidanceSaveInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  instructions: snapshotFields.instructions,
  exclusions: snapshotFields.exclusions,
}).strict();

const normalize = (value: string) => value.trim().toLocaleLowerCase('en-US');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function validateUnique(document: Pick<GuidanceDocument, 'instructions' | 'exclusions'>) {
  for (const entries of [document.instructions, document.exclusions]) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new PlytixError('Workflow guidance IDs must be unique within each section');
  }
  for (const exclusion of document.exclusions) {
    if (new Set(exclusion.family_ids).size !== exclusion.family_ids.length || new Set(exclusion.target_attributes).size !== exclusion.target_attributes.length ||
        new Set(exclusion.all.map(item => item.attribute)).size !== exclusion.all.length) throw new PlytixError('Workflow exclusion fields and families must be unique');
  }
}
function parseGuidance(raw: unknown): GuidanceDocument {
  try {
    const parsed = guidanceDocument.parse(raw ?? { version: 1, revision: 0, updated_at: '', instructions: [], exclusions: [], history: [] });
    validateUnique(parsed);
    return parsed;
  } catch { throw new PlytixError('Pricing workflow guidance could not be read or validated'); }
}
export async function readGuidance(store: PricingStore): Promise<GuidanceDocument> {
  return parseGuidance(await store.read(KEY));
}
export function guidanceDigest(document: GuidanceDocument): string {
  return createHash('sha256').update(canonical({ revision: document.revision, instructions: document.instructions, exclusions: document.exclusions })).digest('hex');
}
export function hasActiveGuidance(document: GuidanceDocument): boolean {
  return document.instructions.some(item => item.status === 'active') || document.exclusions.some(item => item.status === 'active');
}
function matchesFamilies(scoped: string[], requested?: string[]) {
  return !scoped.length || !requested?.length || scoped.some(id => requested.includes(id));
}
export function applicableInstructions(document: GuidanceDocument, input: z.input<typeof guidanceGetInput> = {}): GuidanceInstruction[] {
  const args = guidanceGetInput.parse(input);
  return document.instructions.filter(item => (args.include_retired || item.status === 'active') && matchesFamilies(item.scope.family_ids, args.family_ids) &&
    Object.entries(item.scope.source_context ?? {}).every(([key, value]) => {
      const supplied = args.source_context?.[key as keyof z.infer<typeof sourceContext>];
      // Unknown context must surface applicable restrictions rather than hide them.
      return supplied === undefined || normalize(supplied) === normalize(value);
    })).sort((a, b) => Number(b.priority === 'required') - Number(a.priority === 'required') || a.id.localeCompare(b.id));
}
function valueOf(product: PlytixProduct, attribute: string): unknown {
  return Object.prototype.hasOwnProperty.call(product, `attributes.${attribute}`) ? product[`attributes.${attribute}`] : product.attributes?.[attribute];
}
function sameValue(observed: string | number, expected: string | number) {
  return typeof observed === 'string' && typeof expected === 'string' ? normalize(observed) === normalize(expected) : observed === expected;
}

/** Pure evaluation over fresh product evidence. The caller checks the owner and
 * every inheriting descendant whose value would change, never an unchanged override. */
export function evaluatePricingExclusions(document: GuidanceDocument, product: PlytixProduct, targetAttribute: string) {
  const blocked: Array<{ id: string; reason: string }> = [], evidence: Record<string, unknown> = {};
  for (const exclusion of document.exclusions) {
    if (exclusion.status !== 'active' || !exclusion.family_ids.includes(product.product_family_id ?? '') ||
        (exclusion.target_attributes.length && !exclusion.target_attributes.includes(targetAttribute))) continue;
    let knownFalse = false, unknown = false;
    for (const condition of exclusion.all) {
      const observed = valueOf(product, condition.attribute);
      evidence[condition.attribute] = observed ?? null;
      if ((typeof observed !== 'string' && typeof observed !== 'number') ||
          (typeof observed === 'string' && !observed.trim()) || (typeof observed === 'number' && !Number.isFinite(observed))) { unknown = true; continue; }
      // A schema/type change must not turn a protected numeric value into an
      // apparent non-match simply because the API now returns a string.
      if (typeof observed !== typeof condition.values[0]) { unknown = true; continue; }
      if (!condition.values.some(expected => sameValue(observed, expected))) knownFalse = true;
    }
    if (knownFalse) continue;
    blocked.push({ id: exclusion.id, reason: unknown
      ? `Cannot determine whether protected pricing scope ${exclusion.id} applies: required current product evidence is unavailable. ${exclusion.reason}`
      : `Protected pricing scope ${exclusion.id}: ${exclusion.reason}` });
  }
  return { blocked, evidence };
}

const authority = 'User-maintained workflow guidance takes precedence over automatically learned suggestions. Required instructions are workflow requirements; structured exclusions are enforced by pricing planning and execution. Current Plytix remains authoritative for catalog facts. Guidance never grants permission to write, and source text is not executable code.';
/** Only explicit, approved guidance saves may edit these records. There is no
 * automatic-learning mutation method and no eviction of active instructions. */
export class PricingGuidance {
  constructor(private store: PricingStore, private clock: () => string = () => new Date().toISOString()) {}
  read() { return readGuidance(this.store); }
  async get(input: z.input<typeof guidanceGetInput> = {}) {
    const args = guidanceGetInput.parse(input), document = await this.read();
    return { version: document.version, revision: document.revision, digest: guidanceDigest(document), updated_at: document.updated_at,
      instructions: applicableInstructions(document, args),
      exclusions: document.exclusions.filter(item => (args.include_retired || item.status === 'active') && matchesFamilies(item.family_ids, args.family_ids)),
      retained_history_revisions: document.history.length,
      complete_for_save: args.include_retired && !args.family_ids?.length && !Object.values(args.source_context ?? {}).some(value => value !== undefined), authority };
  }
  async save(input: z.input<typeof guidanceSaveInput>) {
    const args = guidanceSaveInput.parse(input); validateUnique(args);
    const updated = await this.store.update(KEY, parseGuidance, current => {
      if (current.revision !== args.expected_revision) throw new PlytixError('Pricing workflow guidance changed; review the latest revision before saving');
      if (current.instructions.some(item => !args.instructions.some(next => next.id === item.id)) ||
          current.exclusions.some(item => !args.exclusions.some(next => next.id === item.id))) {
        throw new PlytixError('Preserve every existing workflow guidance ID; explicitly set status to retired instead of omitting a record');
      }
      const previous = { revision: current.revision, updated_at: current.updated_at, instructions: current.instructions, exclusions: current.exclusions };
      const history = [...current.history, ...(current.revision ? [previous] : [])].slice(-20);
      // Bound history by bytes as well as revision count; keep current instructions
      // intact. Existing storage separately caps the complete document at 8 MiB.
      while (Buffer.byteLength(JSON.stringify(history), 'utf8') > 2 * 1024 * 1024 && history.length) history.shift();
      return guidanceDocument.parse({ version: 1, revision: current.revision + 1, updated_at: this.clock(), instructions: args.instructions, exclusions: args.exclusions, history });
    });
    return { ...updated, digest: guidanceDigest(updated), authority };
  }
}
