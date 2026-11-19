import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlytixClient } from '../client.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { PricingService } from '../pricing/service.js';
import { PricingReviewService } from '../pricing/review.js';
import { coverageInput, reviewCreateInput, reviewDocument, type ReviewDocument } from '../pricing/review-model.js';
import { ruleSchema } from '../pricing/model.js';
import { createPricingStore } from '../pricing/store.js';
import { z } from 'zod';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const coverage: z.infer<typeof coverageInput>[] = [
  { kind: 'missing_source', label: 'Unlisted thickness', reason: 'This source has no matching thickness; retain the catalog cost.', product_id: 'missing', sku: 'MISSING', family_id: 'f', attribute: 'cost', current_value: 7.5, source_ref: 'Page 1, available thickness table' },
  { kind: 'protected_custom', label: 'Custom product', reason: 'A separate reviewed custom quote is required.', product_id: 'custom', sku: 'CUSTOM', family_id: 'f', attribute: 'cost', current_value: 0 },
  { kind: 'unused_alternative', label: 'Alternative stock size', reason: 'The catalog uses a different stock size.', source_name: 'supplier.pdf', source_sha256: '1'.repeat(64), source_ref: 'Page 1, alternative size table', details: { tier: 'Skid', source_size: '60 x 120 in', chosen_size: '48 x 96 in' } },
  { kind: 'unresolved_mapping', label: 'Unmatched source line', reason: 'Product family mapping is unresolved.', source_ref: 'Page 2, specialty row' },
];

async function fixture(withPlan = true, inherited = false, unchanged = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-coverage-')); directories.push(directory);
  const client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_apply', 'pricing_review_apply']) });
  const products: PlytixProduct[] = [
    { id: 'priced', sku: 'PRICED', product_type: 'STANDALONE', product_family_id: 'f', num_variations: 0, attributes: { cost: 10 } },
    { id: 'missing', sku: 'MISSING', product_type: 'STANDALONE', product_family_id: 'f', num_variations: 0, attributes: { cost: 7.5 } },
    { id: 'custom', sku: 'CUSTOM', product_type: 'STANDALONE', product_family_id: 'f', num_variations: 0, attributes: { cost: 0 } },
  ];
  if (inherited) {
    Object.assign(products[0], { product_type: 'PARENT', num_variations: 2, overwritten_attributes: [] });
    Object.assign(products[1], { product_type: 'VARIANT', _parent_id: 'priced', overwritten_attributes: [], attributes: { cost: 10 } });
    Object.assign(products[2], { product_type: 'VARIANT', _parent_id: 'priced', overwritten_attributes: ['a'] });
    vi.spyOn(client, 'getProductVariants').mockImplementation(async () => ({ data: structuredClone(products.slice(1)), pagination: { page: 1, pages: 1, count: 2, total: 2 } }));
  }
  vi.spyOn(client, 'verifyKnowledgeAccess').mockResolvedValue();
  const search = vi.spyOn(client, 'searchProducts').mockResolvedValue({ data: structuredClone(products), pagination: { page: 1, pages: 1, count: products.length, total: products.length } });
  // Batch validation sees the newly written owner cost on its second snapshot.
  search.mockImplementation(async () => ({ data: structuredClone(products), pagination: { page: 1, pages: 1, count: products.length, total: products.length } }));
  vi.spyOn(client, 'getProduct').mockImplementation(async id => ({ data: structuredClone(products.filter(product => product.id === id)) }));
  vi.spyOn(client, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Fixture family' }] });
  vi.spyOn(client, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: 'parent_level' }] });
  vi.spyOn(client, 'getAttributeById').mockResolvedValue({ id: 'a', label: 'cost', name: 'Cost', type_class: 'DecimalAttribute' });
  vi.spyOn(client, 'submitPricingBulk').mockRejectedValue(new PlytixError('Bulk unavailable', 405));
  const write = vi.spyOn(client, 'updateProduct').mockImplementation(async (id, patch) => {
    const product = products.find(product => product.id === id)!;
    product.attributes!.cost = patch.attributes!.cost;
    return { data: [structuredClone(product)] };
  });
  const service = new PricingService(client, directory), reviews = new PricingReviewService(client, directory);
  if (!withPlan) return { directory, client, products, write, search, service, reviews, plan: undefined };
  const imported = await service.importDocument({ source_name: 'supplier.pdf', source_sha256: '1'.repeat(64), sku_column: 'SKU', learning_mode: 'proposal_only', rows: [
    { source_ref: 'Page 1, matched row', values: { SKU: 'PRICED', Price: unchanged ? '10' : '12', Currency: 'USD', Unit: 'each' } },
  ] });
  const rule = ruleSchema.parse({ id: 'cost', name: 'Quoted cost', status: 'confirmed', evidence: 'Fixture source page 1', family_ids: ['f'], target_attribute: 'cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency', unit: 'each', unit_column: 'Unit', operations: [], maximum: '100', max_change_percent: 50 });
  const plan = await service.plan({ import_id: imported.import_id, rule_ids: [], batch_rules: [rule], mappings: [{ row_index: 0, product_id: 'priced', family_id: 'f' }] });
  expect(plan.blocked).toEqual([]);
  return { directory, client, products, write, search, service, reviews, plan };
}

describe('non-executable pricing coverage ledger', () => {
  it('persists a coverage-only review without inventing source prices or loading product comparisons', async () => {
    const f = await fixture(false);
    const review = await f.reviews.create({ plan_ids: [], coverage, title: 'Source coverage' });
    expect(review.lines).toEqual([]);
    expect(review.counts).toMatchObject({ total: 0, coverage: 4, review_total: 4, selected: 0, awaiting_approval: 0 });
    expect(review.coverage_counts).toEqual({ total: 4, missing_source: 1, protected_custom: 1, unused_alternative: 1, unresolved_mapping: 1 });
    expect(review.coverage[1].current_value).toBe(0);
    expect(review.coverage[0]).not.toHaveProperty('proposed_value');
    expect(review.coverage[0]).not.toHaveProperty('change');
    expect(review.coverage.every(entry => entry.coverage_id.startsWith('coverage_'))).toBe(true);
    expect(await new PricingReviewService(f.client, f.directory).get(review.review_id)).toEqual(review);
    expect(f.search).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('never selects or prepares coverage IDs, even through explicit decision and line-ID requests', async () => {
    const f = await fixture(false);
    const review = await f.reviews.create({ plan_ids: [], coverage });
    for (const entry of review.coverage) {
      await expect(f.reviews.update({ review_id: review.review_id, expected_revision: 0, decisions: [{ line_id: entry.coverage_id, status: 'selected' }] })).rejects.toThrow('Unknown review line');
      await expect(f.reviews.plan({ review_id: review.review_id, expected_revision: 0, line_ids: [entry.coverage_id] })).rejects.toThrow('Unknown review line');
    }
    await expect(f.reviews.plan({ review_id: review.review_id, expected_revision: 0 })).rejects.toThrow(/Choose one/);
    expect(await f.reviews.get(review.review_id)).toEqual(review);
    expect(f.search).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('keeps coverage out of exact approval and writes while preserving it through plan and apply', async () => {
    const f = await fixture();
    const review = await f.reviews.create({ plan_ids: [f.plan!.plan_id], coverage });
    expect(review.counts).toMatchObject({ total: 1, coverage: 4, review_total: 5, pending: 1 });
    expect(review.learning_proposals).toHaveLength(1);
    expect(review.learning_proposals[0].learning).toMatchObject({ status: 'proposal_only', saved: 0 });
    const selected = await f.reviews.update({ review_id: review.review_id, expected_revision: 0, decisions: [{ line_id: review.lines[0].line_id, status: 'selected' }] });
    const prepared = await f.reviews.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    expect(prepared.review.coverage).toEqual(review.coverage);
    expect(prepared.plans.every(plan => plan.input.learning_mode === 'proposal_only')).toBe(true);
    expect(prepared.review.learning_proposals[0].learning.saved).toBe(0);
    const approval = prepared.approval!.arguments;
    expect(approval.changes).toHaveLength(1);
    expect(approval.changes[0]).toMatchObject({ product_id: 'priced', old_value: 10, new_value: 12 });
    expect(approval).not.toHaveProperty('coverage');
    await expect(f.reviews.apply({ ...approval, changes: [{ ...approval.changes[0], line_id: review.coverage[0].coverage_id, product_id: 'missing', sku: 'MISSING', old_value: 7.5 }] })).rejects.toThrow(/altered/);
    expect(f.write).not.toHaveBeenCalled();
    const applied = await f.reviews.apply(approval);
    expect(applied.state).toBe('complete');
    expect(f.write.mock.calls.map(([id]) => id)).toEqual(['priced']);
    expect(f.products.map(product => product.attributes!.cost)).toEqual([12, 7.5, 0]);
    expect(applied.review.coverage).toEqual(review.coverage);
    expect(applied.review.coverage_counts).toEqual(review.coverage_counts);
    expect(applied.review.counts).toMatchObject({ verified: 1, coverage: 4, review_total: 5 });
  });

  it('rejects contradictory retained-target coverage, duplicate entries and price-change payloads', async () => {
    const f = await fixture();
    const overlapping = { ...coverage[0], product_id: 'priced', sku: 'PRICED' };
    await expect(f.reviews.create({ plan_ids: [f.plan!.plan_id], coverage: [overlapping] })).rejects.toThrow(/cannot duplicate/);
    await expect(f.reviews.create({ plan_ids: [], coverage: [coverage[0], coverage[0]] })).rejects.toThrow(/unique/);
    await expect(f.reviews.create({ plan_ids: [], coverage: [{ kind: 'missing_source', label: 'No identity', reason: 'No match' }] })).rejects.toThrow(/product ID|source reference/);
    expect(reviewCreateInput.safeParse({ plan_ids: [] }).success).toBe(false);
    for (const injected of [{ proposed_value: '0' }, { change: { new_value: 0 } }, { status: 'selected' }, { coverage_id: 'caller-id' }]) {
      expect(reviewCreateInput.safeParse({ plan_ids: [], coverage: [{ ...coverage[0], ...injected }] }).success).toBe(false);
    }
    expect(f.write).not.toHaveBeenCalled();
  });

  it('blocks held descendant targets but permits preserved overrides and unused alternatives', async () => {
    const f = await fixture(true, true);
    expect(f.plan!.changes[0].descendant_impact).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: 'missing', old_value: 10, new_value: 12, overridden: false }),
      expect.objectContaining({ product_id: 'custom', old_value: 0, new_value: 0, overridden: true }),
    ]));
    for (const kind of ['missing_source', 'protected_custom', 'unresolved_mapping'] as const) {
      await expect(f.reviews.create({ plan_ids: [f.plan!.plan_id], coverage: [{ ...coverage[0], kind, current_value: 10 }] })).rejects.toThrow(/changed inheriting descendant/);
    }
    const review = await f.reviews.create({ plan_ids: [f.plan!.plan_id], coverage: [coverage[1], { ...coverage[2], product_id: 'missing', attribute: 'cost' }] });
    expect(review.coverage).toHaveLength(2);
    expect(review.lines[0].status).toBe('pending');
    expect(f.write).not.toHaveBeenCalled();
  });

  it('permits retained coverage when the inherited cost is unchanged', async () => {
    const f = await fixture(true, true, true);
    expect(f.plan!.changes[0].descendant_impact.every(child => child.new_value === child.old_value)).toBe(true);
    const review = await f.reviews.create({ plan_ids: [f.plan!.plan_id], coverage: [{ ...coverage[0], current_value: 10 }, coverage[1]] });
    expect(review.lines[0].status).toBe('unchanged');
    expect(review.coverage).toHaveLength(2);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('holds a refreshed owner when a previously preserved descendant would now inherit a change', async () => {
    const f = await fixture(true, true);
    const review = await f.reviews.create({ plan_ids: [f.plan!.plan_id], coverage: [coverage[1]] });
    const selected = await f.reviews.update({ review_id: review.review_id, expected_revision: 0, decisions: [{ line_id: review.lines[0].line_id, status: 'selected' }] });
    f.products[2].overwritten_attributes = [];
    f.products[2].attributes!.cost = 10;
    const prepared = await f.reviews.plan({ review_id: review.review_id, expected_revision: selected.revision });
    expect(prepared.approval).toBeUndefined();
    expect(prepared.review.lines[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('retained coverage') });
    expect(prepared.review.coverage).toEqual(review.coverage);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('validates target and source evidence when reading persisted coverage records too', async () => {
    const f = await fixture(false);
    const review = await f.reviews.create({ plan_ids: [], coverage });
    for (const broken of [
      { ...review.coverage[1], product_id: undefined, attribute: undefined, source_ref: undefined },
      { ...review.coverage[0], attribute: undefined },
      { ...review.coverage[3], source_ref: undefined },
      { ...review.coverage[2], current_value: 12 },
    ]) expect(reviewDocument.safeParse({ ...review, coverage: [broken] }).success).toBe(false);
    expect(reviewDocument.safeParse(review).success).toBe(true);
  });

  it('reads existing reviews without coverage and preserves normal line decisions', async () => {
    const f = await fixture();
    const review = await f.reviews.create({ plan_ids: [f.plan!.plan_id] });
    const store = createPricingStore(f.client.knowledgeFingerprint(), f.directory);
    const legacy = { ...review } as Partial<ReviewDocument>;
    delete legacy.coverage;
    // Simulate an existing stored document from the previous release.
    await store.update(`${review.review_id}.json`, value => value as typeof legacy, () => legacy);
    const reopened = await f.reviews.get(review.review_id);
    expect(reopened.coverage).toEqual([]);
    expect(reopened.coverage_counts.total).toBe(0);
    expect(reopened.counts).toMatchObject({ total: 1, coverage: 0, review_total: 1 });
    const selected = await f.reviews.update({ review_id: reopened.review_id, expected_revision: reopened.revision, decisions: [{ line_id: reopened.lines[0].line_id, status: 'selected' }] });
    expect(selected.counts.awaiting_approval).toBe(1);
    expect(f.write).not.toHaveBeenCalled();
  });
});
