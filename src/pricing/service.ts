import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { readBoundedJson, updateJsonFile } from '../knowledge/store.js';
import { applyInput, changeSchema, importInput, planInput, ruleSchema, rulesDocument, rulesInput, sourceRow, type PricingChange, type PricingRule, type SourceRow } from './model.js';
import { calculate, parseCsv, withinChangeLimit } from './calculate.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fail(message: string): never { throw new PlytixError(message); }
const docSchema = z.object({ id: z.string().uuid(), source_name: z.string(), source_sha256: z.string(), extraction_sha256: z.string(), sku_column: z.string(), rows: z.array(sourceRow).max(20), created_at: z.string() });
const storedPlan = z.object({
  plan_id: z.string().uuid(), digest: z.string(), created_at: z.string(), expires_at: z.string(),
  import_id: z.string().uuid(), rules_revision: z.number(), input: planInput,
  rules_digest: z.string(), source_digest: z.string(), rule_snapshot: z.array(ruleSchema),
  source_snapshot: docSchema,
  changes: z.array(changeSchema).max(20), blocked: z.array(z.object({ row_index: z.number(), rule_id: z.string(), reason: z.string() })),
  state: z.enum(['draft', 'executing', 'complete', 'stopped']),
  results: z.array(z.object({ product_id: z.string(), attribute: z.string(), status: z.string() })),
});
type StoredPlan = z.infer<typeof storedPlan>;

function valueOf(product: PlytixProduct, label: string): unknown {
  return Object.prototype.hasOwnProperty.call(product, `attributes.${label}`) ? product[`attributes.${label}`] : product.attributes?.[label];
}
function canonicalName(value: string, aliases: PricingRule['associations'][number]['aliases']): string {
  const matches = aliases.filter(alias => alias.from.trim().toLowerCase() === value.trim().toLowerCase());
  if (matches.length > 1) fail('Association alias is ambiguous');
  return (matches[0]?.to ?? value).trim().toLowerCase();
}

export class PricingService {
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR) {}
  private async directory() {
    if (!this.root) fail('Pricing storage is not configured; set PLYTIX_PRICING_DIR to a private durable local volume');
    await this.client.verifyKnowledgeAccess();
    return join(resolve(this.root!), this.client.knowledgeFingerprint());
  }
  private async readRules(directory: string) {
    try { return rulesDocument.parse(await readBoundedJson(join(directory, 'rules.json'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, updated_at: '', rules: [] };
      return fail('Pricing rules could not be read or validated');
    }
  }
  private async put(directory: string, id: string, value: unknown) {
    await updateJsonFile(join(directory, `${id}.json`), async () => {
      try { await readBoundedJson(join(directory, `${id}.json`)); fail('Pricing document already exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return value;
    }, current => current);
  }
  async rulesGet() {
    const directory = await this.directory();
    return { ...await this.readRules(directory), storage: 'Private credential-bound rules.json', sharing: 'Connections with different credentials have separate pricing files. Rules never authorize writes.' };
  }
  async rulesSave(input: z.infer<typeof rulesInput>) {
    input = rulesInput.parse(input);
    if (new Set(input.rules.map(rule => rule.id)).size !== input.rules.length) fail('Pricing rule IDs must be unique');
    for (const rule of input.rules) {
      if (Number(rule.minimum) > Number(rule.maximum)) fail('Pricing rule range is invalid');
      if (rule.effective_from && rule.effective_until && Date.parse(rule.effective_from) > Date.parse(rule.effective_until)) fail('Pricing rule effective date range is invalid');
      for (const association of rule.associations) {
        const keys = association.aliases.map(alias => alias.from.trim().toLowerCase());
        if (new Set(keys).size !== keys.length) fail('Association aliases must have unique source names');
      }
    }
    const directory = await this.directory();
    const next = await updateJsonFile(join(directory, 'rules.json'), () => this.readRules(directory), previous => {
      if (previous.revision !== input.expected_revision) fail('Pricing rules changed; review the latest revision');
      return rulesDocument.parse({ revision: previous.revision + 1, updated_at: new Date().toISOString(), rules: input.rules });
    });
    // The immutable revision copy preserves reviewed rules for later audits.
    await this.put(directory, `rules-revision-${next.revision}`, next);
    return next;
  }
  async importDocument(input: z.infer<typeof importInput>) {
    input = importInput.parse(input);
    if (Boolean(input.csv) === Boolean(input.rows)) fail('Supply exactly one CSV document or extracted rows');
    if (input.csv && createHash('sha256').update(input.csv, 'utf8').digest('hex') !== input.source_sha256) fail('CSV source hash does not match the submitted UTF-8 document');
    const rows = z.array(sourceRow).min(1).max(20).parse(input.csv ? parseCsv(input.csv) : input.rows);
    if (rows.some(row => !row.values[input.sku_column]?.trim())) fail('Every source row requires a nonempty SKU');
    const directory = await this.directory();
    const matches = [];
    const families = new Map<string, { family_id: string; name: string | null; matched_rows: number[] }>();
    for (const [row_index, row] of rows.entries()) {
      const sku = row.values[input.sku_column].trim();
      const response = await this.client.searchProducts({ filters: [[{ field: 'sku', operator: 'eq', value: sku }]], attributes: ['sku', 'product_family_id'], pagination: { page: 1, page_size: 3 } });
      const candidates = response.data.filter(p => p.sku === sku).map(p => ({ product_id: p.id, sku: p.sku, family_id: p.product_family_id ?? null }));
      for (const candidate of candidates) if (candidate.family_id) {
        const current = families.get(candidate.family_id) ?? { family_id: candidate.family_id, name: null, matched_rows: [] };
        current.matched_rows.push(row_index); families.set(candidate.family_id, current);
      }
      matches.push({ row_index, sku, status: candidates.length === 1 && candidates[0].family_id ? 'candidate' : candidates.length ? 'ambiguous_or_missing_family' : 'unmatched', candidates });
    }
    for (const family of families.values()) {
      try { family.name = (await this.client.getFamily(family.family_id)).data[0]?.name ?? null; }
      catch { /* A suggested ID is evidence; unavailable family name is explicitly null. */ }
    }
    const document = { id: randomUUID(), source_name: input.source_name, source_sha256: input.source_sha256, extraction_sha256: digest(rows), sku_column: input.sku_column, rows, created_at: new Date().toISOString() };
    await this.put(directory, document.id, document);
    return { import_id: document.id, source_name: input.source_name, source_sha256: input.source_sha256, extraction_sha256: document.extraction_sha256, family_suggestions: [...families.values()], matches, next: 'Review family suggestions and choose explicit row/product/family mappings before pricing_plan. The source hash is supplied by the document reader; extraction hash is computed by this server.' };
  }
  private async inspect(row: SourceRow, skuColumn: string, mapping: z.infer<typeof planInput>['mappings'][number], rule: PricingRule): Promise<PricingChange> {
    if ((rule.effective_from && Date.now() < Date.parse(rule.effective_from)) || (rule.effective_until && Date.now() > Date.parse(rule.effective_until))) fail('Pricing rule is outside its reviewed effective time window');
    if (!rule.family_ids.includes(mapping.family_id)) fail('Selected family is outside the reviewed pricing rule');
    const product = (await this.client.getProduct(mapping.product_id)).data[0];
    if (!product || product.id !== mapping.product_id || product.sku !== row.values[skuColumn].trim() || product.product_family_id !== mapping.family_id) fail('Product identity or family does not match the reviewed document mapping');
    if (!['SINGLE', 'STANDALONE', 'VARIANT', 'PARENT'].includes(product.product_type ?? '')) fail('Deeper variant or unknown product levels require a separately reviewed descendant-impact workflow');
    if (product.product_type !== 'VARIANT' && product._parent_id) fail('Product ancestry is inconsistent');
    if (product.product_type === 'VARIANT' && !product._parent_id) fail('Variant parent is unavailable');
    if (!Number.isInteger(product.num_variations) || product.num_variations! < 0 || product.num_variations! > 10) fail('A bounded explicit descendant count from zero to ten is required');
    if (product.product_type !== 'PARENT' && product.num_variations !== 0) fail('Non-parent products must report a zero descendant count');
    const family = await this.client.getFamilyAllAttributes(mapping.family_id);
    const candidates = family.data.filter(attribute => attribute.id && attribute.label === rule.target_attribute);
    if (candidates.length !== 1) fail('Attribute inheritance configuration is missing or ambiguous');
    const attribute = candidates[0];
    const level = attribute.attribute_level;
    if (level === 'no_level' || !['parent_level', 'variant_level'].includes(level ?? '')) fail('Attribute inheritance level is off or unavailable');
    if (product.product_type === 'VARIANT' && level !== 'variant_level') fail('Parent-level variant attributes require explicit inheritance-impact review; no override is created');
    if (product.product_type !== 'VARIANT' && level !== 'parent_level') fail('Root product attribute is not configured at parent level');
    // Fetch schema by observed ID, bypassing the client's cross-call label cache.
    const schema = await this.client.getAttributeById(attribute.id!);
    if (!schema || schema.label !== rule.target_attribute || !['NumberAttribute', 'DecimalAttribute', 'IntegerAttribute'].includes(schema.type_class)) fail('Target must be a current supported numeric attribute');
    if (row.values[rule.currency_column] !== rule.currency || row.values[rule.unit_column] !== rule.unit) fail('Document currency or unit differs from the reviewed rule');
    const evidence: Record<string, unknown> = {};
    const requiredLabels = new Set([...rule.review_attributes, ...rule.associations.map(a => a.attribute), ...rule.conditions.filter(c => c.source === 'product').map(c => c.field)]);
    for (const label of requiredLabels) {
      evidence[label] = valueOf(product, label);
      if (evidence[label] === undefined || evidence[label] === null) fail('A required review or restriction attribute is unavailable');
    }
    for (const association of rule.associations) {
      const documentValue = row.values[association.column];
      const current = valueOf(product, association.attribute);
      if (!documentValue || typeof current !== 'string' || canonicalName(documentValue, association.aliases) !== canonicalName(current, association.aliases)) fail('Brand, supplier or other association does not match the reviewed rule');
    }
    for (const condition of rule.conditions) {
      const observed = condition.source === 'product' ? valueOf(product, condition.field) : row.values[condition.field];
      if (typeof observed !== 'string' && typeof observed !== 'number') fail('Restriction value is unavailable or unsupported');
      const included = condition.values.includes(String(observed));
      if (condition.operator === 'not_equals' ? included : !included) fail('Product or document restriction is not satisfied');
    }
    const oldValue = valueOf(product, rule.target_attribute);
    if (typeof oldValue !== 'number' || !Number.isFinite(oldValue) || oldValue < 0) fail('Existing numeric value is missing or invalid; initial value creation needs separate review');
    if (rule.expected_existing_column && (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(row.values[rule.expected_existing_column] ?? '') || Number(row.values[rule.expected_existing_column]) !== oldValue)) fail('Existing value does not match the document verification column');
    const newValue = calculate(rule, row);
    if (schema.type_class === 'IntegerAttribute' && !Number.isInteger(newValue)) fail('Calculated amount is not an integer');
    if (!withinChangeLimit(oldValue, newValue, rule.max_change_percent)) fail('Price change exceeds the reviewed change limit');
    const descendantImpact: PricingChange['descendant_impact'] = [];
    if (product.product_type === 'PARENT') {
      const listing = await this.client.getProductVariants(product.id);
      const ids = listing.data.map(child => child.id);
      const pagination = listing.pagination;
      if (new Set(ids).size !== ids.length || ids.length !== product.num_variations ||
          (pagination?.pages !== undefined && pagination.pages > 1) ||
          (pagination?.page !== undefined && pagination.page !== 1) ||
          (pagination?.total !== undefined && pagination.total !== ids.length) ||
          (pagination?.total_count !== undefined && pagination.total_count !== ids.length)) fail('Complete bounded descendant listing is unavailable');
      for (const id of ids) {
        const child = (await this.client.getProduct(id)).data[0];
        if (!child || child.id === product.id || child.product_type !== 'VARIANT' || child._parent_id !== product.id || child.num_variations !== 0 || child.product_family_id !== product.product_family_id || !Array.isArray(child.overwritten_attributes)) fail('Descendant identity, leaf status, family or override evidence is incomplete');
        const childValue = valueOf(child, rule.target_attribute);
        const overridden = child.overwritten_attributes.some(item => item.replace(/^attributes\./, '') === rule.target_attribute);
        if (typeof childValue !== 'number' || !Number.isFinite(childValue) || (!overridden && childValue !== oldValue)) fail('Descendant value does not agree with explicit inheritance evidence');
        // Parent changes may only propagate into the reviewed business scope.
        for (const association of rule.associations) {
          const current = valueOf(child, association.attribute);
          if (typeof current !== 'string' || canonicalName(current, association.aliases) !== canonicalName(row.values[association.column], association.aliases)) fail('Descendant association is outside the reviewed rule');
        }
        const childEvidence: Record<string, unknown> = {};
        for (const label of requiredLabels) {
          childEvidence[label] = valueOf(child, label);
          if (childEvidence[label] === undefined || childEvidence[label] === null) fail('Descendant review attribute is unavailable');
        }
        for (const condition of rule.conditions.filter(c => c.source === 'product')) {
          const observed = valueOf(child, condition.field);
          const included = (typeof observed === 'string' || typeof observed === 'number') && condition.values.includes(String(observed));
          if ((typeof observed !== 'string' && typeof observed !== 'number') || (condition.operator === 'not_equals' ? included : !included)) fail('Descendant restriction is not satisfied');
        }
        descendantImpact.push({ product_id: child.id, sku: child.sku ?? '', old_value: childValue, new_value: overridden ? childValue : newValue, overridden, evidence_digest: digest({ parent: child._parent_id, family: child.product_family_id, overrides: child.overwritten_attributes, evidence: childEvidence }) });
      }
      descendantImpact.sort((a, b) => a.product_id.localeCompare(b.product_id));
    }
    return { row_index: mapping.row_index, product_id: product.id, sku: product.sku!, family_id: mapping.family_id, attribute: rule.target_attribute, old_value: oldValue, new_value: newValue, currency: rule.currency, unit: rule.unit, rule_id: rule.id, source_ref: row.source_ref, inheritance_level: level!, descendant_impact: descendantImpact, evidence_digest: digest({ product_type: product.product_type, parent: product._parent_id, descendants: product.num_variations, overwritten: product.overwritten_attributes, attribute, schema, evidence, oldValue }) };
  }
  private async build(input: z.infer<typeof planInput>, directory: string) {
    const document = docSchema.parse(await readBoundedJson(join(directory, `${input.import_id}.json`)));
    const rules = await this.readRules(directory);
    const selected = input.rule_ids.map(id => rules.rules.find(rule => rule.id === id && rule.status === 'confirmed') ?? fail('Only current confirmed pricing rules may calculate an update'));
    if (input.mappings.length * selected.length > 20 || new Set(input.rule_ids).size !== input.rule_ids.length) fail('A plan supports at most 20 unique product/attribute changes');
    const changes: PricingChange[] = [], blocked: StoredPlan['blocked'] = [];
    const targets = new Set<string>();
    for (const mapping of input.mappings) for (const rule of selected) {
      try {
        const row = document.rows[mapping.row_index];
        if (!row) fail('Mapped document row does not exist');
        const target = `${mapping.product_id}/${rule.target_attribute}`;
        if (targets.has(target)) fail('Duplicate source rows or rules target the same product attribute');
        targets.add(target);
        changes.push(await this.inspect(row, document.sku_column, mapping, rule));
      } catch (error) { blocked.push({ row_index: mapping.row_index, rule_id: rule.id, reason: error instanceof PlytixError ? error.message : 'Pricing evidence could not be verified' }); }
    }
    return { changes, blocked, rules_revision: rules.revision, rules_digest: digest(rules), source_digest: digest(document), rule_snapshot: selected, source_snapshot: document };
  }
  async plan(input: z.infer<typeof planInput>) {
    input = planInput.parse(input);
    const directory = await this.directory();
    const built = await this.build(input, directory);
    const plan: StoredPlan = { plan_id: randomUUID(), digest: digest({ input, ...built }), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), import_id: input.import_id, input, ...built, state: 'draft', results: [] };
    await this.put(directory, plan.plan_id, plan);
    return plan;
  }
  async planGet(planId: string) {
    z.string().uuid().parse(planId);
    const directory = await this.directory();
    return storedPlan.parse(await readBoundedJson(join(directory, `${planId}.json`)));
  }
  async apply(input: z.infer<typeof applyInput>) {
    input = applyInput.parse(input);
    const directory = await this.directory();
    const path = join(directory, `${input.plan_id}.json`);
    // Reserve durably before any product write. A crash requires review, never replay.
    const plan = await updateJsonFile(path, async () => storedPlan.parse(await readBoundedJson(path)), current => {
      if (current.state !== 'draft' || current.blocked.length || current.digest !== input.digest || canonical(current.changes) !== canonical(input.changes) || Date.parse(current.expires_at) <= Date.now()) fail('Pricing plan is blocked, expired, altered or already consumed; create a new reviewed plan');
      current.state = 'executing'; return current;
    });
    const persist = async () => updateJsonFile(path, async () => storedPlan.parse(await readBoundedJson(path)), () => plan);
    try {
      const fresh = await this.build(plan.input, directory);
      if (fresh.blocked.length || digest({ input: plan.input, ...fresh }) !== plan.digest) fail('Pricing values, rules or inheritance changed after review; no updates were sent');
      for (const change of plan.changes) {
        if (change.old_value === change.new_value) { plan.results.push({ product_id: change.product_id, attribute: change.attribute, status: 'unchanged' }); continue; }
        // Final per-row guard narrows the external race window. Plytix has no CAS here.
        this.client.clearOperationReadCache();
        if (digest(await this.readRules(directory)) !== plan.rules_digest) fail('Pricing rules changed before execution; remaining updates stopped');
        const rule = plan.rule_snapshot.find(item => item.id === change.rule_id)!;
        const mapping = plan.input.mappings.find(item => item.row_index === change.row_index && item.product_id === change.product_id)!;
        const current = await this.inspect(plan.source_snapshot.rows[change.row_index], plan.source_snapshot.sku_column, mapping, rule);
        if (canonical(current) !== canonical(change)) fail('Product or inheritance changed before execution; remaining updates stopped');
        plan.results.push({ product_id: change.product_id, attribute: change.attribute, status: 'sending_or_unknown' });
        await persist();
        await this.client.updateProduct(change.product_id, { attributes: { [change.attribute]: change.new_value } });
        const verified = (await this.client.getProduct(change.product_id)).data[0];
        if (!verified || valueOf(verified, change.attribute) !== change.new_value) fail('Pricing readback failed; inspect actual state before any new plan');
        for (const impact of change.descendant_impact) {
          const child = (await this.client.getProduct(impact.product_id)).data[0];
          if (!child || valueOf(child, change.attribute) !== impact.new_value) fail('Descendant propagation or override readback failed; inspect actual state before any new plan');
        }
        plan.results[plan.results.length - 1].status = 'verified';
        await persist();
      }
      plan.state = 'complete'; await persist();
    } catch (error) {
      plan.state = 'stopped'; await persist();
      return { ...plan, partial: true, error: error instanceof PlytixError ? error.message : 'Pricing execution stopped; inspect the saved audit before creating another plan' };
    }
    return plan;
  }
}
