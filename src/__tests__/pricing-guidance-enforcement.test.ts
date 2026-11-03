import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';
import { PricingService, digest, storedPlan, type StoredPlan } from '../pricing/service.js';
import { PricingReviewService } from '../pricing/review.js';
import { guidanceDocument, guidanceExclusion, guidanceInstruction, type GuidanceDocument } from '../pricing/guidance.js';
import { ruleSchema } from '../pricing/model.js';
import type { PricingStore } from '../pricing/store.js';
import type { PlytixProduct } from '../types.js';

afterEach(() => vi.restoreAllMocks());
class FixtureStore implements PricingStore {
  readonly kind = 'gcs';
  values = new Map<string, unknown>();
  reads: string[] = [];
  async read(key: string) { this.reads.push(key); return structuredClone(this.values.get(key)); }
  async create(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    const value = change(parse(await this.read(key))); this.values.set(key, structuredClone(value)); return structuredClone(value);
  }
}
const instruction = (id = 'supplier_owner', family_ids: string[] = []) => guidanceInstruction.parse({ id, title: 'Verify the supplier owner', text: 'Use current supplier and inheritance evidence before calculating a full-sheet cost.', scope: { family_ids }, priority: 'required', status: 'active', source_ref: 'Explicit user workflow instruction' });
const exclusion = () => guidanceExclusion.parse({ id: 'protected_finish', title: 'Protected finish pricing', status: 'active', family_ids: ['f'], target_attributes: ['cost'], all: [{ attribute: 'color', operator: 'equals', values: ['Red'] }], reason: 'This finish must not receive standard pricing, regardless of thickness.', source_ref: 'Explicit user exclusion' });
function policy(overrides: Partial<GuidanceDocument> = {}) {
  return guidanceDocument.parse({ version: 1, revision: 1, updated_at: '2026-11-03T12:00:00.000Z', instructions: [instruction()], exclusions: [exclusion()], history: [], ...overrides });
}

async function fixture(count = 1, descendants = 0) {
  const store = new FixtureStore();
  const client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_apply']) });
  const products: PlytixProduct[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, sku: `SKU-${i}`, product_type: descendants ? 'VARIANT' : 'STANDALONE', product_family_id: 'f', num_variations: descendants, ...(descendants ? { _parent_id: 'root', overwritten_attributes: [] } : {}), attributes: { cost: 10, color: 'Blue', thickness: 0.5 } }));
  const children: PlytixProduct[] = descendants ? Array.from({ length: descendants }, (_, i) => ({ id: `c${i}`, sku: `CHILD-${i}`, product_type: 'SUB_VARIANT', _parent_id: 'p0', product_family_id: 'f', num_variations: 0, overwritten_attributes: [], attributes: { cost: 10, color: 'Blue' } })) : [];
  const root: PlytixProduct = { id: 'root', sku: 'ROOT', product_type: 'PARENT', product_family_id: 'f', num_variations: count };
  const all = [...products, ...children, root];
  vi.spyOn(client, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(client, 'searchProducts').mockResolvedValue({ data: structuredClone(products), pagination: { page: 1, page_size: 100, pages: 1, total: count } });
  vi.spyOn(client, 'getProduct').mockImplementation(async id => ({ data: structuredClone(all.filter(product => product.id === id)) }));
  vi.spyOn(client, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Family' }] });
  vi.spyOn(client, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: descendants ? 'variant_level' : 'parent_level' }] });
  vi.spyOn(client, 'getAttributeById').mockResolvedValue({ id: 'a', label: 'cost', name: 'Cost', type_class: 'DecimalAttribute' });
  vi.spyOn(client, 'getProductVariants').mockResolvedValue({ data: structuredClone(children), pagination: { page: 1, page_size: 100, pages: 1, total: descendants, count: descendants } });
  const write = vi.spyOn(client, 'updateProduct').mockImplementation(async (id, patch) => {
    const product = products.find(item => item.id === id)!; Object.assign(product.attributes!, patch.attributes);
    for (const child of children) if (child._parent_id === id && !child.overwritten_attributes!.length) Object.assign(child.attributes!, patch.attributes);
    return { data: [structuredClone(product)] };
  });
  const service = new PricingService(client, undefined, () => store), reviews = new PricingReviewService(client, undefined, () => store);
  const rule = ruleSchema.parse({ id: 'cost_rule', name: 'Sheet cost', status: 'confirmed', evidence: 'Reviewed supplier list', family_ids: ['f'], target_attribute: 'cost', source_column: 'Cost', currency: 'USD', currency_column: 'Currency', unit: 'sheet', unit_column: 'Unit', operations: [], maximum: '1000', max_change_percent: 50 });
  await service.rulesSave({ expected_revision: 0, rules: [rule] });
  const source = await service.importDocument({ source_name: 'Supplier price list', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: products.map(product => ({ source_ref: product.id, values: { SKU: product.sku!, Cost: '12', Currency: 'USD', Unit: 'sheet' } })) });
  const input = { import_id: source.import_id, rule_ids: [rule.id], mappings: products.map((product, row_index) => ({ row_index, product_id: product.id, family_id: 'f' })) };
  return { client, store, products, children, service, reviews, input, write };
}
function makeLegacy(plan: StoredPlan): StoredPlan {
  const legacy = structuredClone(plan); delete legacy.guidance_binding;
  const { input, changes, blocked, rules_revision, rules_digest, source_digest, rule_snapshot, source_snapshot } = legacy;
  legacy.digest = digest({ input, changes, blocked, rules_revision, rules_digest, source_digest, rule_snapshot, source_snapshot });
  return storedPlan.parse(legacy);
}

describe('protected guidance in pricing planning and execution', () => {
  it('loads and binds required global/family instructions on every plan and reads policy once per build', async () => {
    const f = await fixture(3);
    f.store.values.set('workflow.json', policy({ instructions: [instruction('global'), instruction('family', ['f']), instruction('other', ['elsewhere'])] }));
    f.store.reads = [];
    const plan = await f.service.plan(f.input);
    expect(plan.guidance_binding).toMatchObject({ revision: 1, instructions: [{ id: 'family' }, { id: 'global' }] });
    expect(plan.changes.every(change => change.review_evidence.color === 'Blue')).toBe(true);
    expect(f.store.reads.filter(key => key === 'workflow.json')).toHaveLength(1);
    const review = await f.reviews.create({ plan_ids: [plan.plan_id] });
    expect(review.guidance_snapshots).toHaveLength(1);
    expect(review.guidance_snapshots[0]).toEqual(plan.guidance_binding);
  });

  it('blocks protected family/color combinations regardless of thickness', async () => {
    const f = await fixture(2);
    f.store.values.set('workflow.json', policy());
    for (const [index, product] of f.products.entries()) { product.attributes!.color = ' RED '; product.attributes!.thickness = index ? 0.75 : 0.5; }
    const plan = await f.service.plan(f.input);
    expect(plan.changes).toHaveLength(0);
    expect(plan.blocked).toHaveLength(2);
    expect(plan.blocked.every(row => row.reason.includes('protected_finish'))).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('does not apply another family or target exclusion and does not block an unchanged value', async () => {
    const f = await fixture();
    f.products[0].attributes!.color = 'Red';
    for (const different of [{ ...exclusion(), family_ids: ['other'] }, { ...exclusion(), target_attributes: ['retail'] }]) {
      f.store.values.set('workflow.json', policy({ exclusions: [different] }));
      expect((await f.service.plan(f.input)).blocked).toHaveLength(0);
    }
    f.store.values.set('workflow.json', policy()); f.products[0].attributes!.cost = 12;
    const unchanged = await f.service.plan(f.input);
    expect(unchanged.blocked).toHaveLength(0);
    expect(unchanged.changes[0]).toMatchObject({ old_value: 12, new_value: 12 });
  });

  it('fails closed when applicable exclusion evidence is unavailable', async () => {
    const f = await fixture(); f.store.values.set('workflow.json', policy());
    delete f.products[0].attributes!.color;
    const plan = await f.service.plan(f.input);
    expect(plan.blocked[0].reason).toMatch(/protected.*unavailable/i);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('blocks inherited changes into a protected descendant even when the owner is allowed', async () => {
    const f = await fixture(1, 2); f.store.values.set('workflow.json', policy());
    f.children[1].attributes!.color = 'Red';
    const plan = await f.service.plan(f.input);
    expect(plan.blocked[0].reason).toMatch(/Inherited update.*CHILD-1.*protected_finish/);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('preserves a protected overridden descendant without requiring its excluded fields', async () => {
    const f = await fixture(1, 2); f.store.values.set('workflow.json', policy());
    f.children[1].attributes!.cost = 8; delete f.children[1].attributes!.color;
    f.children[1].overwritten_attributes = ['a'];
    const plan = await f.service.plan(f.input);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.changes[0].descendant_impact[0].review_evidence.color).toBe('Blue');
    expect(plan.changes[0].descendant_impact[1].review_evidence).not.toHaveProperty('color');
    const applied = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(applied.state).toBe('complete');
    expect(f.children.map(child => child.attributes!.cost)).toEqual([12, 8]);
  });

  it('rejects a changed policy revision or content before any write', async () => {
    const f = await fixture(); f.store.values.set('workflow.json', policy());
    const plan = await f.service.plan(f.input);
    f.store.values.set('workflow.json', policy({ revision: 2 }));
    await expect(f.service.preflight(plan.plan_id)).rejects.toThrow(/guidance changed/);
    f.store.values.set('workflow.json', policy({ instructions: [instruction('different_instruction')] }));
    await expect(f.service.preflight(plan.plan_id)).rejects.toThrow(/guidance changed/);
    const applied = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(applied.state).toBe('stopped'); expect(f.write).not.toHaveBeenCalled();
  });

  it('rejects newly active guidance for old unbound plans while permitting legacy plans with no active guidance', async () => {
    const f = await fixture();
    const plan = makeLegacy(await f.service.plan(f.input)); f.store.values.set(`${plan.plan_id}.json`, plan);
    expect(await f.service.preflight(plan.plan_id)).toMatchObject({ plan_id: plan.plan_id });
    f.store.values.set('workflow.json', policy({ exclusions: [] }));
    await expect(f.service.preflight(plan.plan_id)).rejects.toThrow(/legacy.*active protected/);
    f.store.values.set('workflow.json', policy({ instructions: [], exclusions: [{ ...exclusion(), status: 'retired' }] }));
    expect((await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes })).state).toBe('complete');
  });

  it('stops remaining writes when guidance changes during execution and rereads policy for each guard', async () => {
    const f = await fixture(2); f.store.values.set('workflow.json', policy());
    const plan = await f.service.plan(f.input), write = f.write.getMockImplementation()!;
    f.write.mockImplementation(async (...args) => { const result = await write(...args); f.store.values.set('workflow.json', policy({ revision: 2 })); return result; });
    f.store.reads = [];
    const applied = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(applied.state).toBe('stopped'); expect(f.write).toHaveBeenCalledTimes(1);
    expect(applied.results).toEqual([{ product_id: 'p0', attribute: 'cost', status: 'verified' }]);
    expect(f.store.reads.filter(key => key === 'workflow.json')).toHaveLength(3);
  });

  it('detects an owner exclusion field changed after initial preflight before sending', async () => {
    const f = await fixture(); f.store.values.set('workflow.json', policy());
    const plan = await f.service.plan(f.input), clear = vi.spyOn(f.client, 'clearOperationReadCache');
    clear.mockImplementation(() => { f.products[0].attributes!.color = 'Red'; });
    const applied = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(applied.state).toBe('stopped'); expect(f.write).not.toHaveBeenCalled();
  });

  it('detects a changed inheriting descendant exclusion field before sending', async () => {
    const f = await fixture(1, 1); f.store.values.set('workflow.json', policy());
    const plan = await f.service.plan(f.input);
    vi.spyOn(f.client, 'clearOperationReadCache').mockImplementation(() => { f.children[0].attributes!.color = 'Red'; });
    const applied = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(applied.state).toBe('stopped'); expect(f.write).not.toHaveBeenCalled();
  });

  it('checks actual policy fields during owner and descendant readback', async () => {
    for (const descendants of [0, 1]) {
      const f = await fixture(1, descendants); f.store.values.set('workflow.json', policy());
      const plan = await f.service.plan(f.input), write = f.write.getMockImplementation()!;
      f.write.mockImplementation(async (...args) => { const result = await write(...args); (descendants ? f.children[0] : f.products[0]).attributes!.color = 'Red'; return result; });
      const applied = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
      expect(applied.state).toBe('stopped'); expect(applied.results[0].status).toBe('sending_or_unknown');
    }
  });

  it('preserves guidance binding through grouped review partitions and exact approval', async () => {
    const f = await fixture(3); f.store.values.set('workflow.json', policy());
    const plan = await f.service.plan(f.input), review = await f.reviews.create({ plan_ids: [plan.plan_id] });
    const selected = await f.reviews.update({ review_id: review.review_id, expected_revision: review.revision, decisions: review.lines.map(line => ({ line_id: line.line_id, status: 'selected' })) });
    f.products[0].attributes!.color = 'Green';
    const prepared = await f.reviews.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    expect(prepared.review.lines.map(line => line.status)).toEqual(['pending', 'selected', 'selected']);
    expect(prepared.plans).toHaveLength(2);
    expect(prepared.plans.every(item => item.guidance_binding?.digest === plan.guidance_binding!.digest)).toBe(true);
    expect(prepared.review.guidance_snapshots).toHaveLength(1);
    expect((await f.reviews.apply(prepared.approval!.arguments)).state).toBe('complete');
    expect(f.write.mock.calls.map(([id]) => id)).toEqual(['p1', 'p2']);
  });

  it('keeps subset instruction snapshots identical to a fresh plan for its own families', async () => {
    const f = await fixture(2);
    f.products[1].product_family_id = 'g'; f.input.mappings[1].family_id = 'g';
    const rules = await f.service.rulesGet();
    await f.service.rulesSave({ expected_revision: rules.revision, rules: [{ ...rules.rules[0], family_ids: ['f', 'g'] }] });
    f.store.values.set('workflow.json', policy({ instructions: [instruction('global'), instruction('family_f', ['f']), instruction('family_g', ['g'])] }));
    const plan = await f.service.plan(f.input), review = await f.reviews.create({ plan_ids: [plan.plan_id] });
    const selected = await f.reviews.update({ review_id: review.review_id, expected_revision: review.revision, decisions: review.lines.map(line => ({ line_id: line.line_id, status: 'selected' })) });
    f.products[0].attributes!.color = 'Green';
    const prepared = await f.reviews.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    const ready = prepared.plans.find(item => item.changes.some(change => change.product_id === 'p1'))!;
    expect(ready.guidance_binding!.instructions.map(item => item.id)).toEqual(['family_g', 'global']);
    expect((await f.reviews.apply(prepared.approval!.arguments)).state).toBe('complete');
    expect(f.write.mock.calls.map(([id]) => id)).toEqual(['p1']);
  });

  it('fails closed on unreadable policy storage without suppressing the policy failure', async () => {
    const f = await fixture(); f.store.values.set('workflow.json', { revision: 1, exclusions: 'broken' });
    await expect(f.service.plan(f.input)).rejects.toThrow(/guidance could not be read/);
    expect(f.write).not.toHaveBeenCalled();
  });
});
