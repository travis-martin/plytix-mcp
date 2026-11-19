import { z } from 'zod';
import { provenanceDigest, reviewMetadataSchema } from './provenance.js';
import type { PricingStore } from './store.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const historyDocumentName = z.enum(['workflow', 'dictionary', 'rules']);
export type HistoryDocumentName = z.infer<typeof historyDocumentName>;
export const revisionContextSchema = z.object({ operation: z.enum(['user_save', 'automatic_observation', 'rule_sync']),
  review: reviewMetadataSchema.optional() }).strict().refine(value => value.operation === 'user_save' || !value.review,
  'Automatic revisions cannot contain a user review');
export const versionHistoryPointer = z.object({ schema_version: z.literal(1), document: historyDocumentName,
  revision: z.number().int().nonnegative(), head_id: digest }).strict();
export const HISTORY_POLICY = { standard: 'pricing-change-history', schema_version: 1,
  retention: 'no_automatic_pruning', scope: 'workflow_dictionary_rules',
  commit_rule: 'Only revisions reachable from the current document head are committed.',
  rollback: 'Restore reviewed business fields as a new revision through the existing save tools.',
  attribution: 'Review reason, sources, reviewer and optional cross-system change_id are caller supplied, not authenticated identity or independent approval.',
  limits: 'Legacy history before the first archived baseline may be unavailable. Backend access controls, backups and lifecycle policies remain operator responsibilities.' } as const;

const object = z.record(z.string(), z.unknown());
export const revisionArchiveSchema = z.object({
  schema_version: z.literal(1), standard: z.literal('pricing-change-history'), document: historyDocumentName,
  revision: z.number().int().nonnegative(), change_id: digest, previous_id: digest.nullable(),
  recorded_at: z.string().datetime(), document_updated_at: z.string(),
  operation: z.enum(['baseline', 'user_save', 'automatic_observation', 'rule_sync', 'unattributed_save']),
  before_digest: digest.nullable(), after_digest: digest, review: reviewMetadataSchema.optional(),
  snapshot: object,
}).strict();
export type RevisionArchive = z.infer<typeof revisionArchiveSchema>;
type Document = Record<string, unknown> & { revision: number; updated_at: string };
const clean = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'version_history'));
const archiveIdentity = ({ change_id: _id, recorded_at: _at, ...value }: RevisionArchive) => value;
export const archiveKey = (name: HistoryDocumentName, id: string) => `history-${historyDocumentName.parse(name)}-${digest.parse(id)}.json`;
export function validateRevisionArchive(raw: unknown, name?: HistoryDocumentName, id?: string): RevisionArchive {
  const value = revisionArchiveSchema.parse(raw);
  if (value.change_id !== provenanceDigest(archiveIdentity(value)) || value.after_digest !== provenanceDigest(value.snapshot) ||
      value.snapshot.version_history !== undefined || value.snapshot.revision !== value.revision ||
      value.snapshot.updated_at !== value.document_updated_at || (name && value.document !== name) || (id && value.change_id !== id)) {
    throw new Error('Version history integrity check failed');
  }
  return value;
}
export function sameRevisionArchive(a: unknown, b: unknown) {
  return provenanceDigest(archiveIdentity(validateRevisionArchive(a))) === provenanceDigest(archiveIdentity(validateRevisionArchive(b)));
}
function recognized(name: HistoryDocumentName, value: unknown): value is Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.revision) && Number(v.revision) >= 0 && typeof v.updated_at === 'string' &&
    (name === 'workflow' ? Array.isArray(v.instructions) && Array.isArray(v.exclusions)
      : name === 'dictionary' ? Array.isArray(v.entries) : Array.isArray(v.rules));
}
function makeArchive(name: HistoryDocumentName, doc: Document, previous: RevisionArchive | undefined, baseline: boolean): RevisionArchive {
  const snapshot = clean(doc);
  const histories = (doc.record_provenance as { records?: Record<string, { events: Array<{ revision: number; operation: RevisionArchive['operation']; review?: z.infer<typeof reviewMetadataSchema> }> }> } | undefined)?.records;
  const events = Object.values(histories ?? {}).flatMap(h => h.events).filter(e => e.revision === doc.revision);
  const operations = [...new Set(events.map(e => e.operation))];
  const reviews = events.flatMap(e => e.review ? [e.review] : []);
  const context = doc.revision_context ? revisionContextSchema.parse(doc.revision_context) : undefined;
  const review = context?.review ?? reviews[0];
  if (reviews.some(r => provenanceDigest(r) !== provenanceDigest(review))) throw new Error('Conflicting review metadata in document revision');
  const body = { schema_version: 1 as const, standard: 'pricing-change-history' as const, document: name,
    revision: doc.revision, previous_id: previous?.change_id ?? null, document_updated_at: doc.updated_at,
    operation: baseline ? 'baseline' as const : context?.operation ?? (operations.length === 1 ? operations[0] : 'unattributed_save' as const),
    before_digest: previous?.after_digest ?? null, after_digest: provenanceDigest(snapshot),
    ...(!baseline && review ? { review } : {}), snapshot };
  return validateRevisionArchive({ ...body, change_id: provenanceDigest(body), recorded_at: new Date().toISOString() });
}

/** Archive writes are immutable and happen before the current-document CAS.
 * A failed CAS may leave an unreferenced candidate, never a committed revision.
 * The current head pointer and current content commit in one atomic write. */
export async function retainVersionHistory<T>(key: string, previousRaw: unknown, next: T,
  io: { read(key: string): Promise<unknown | undefined>; create(key: string, value: RevisionArchive): Promise<void> }): Promise<T> {
  const name = /^(workflow|dictionary|rules)\.json$/.exec(key)?.[1] as HistoryDocumentName | undefined;
  if (!name || !recognized(name, next)) return next;
  const current = recognized(name, previousRaw) ? previousRaw : undefined;
  if (current && provenanceDigest(clean(current)) === provenanceDigest(clean(next))) return previousRaw as T;
  if (current && next.revision !== current.revision + 1) throw new Error('Knowledge revisions must advance by exactly one');
  let previous: RevisionArchive | undefined;
  if (current?.version_history) {
    const pointer = versionHistoryPointer.parse(current.version_history);
    if (pointer.document !== name || pointer.revision !== current.revision) throw new Error('Version history head does not match current document');
    previous = validateRevisionArchive(await io.read(archiveKey(name, pointer.head_id)), name, pointer.head_id);
    if (previous.after_digest !== provenanceDigest(clean(current))) throw new Error('Current knowledge content differs from its version history');
  } else if (current) {
    previous = makeArchive(name, current, undefined, true);
    await io.create(archiveKey(name, previous.change_id), previous);
  }
  const archive = makeArchive(name, next, previous, false);
  await io.create(archiveKey(name, archive.change_id), archive);
  return { ...next, version_history: { schema_version: 1, document: name, revision: next.revision, head_id: archive.change_id } };
}

export const historyGetInput = z.object({ document: historyDocumentName,
  cursor: digest.optional(), limit: z.number().int().min(1).max(25).default(10),
  include_snapshots: z.boolean().default(false),
}).strict();

/** Cursor traversal starts from the current head, so an orphaned CAS candidate
 * cannot be passed as a cursor and represented as a committed revision. */
export async function getVersionHistory(store: PricingStore, input: z.input<typeof historyGetInput>) {
  const args = historyGetInput.parse(input), raw = await store.read(`${args.document}.json`);
  if (args.include_snapshots && args.limit !== 1) throw new Error('Use limit=1 when requesting a full history snapshot');
  if (!recognized(args.document, raw)) return { policy: HISTORY_POLICY, document: args.document, state: 'unavailable', revisions: [], complete: true };
  if (!raw.version_history) return { policy: HISTORY_POLICY, document: args.document, state: 'legacy_unarchived', current_revision: raw.revision,
    revisions: [], complete: true, warning: 'No retained archive head exists yet. The next successful changed save will capture this baseline before writing.' };
  const head = versionHistoryPointer.parse(raw.version_history);
  if (head.document !== args.document || head.revision !== raw.revision) throw new Error('Version history head does not match current document');
  let id: string | null = head.head_id, expectedDigest = provenanceDigest(clean(raw)), started = !args.cursor;
  const revisions: Array<Omit<RevisionArchive, 'snapshot'> & { snapshot?: RevisionArchive['snapshot'] }> = [];
  const visited = new Set<string>();
  while (id) {
    if (visited.has(id)) throw new Error('Version history contains a cycle');
    visited.add(id);
    const item = validateRevisionArchive(await store.read(archiveKey(args.document, id)), args.document, id);
    if (item.after_digest !== expectedDigest) throw new Error('Version history chain digest mismatch');
    if (args.cursor === id) started = true;
    if (started) {
      const { snapshot, ...summary } = item;
      revisions.push({ ...summary, ...(args.include_snapshots ? { snapshot } : {}) });
      if (revisions.length === args.limit) return { policy: HISTORY_POLICY, document: args.document, state: 'retained', current_revision: raw.revision,
        head_id: head.head_id, revisions, next_cursor: item.previous_id, complete: item.previous_id === null };
    }
    expectedDigest = item.before_digest ?? ''; id = item.previous_id;
  }
  if (!started) throw new Error('History cursor is not reachable from the current head');
  return { policy: HISTORY_POLICY, document: args.document, state: 'retained', current_revision: raw.revision,
    head_id: head.head_id, revisions, next_cursor: id, complete: id === null };
}
