import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlytixClient } from '../client.js';
import { PricingService } from '../pricing/service.js';
import { PricingReviewService } from '../pricing/review.js';
import { ruleSchema } from '../pricing/model.js';
import { createPricingStore, type PricingStore } from '../pricing/store.js';
import { decorateResult } from '../results.js';
import { PlytixError, type PlytixProduct } from '../types.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const rule = ruleSchema.parse({
  id: 'supplier_cost', name: 'Supplier cost', status: 'confirmed', evidence: 'Reviewed supplier document page 1',
  family_ids: ['f'], target_attribute: 'cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency',
  unit: 'each', unit_column: 'Unit', operations: [{ op: 'multiply', operand: '0.9' }], maximum: '1000',
  max_change_percent: 50, review_attributes: ['brand'], associations: [{ kind: 'brand', column: 'Brand', attribute: 'brand' }],
});

async function fixture(separatePlans = false, containerCount = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'pricing-review-')); directories.push(directory);
  const client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_apply', 'pricing_rules_save']) });
  const products: PlytixProduct[] = (containerCount ? Array<number>(containerCount).fill(10) : [10, 20, 30]).map((cost, index) => ({
    id: `p${index + 1}`, sku: `SKU-${index + 1}`, product_type: containerCount ? 'VARIANT' : 'STANDALONE', product_family_id: 'f', num_variations: containerCount ? 10 : 0,
    ...(containerCount ? { _parent_id: 'root', overwritten_attributes: [] } : {}),
    attributes: { cost, brand: 'Acme' },
  }));
  const children = new Map<string, PlytixProduct[]>();
  if (containerCount) for (const product of products) children.set(product.id, Array.from({ length: 10 }, (_, index) => ({
    id: `${product.id}-c${index + 1}`, sku: `${product.sku}-CHILD-${index + 1}`, product_type: 'SUB_VARIANT', product_family_id: 'f', _parent_id: product.id,
    num_variations: 0, overwritten_attributes: index === 9 ? ['attributes.a'] : [], attributes: { cost: index === 9 ? 12 : 10, brand: 'Acme' },
  })));
  const root: PlytixProduct = { id: 'root', sku: 'ROOT', product_type: 'PARENT', product_family_id: 'f', num_variations: containerCount };
  const records = [...products, root, ...[...children.values()].flat()];
  vi.spyOn(client, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(client, 'searchProducts').mockImplementation(async body => {
    const all = body.filters?.some(g => g.some(f => f.field === 'product_family_id')) ? records : products;
    const page = body.pagination?.page ?? 1, pageSize = body.pagination?.page_size ?? 100;
    return { data: structuredClone(all.slice((page - 1) * pageSize, page * pageSize)), pagination: { page, page_size: pageSize, total: all.length, pages: Math.max(1, Math.ceil(all.length / pageSize)) } };
  });
  vi.spyOn(client, 'submitPricingBulk').mockRejectedValue(new PlytixError('Bulk unavailable', 405));
  vi.spyOn(client, 'getProduct').mockImplementation(async id => ({ data: structuredClone(records.filter(product => product.id === id)) }));
  if (containerCount) vi.spyOn(client, 'getProductVariants').mockImplementation(async id => ({ data: structuredClone(children.get(id) ?? []), pagination: { page: 1, pages: 1, count: 10, total: 10 } }));
  vi.spyOn(client, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Family' }] });
  vi.spyOn(client, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: containerCount ? 'variant_level' : 'parent_level' }] });
  vi.spyOn(client, 'getAttributeById').mockResolvedValue({ id: 'a', label: 'cost', name: 'Cost', type_class: 'DecimalAttribute' });
  const write = vi.spyOn(client, 'updateProduct').mockImplementation(async (id, patch) => {
    const product = products.find(item => item.id === id)!;
    product.attributes!.cost = patch.attributes!.cost;
    for (const child of children.get(id) ?? []) if (!child.overwritten_attributes!.length) child.attributes!.cost = patch.attributes!.cost;
    return { data: [structuredClone(product)] };
  });
  const service = new PricingService(client, directory);
  const reviewService = new PricingReviewService(client, directory);
  await service.rulesSave({ expected_revision: 0, rules: [rule] });
  const rows = products.map((product, index) => ({ source_ref: `page 1 row ${index + 2}`, values: {
    SKU: product.sku!, Price: containerCount ? '12.50' : ['12.50', '22.00', '33.00'][index], Currency: 'USD', Unit: 'each', Brand: 'Acme',
  } }));
  const groups = separatePlans ? rows.map(row => [row]) : Array.from({ length: Math.ceil(rows.length / 20) }, (_, index) => rows.slice(index * 20, index * 20 + 20));
  const plans = [];
  for (const [index, group] of groups.entries()) {
    const imported = await service.importDocument({ source_name: `supplier-${index + 1}.pdf`, source_sha256: String(index + 1).repeat(64), sku_column: 'SKU', rows: group });
    plans.push(await service.plan({ import_id: imported.import_id, rule_ids: [rule.id], mappings: group.map((row, rowIndex) => ({
      row_index: rowIndex, product_id: products.find(product => product.sku === row.values.SKU)!.id, family_id: 'f',
    })) }));
  }
  const review = await reviewService.create({ plan_ids: plans.map(plan => plan.plan_id), title: 'Supplier sheet review' });
  return { client, directory, service, reviewService, products, children, write, rows, plans, review };
}

describe('durable pricing review', () => {
  it('preserves the review workspace envelope without claiming saved prices were freshly read', async () => {
    const f = await fixture();
    f.products[0].attributes!.cost = 99;
    const saved = await f.reviewService.get(f.review.review_id);
    const result = decorateResult('pricing_review_get', { content: [{ type: 'text', text: JSON.stringify(saved) }] }, new Date().toISOString(), []);
    expect(result.structuredContent.data).toEqual(saved);
    expect(saved.lines[0].change!.old_value).toBe(10);
    expect(result.structuredContent.metadata).toMatchObject({ status: 'ok', freshness: 'not_asserted', coverage: 'not_asserted' });
    const failure = decorateResult('pricing_review_get', { content: [{ type: 'text', text: 'Saved review could not be read' }], isError: true }, new Date().toISOString(), []);
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent.metadata.status).toBe('error');
    expect(failure.structuredContent.data).toEqual({ message: 'Saved review could not be read' });
  });

  it('prepares and applies 26 containers with bounded parallel child reads and sequential owner writes', async () => {
    const f = await fixture(false, 26);
    let activeReads = 0, peakReads = 0, completedReads = 0, activeWrites = 0, peakWrites = 0;
    const read = vi.mocked(f.client.getProduct).getMockImplementation()!;
    vi.mocked(f.client.getProduct).mockImplementation(async id => {
      if (!id.includes('-c')) return read(id);
      activeReads++; peakReads = Math.max(peakReads, activeReads);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await read(id); }
      finally { activeReads--; completedReads++; }
    });
    const write = f.write.getMockImplementation()!;
    f.write.mockImplementation(async (...args) => {
      activeWrites++; peakWrites = Math.max(peakWrites, activeWrites);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await write(...args); }
      finally { activeWrites--; }
    });
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: f.review.lines.map(line => ({ line_id: line.line_id, status: 'selected' })) });
    let current = selected, batches = 0;
    while (current.counts.awaiting_approval) {
      const prepared = await f.reviewService.plan({ review_id: current.review_id, expected_revision: current.revision });
      expect(prepared.approval!.arguments.changes).toHaveLength(26);
      expect(prepared.approval!.arguments.changes.every(change => change.descendants.length === 10)).toBe(true);
      expect(prepared.approval!.argument_characters).toBeLessThan(64_000);
      expect(prepared.batching.estimated_api_requests).toBeLessThanOrEqual(prepared.batching.max_estimated_api_requests);
      expect(prepared.batching.estimated_api_requests).toBe(2 + 26 * 5);
      if (!batches) expect(f.write).not.toHaveBeenCalled();
      const applied = await f.reviewService.apply(prepared.approval!.arguments);
      expect(applied.state).toBe('complete');
      current = applied.review; batches++;
    }
    expect(batches).toBe(1);
    expect(current.counts).toMatchObject({ verified: 26, awaiting_approval: 0 });
    expect(current.lines.every(line => line.execution?.status === 'verified')).toBe(true);
    expect(f.write.mock.calls.map(([id]) => id)).toEqual(f.products.map(product => product.id));
    expect(f.products.every(product => product.attributes!.cost === 11.25)).toBe(true);
    for (const children of f.children.values()) expect(children.map(child => child.attributes!.cost)).toEqual([...Array<number>(9).fill(11.25), 12]);
    expect(peakReads).toBe(0);
    expect(activeReads).toBe(0);
    expect(completedReads).toBe(0);
    expect(peakWrites).toBe(1);
  }, 15_000);

  it('starts every change pending and preserves individual and batch decisions across service instances', async () => {
    const f = await fixture();
    expect(f.review.lines.map(line => line.status)).toEqual(['pending', 'pending', 'pending']);
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [
      { line_id: f.review.lines[0].line_id, status: 'selected' },
      { line_id: f.review.lines[1].line_id, status: 'rejected', note: 'Supplier row is not in this order' },
    ] });
    const reopened = await new PricingReviewService(f.client, f.directory).get(f.review.review_id);
    expect(reopened).toEqual(selected);
    expect(reopened.lines.map(line => line.status)).toEqual(['selected', 'rejected', 'pending']);
    expect(reopened.lines[1].instruction).toBe('Supplier row is not in this order');
    const batch = await f.reviewService.update({ review_id: reopened.review_id, expected_revision: reopened.revision, decisions: reopened.lines.map(line => ({ line_id: line.line_id, status: 'rejected', note: 'Hold this supplier update' })) });
    expect(batch.lines.every(line => line.status === 'rejected')).toBe(true);
    expect(batch.lines.every(line => line.instruction === 'Hold this supplier update')).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('rejects stale revisions and invalid batch members without changing any decision', async () => {
    const f = await fixture();
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: f.review.lines[0].line_id, status: 'selected' }] });
    await expect(f.reviewService.update({ review_id: selected.review_id, expected_revision: f.review.revision, decisions: [{ line_id: selected.lines[1].line_id, status: 'rejected' }] })).rejects.toThrow(/revision|changed/i);
    await expect(f.reviewService.plan({ review_id: selected.review_id, expected_revision: f.review.revision })).rejects.toThrow(/revision|changed/i);
    await expect(f.reviewService.update({ review_id: selected.review_id, expected_revision: selected.revision, decisions: [
      { line_id: selected.lines[0].line_id, status: 'rejected' }, { line_id: 'unknown-line', status: 'selected' },
    ] })).rejects.toThrow();
    expect(await f.reviewService.get(selected.review_id)).toEqual(selected);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('shows blocked and unchanged source rows alongside pending work and prevents selecting them', async () => {
    const f = await fixture();
    f.products[0].attributes!.cost = 11.25;
    f.products[1].attributes!.brand = 'Other brand';
    const plan = await f.service.plan(f.plans[0].input);
    const review = await f.reviewService.create({ plan_ids: [plan.plan_id] });
    expect(review.lines.map(line => line.status)).toEqual(['unchanged', 'blocked', 'pending']);
    expect(review.lines[1].reason).toMatch(/association/i);
    expect(review.lines[1].source.source_values.Price).toBe('22.00');
    expect(review.counts).toMatchObject({ total: 3, unchanged: 1, blocked: 1, pending: 1 });
    for (const line of review.lines.slice(0, 2)) await expect(f.reviewService.update({ review_id: review.review_id, expected_revision: review.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] })).rejects.toThrow(/recalculate/i);
    f.products[1].attributes!.brand = 'Acme';
    const refreshed = await f.reviewService.plan({ review_id: review.review_id, expected_revision: review.revision, line_ids: [review.lines[1].line_id] });
    expect(refreshed.review.lines[1].status).toBe('pending');
    expect(refreshed.review.lines[1].reason).toBeUndefined();
    expect(refreshed.approval).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('recalculates batch modifications and can restore the original supplier-derived amount', async () => {
    const f = await fixture();
    const modified = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: f.review.lines.slice(0, 2).map((line, index) => ({ line_id: line.line_id, status: 'selected', proposed_value: ['11.10', '19.50'][index], note: 'Reviewed supplier correction' })) });
    expect(modified.lines.map(line => line.status)).toEqual(['needs_revision', 'needs_revision', 'pending']);
    const refreshed = await f.reviewService.plan({ review_id: modified.review_id, expected_revision: modified.revision, line_ids: modified.lines.slice(0, 2).map(line => line.line_id) });
    expect(refreshed.review.lines.map(line => line.status)).toEqual(['pending', 'pending', 'pending']);
    expect(refreshed.review.lines.slice(0, 2).map(line => line.change!.new_value)).toEqual([11.1, 19.5]);
    expect(refreshed.approval).toBeUndefined();
    const reset = await f.reviewService.update({ review_id: modified.review_id, expected_revision: refreshed.review.revision, decisions: [{ line_id: modified.lines[0].line_id, status: 'pending', proposed_value: null }] });
    const restored = await f.reviewService.plan({ review_id: reset.review_id, expected_revision: reset.revision, line_ids: [reset.lines[0].line_id] });
    expect(restored.review.lines[0].change!.new_value).toBe(11.25);
    expect(restored.review.lines[0].change!.calculated_value).toBeUndefined();
    expect(restored.review.lines[0].source).toEqual(f.review.lines[0].source);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('retains the original supplier source when a reviewed amount is modified and resets selection', async () => {
    const f = await fixture();
    const line = f.review.lines[0];
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] });
    const modified = await f.reviewService.update({ review_id: selected.review_id, expected_revision: selected.revision, decisions: [{ line_id: line.line_id, status: 'selected', proposed_value: '11.10', note: 'Use the supplier correction' }] });
    const edited = modified.lines.find(item => item.line_id === line.line_id)!;
    expect(edited.status).toBe('needs_revision');
    expect(edited.source).toEqual(line.source);
    expect(edited.source.source_values.Price).toBe('12.50');
    expect(edited.proposed_value).toBe('11.10');
    expect(edited.instruction).toBe('Use the supplier correction');
    await expect(f.reviewService.update({ review_id: modified.review_id, expected_revision: modified.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] })).rejects.toThrow(/recalculate/i);
    const recalculated = await f.reviewService.plan({ review_id: modified.review_id, expected_revision: modified.revision, line_ids: [line.line_id] });
    expect(recalculated.approval).toBeUndefined();
    expect(recalculated.review.lines[0].status).toBe('pending');
    expect(recalculated.review.lines[0].change).toMatchObject({ old_value: 10, new_value: 11.1, calculated_value: 11.25, review_note: 'Use the supplier correction' });
    expect(recalculated.review.lines[0].source).toEqual(line.source);
    expect((await f.service.planGet(f.plans[0].plan_id)).source_snapshot.rows[0].values.Price).toBe('12.50');
    expect(f.write).not.toHaveBeenCalled();
  });

  it('prepares only a chosen selected subset as fresh plans, leaving other decisions visible', async () => {
    const f = await fixture(true);
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: f.review.lines.map((line, index) => ({ line_id: line.line_id, status: index === 2 ? 'rejected' : 'selected' })) });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision, line_ids: [selected.lines[1].line_id] });
    expect(prepared.plans).toHaveLength(1);
    expect(prepared.plans[0].plan_id).not.toBe(f.plans[1].plan_id);
    expect(prepared.plans[0].input.import_id).toBe(f.plans[1].import_id);
    expect(prepared.plans[0].changes.map(change => change.product_id)).toEqual(['p2']);
    expect(prepared.review.lines.map(line => line.status)).toEqual(['selected', 'selected', 'rejected']);
    expect(prepared.approval!.arguments.changes.map(change => change.line_id)).toEqual([selected.lines[1].line_id]);
    expect(prepared.approval!.arguments.plans).toEqual([{ plan_id: prepared.plans[0].plan_id, digest: prepared.plans[0].digest }]);
    expect(prepared.review.counts).toMatchObject({ total: 3, selected: 2, rejected: 1, awaiting_approval: 2 });
    expect(f.write).not.toHaveBeenCalled();
  });

  it('does not accept a modified proposal as approved until it has been recalculated and freshly selected', async () => {
    const f = await fixture();
    const line = f.review.lines[0];
    const modified = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: line.line_id, status: 'selected', proposed_value: '11.10', note: 'Reviewed supplier correction' }] });
    const recalculated = await f.reviewService.plan({ review_id: modified.review_id, expected_revision: modified.revision, line_ids: [line.line_id] });
    const selected = await f.reviewService.update({ review_id: modified.review_id, expected_revision: recalculated.review.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    expect(prepared.approval!.arguments.changes[0]).toMatchObject({ new_value: 11.1, calculated_value: 11.25, review_note: 'Reviewed supplier correction' });
    expect(f.write).not.toHaveBeenCalled();
    const applied = await f.reviewService.apply(prepared.approval!.arguments);
    expect(applied.state).toBe('complete');
    expect(applied.review.lines[0].execution?.status).toBe('verified');
    expect(f.products[0].attributes!.cost).toBe(11.1);
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('rejects stale prepared manifests after any review decision changes', async () => {
    const f = await fixture();
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: f.review.lines[0].line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    const changed = await f.reviewService.update({ review_id: selected.review_id, expected_revision: prepared.review.revision, decisions: [{ line_id: selected.lines[1].line_id, status: 'rejected' }] });
    expect(changed.lines.every(line => line.prepared_plan_id === undefined)).toBe(true);
    await expect(f.reviewService.apply(prepared.approval!.arguments)).rejects.toThrow(/changed|stale/i);
    await expect(f.service.preflight(prepared.plans[0].plan_id)).rejects.toThrow(/review decisions changed/i);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('checks every selected plan before sending the first write', async () => {
    const f = await fixture(true);
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: f.review.lines.map(line => ({ line_id: line.line_id, status: 'selected' })) });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    f.products[2].attributes!.cost = 31;
    const result = await f.reviewService.apply(prepared.approval!.arguments);
    expect(result.state).toBe('stopped');
    expect(result.review.lines.map(l => l.execution?.status)).toEqual(['verified', 'verified', 'conflict']);
    expect(f.write.mock.calls.map(c => c[0])).toEqual(['p1', 'p2']);
  });

  it('rejects tampered amounts, child impacts, or plan digests in the exact approval manifest', async () => {
    const f = await fixture();
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: f.review.lines[0].line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    const original = prepared.approval!.arguments;
    const alteredAmount = structuredClone(original); alteredAmount.changes[0].new_value = 11;
    const alteredImpact = structuredClone(original); alteredImpact.changes[0].descendants.push({ product_id: 'injected', sku: 'INJECTED', old_value: 10, new_value: 11.25, overridden: false });
    const alteredDigest = structuredClone(original); alteredDigest.plans[0].digest = '0'.repeat(64);
    for (const altered of [alteredAmount, alteredImpact, alteredDigest]) await expect(f.reviewService.apply(altered)).rejects.toThrow(/altered/i);
    expect(f.write).not.toHaveBeenCalled();
    expect((await f.reviewService.get(selected.review_id)).batches).toEqual([]);
  });

  it('locks verified lines against editing, replanning, and replay while retaining pending rows', async () => {
    const f = await fixture();
    const line = f.review.lines[0];
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    const applied = await f.reviewService.apply(prepared.approval!.arguments);
    expect(applied.state).toBe('complete');
    expect(applied.review.lines.map(item => item.execution?.status)).toEqual(['verified', undefined, undefined]);
    expect(applied.review.counts).toMatchObject({ verified: 1, pending: 2, awaiting_approval: 0 });
    await expect(f.reviewService.update({ review_id: applied.review.review_id, expected_revision: applied.review.revision, decisions: [{ line_id: line.line_id, status: 'pending' }] })).rejects.toThrow(/executed|uncertain/i);
    await expect(f.reviewService.plan({ review_id: applied.review.review_id, expected_revision: applied.review.revision, line_ids: [line.line_id] })).rejects.toThrow(/executed|uncertain/i);
    await f.reviewService.apply(prepared.approval!.arguments); // Idempotent status/resume: no repeated write.
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('persists uncertain execution per line, stops the batch, and forbids retry', async () => {
    const f = await fixture(true);
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: f.review.lines.map(line => ({ line_id: line.line_id, status: 'selected' })) });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    f.write.mockRejectedValueOnce(new Error('Transport failed with private server body'));
    const applied = await f.reviewService.apply(prepared.approval!.arguments);
    expect(applied.state).toBe('stopped');
    expect(applied.review.lines[0].execution?.status).toBe('sending_or_unknown');
    expect(applied.review.lines.slice(1).every(line => line.execution?.status === 'skipped')).toBe(true);
    expect(applied.review.counts).toMatchObject({ sending_or_unknown: 1, awaiting_approval: 2 });
    expect(JSON.stringify(applied)).not.toContain('private server body');
    const reopened = await new PricingReviewService(f.client, f.directory).get(applied.review.review_id);
    expect(reopened.lines[0].execution?.status).toBe('sending_or_unknown');
    await expect(f.reviewService.plan({ review_id: reopened.review_id, expected_revision: reopened.revision, line_ids: [reopened.lines[0].line_id] })).rejects.toThrow(/executed|uncertain/i);
    await expect(f.reviewService.update({ review_id: reopened.review_id, expected_revision: reopened.revision, decisions: [{ line_id: reopened.lines[0].line_id, status: 'pending' }] })).rejects.toThrow(/executed|uncertain/i);
    await f.reviewService.apply(prepared.approval!.arguments); // Idempotent status/resume: no repeated write.
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('reports an in-flight write and prevents simultaneous edits, preparation, or another batch', async () => {
    const f = await fixture();
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: f.review.lines[0].line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    let entered!: () => void, release!: () => void;
    const writeStarted = new Promise<void>(resolve => { entered = resolve; });
    const finishWrite = new Promise<void>(resolve => { release = resolve; });
    const write = f.write.getMockImplementation()!;
    f.write.mockImplementation(async (...args) => { entered(); await finishWrite; return write(...args); });
    const applying = f.reviewService.apply(prepared.approval!.arguments);
    await writeStarted;
    try {
      const current = await f.reviewService.get(selected.review_id);
      expect(current.batches[0].state).toBe('executing');
      expect(current.lines[0].execution?.status).toBe('sending_or_unknown');
      await expect(f.reviewService.update({ review_id: current.review_id, expected_revision: current.revision, decisions: [{ line_id: current.lines[1].line_id, status: 'selected' }] })).rejects.toThrow(/progress|uncertain/i);
      await expect(f.reviewService.plan({ review_id: current.review_id, expected_revision: current.revision, line_ids: [current.lines[1].line_id] })).rejects.toThrow(/progress|uncertain/i);
      await expect(f.reviewService.apply(prepared.approval!.arguments)).rejects.toThrow(/progress|uncertain/i);
    } finally { release(); }
    expect((await applying).state).toBe('complete');
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid modified amounts blocked when recalculating a mixed batch', async () => {
    const f = await fixture();
    const modified = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: f.review.lines.slice(0, 2).map((line, index) => ({ line_id: line.line_id, status: 'selected', proposed_value: ['16.00', '19.50'][index], note: 'Requested adjustment' })) });
    const refreshed = await f.reviewService.plan({ review_id: modified.review_id, expected_revision: modified.revision, line_ids: modified.lines.slice(0, 2).map(line => line.line_id) });
    expect(refreshed.review.lines.map(line => line.status)).toEqual(['blocked', 'pending', 'pending']);
    expect(refreshed.review.lines[0].reason).toMatch(/change limit/i);
    expect(refreshed.review.lines[0].source.source_values.Price).toBe('12.50');
    expect(refreshed.review.lines[1].change!.new_value).toBe(19.5);
    expect(refreshed.approval).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each(['verified', 'sending_or_unknown'] as const)('never replaces an earlier %s result with a later skipped attempt', async outcome => {
    const f = await fixture();
    const line = f.review.lines[0];
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    if (outcome === 'sending_or_unknown') f.write.mockRejectedValueOnce(new Error('Lost response'));
    const original = f.plans[0];
    const earlier = await f.service.apply({ plan_id: original.plan_id, digest: original.digest, changes: original.changes });
    expect(earlier.results[0].status).toBe(outcome);
    if (outcome === 'sending_or_unknown') f.products[0].attributes!.cost = 10.1;
    const late = prepared.plans[0];
    const stopped = await f.service.apply({ plan_id: late.plan_id, digest: late.digest, changes: late.changes });
    expect(stopped.state).toBe('stopped');
    expect(stopped.results).toEqual([]);
    const reopened = await f.reviewService.get(selected.review_id);
    expect(reopened.lines[0].execution?.status).toBe(outcome);
    await expect(f.reviewService.update({ review_id: reopened.review_id, expected_revision: reopened.revision, decisions: [{ line_id: line.line_id, status: 'pending' }] })).rejects.toThrow(/executed|uncertain/i);
    await expect(f.reviewService.plan({ review_id: reopened.review_id, expected_revision: reopened.revision, line_ids: [line.line_id] })).rejects.toThrow(/executed|uncertain/i);
  });

  it.each(['review', 'pricing'] as const)('blocks an already prepared %s approval after an earlier source plan becomes uncertain', async route => {
    const f = await fixture();
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: f.review.lines[0].line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    f.write.mockRejectedValueOnce(new Error('Lost response'));
    const source = f.plans[0];
    const uncertain = await f.service.apply({ plan_id: source.plan_id, digest: source.digest, changes: source.changes });
    expect(uncertain.results[0].status).toBe('sending_or_unknown');
    expect(f.products[0].attributes!.cost).toBe(10);
    if (route === 'review') {
      await expect(f.reviewService.apply(prepared.approval!.arguments)).rejects.toThrow(/executed|uncertain|retry/i);
    } else {
      const plan = prepared.plans[0];
      const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
      expect(result.state).toBe('stopped');
      expect(result.results).toEqual([]);
    }
    expect(f.write).toHaveBeenCalledTimes(1);
  });

  it.each(['update', 'plan'] as const)('rejects a %s that started before execution but would commit afterward', async action => {
    const f = await fixture();
    const line = f.review.lines[0];
    const selected = await f.reviewService.update({ review_id: f.review.review_id, expected_revision: f.review.revision, decisions: [{ line_id: line.line_id, status: 'selected' }] });
    const prepared = await f.reviewService.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    let entered!: () => void, release!: () => void;
    const reachedCommit = new Promise<void>(resolve => { entered = resolve; });
    const continueCommit = new Promise<void>(resolve => { release = resolve; });
    const delayed = new PricingReviewService(f.client, f.directory, (fingerprint, root) => {
      const base = createPricingStore(fingerprint, root);
      return {
        kind: base.kind, read: base.read.bind(base), create: base.create.bind(base),
        async update<T>(key: string, parse: Parameters<PricingStore['update']>[1], change: (value: T) => T) {
          if (key === `${prepared.review.review_id}.json`) { entered(); await continueCommit; }
          return base.update(key, parse as (value: unknown | undefined) => T, change);
        },
      };
    });
    const editing = action === 'update'
      ? delayed.update({ review_id: prepared.review.review_id, expected_revision: prepared.review.revision, decisions: [{ line_id: line.line_id, status: 'pending' }] })
      : delayed.plan({ review_id: prepared.review.review_id, expected_revision: prepared.review.revision, line_ids: [line.line_id] });
    await reachedCommit;
    try {
      const applied = await f.reviewService.apply(prepared.approval!.arguments);
      expect(applied.state).toBe('complete');
    } finally { release(); }
    await expect(editing).rejects.toThrow(/changed|executed|uncertain/i);
    expect((await f.reviewService.get(prepared.review.review_id)).lines[0].execution?.status).toBe('verified');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
});
