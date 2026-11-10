import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlytixClient } from '../client.js';
import { PricingService } from '../pricing/service.js';
import { PricingReviewService } from '../pricing/review.js';
import { ruleSchema } from '../pricing/model.js';
import { PlytixError, type PlytixProduct } from '../types.js';
import { isWriteRequestForTool } from '../policy.js';
import { materialGroup } from '../pricing/snapshot.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function fixture(count = 2, excluded = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'pricing-batch-')); dirs.push(dir);
  const client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_review_apply']) });
  // No fixture may fall through to a live request.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call in fixture'); }));
  vi.spyOn(client, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(client, 'remainingOperationTimeMs').mockReturnValue(60_000);
  const owners: PlytixProduct[] = Array.from({ length: count + excluded }, (_, i) => ({
    id: `owner-${i}`, sku: `OWNER-${i}`, product_type: 'VARIANT', product_family_id: 'family', _parent_id: 'root', num_variations: 6, overwritten_attributes: [],
    attributes: { supplier_1_name: 'Supplier A', supplier_1_mpn: `RD-${Math.floor(i / 2)}`, supplier_1_cost: i < count ? 10 + i : null,
      supplier_2_name: 'Supplier B', supplier_2_cost: 20 + i, primary_supplier: i < count ? 'Supplier 1' : 'Supplier 2',
      material_id: `MATERIAL-${i}`, raw_material_length: 120, price_calculation_method: 'Linear', color_name: i % 2 ? 'Reprocessed' : 'Natural', grade: i % 2 ? 'reprocessed' : 'virgin', shape: 'Rod', specific_gravity: 0.94 },
  }));
  const children = owners.flatMap(owner => Array.from({ length: 6 }, (_, i): PlytixProduct => ({
    ...structuredClone(owner), id: `${owner.id}-child-${i}`, sku: `${owner.sku}-CHILD-${i}`, product_type: 'SUB_VARIANT', _parent_id: owner.id, num_variations: 0,
    overwritten_attributes: i === 5 ? ['cost-id'] : [],
    attributes: { ...owner.attributes, supplier_1_cost: i === 5 ? 77 : owner.attributes!.supplier_1_cost },
  })));
  const root: PlytixProduct = { id: 'root', sku: 'ROOT', product_type: 'PARENT', product_family_id: 'family', num_variations: owners.length + children.length, overwritten_attributes: [], attributes: { primary_supplier: 'N/A' } };
  const records = [root, ...owners, ...children];
  const read = vi.spyOn(client, 'getProduct').mockImplementation(async id => ({ data: structuredClone(records.filter(p => p.id === id)) }));
  vi.spyOn(client, 'getProductVariants').mockImplementation(async id => ({ data: structuredClone(records.filter(p => p._parent_id === id)) }));
  vi.spyOn(client, 'getFamily').mockResolvedValue({ data: [{ id: 'family', name: 'Example rods' }] });
  vi.spyOn(client, 'getFamilyAllAttributes').mockResolvedValue({ data: Object.keys(owners[0].attributes!).map(label => ({
    id: label === 'supplier_1_cost' ? 'cost-id' : label, label, name: label, attribute_level: label.endsWith('_cost') ? 'variant_level' : 'parent_level',
  })) });
  vi.spyOn(client, 'getAttributeById').mockImplementation(async id => ({ id, label: id === 'cost-id' ? 'supplier_1_cost' : id, name: 'Supplier cost', type_class: 'DecimalAttribute' }));
  const search = vi.spyOn(client, 'searchProducts').mockImplementation(async body => {
    const family = body.filters?.some(g => g.some(f => f.field === 'product_family_id'));
    const skus = new Set(body.filters?.flatMap(g => g.filter(f => f.field === 'sku').map(f => f.value)));
    const matching = family ? records : owners.filter(p => skus.has(p.sku));
    const page = body.pagination?.page ?? 1, size = body.pagination?.page_size ?? 100;
    return { data: structuredClone(matching.slice((page - 1) * size, page * size)), pagination: { page, page_size: size, count: matching.length, total_count: 9000 } };
  });
  const set = (id: string, attrs: Record<string, unknown>) => {
    const product = records.find(p => p.id === id)!; Object.assign(product.attributes!, attrs);
    for (const child of children.filter(c => c._parent_id === id)) for (const [label, value] of Object.entries(attrs)) {
      if (!child.overwritten_attributes!.some(a => a === label || (label === 'supplier_1_cost' && a === 'cost-id'))) child.attributes![label] = value;
    }
  };
  const patch = vi.spyOn(client, 'updateProduct').mockImplementation(async (id, data) => { set(id, data.attributes!); return { data: [] }; });
  const submit = vi.spyOn(client, 'submitPricingBulk').mockImplementation(async rows => { rows.forEach(row => set(row.id, row.data.attributes)); return 'job-1'; });
  const poll = vi.spyOn(client, 'getPricingBulkJob').mockResolvedValue({ status: 'Finished', summary: { ok: String(count), error: '0', cancelled: '0' } });
  const service = new PricingService(client, dir), reviews = new PricingReviewService(client, dir);
  const rule = ruleSchema.parse({ id: 'one_run', name: 'Reviewed price sheet', status: 'proposed', evidence: 'Fixture source document', family_ids: ['family'],
    target_attribute: 'supplier_1_cost', source_column: 'PerFoot', currency: 'USD', currency_column: 'Currency', unit: 'full rod', unit_column: 'Unit',
    operations: [{ op: 'multiply', operand: '10' }], maximum: '1000', max_change_percent: 50,
    associations: [{ kind: 'supplier', column: 'Supplier', attribute: 'supplier_1_name' }], review_attributes: ['raw_material_length', 'material_id'] });
  const imported = await service.importDocument({ source_name: 'fixture.pdf', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: owners.slice(0,count).map((p,i) => ({
    source_ref: `row ${i+1}`, values: { SKU: p.sku!, PerFoot: String((11+i)/10), Currency: 'USD', Unit: 'full rod', Supplier: 'Supplier A' },
  })) });
  const plan = await service.plan({ import_id: imported.import_id, batch_rules: [rule], mappings: owners.slice(0,count).map((p,i) => ({ row_index: i, product_id: p.id, family_id: 'family' })) });
  expect(plan.blocked).toEqual([]);
  const review = await reviews.create({ plan_ids: [plan.plan_id] });
  const selected = await reviews.update({ review_id: review.review_id, expected_revision: review.revision, decisions: review.lines.map(l => ({ line_id: l.line_id, status: 'selected' })) });
  const prepare = (transport: 'auto' | 'bulk' | 'patch' = 'auto') => reviews.plan({ review_id: selected.review_id, expected_revision: selected.revision, transport });
  return { client, service, reviews, records, owners, children, search, read, patch, submit, poll, selected, prepare, set, plan, rule, imported };
}

describe('streamlined reviewed pricing batches', () => {
  it('posts 38 owners in one bulk job and validates 295 records in three final pages', async () => {
    const f = await fixture(38, 4), prepared = await f.prepare();
    expect(prepared.approval!.arguments.changes).toHaveLength(38);
    f.search.mockClear(); f.read.mockClear();
    const result = await f.reviews.apply(prepared.approval!.arguments);
    expect(result.state).toBe('complete');
    expect(result.batch.metrics).toMatchObject({ preflight_searches: 3, validation_searches: 3, bulk_attempts: 1, patch_attempts: 0 });
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.submit.mock.calls[0][0]).toHaveLength(38);
    expect(f.patch).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.search).toHaveBeenCalledTimes(6);
    expect(result.review.counts.verified).toBe(38);
    expect(f.children.filter(c => c.overwritten_attributes!.length).every(c => c.attributes!.supplier_1_cost === 77)).toBe(true);
    expect(f.owners.slice(38).every(p => p.attributes!.supplier_1_cost === null && p.attributes!.primary_supplier === 'Supplier 2')).toBe(true);
    expect((await f.service.rulesGet()).rules).toEqual([]);
  });

  it('falls back only after a definitive unsupported bulk response, with no per-row reads', async () => {
    const f = await fixture(), p = await f.prepare();
    f.submit.mockRejectedValue(new PlytixError('Bulk unavailable', 405)); f.read.mockClear(); f.search.mockClear();
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('complete'); expect(result.batch.used_transport).toBe('patch');
    expect(f.patch.mock.calls.map(c => c[0])).toEqual(['owner-0', 'owner-1']);
    expect(f.read).not.toHaveBeenCalled(); expect(f.search).toHaveBeenCalledTimes(2);
  });

  it('supports an explicit PATCH transport and binds that choice to approval', async () => {
    const f = await fixture(), p = await f.prepare('patch');
    await expect(f.reviews.apply({ ...p.approval!.arguments, transport: 'bulk' })).rejects.toThrow(/altered/);
    expect((await f.reviews.apply(p.approval!.arguments)).state).toBe('complete'); expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { ok: '0', error: '0', cancelled: '0' }])('settles Finished with empty counters %j only after full readback', async summary => {
    const f = await fixture(), p = await f.prepare();
    f.poll.mockResolvedValue({ status: 'Finished', summary, errors: [], products: [] });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('complete');
    expect(result.batch.bulk).toMatchObject({ settled: true, completion_evidence: 'verified_readback' });
    expect(result.review.counts.verified).toBe(2);
    expect(result.batch.metrics.validation_searches).toBe(1);
    expect(f.children.filter(c => c.overwritten_attributes!.length).every(c => c.attributes!.supplier_1_cost === 77)).toBe(true);
    await f.reviews.refresh(p.review.review_id);
    await f.reviews.apply(p.approval!.arguments);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it('recovers an existing submitted job with empty counters through read-only refresh', async () => {
    const f = await fixture(), p = await f.prepare();
    f.poll.mockResolvedValueOnce({ status: 'Queued', summary: { ok: '0', error: '0' } });
    const pending = await f.reviews.apply(p.approval!.arguments);
    expect(pending.state).toBe('pending'); expect(pending.review.counts.submitted).toBe(2);
    f.poll.mockResolvedValue({ status: 'Finished', summary: { ok: '0', error: '0' } });
    expect((await f.reviews.refresh(p.review.review_id)).counts.verified).toBe(2);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it('keeps empty-counter jobs pending until delayed owner and child values match', async () => {
    const f = await fixture(), p = await f.prepare();
    f.submit.mockImplementation(async rows => { f.set(rows[0].id, rows[0].data.attributes); return 'job-1'; });
    f.poll.mockResolvedValue({ status: 'Finished', summary: {} });
    const pending = await f.reviews.apply(p.approval!.arguments);
    expect(pending.state).toBe('pending'); expect(pending.batch.bulk?.settled).toBe(false);
    expect(pending.review.lines.map(l => l.execution?.status)).toEqual(['verified', 'validation_pending']);
    f.set('owner-1', { supplier_1_cost: 12 });
    const refreshed = await f.reviews.refresh(p.review.review_id);
    expect(refreshed.counts.verified).toBe(2); expect(refreshed.batches[0].state).toBe('complete');
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it.each(['primary_supplier', 'override', 'unapproved'])('does not settle an empty-counter job with a preserved %s mismatch', async field => {
    const f = await fixture(2, 1), p = await f.prepare(), submit = f.submit.getMockImplementation()!;
    f.poll.mockResolvedValue({ status: 'Finished' });
    f.submit.mockImplementation(async rows => {
      const id = await submit(rows);
      if (field === 'primary_supplier') f.owners[0].attributes!.primary_supplier = 'Supplier 2';
      if (field === 'override') f.children[5].attributes!.supplier_1_cost = 999;
      if (field === 'unapproved') f.owners[2].attributes!.supplier_2_cost = 999;
      return id;
    });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).not.toBe('complete'); expect(result.batch.bulk?.settled).toBe(false);
    await f.reviews.refresh(p.review.review_id);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'Running', summary: {} },
    { status: 'Finished', summary: { ok: '1', error: '0' } },
    { status: 'Finished', summary: {}, errors: [{ id: 'unknown-product' }] },
    { status: 'Finished', summary: {}, errors: { message: 'unrecognized error shape' } },
    { status: 'Failed', summary: {} },
    { status: 'Cancelled', summary: {} },
    { status: 'Finished', summary: { ok: 'invalid' } },
  ])('does not treat incomplete or erroneous jobs as an empty successful result: %j', async job => {
    const f = await fixture(), p = await f.prepare(); f.poll.mockResolvedValue(job);
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).not.toBe('complete'); expect(result.batch.bulk?.completion_evidence).toBeUndefined();
    await f.reviews.refresh(p.review.review_id);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it('does not fall back or replay an ambiguous bulk submission', async () => {
    const f = await fixture(), p = await f.prepare(); f.submit.mockRejectedValue(new Error('private response body'));
    const stopped = await f.reviews.apply(p.approval!.arguments);
    expect(stopped.state).toBe('stopped'); expect(stopped.review.counts.sending_or_unknown).toBe(2);
    expect(JSON.stringify(stopped)).not.toContain('private response body');
    await f.reviews.apply(p.approval!.arguments); await f.reviews.refresh(p.review.review_id);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it('records partial bulk failures by SKU and verifies successful rows', async () => {
    const f = await fixture(), p = await f.prepare();
    f.submit.mockImplementation(async rows => { f.set(rows[0].id, rows[0].data.attributes); return 'job-1'; });
    f.poll.mockResolvedValue({ status: 'Finished', summary: { ok: '1', error: '1' }, errors: [{ sku: 'OWNER-1', errors: [{ supplier_1_cost: 'private validation details' }] }] });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('stopped'); expect(result.review.lines.map(l => l.execution?.status)).toEqual(['verified','failed']);
    expect(JSON.stringify(result)).not.toContain('private validation details');
    f.search.mockClear(); f.poll.mockClear();
    await f.reviews.refresh(p.review.review_id);
    expect(f.search).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled();
  });

  it('continues polling delayed row errors after counters settle without resending anything', async () => {
    const f = await fixture(), p = await f.prepare();
    f.submit.mockImplementation(async rows => { f.set(rows[0].id, rows[0].data.attributes); return 'job-1'; });
    f.poll.mockResolvedValueOnce({ status: 'Finished', summary: { ok: '1', error: '1' } });
    const pending = await f.reviews.apply(p.approval!.arguments);
    expect(pending.batch.bulk?.unresolved_errors).toBe(1);
    expect(pending.review.lines.map(l => l.execution?.status)).toEqual(['verified', 'validation_pending']);
    f.poll.mockResolvedValue({ status: 'Finished', summary: { ok: '1', error: '1' }, errors: [{ id: 'owner-1' }] });
    const refreshed = await f.reviews.refresh(p.review.review_id);
    expect(refreshed.lines.map(l => l.execution?.status)).toEqual(['verified', 'failed']);
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.patch).not.toHaveBeenCalled();
  });

  it('combines approved attributes into one PATCH per owner', async () => {
    const f = await fixture();
    const rule2 = { ...f.rule, id: 'second_cost', target_attribute: 'supplier_2_cost', associations: [], operations: [{ op: 'multiply' as const, operand: '20' }] };
    const plan = await f.service.plan({ ...f.plan.input, batch_rules: [f.rule, rule2] });
    expect(plan.blocked).toEqual([]);
    const review = await f.reviews.create({ plan_ids: [plan.plan_id] });
    const selected = await f.reviews.update({ review_id: review.review_id, expected_revision: review.revision, decisions: review.lines.map(l => ({ line_id: l.line_id, status: 'selected' })) });
    const prepared = await f.reviews.plan({ review_id: review.review_id, expected_revision: selected.revision, transport: 'patch' });
    const result = await f.reviews.apply(prepared.approval!.arguments);
    expect(result.state).toBe('complete'); expect(result.review.counts.verified).toBe(4);
    expect(f.patch).toHaveBeenCalledTimes(2);
    expect(f.patch.mock.calls[0]).toEqual(['owner-0', { attributes: { supplier_1_cost: 11, supplier_2_cost: 22 } }]);
    expect(f.children[5].attributes).toMatchObject({ supplier_1_cost: 77, supplier_2_cost: 22 });
  });

  it('holds an additional unreviewed material owner instead of adding writes to approval', async () => {
    const f = await fixture(1,1);
    for (const p of f.records.filter(p => p.id === 'owner-1' || p._parent_id === 'owner-1')) Object.assign(p.attributes!, {
      material_id: 'MATERIAL-0', color_name: 'Natural', grade: 'virgin',
    });
    const prepared = await f.prepare();
    expect(prepared.approval).toBeUndefined();
    expect(prepared.review.lines[0].reason).toContain('additional unapproved');
    expect(f.submit).not.toHaveBeenCalled(); expect(f.patch).not.toHaveBeenCalled();
  });

  it('uses an MPN fallback with supplier, material identity and raw dimensions in the group', () => {
    const rule = { target_attribute: 'supplier_1_cost', associations: [], currency: 'USD', unit: 'full rod' };
    const base: PlytixProduct = { id: 'p', product_family_id: 'f', attributes: { supplier_1_name: 'Supplier A', supplier_1_mpn: 'RD100', color_name: 'Natural', raw_material_length: 120 } };
    const group = materialGroup(base, rule)!;
    expect(group.identifier_attribute).toBe('supplier_1_mpn');
    for (const changed of [{ raw_material_length: 144 }, { color_name: 'Reprocessed' }, { supplier_1_name: 'Supplier B' }]) {
      expect(materialGroup({ ...base, attributes: { ...base.attributes, ...changed } }, rule)!.key).not.toBe(group.key);
    }
    expect(materialGroup({ ...base, attributes: { ...base.attributes, material_id: 'M1' } }, rule)!.identifier_attribute).toBe('material_id');
  });

  it('holds only changed groups and preserves primary suppliers in final validation', async () => {
    const f = await fixture(), p = await f.prepare(); f.owners[0].attributes!.raw_material_length = 144;
    f.poll.mockResolvedValue({ status: 'Finished', summary: { ok: '1', error: '0' } });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.review.lines.map(l => l.execution?.status)).toEqual(['conflict','verified']);
    expect(f.submit.mock.calls[0][0].map(r => r.id)).toEqual(['owner-1']);
  });

  it('keeps conflicting material-group prices out of the approval manifest', async () => {
    const f = await fixture();
    for (const p of f.records.filter(p => p.id === 'owner-1' || p._parent_id === 'owner-1')) Object.assign(p.attributes!, {
      material_id: 'MATERIAL-0', color_name: 'Natural', grade: 'virgin',
    });
    const result = await f.prepare();
    expect(result.approval).toBeUndefined(); expect(result.review.lines.every(l => l.status === 'blocked')).toBe(true);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('keeps same-MPN natural and reprocessed materials in separate cost groups', async () => {
    const f = await fixture(), p = await f.prepare();
    expect(p.approval!.arguments.changes[0].material_group!.key).not.toBe(p.approval!.arguments.changes[1].material_group!.key);
    expect((await f.reviews.apply(p.approval!.arguments)).state).toBe('complete');
    expect(f.owners.map(p => p.attributes!.supplier_1_cost)).toEqual([11,12]);
  });

  it('approves all material owners together and holds an unselected owner before requesting approval', async () => {
    const f = await fixture();
    for (const p of f.records.filter(p => p.id === 'owner-1' || p._parent_id === 'owner-1')) Object.assign(p.attributes!, { material_id: 'MATERIAL-0', color_name: 'Natural', grade: 'virgin' });
    const revised = await f.reviews.update({ review_id: f.selected.review_id, expected_revision: f.selected.revision,
      decisions: f.selected.lines.map(l => ({ line_id: l.line_id, status: 'needs_revision', proposed_value: '12', note: 'Reviewed common full-rod cost' })) });
    const refreshed = await f.reviews.plan({ review_id: revised.review_id, expected_revision: revised.revision, line_ids: revised.lines.map(l => l.line_id) });
    const selected = await f.reviews.update({ review_id: revised.review_id, expected_revision: refreshed.review.revision,
      decisions: refreshed.review.lines.map(l => ({ line_id: l.line_id, status: 'selected' })) });
    const together = await f.reviews.plan({ review_id: selected.review_id, expected_revision: selected.revision });
    expect(together.approval!.arguments.changes).toHaveLength(2);
    const pending = await f.reviews.update({ review_id: selected.review_id, expected_revision: together.review.revision,
      decisions: [{ line_id: selected.lines[0].line_id, status: 'pending' }] });
    const partial = await f.reviews.plan({ review_id: pending.review_id, expected_revision: pending.revision, line_ids: pending.lines.map(l => l.line_id) });
    expect(partial.approval).toBeUndefined(); expect(partial.review.lines[1].reason).toContain('additional unapproved');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('resumes only unsent PATCH rows under the same manifest after a bounded execution', async () => {
    const f = await fixture(), p = await f.prepare('patch');
    vi.mocked(f.client.remainingOperationTimeMs).mockImplementation(() => f.patch.mock.calls.length ? 2000 : 60_000);
    const first = await f.reviews.apply(p.approval!.arguments);
    expect(first.state).toBe('pending'); expect(first.review.lines.map(l => l.execution?.status)).toEqual(['verified','queued']);
    await f.reviews.refresh(p.review.review_id); expect(f.patch).toHaveBeenCalledTimes(1);
    vi.mocked(f.client.remainingOperationTimeMs).mockReturnValue(60_000);
    expect((await f.reviews.apply(p.approval!.arguments)).state).toBe('complete');
    expect(f.patch.mock.calls.map(c => c[0])).toEqual(['owner-0','owner-1']);
  });

  it('backs off only on an actual 429 and retains Retry-After across continuations', async () => {
    const f = await fixture(), p = await f.prepare('patch');
    const error = new PlytixError('Rate limited', 429); error.retryAfterMs = 60_000;
    f.patch.mockRejectedValueOnce(error);
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('pending'); expect(result.batch.retry_at).toBeGreaterThan(Date.now());
    await f.reviews.apply(p.approval!.arguments); expect(f.patch).toHaveBeenCalledTimes(1);
  });

  it('does not repost a submitted owner when descendant propagation needs another validation', async () => {
    const f = await fixture(), p = await f.prepare('patch');
    f.patch.mockImplementation(async (id, data) => { Object.assign(f.owners.find(p => p.id === id)!.attributes!, data.attributes); return { data: [] }; });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('pending'); expect(result.review.counts.validation_pending).toBe(2);
    f.owners.forEach(p => f.set(p.id, { supplier_1_cost: p.attributes!.supplier_1_cost }));
    expect((await f.reviews.refresh(p.review.review_id)).counts.verified).toBe(2);
    expect(f.patch).toHaveBeenCalledTimes(2);
  });

  it('reports unexpected primary supplier and excluded-product changes without fixing them', async () => {
    const f = await fixture(1,1), p = await f.prepare();
    const submit = f.submit.getMockImplementation()!;
    f.submit.mockImplementation(async rows => { const id = await submit(rows); f.owners[0].attributes!.primary_supplier = 'Supplier 2'; f.owners[1].attributes!.supplier_2_cost = 999; return id; });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('stopped'); expect(result.review.lines[0].execution?.status).toBe('validation_pending');
    expect(result.batch.errors.length).toBeGreaterThan(0); expect(f.patch).not.toHaveBeenCalled();
  });

  it('detects inheritance configuration changes during final validation', async () => {
    const f = await fixture(), p = await f.prepare();
    const submit = f.submit.getMockImplementation()!, family = vi.mocked(f.client.getFamilyAllAttributes).getMockImplementation()!;
    f.submit.mockImplementation(async rows => {
      const job = await submit(rows);
      vi.mocked(f.client.getFamilyAllAttributes).mockImplementation(async id => {
        const result = structuredClone(await family(id)); result.data.find(a => a.label === 'supplier_1_cost')!.attribute_level = 'parent_level'; return result;
      });
      return job;
    });
    const result = await f.reviews.apply(p.approval!.arguments);
    expect(result.state).toBe('stopped'); expect(result.review.counts.validation_pending).toBe(2);
    expect(result.batch.errors.join(' ')).toContain('inheritance');
    vi.mocked(f.client.getFamilyAllAttributes).mockImplementation(family);
    expect((await f.reviews.refresh(p.review.review_id)).counts.verified).toBe(2);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it('permits bulk mutation only through the reviewed-pricing write route', () => {
    expect(isWriteRequestForTool('pricing_review_apply','/api/v1/bulk/products','POST')).toBe(true);
    for (const tool of ['pricing_review_refresh','products_update','pricing_apply']) expect(isWriteRequestForTool(tool,'/api/v1/bulk/products','POST')).toBe(false);
    expect(isWriteRequestForTool('pricing_review_apply','/api/v1/bulk/products','DELETE')).toBe(false);
  });
});
