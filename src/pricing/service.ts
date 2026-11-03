import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct, type PlytixResult } from '../types.js';
import { createPricingStore, type PricingStore } from './store.js';
import { applyInput, changeSchema, importInput, planInput, PRICING_LIMITS, ruleSchema, rulesDocument, rulesInput, sourceRow, type PricingChange, type PricingRule, type SourceRow } from './model.js';
import { calculate, parseCsv, withinChangeLimit } from './calculate.js';
import { reviewBinding, reviewDocument } from './review-model.js';
import { PricingMemory } from './memory.js';
import { learnImport, learnPlan } from './learning.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fail(message: string): never { throw new PlytixError(message); }
const docSchema = z.object({ id: z.string().uuid(), source_name: z.string(), source_sha256: z.string(), extraction_sha256: z.string(), sku_column: z.string(), source_context: importInput.shape.source_context, rows: z.array(sourceRow).max(PRICING_LIMITS.import_rows), created_at: z.string() });
export const storedPlan = z.object({
  plan_id: z.string().uuid(), digest: z.string(), created_at: z.string(), expires_at: z.string(),
  import_id: z.string().uuid(), rules_revision: z.number(), input: planInput,
  rules_digest: z.string(), source_digest: z.string(), rule_snapshot: z.array(ruleSchema),
  source_snapshot: docSchema,
  review_binding: reviewBinding.optional(),
  changes: z.array(changeSchema).max(PRICING_LIMITS.plan_changes), blocked: z.array(z.object({ row_index: z.number(), rule_id: z.string(), product_id: z.string().optional(), family_id: z.string().optional(), reason: z.string() })),
  state: z.enum(['draft', 'executing', 'complete', 'stopped', 'deferred']),
  results: z.array(z.object({ product_id: z.string(), attribute: z.string(), status: z.string() })),
});
export type StoredPlan = z.infer<typeof storedPlan>;

function valueOf(product: PlytixProduct, label: string): unknown {
  return Object.prototype.hasOwnProperty.call(product, `attributes.${label}`) ? product[`attributes.${label}`] : product.attributes?.[label];
}
function canonicalName(value: string, aliases: PricingRule['associations'][number]['aliases']): string {
  const matches = aliases.filter(alias => alias.from.trim().toLowerCase() === value.trim().toLowerCase());
  if (matches.length > 1) fail('Association alias is ambiguous');
  return (matches[0]?.to ?? value).trim().toLowerCase();
}

function hasOverrideEvidence(product: PlytixProduct): boolean {
  return Array.isArray(product.overwritten_attributes) && product.overwritten_attributes.every(item => typeof item === 'string' && item.length > 0);
}

function descendantEvidenceDigest(product: PlytixProduct, evidence: Record<string, unknown>): string {
  return digest({ id: product.id, sku: product.sku, product_type: product.product_type, descendants: product.num_variations,
    parent: product._parent_id, family: product.product_family_id, overrides: product.overwritten_attributes, evidence });
}

function completeDescendantIds(product: PlytixProduct, listing: PlytixResult<PlytixProduct>): string[] {
  const ids = listing.data.map(child => child.id);
  const pagination = listing.pagination;
  if (ids.some(id => typeof id !== 'string' || !id || id === product.id) || new Set(ids).size !== ids.length || ids.length !== product.num_variations ||
      (pagination?.pages !== undefined && pagination.pages > 1) ||
      (pagination?.page !== undefined && pagination.page !== 1) ||
      (pagination?.count !== undefined && pagination.count !== ids.length) ||
      (pagination?.total !== undefined && pagination.total !== ids.length) ||
      (pagination?.total_count !== undefined && pagination.total_count !== ids.length)) fail('Complete bounded descendant listing is unavailable');
  return ids;
}

export class PricingService {
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR,
    private storeFactory: (fingerprint: string, root?: string) => PricingStore = createPricingStore) {}
  private async directory() {
    await this.client.verifyKnowledgeAccess();
    return this.storeFactory(this.client.knowledgeFingerprint(), this.root);
  }
  private parseRules(value: unknown | undefined) {
    try { return rulesDocument.parse(value ?? { revision: 0, updated_at: '', rules: [] }); }
    catch { return fail('Pricing rules could not be read or validated'); }
  }
  private async readRules(directory: PricingStore) { return this.parseRules(await directory.read('rules.json')); }
  private async put(directory: PricingStore, id: string, value: unknown) { await directory.create(`${id}.json`, value); }
  async rulesGet() {
    const directory = await this.directory();
    const rules = await this.readRules(directory);
    const learning = rules.revision ? await this.learnSafely(() => new PricingMemory(directory).recordRules(rules.rules, rules.revision)) : { status: 'empty' };
    return { ...rules, learning, storage: directory.kind, sharing: 'Connections with different credentials have separate pricing files. Rules never authorize writes.' };
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
    const next = await directory.update('rules.json', value => this.parseRules(value), previous => {
      if (previous.revision !== input.expected_revision) fail('Pricing rules changed; review the latest revision');
      return rulesDocument.parse({ revision: previous.revision + 1, updated_at: new Date().toISOString(), rules: input.rules,
        history: [...previous.history, ...(previous.revision ? [{ revision: previous.revision, updated_at: previous.updated_at, rules: previous.rules }] : [])] });
    });
    // The immutable revision copy preserves reviewed rules for later audits.
    const warnings: string[] = [];
    try { await this.put(directory, `rules-revision-${next.revision}`, next); }
    catch { warnings.push('Rules and history were saved atomically, but the extra immutable revision copy is unavailable. Review rules.json before retrying.'); }
    const learning = await this.learnSafely(() => new PricingMemory(directory).recordRules(next.rules, next.revision));
    if (learning.status === 'unavailable') warnings.push('Rules were saved, but their advisory dictionary index could not be updated.');
    return { ...next, learning, ...(warnings.length ? { partial: true, warning: warnings.join(' ') } : {}) };
  }
  private async learnSafely(work: () => Promise<object>) {
    try { return { status: 'stored' as const, ...await work() }; }
    catch { return { status: 'unavailable' as const, warning: 'Advisory dictionary learning could not be saved; use current Plytix and reviewed rules.' }; }
  }
  async importDocument(input: z.infer<typeof importInput>) {
    input = importInput.parse(input);
    if (Boolean(input.csv) === Boolean(input.rows)) fail('Supply exactly one CSV document or extracted rows');
    if (input.csv && createHash('sha256').update(input.csv, 'utf8').digest('hex') !== input.source_sha256) fail('CSV source hash does not match the submitted UTF-8 document');
    const rows = z.array(sourceRow).min(1).max(PRICING_LIMITS.import_rows).parse(input.csv ? parseCsv(input.csv) : input.rows);
    if (rows.some(row => !row.values[input.sku_column]?.trim())) fail('Every source row requires a nonempty SKU');
    const directory = await this.directory();
    const matches = [];
    const families = new Map<string, { family_id: string; name: string | null; matched_rows: number[] }>();
    // Text eq is case-insensitive upstream. Page the entire OR query, then use
    // exact case-sensitive SKU matching locally; a first-page hit is not proof
    // of uniqueness. Repeated source SKUs share the same lookup.
    const skus = [...new Set(rows.map(row => row.values[input.sku_column].trim()))];
    const products = new Map<string, PlytixProduct>();
    let complete = false, pages = 0, expectedTotal: number | undefined, expectedPages: number | undefined;
    for (let page = 1; page <= PRICING_LIMITS.search_pages; page++) {
      const response = await this.client.searchProducts({ filters: skus.map(sku => [{ field: 'sku', operator: 'eq', value: sku }]), attributes: ['sku', 'product_family_id'], pagination: { page, page_size: PRICING_LIMITS.search_page_size } });
      pages++;
      const pagination = response.pagination;
      const total = pagination?.total ?? pagination?.total_count;
      if (response.meta?.complete === false || (pagination?.page !== undefined && pagination.page !== page) ||
          (expectedTotal !== undefined && total !== undefined && total !== expectedTotal) ||
          (expectedPages !== undefined && pagination?.pages !== undefined && pagination.pages !== expectedPages) ||
          response.data.some(product => !product.id || products.has(product.id)) || new Set(response.data.map(product => product.id)).size !== response.data.length) break;
      expectedTotal ??= total; expectedPages ??= pagination?.pages;
      for (const product of response.data) products.set(product.id, product);
      if (page === 1 && products.size === 0 && (total === 0 || pagination?.pages === 0)) { complete = total === undefined || total === 0; break; }
      if ((total !== undefined && products.size > total) || (pagination?.pages !== undefined && pagination.pages < page)) break;
      const last = expectedPages !== undefined ? page === expectedPages : expectedTotal !== undefined ? products.size === expectedTotal : response.data.length < PRICING_LIMITS.search_page_size;
      if (last) { complete = expectedTotal === undefined || products.size === expectedTotal; break; }
      if (!response.data.length || response.data.length < PRICING_LIMITS.search_page_size) break;
    }
    for (const [row_index, row] of rows.entries()) {
      const sku = row.values[input.sku_column].trim();
      const candidates = [...products.values()].filter(p => p.sku === sku).map(p => ({ product_id: p.id, sku: p.sku, family_id: p.product_family_id ?? null }));
      for (const candidate of candidates) if (candidate.family_id) {
        const current = families.get(candidate.family_id) ?? { family_id: candidate.family_id, name: null, matched_rows: [] };
        current.matched_rows.push(row_index); families.set(candidate.family_id, current);
      }
      matches.push({ row_index, sku, status: !complete ? 'incomplete_lookup' : candidates.length === 1 && candidates[0].family_id ? 'candidate' : candidates.length ? 'ambiguous_or_missing_family' : 'unmatched', candidates });
    }
    for (const family of families.values()) {
      try { family.name = (await this.client.getFamily(family.family_id)).data[0]?.name ?? null; }
      catch { /* A suggested ID is evidence; unavailable family name is explicitly null. */ }
    }
    const document = { id: randomUUID(), source_name: input.source_name, source_sha256: input.source_sha256, extraction_sha256: digest(rows), sku_column: input.sku_column, ...(input.source_context ? { source_context: input.source_context } : {}), rows, created_at: new Date().toISOString() };
    await this.put(directory, document.id, document);
    const learning = await this.learnSafely(() => learnImport(new PricingMemory(directory), {
      ...document, columns: [...new Set(rows.flatMap(row => Object.keys(row.values)))], family_suggestions: complete ? [...families.values()] : [],
    }));
    return { import_id: document.id, source_name: input.source_name, source_sha256: input.source_sha256, extraction_sha256: document.extraction_sha256, family_suggestions: [...families.values()], matches, lookup: { complete, pages, unique_skus: skus.length }, learning, next: 'Review family suggestions and choose explicit row/product/family mappings before pricing_plan. Incomplete lookups do not establish unique matches. The source hash is supplied by the document reader; extraction hash is computed by this server.' };
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
    if (!['PARENT', 'VARIANT'].includes(product.product_type!) && product.num_variations !== 0) fail('Non-container products must report a zero descendant count');
    const family = await this.client.getFamilyAllAttributes(mapping.family_id);
    const candidates = family.data.filter(attribute => attribute.id && attribute.label === rule.target_attribute);
    if (candidates.length !== 1) fail('Attribute inheritance configuration is missing or ambiguous');
    const attribute = candidates[0];
    const level = attribute.attribute_level;
    if (level === 'no_level' || !['parent_level', 'variant_level'].includes(level ?? '')) fail('Attribute inheritance level is off or unavailable');
    if (product.product_type === 'VARIANT' && level !== 'variant_level') fail('Parent-level variant attributes require explicit inheritance-impact review; no override is created');
    if (product.product_type !== 'VARIANT' && level !== 'parent_level') fail('Root product attribute is not configured at parent level');
    // A Level 2 owner is a direct variant of a root parent, not an arbitrary
    // record with a matching value or a particular SKU prefix.
    let ownerAncestry: Record<string, unknown> | undefined;
    if (product.product_type === 'VARIANT') {
      const parent = (await this.client.getProduct(product._parent_id!)).data[0];
      if (!parent || parent.id !== product._parent_id || parent.id === product.id || parent.product_type !== 'PARENT' ||
          parent._parent_id || parent.product_family_id !== product.product_family_id) fail('Variant inheritance owner requires a verified root parent in the same family');
      ownerAncestry = { id: parent.id, product_type: parent.product_type, parent: parent._parent_id, family: parent.product_family_id };
    }
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
    const calculatedValue = calculate(rule, row);
    const manuallyModified = mapping.proposed_value !== undefined;
    if (manuallyModified && !mapping.review_note?.trim()) fail('A manual proposed value requires a review note');
    const newValue = manuallyModified
      ? calculate({ ...rule, source_column: 'reviewed_proposed_value', operations: [] }, { source_ref: row.source_ref, values: { reviewed_proposed_value: mapping.proposed_value! } })
      : calculatedValue;
    if (manuallyModified && newValue !== Number(mapping.proposed_value)) fail('Manual proposed value exceeds the reviewed rounding precision');
    if (schema.type_class === 'IntegerAttribute' && !Number.isInteger(newValue)) fail('Calculated amount is not an integer');
    if (!withinChangeLimit(oldValue, newValue, rule.max_change_percent)) fail('Price change exceeds the reviewed change limit');
    const descendantImpact: PricingChange['descendant_impact'] = [];
    if (product.product_type === 'PARENT' || product.num_variations! > 0) {
      const expectedChildType = product.product_type === 'VARIANT' ? 'SUB_VARIANT' : 'VARIANT';
      const listing = await this.client.getProductVariants(product.id);
      const ids = completeDescendantIds(product, listing);
      // The validated owner bounds this group to ten independent reads. Preserve
      // listing order while reducing the latency of inheritance verification.
      const children = await Promise.allSettled(ids.map(id => this.client.getProduct(id)));
      if (children.some(child => child.status === 'rejected')) fail('Descendant reads could not be completed');
      for (const [index, id] of ids.entries()) {
        const result = children[index];
        const child = result.status === 'fulfilled' ? result.value.data[0] : undefined;
        if (!child || child.id !== id || !child.sku || child.id === product.id || child.product_type !== expectedChildType || child._parent_id !== product.id || child.num_variations !== 0 || child.product_family_id !== product.product_family_id || !hasOverrideEvidence(child)) fail('Descendant identity, leaf status, family or override evidence is incomplete');
        const childValue = valueOf(child, rule.target_attribute);
        const overridden = child.overwritten_attributes!.some(item => [rule.target_attribute, attribute.id].includes(item.replace(/^attributes\./, '')));
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
        descendantImpact.push({ product_id: child.id, sku: child.sku!, old_value: childValue, new_value: overridden ? childValue : newValue, overridden, review_evidence: childEvidence, evidence_digest: descendantEvidenceDigest(child, childEvidence) });
      }
      descendantImpact.sort((a, b) => a.product_id.localeCompare(b.product_id));
    }
    return { row_index: mapping.row_index, product_id: product.id, sku: product.sku!, family_id: mapping.family_id, attribute: rule.target_attribute, old_value: oldValue, new_value: newValue,
      ...(manuallyModified ? { calculated_value: calculatedValue } : {}), ...(mapping.review_note ? { review_note: mapping.review_note } : {}),
      currency: rule.currency, unit: rule.unit, rule_id: rule.id, source_ref: row.source_ref, inheritance_level: level!, descendant_impact: descendantImpact, review_evidence: evidence,
      evidence_digest: digest({ product_type: product.product_type, parent: product._parent_id, ownerAncestry, descendants: product.num_variations, overwritten: product.overwritten_attributes, attribute, schema, evidence, oldValue }) };
  }
  private async build(input: z.infer<typeof planInput>, directory: PricingStore) {
    const document = docSchema.parse(await directory.read(`${input.import_id}.json`));
    const rules = await this.readRules(directory);
    const selected = input.rule_ids.map(id => rules.rules.find(rule => rule.id === id && rule.status === 'confirmed') ?? fail('Only current confirmed pricing rules may calculate an update'));
    if (input.mappings.length * selected.length > PRICING_LIMITS.plan_changes || new Set(input.rule_ids).size !== input.rule_ids.length) fail(`A plan supports at most ${PRICING_LIMITS.plan_changes} unique product/attribute changes`);
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
      } catch (error) { blocked.push({ row_index: mapping.row_index, rule_id: rule.id, product_id: mapping.product_id, family_id: mapping.family_id, reason: error instanceof PlytixError ? error.message : 'Pricing evidence could not be verified' }); }
    }
    return { changes, blocked, rules_revision: rules.revision, rules_digest: digest(rules), source_digest: digest(document), rule_snapshot: selected, source_snapshot: document };
  }
  async plan(input: z.infer<typeof planInput>, binding?: z.infer<typeof reviewBinding>, options: { store?: PricingStore; persist?: boolean } = {}) {
    input = planInput.parse(input);
    const directory = options.store ?? await this.directory();
    const built = await this.build(input, directory);
    const plan: StoredPlan = { plan_id: randomUUID(), digest: digest({ input, ...built }), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), import_id: input.import_id, input, ...built, ...(binding ? { review_binding: reviewBinding.parse(binding) } : {}), state: 'draft', results: [] };
    if (options.persist !== false) await this.put(directory, plan.plan_id, plan);
    // Grouped review previews also refresh advisory setup once per group.
    const learning = await this.learnSafely(() => learnPlan(new PricingMemory(directory), { ...plan.source_snapshot, changes: plan.changes, rules: plan.rule_snapshot }));
    return { ...plan, learning };
  }
  /** Split a freshly calculated internal snapshot without rereading the same
   * source or catalog. Apply still rebuilds and freshly checks every write. */
  async saveReviewSubset(source: StoredPlan, mappings: z.infer<typeof planInput>['mappings'], binding: z.infer<typeof reviewBinding>, directory: PricingStore) {
    if (source.state !== 'draft' || source.input.rule_ids.length !== 1 || Date.parse(source.expires_at) <= Date.now()) fail('Only a fresh single-rule review snapshot can be partitioned');
    const input = planInput.parse({ ...source.input, mappings });
    if (mappings.some(mapping => !source.input.mappings.some(original => canonical(original) === canonical(mapping)))) fail('Review partition changed its source mappings');
    const included = (item: { row_index: number; product_id?: string }) => mappings.some(mapping => mapping.row_index === item.row_index && mapping.product_id === item.product_id);
    const built = { changes: source.changes.filter(included), blocked: source.blocked.filter(included), rules_revision: source.rules_revision, rules_digest: source.rules_digest, source_digest: source.source_digest, rule_snapshot: source.rule_snapshot, source_snapshot: source.source_snapshot };
    const plan = storedPlan.parse({ ...source, ...built, plan_id: randomUUID(), input, review_binding: binding, digest: digest({ input, ...built }) });
    await this.put(directory, plan.plan_id, plan);
    return plan;
  }
  async planGet(planId: string, store?: PricingStore) {
    z.string().uuid().parse(planId);
    const directory = store ?? await this.directory();
    return storedPlan.parse(await directory.read(`${planId}.json`));
  }
  private async checkReviewBinding(plan: StoredPlan, directory: PricingStore) {
    if (!plan.review_binding) return;
    const binding = plan.review_binding;
    const review = reviewDocument.parse(await directory.read(`${binding.review_id}.json`));
    if (review.revision !== binding.revision || binding.line_ids.some(id => !review.lines.some(line => line.line_id === id && line.status === 'selected' && line.prepared_plan_id === plan.plan_id))) fail('Review decisions changed; prepare a new selected-only plan');
    const history = new Map<string, StoredPlan>();
    for (const line of review.lines.filter(line => binding.line_ids.includes(line.line_id))) {
      for (const id of line.plan_history) {
        if (id === plan.plan_id) continue;
        let previous = history.get(id);
        if (!previous) { previous = storedPlan.parse(await directory.read(`${id}.json`)); history.set(id, previous); }
        if (previous.state === 'draft') continue;
        const attribute = previous.rule_snapshot.find(rule => rule.id === line.provenance.rule_id)?.target_attribute;
        const result = previous.results.find(result => result.product_id === line.provenance.mapping.product_id && result.attribute === attribute);
        if ((result && result.status !== 'skipped') || previous.state === 'executing' || (previous.state === 'complete' && !result)) fail('An executed or uncertain review line cannot be retried');
      }
    }
  }
  async preflight(planId: string) {
    const directory = await this.directory();
    const plan = storedPlan.parse(await directory.read(`${planId}.json`));
    if (plan.state !== 'draft' || plan.blocked.length || Date.parse(plan.expires_at) <= Date.now()) fail('Pricing plan is blocked, expired or consumed');
    await this.checkReviewBinding(plan, directory);
    const fresh = await this.build(plan.input, directory);
    if (fresh.blocked.length || digest({ input: plan.input, ...fresh }) !== plan.digest) fail('Pricing values, rules or inheritance changed after review; no updates were sent');
    return plan;
  }
  async apply(input: z.infer<typeof applyInput>) {
    input = applyInput.parse(input);
    const directory = await this.directory();
    const key = `${input.plan_id}.json`;
    // Reserve durably before any product write. A crash requires review, never replay.
    const plan = await directory.update(key, value => storedPlan.parse(value), current => {
      if (current.state !== 'draft' || current.blocked.length || current.digest !== input.digest || canonical(current.changes) !== canonical(input.changes) || Date.parse(current.expires_at) <= Date.now()) fail('Pricing plan is blocked, expired, altered or already consumed; create a new reviewed plan');
      current.state = 'executing'; return current;
    });
    const persist = async () => directory.update(key, value => storedPlan.parse(value), () => plan);
    const deferRemaining = async () => {
      for (const change of plan.changes) if (!plan.results.some(result => result.product_id === change.product_id && result.attribute === change.attribute)) {
        plan.results.push({ product_id: change.product_id, attribute: change.attribute, status: 'skipped' });
      }
      plan.state = 'deferred'; await persist();
      return { ...plan, deferred: true, deferred_count: plan.results.filter(result => result.status === 'skipped').length, reason: 'Execution time reserved for verification; untouched lines need a fresh reviewed batch.' };
    };
    try {
      await this.checkReviewBinding(plan, directory);
      const fresh = await this.build(plan.input, directory);
      if (fresh.blocked.length || digest({ input: plan.input, ...fresh }) !== plan.digest) fail('Pricing values, rules or inheritance changed after review; no updates were sent');
      for (const change of plan.changes) {
        if (change.old_value === change.new_value) { plan.results.push({ product_id: change.product_id, attribute: change.attribute, status: 'unchanged' }); continue; }
        if (this.client.remainingOperationTimeMs() < 10_000) return deferRemaining();
        // Final per-row guard narrows the external race window. Plytix has no CAS here.
        this.client.clearOperationReadCache();
        await this.checkReviewBinding(plan, directory);
        if (digest(await this.readRules(directory)) !== plan.rules_digest) fail('Pricing rules changed before execution; remaining updates stopped');
        const rule = plan.rule_snapshot.find(item => item.id === change.rule_id)!;
        const mapping = plan.input.mappings.find(item => item.row_index === change.row_index && item.product_id === change.product_id)!;
        const current = await this.inspect(plan.source_snapshot.rows[change.row_index], plan.source_snapshot.sku_column, mapping, rule);
        if (canonical(current) !== canonical(change)) fail('Product or inheritance changed before execution; remaining updates stopped');
        // Reuse the just-verified detail read inside this invocation to pin the
        // owner's structural identity as well as its numeric readback.
        const ownerBefore = (await this.client.getProduct(change.product_id)).data[0];
        if (!ownerBefore || ownerBefore.id !== change.product_id) fail('Pricing owner evidence is unavailable before execution');
        const ownerStructure = digest({ type: ownerBefore.product_type, parent: ownerBefore._parent_id, overrides: ownerBefore.overwritten_attributes });
        if (this.client.remainingOperationTimeMs() < 10_000) return deferRemaining();
        plan.results.push({ product_id: change.product_id, attribute: change.attribute, status: 'sending_or_unknown' });
        await persist();
        await this.client.updateProduct(change.product_id, { attributes: { [change.attribute]: change.new_value } });
        const verified = (await this.client.getProduct(change.product_id)).data[0];
        if (!verified || verified.id !== change.product_id || verified.sku !== change.sku || verified.product_family_id !== change.family_id ||
            verified.num_variations !== change.descendant_impact.length || valueOf(verified, change.attribute) !== change.new_value ||
            digest({ type: verified.product_type, parent: verified._parent_id, overrides: verified.overwritten_attributes }) !== ownerStructure) fail('Pricing readback failed; inspect actual state before any new plan');
        if (change.descendant_impact.length) {
          const ids = completeDescendantIds(verified, await this.client.getProductVariants(change.product_id)).sort();
          if (canonical(ids) !== canonical(change.descendant_impact.map(impact => impact.product_id).sort())) fail('Descendant membership changed during execution; inspect actual state before any new plan');
        }
        const verifiedChildren = await Promise.allSettled(change.descendant_impact.map(impact => this.client.getProduct(impact.product_id)));
        if (verifiedChildren.some(child => child.status === 'rejected')) fail('Descendant readback could not be completed; inspect actual state before any new plan');
        for (const [index, impact] of change.descendant_impact.entries()) {
          const result = verifiedChildren[index];
          const child = result.status === 'fulfilled' ? result.value.data[0] : undefined;
          if (!child || child.id !== impact.product_id || !hasOverrideEvidence(child) || valueOf(child, change.attribute) !== impact.new_value ||
              descendantEvidenceDigest(child, impact.review_evidence) !== impact.evidence_digest) fail('Descendant propagation or override readback failed; inspect actual state before any new plan');
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
