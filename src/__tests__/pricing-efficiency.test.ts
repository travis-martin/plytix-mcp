import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PlytixClient } from '../client.js';
import { PricingService } from '../pricing/service.js';
import { PricingReviewService } from '../pricing/review.js';
import { ruleSchema } from '../pricing/model.js';
import type { PricingStore } from '../pricing/store.js';
import { PlytixError, type PlytixProduct } from '../types.js';

afterEach(() => vi.restoreAllMocks());

class CountingStore implements PricingStore {
  readonly kind = 'gcs';
  values = new Map<string, unknown>();
  reads: string[] = [];
  creates: string[] = [];
  async read(key: string) { this.reads.push(key); return structuredClone(this.values.get(key)); }
  async create(key: string, value: unknown) { if (this.values.has(key)) throw new Error('Already exists'); this.creates.push(key); this.values.set(key, structuredClone(value)); }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    const next = change(parse(await this.read(key))); this.values.set(key, structuredClone(next)); return structuredClone(next);
  }
}

async function fixture(count = 100, longNotes = false, groupSize = 100) {
  const store = new CountingStore();
  const client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_apply']) });
  const products: PlytixProduct[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, sku: `SKU-${i}`, product_type: 'STANDALONE', product_family_id: 'f', num_variations: 0, attributes: { cost: 10, brand: 'Acme' } }));
  vi.spyOn(client, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(client, 'submitPricingBulk').mockRejectedValue(new PlytixError('Bulk unavailable', 405));
  vi.spyOn(client, 'searchProducts').mockImplementation(async body => {
    const skus = new Set(body.filters!.map(group => String(group[0].value).toLowerCase()));
    const all = body.filters!.some(group => group[0].field === 'product_family_id') ? products : products.filter(product => skus.has(product.sku!.toLowerCase()));
    const page = body.pagination!.page!, pageSize = body.pagination!.page_size!;
    return { data: structuredClone(all.slice((page - 1) * pageSize, page * pageSize)), pagination: { page, page_size: pageSize, total: all.length, pages: Math.max(1, Math.ceil(all.length / pageSize)) } };
  });
  vi.spyOn(client, 'getProduct').mockImplementation(async id => ({ data: structuredClone(products.filter(product => product.id === id)) }));
  vi.spyOn(client, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Family' }] });
  vi.spyOn(client, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: 'parent_level' }] });
  vi.spyOn(client, 'getAttributeById').mockResolvedValue({ id: 'a', label: 'cost', name: 'Cost', type_class: 'DecimalAttribute' });
  const write = vi.spyOn(client, 'updateProduct').mockImplementation(async (id, patch) => {
    const product = products.find(product => product.id === id)!; Object.assign(product.attributes!, patch.attributes);
    return { data: [structuredClone(product)] };
  });
  const service = new PricingService(client, undefined, () => store), reviews = new PricingReviewService(client, undefined, () => store);
  const rule = ruleSchema.parse({ id: 'cost', name: 'Supplier cost', status: 'confirmed', evidence: 'Reviewed source', family_ids: ['f'], target_attribute: 'cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency', unit: 'each', unit_column: 'Unit', operations: [], maximum: '100', max_change_percent: 50, review_attributes: ['brand'], associations: [{ kind: 'brand', column: 'Brand', attribute: 'brand' }] });
  await service.rulesSave({ expected_revision: 0, rules: [rule] });
  const rows = products.map(product => ({ source_ref: `row ${product.id}`, values: { SKU: product.sku!, Price: '12', Currency: 'USD', Unit: 'each', Brand: 'Acme' } }));
  const imports = [], plans = [];
  for (let start = 0; start < count; start += groupSize) {
    const imported = await service.importDocument({ source_name: 'supplier.csv', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: rows.slice(start, start + groupSize) });
    imports.push(imported);
    plans.push(await service.plan({ import_id: imported.import_id, rule_ids: ['cost'], mappings: products.slice(start, start + groupSize).map((product, row_index) => ({ row_index, product_id: product.id, family_id: 'f', ...(longNotes ? { proposed_value: '12', review_note: '\\'.repeat(2000) } : {}) })) }));
  }
  const review = await reviews.create({ plan_ids: plans.map(plan => plan.plan_id) });
  const selected = await reviews.update({ review_id: review.review_id, expected_revision: review.revision, decisions: review.lines.map(line => ({ line_id: line.line_id, status: 'selected' })) });
  return { store, client, products, service, reviews, rows, imported: imports[0], plan: plans[0], plans, selected, write };
}

describe('pricing efficiency and bounded batching', () => {
  it('resolves 100 exact SKUs in one supported 100-result lookup and one family lookup', async () => {
    const f = await fixture();
    expect(f.client.searchProducts).toHaveBeenCalledTimes(1);
    expect(f.client.searchProducts).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.any(Array), pagination: { page: 1, page_size: 100 } }));
    expect(vi.mocked(f.client.searchProducts).mock.calls[0][0].filters).toHaveLength(100);
    expect(f.client.getFamily).toHaveBeenCalledTimes(1);
    expect(f.imported.lookup).toEqual({ complete: true, pages: 1, unique_skus: 100 });
    expect(f.imported.matches.every(match => match.status === 'candidate')).toBe(true);
  });

  it('accepts 100 CSV rows and enforces the same bounded row count as extracted imports', async () => {
    const f = await fixture();
    const csv = ['SKU,Price,Currency,Unit,Brand', ...f.rows.map(row => `${row.values.SKU},12,USD,each,Acme`)].join('\n');
    const input = (value: string) => ({ source_name: 'supplier.csv', source_sha256: createHash('sha256').update(value).digest('hex'), sku_column: 'SKU', csv: value });
    const result = await f.service.importDocument(input(csv));
    expect(result.matches).toHaveLength(100);
    expect(result.lookup).toMatchObject({ complete: true, pages: 1 });
    await expect(f.service.importDocument(input(`${csv}\nEXTRA,12,USD,each,Acme`))).rejects.toThrow(/100 rows/);
  });

  it('bounds the total mapping-rule cross product, not just the number of mappings', async () => {
    const f = await fixture(51);
    const rules = await f.service.rulesGet();
    await f.service.rulesSave({ expected_revision: rules.revision, rules: [...rules.rules, { ...rules.rules[0], id: 'second' }] });
    await expect(f.service.plan({ ...f.plan.input, rule_ids: ['cost', 'second'] })).rejects.toThrow(/at most 100/);
  });

  it('uses complete pagination to discover duplicates and excludes case-only SKU matches', async () => {
    const f = await fixture(1);
    const cases = Array.from({ length: 99 }, (_, index) => ({ ...f.products[0], id: `case-${index}`, sku: 'sku-0' }));
    vi.mocked(f.client.searchProducts).mockReset().mockResolvedValueOnce({ data: [f.products[0], ...cases], pagination: { page: 1, page_size: 100, pages: 2, total: 101 } }).mockResolvedValueOnce({ data: [{ ...f.products[0], id: 'duplicate' }], pagination: { page: 2, page_size: 100, pages: 2, total: 101 } });
    const result = await f.service.importDocument({ source_name: 'supplier.pdf', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: f.rows });
    expect(result.lookup).toMatchObject({ complete: true, pages: 2 });
    expect(result.matches[0].status).toBe('ambiguous_or_missing_family');
    expect(result.matches[0].candidates.map(candidate => candidate.product_id)).toEqual(['p0', 'duplicate']);
  });

  it('never treats a truncated or repeated first page as a unique match', async () => {
    const f = await fixture(1);
    vi.mocked(f.client.searchProducts).mockResolvedValue({ data: [f.products[0]], pagination: { page: 1, page_size: 100, pages: 2, total: 2 } });
    const result = await f.service.importDocument({ source_name: 'supplier.pdf', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: f.rows });
    expect(result.lookup.complete).toBe(false);
    expect(result.matches[0].status).toBe('incomplete_lookup');
  });

  it('recognizes a complete zero-result lookup without requiring a nonexistent page', async () => {
    const f = await fixture(1);
    vi.mocked(f.client.searchProducts).mockResolvedValue({ data: [], pagination: { page: 1, page_size: 100, pages: 0, total: 0 } });
    const result = await f.service.importDocument({ source_name: 'supplier.pdf', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: f.rows });
    expect(result.lookup.complete).toBe(true);
    expect(result.matches[0].status).toBe('unmatched');
  });

  it('shares repeated source-SKU lookups without dropping source rows', async () => {
    const f = await fixture(1);
    vi.mocked(f.client.searchProducts).mockClear();
    const result = await f.service.importDocument({ source_name: 'supplier.pdf', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: Array.from({ length: 100 }, (_, index) => ({ ...f.rows[0], source_ref: `row ${index}` })) });
    expect(f.client.searchProducts).toHaveBeenCalledTimes(1);
    expect(result.lookup.unique_skus).toBe(1);
    expect(result.matches).toHaveLength(100);
  });

  it('prepares one grouped plan with one source/rules/history read and preserves the remaining selection', async () => {
    const f = await fixture();
    f.store.reads = []; f.store.creates = [];
    const result = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    expect(result.plans).toHaveLength(1);
    expect(result.approval!.arguments.plans).toHaveLength(1);
    expect(result.approval!.arguments.changes).toHaveLength(100);
    expect(result.batching).toMatchObject({ requested: 100, prepared: 100, deferred_count: 0, estimated_api_requests: 502, max_estimated_api_requests: 2048 });
    expect(f.store.reads.filter(key => key === `${f.imported.import_id}.json`)).toHaveLength(1);
    expect(f.store.reads.filter(key => key === `${f.plan.plan_id}.json`)).toHaveLength(1);
    expect(f.store.reads.filter(key => key === 'rules.json')).toHaveLength(1);
    expect(f.store.creates.filter(key => /^[a-f0-9-]{36}\.json$/.test(key))).toHaveLength(1);
    expect(result.review.lines.filter(line => line.status === 'selected')).toHaveLength(100);
    const applied = await f.reviews.apply(result.approval!.arguments);
    expect(applied.state).toBe('complete');
    expect(applied.review.counts).toMatchObject({ verified: 100, awaiting_approval: 0 });
    expect(f.write).toHaveBeenCalledTimes(100);
  });

  it('automatically takes the maximum 100-line selection and retains later review rows', async () => {
    const f = await fixture(101);
    const prepared = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    expect(prepared.approval!.arguments.changes).toHaveLength(100);
    expect(prepared.batching).toMatchObject({ requested: 101, prepared: 100, deferred_count: 1, reasons: ['change_limit'] });
    expect(prepared.review.lines.every(line => line.status === 'selected')).toBe(true);
    const applied = await f.reviews.apply(prepared.approval!.arguments);
    expect(applied.review.counts).toMatchObject({ verified: 100, awaiting_approval: 1 });
    const last = await f.reviews.plan({ review_id: applied.review.review_id, expected_revision: applied.review.revision });
    expect(last.approval!.arguments.changes.map(change => change.product_id)).toEqual(['p100']);
  });

  it('budgets heterogeneous groups for preflight, later rebuild and final verification without shared-read assumptions', async () => {
    const f = await fixture(3, false, 1);
    const prepared = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    expect(prepared.plans).toHaveLength(3);
    // The estimate reserves a conservative shared-read/metadata allowance and
    // one fallback PATCH per owner, without per-row readback loops.
    expect(prepared.batching.estimated_api_requests).toBe(3 * 5 + 2);
    expect(prepared.learning).toHaveLength(3);
    expect((await f.reviews.apply(prepared.approval!.arguments)).state).toBe('complete');
  });

  it('partitions fresh changes and blocked evidence away from stable selected rows', async () => {
    const f = await fixture(4);
    f.products[0].attributes!.cost = 11;
    f.products[1].attributes!.brand = 'Other';
    const prepared = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    expect(prepared.review.lines.map(line => line.status)).toEqual(['pending', 'blocked', 'selected', 'selected']);
    expect(prepared.pending_review).toBe(true);
    expect(prepared.plans).toHaveLength(2);
    expect(prepared.approval!.arguments.changes.map(change => change.product_id)).toEqual(['p2', 'p3']);
    expect((await f.reviews.apply(prepared.approval!.arguments)).state).toBe('complete');
    expect(f.write.mock.calls.map(([id]) => id)).toEqual(['p2', 'p3']);
  });

  it('automatically byte-fits verbose review notes instead of blocking the entire selection', async () => {
    const f = await fixture(16, true);
    const prepared = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    expect(prepared.approval!.argument_characters).toBeLessThanOrEqual(64_000);
    expect(prepared.approval!.arguments.changes.length).toBeGreaterThan(0);
    expect(prepared.batching.deferred_count).toBeGreaterThan(0);
    expect(prepared.batching.reasons).toContain('approval_size_limit');
    expect(prepared.review.lines.every(line => line.status === 'selected')).toBe(true);
    expect((await f.reviews.apply(prepared.approval!.arguments)).state).toBe('complete');
  });

  it('keeps untouched rows queued and resumes the same exact approved manifest', async () => {
    const f = await fixture(3);
    const prepared = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    const remaining = vi.spyOn(f.client, 'remainingOperationTimeMs').mockReturnValue(2000);
    const deferred = await f.reviews.apply(prepared.approval!.arguments);
    expect(deferred.state).toBe('pending');
    expect(deferred.review.counts.queued).toBe(3);
    expect(deferred.review.lines.every(line => line.execution?.status === 'queued')).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
    remaining.mockReturnValue(60_000);
    expect((await f.reviews.apply(prepared.approval!.arguments)).state).toBe('complete');
    expect(f.write).toHaveBeenCalledTimes(3);
  });

  it('keeps verified rows locked when the next row runs out of time before sending', async () => {
    const f = await fixture(3);
    const prepared = await f.reviews.plan({ review_id: f.selected.review_id, expected_revision: f.selected.revision });
    vi.spyOn(f.client, 'remainingOperationTimeMs').mockImplementation(() => f.write.mock.calls.length ? 2000 : 60_000);
    const result = await f.reviews.apply(prepared.approval!.arguments);
    expect(result.state).toBe('pending');
    expect(result.review.lines.map(line => line.execution?.status)).toEqual(['verified', 'queued', 'queued']);
    expect(result.review.counts.queued).toBe(2);
    expect(f.write).toHaveBeenCalledTimes(1);
    await expect(f.reviews.update({ review_id: result.review.review_id, expected_revision: result.review.revision, decisions: [{ line_id: result.review.lines[0].line_id, status: 'selected' }] })).rejects.toThrow(/executed|uncertain|progress/i);
  });
});
