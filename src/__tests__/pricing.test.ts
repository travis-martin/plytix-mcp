import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { createHttpApp } from '../http.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { PricingService } from '../pricing/service.js';
import { ruleSchema } from '../pricing/model.js';
import { calculate, parseCsv, withinChangeLimit } from '../pricing/calculate.js';
import type { PlytixProduct } from '../types.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const rule = ruleSchema.parse({ id: 'supplier_cost', name: 'Supplier cost', status: 'confirmed', evidence: 'Reviewed supplier document page 1', family_ids: ['f'], target_attribute: 'cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency', unit: 'each', unit_column: 'Unit', operations: [{ op: 'multiply', operand: '0.9' }], maximum: '1000', max_change_percent: 50, review_attributes: ['brand'], associations: [{ kind: 'brand', column: 'Brand', attribute: 'brand', aliases: [{ from: 'ACME Co', to: 'Acme' }] }] });
const rows = [{ source_ref: 'page 1 row 2', values: { SKU: 'ABC', Price: '12.50', Currency: 'USD', Unit: 'each', Brand: 'ACME Co' } }];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pricing-')); dirs.push(dir);
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_apply', 'pricing_rules_save']) });
  const product = { id: 'p', sku: 'ABC', product_family_id: 'f', product_type: 'STANDALONE' as const, num_variations: 0, attributes: { cost: 10, brand: 'Acme' } };
  vi.spyOn(api, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(api, 'searchProducts').mockImplementation(async () => ({ data: [structuredClone(product)] }));
  vi.spyOn(api, 'getProduct').mockImplementation(async () => ({ data: [structuredClone(product)] }));
  vi.spyOn(api, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Family' }] });
  const family = vi.spyOn(api, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: 'parent_level' }] });
  vi.spyOn(api, 'getAttributeById').mockResolvedValue({ id: 'a', label: 'cost', name: 'Cost', type_class: 'DecimalAttribute' });
  const update = vi.spyOn(api, 'updateProduct').mockImplementation(async (_id, patch) => { product.attributes.cost = patch.attributes!.cost as number; return { data: [structuredClone(product)] }; });
  const service = new PricingService(api, dir);
  await service.rulesSave({ expected_revision: 0, rules: [rule] });
  const imported = await service.importDocument({ source_name: 'supplier.pdf', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows });
  const input = { import_id: imported.import_id, rule_ids: ['supplier_cost'], mappings: [{ row_index: 0, product_id: 'p', family_id: 'f' }] };
  return { service, api, dir, product, update, family, imported, input };
}

async function containerFixture(childCount = 2) {
  const f = await fixture();
  Object.assign(f.product, { product_type: 'VARIANT', _parent_id: 'root', num_variations: childCount, overwritten_attributes: [] });
  const root: PlytixProduct = { id: 'root', sku: 'ROOT', product_type: 'PARENT', product_family_id: 'f', num_variations: childCount + 1 };
  const children: PlytixProduct[] = Array.from({ length: childCount }, (_, index) => ({
    id: `c${index + 1}`, sku: `CHILD-${index + 1}`, product_type: 'SUB_VARIANT', _parent_id: 'p',
    product_family_id: 'f', num_variations: 0, overwritten_attributes: index === childCount - 1 && childCount > 1 ? ['a'] : [],
    attributes: { cost: index === childCount - 1 && childCount > 1 ? 12 : 10, brand: 'Acme' },
  }));
  f.family.mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: 'variant_level' }] });
  const listing = vi.spyOn(f.api, 'getProductVariants').mockResolvedValue({ data: children, pagination: { page: 1, page_size: 10, pages: 1, total: childCount, count: childCount } });
  vi.mocked(f.api.getProduct).mockImplementation(async id => {
    const record = id === 'p' ? f.product : id === 'root' ? root : children.find(child => child.id === id);
    return { data: record ? [structuredClone(record)] : [] };
  });
  f.update.mockImplementation(async (_id, patch) => {
    f.product.attributes.cost = patch.attributes!.cost as number;
    for (const child of children) if (!child.overwritten_attributes!.some(marker => ['cost', 'a'].includes(marker.replace(/^attributes\./, '')))) child.attributes!.cost = f.product.attributes.cost;
    return { data: [structuredClone(f.product)] };
  });
  return { ...f, root, children, listing };
}

describe('pricing calculations and source parsing', () => {
  it('calculates exact decimal half-up rounding and rejects ambiguous numbers', () => {
    expect(calculate({ ...rule, operations: [] }, { source_ref: '1', values: { Price: '1.005' } })).toBe(1.01);
    expect(calculate(rule, rows[0])).toBe(11.25);
    expect(() => calculate(rule, { source_ref: '1', values: { Price: '1,000' } })).toThrow('plain decimal');
    expect(() => calculate({ ...rule, operations: [{ op: 'divide', operand: '0' }] }, rows[0])).toThrow('zero');
    expect(withinChangeLimit(0.3, 0.33, 10)).toBe(true);
    expect(withinChangeLimit(0.3, 0.330001, 10)).toBe(false);
  });
  it('parses quoted CSV, rejects duplicate headers and malformed records', () => {
    expect(parseCsv('SKU,Label\r\nABC,"A, B"\r\n')[0].values.Label).toBe('A, B');
    expect(() => parseCsv('SKU,SKU\nA,B')).toThrow('unique');
    expect(() => parseCsv('SKU,Price\nA')).toThrow('column count');
    expect(() => parseCsv('SKU\n"A')).toThrow('quote');
  });
});

describe('pricing workflow', () => {
  it.each(['preview', 'readback'])('drains every parallel child read after a %s failure', async phase => {
    const f = await containerFixture();
    const plan = await f.service.plan(f.input);
    const read = vi.mocked(f.api.getProduct).getMockImplementation()!;
    let sent = false, active = 0, completed = 0;
    const update = f.update.getMockImplementation()!;
    f.update.mockImplementation(async (...args) => { sent = true; return update(...args); });
    vi.mocked(f.api.getProduct).mockImplementation(async id => {
      if (!/^c[12]$/.test(id) || (phase === 'readback' && !sent)) return read(id);
      active++;
      try {
        if (id === 'c1') throw new Error('Private upstream failure');
        await new Promise(resolve => setTimeout(resolve, 5));
        return await read(id);
      } finally { active--; completed++; }
    });
    if (phase === 'preview') {
      const blocked = await f.service.plan(f.input);
      expect(blocked.blocked[0].reason).toMatch(/descendant reads/i);
      expect(f.update).not.toHaveBeenCalled();
    } else {
      const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
      expect(result.state).toBe('stopped');
      expect(result.results[0].status).toBe('sending_or_unknown');
      expect(f.update).toHaveBeenCalledTimes(1);
    }
    expect(active).toBe(0);
    expect(completed).toBe(2);
  });
  it.each([
    ['product_type', 'PARENT'], ['_parent_id', 'different-root'], ['overwritten_attributes', ['cost']],
  ])('stops when the container owner %s changes during execution', async (field, value) => {
    const f = await containerFixture();
    const plan = await f.service.plan(f.input);
    const update = f.update.getMockImplementation()!;
    f.update.mockImplementation(async (...args) => {
      const result = await update(...args);
      Object.assign(f.product, { [field as string]: value });
      return result;
    });
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped');
    expect(result.results[0].status).toBe('sending_or_unknown');
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('suggests families before planning; executes once with verified readback and saved audit', async () => {
    const f = await fixture();
    expect(f.imported.family_suggestions).toEqual([{ family_id: 'f', name: 'Family', matched_rows: [0] }]);
    expect(f.update).not.toHaveBeenCalled();
    const plan = await f.service.plan(f.input);
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ old_value: 10, new_value: 11.25, inheritance_level: 'parent_level' });
    expect(plan.changes[0].review_evidence).toEqual({ brand: 'Acme' });
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('complete'); expect(result.results[0].status).toBe('verified');
    await expect(f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes })).rejects.toThrow('consumed');
    expect(f.update).toHaveBeenCalledTimes(1);
    expect((await f.service.planGet(plan.plan_id)).results[0].status).toBe('verified');
    const files = await readdir(join(f.dir, f.api.knowledgeFingerprint()));
    expect(files).toContain('rules-revision-1.json');
  });
  it('blocks ambiguous mapping, duplicate targets, unknown inheritance and unsafe descendants', async () => {
    const f = await fixture();
    expect((await f.service.plan({ ...f.input, mappings: [{ row_index: 0, product_id: 'p', family_id: 'wrong' }] })).blocked).toHaveLength(1);
    expect((await f.service.plan({ ...f.input, mappings: [...f.input.mappings, ...f.input.mappings] })).blocked[0].reason).toContain('Duplicate');
    f.product.num_variations = 1;
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('descendant');
    f.product.num_variations = 0; f.family.mockResolvedValue({ data: [] });
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('inheritance');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('blocks inherited variant overrides, changed old values, and rule revisions after preview', async () => {
    const f = await fixture();
    const plan = await f.service.plan(f.input);
    f.product.attributes.cost = 12;
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped'); expect(f.update).not.toHaveBeenCalled();
    const next = await f.service.plan(f.input);
    await f.service.rulesSave({ expected_revision: 1, rules: [{ ...rule, name: 'Revised' }] });
    expect((await f.service.apply({ plan_id: next.plan_id, digest: next.digest, changes: next.changes })).state).toBe('stopped');
    Object.assign(f.product, { product_type: 'VARIANT', _parent_id: 'parent' });
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('Parent-level');
  });
  it('rejects altered approval payloads and stops after ambiguous mutation without retry', async () => {
    const f = await fixture();
    const plan = await f.service.plan(f.input);
    await expect(f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: [{ ...plan.changes[0], new_value: 11 }] })).rejects.toThrow('altered');
    f.update.mockRejectedValue(new Error('Network failure with private body'));
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped'); expect(result.results[0].status).toBe('sending_or_unknown');
    expect(JSON.stringify(result)).not.toContain('private body'); expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('keeps rules isolated by credential and refuses unconfirmed rules', async () => {
    const f = await fixture();
    const other = new PlytixClient({ apiKey: 'other', apiPassword: 'other' });
    vi.spyOn(other, 'verifyKnowledgeAccess').mockResolvedValue();
    expect((await new PricingService(other, f.dir).rulesGet()).rules).toEqual([]);
    await f.service.rulesSave({ expected_revision: 1, rules: [{ ...rule, status: 'proposed' }] });
    await expect(f.service.plan(f.input)).rejects.toThrow('confirmed');
    await expect(f.service.rulesSave({ expected_revision: 1, rules: [] })).rejects.toThrow('revision');
  });
  it('refuses mismatched brand and excessive changes', async () => {
    const f = await fixture();
    f.product.attributes.brand = 'Different';
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('association');
    f.product.attributes.brand = 'Acme'; f.product.attributes.cost = 1;
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('change limit');
  });
  it('requires host approval for rules and execution, and hides both by default', async () => {
    const f = await fixture(); vi.stubEnv('PLYTIX_PRICING_DIR', f.dir);
    for (const writes of [new Set<string>(), new Set(['pricing_apply', 'pricing_rules_save'])]) {
      const server = createServer(f.api, writes);
      const client = new Client({ name: 'pricing-policy', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
      try {
        const names = (await client.listTools()).tools.map(t => t.name);
        expect(names.includes('pricing_apply')).toBe(writes.size > 0);
        if (writes.size) {
          const result = await client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 1, rules: [] } });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain('approval');
          expect((await f.service.rulesGet()).revision).toBe(1);
        }
      } finally { await client.close(); await server.close(); }
    }
  });
  it('validates the submitted CSV hash before storing a document', async () => {
    const f = await fixture();
    const csv = 'SKU,Price,Currency,Unit,Brand\nABC,12.50,USD,each,Acme';
    await expect(f.service.importDocument({ source_name: 'prices.csv', source_sha256: '0'.repeat(64), sku_column: 'SKU', csv })).rejects.toThrow('hash');
    const imported = await f.service.importDocument({ source_name: 'prices.csv', source_sha256: createHash('sha256').update(csv).digest('hex'), sku_column: 'SKU', csv });
    expect(imported.matches[0].sku).toBe('ABC');
  });
  it('previews and verifies bounded parent propagation while preserving explicit overrides', async () => {
    const f = await fixture();
    Object.assign(f.product, { product_type: 'PARENT', num_variations: 2 });
    const children = [
      { ...structuredClone(f.product), id: 'c1', sku: 'CHILD-1', product_type: 'VARIANT' as const, _parent_id: 'p', num_variations: 0, overwritten_attributes: [] },
      { ...structuredClone(f.product), id: 'c2', sku: 'CHILD-2', product_type: 'VARIANT' as const, _parent_id: 'p', num_variations: 0, overwritten_attributes: ['attributes.cost'], attributes: { cost: 12, brand: 'Acme' } },
    ];
    vi.spyOn(f.api, 'getProductVariants').mockResolvedValue({ data: children, pagination: { page: 1, page_size: 10, pages: 1, total: 2 } });
    vi.mocked(f.api.getProduct).mockImplementation(async id => ({ data: [structuredClone(id === 'p' ? f.product : children.find(c => c.id === id)!)] }));
    f.update.mockImplementation(async (_id, patch) => {
      f.product.attributes.cost = patch.attributes!.cost as number;
      children[0].attributes.cost = f.product.attributes.cost;
      return { data: [structuredClone(f.product)] };
    });
    const plan = await f.service.plan(f.input);
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0].descendant_impact).toMatchObject([
      { product_id: 'c1', old_value: 10, new_value: 11.25, overridden: false, review_evidence: { brand: 'Acme' } },
      { product_id: 'c2', old_value: 12, new_value: 12, overridden: true },
    ]);
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('complete'); expect(children[1].attributes.cost).toBe(12);
  });
  it('blocks incomplete descendant listings and changed override markers', async () => {
    const f = await fixture(); Object.assign(f.product, { product_type: 'PARENT', num_variations: 1 });
    const child = { ...structuredClone(f.product), id: 'c', sku: 'CHILD', product_type: 'VARIANT' as const, _parent_id: 'p', num_variations: 0, overwritten_attributes: [] as string[] };
    const list = vi.spyOn(f.api, 'getProductVariants').mockResolvedValue({ data: [], pagination: { page: 1, page_size: 10, pages: 2 } });
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('listing');
    list.mockResolvedValue({ data: [child] });
    vi.mocked(f.api.getProduct).mockImplementation(async id => ({ data: [structuredClone(id === 'p' ? f.product : child)] }));
    const plan = await f.service.plan(f.input);
    child.overwritten_attributes = ['cost'];
    expect((await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes })).state).toBe('stopped');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('stops when parent readback succeeds but descendant propagation is not verified', async () => {
    const f = await fixture(); Object.assign(f.product, { product_type: 'PARENT', num_variations: 1 });
    const child = { ...structuredClone(f.product), id: 'c', sku: 'CHILD', product_type: 'VARIANT' as const, _parent_id: 'p', num_variations: 0, overwritten_attributes: [] };
    vi.spyOn(f.api, 'getProductVariants').mockResolvedValue({ data: [child] });
    vi.mocked(f.api.getProduct).mockImplementation(async id => ({ data: [structuredClone(id === 'p' ? f.product : child)] }));
    const plan = await f.service.plan(f.input);
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped'); expect(result.results[0].status).toBe('sending_or_unknown');
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('allows a direct variant-level numeric update without creating a parent override', async () => {
    const f = await fixture(); Object.assign(f.product, { product_type: 'VARIANT', _parent_id: 'parent' });
    f.family.mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: 'variant_level' }] });
    vi.mocked(f.api.getProduct).mockImplementation(async id => ({ data: [id === 'parent'
      ? { id: 'parent', product_type: 'PARENT', product_family_id: 'f' }
      : structuredClone(f.product)] }));
    const plan = await f.service.plan(f.input);
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0].descendant_impact).toEqual([]);
  });
  it('updates the configured Level 2 container once and verifies ten leaf subvariants while preserving ID-based overrides', async () => {
    const f = await containerFixture(10);
    const plan = await f.service.plan(f.input);
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ product_id: 'p', inheritance_level: 'variant_level', old_value: 10, new_value: 11.25 });
    expect(plan.changes[0].descendant_impact).toHaveLength(10);
    expect(plan.changes[0].descendant_impact.find(child => child.product_id === 'c10')).toMatchObject({ old_value: 12, new_value: 12, overridden: true });
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('complete');
    expect(result.results).toEqual([{ product_id: 'p', attribute: 'cost', status: 'verified' }]);
    expect(f.update).toHaveBeenCalledExactlyOnceWith('p', { attributes: { cost: 11.25 } });
    expect(f.children.slice(0, 9).every(child => child.attributes!.cost === 11.25)).toBe(true);
    expect(f.children[9].attributes!.cost).toBe(12);
    expect(f.children[9].overwritten_attributes).toEqual(['a']);
  });
  it.each([
    ['root type', (f: Awaited<ReturnType<typeof containerFixture>>) => { f.root.product_type = 'VARIANT'; }],
    ['root parent', (f: Awaited<ReturnType<typeof containerFixture>>) => { f.root._parent_id = 'another-root'; }],
    ['root family', (f: Awaited<ReturnType<typeof containerFixture>>) => { f.root.product_family_id = 'other-family'; }],
  ])('blocks container updates when the %s does not establish Level 2 ownership', async (_case, invalidate) => {
    const f = await containerFixture(); invalidate(f);
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('verified root parent');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('blocks parent-level container writes instead of creating a lower-level override', async () => {
    const f = await containerFixture();
    f.family.mockResolvedValue({ data: [{ id: 'a', label: 'cost', name: 'Cost', attribute_level: 'parent_level' }] });
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('no override');
    expect(f.update).not.toHaveBeenCalled();
  });
  it.each([
    ['duplicate identities', (f: Awaited<ReturnType<typeof containerFixture>>) => f.listing.mockResolvedValue({ data: [f.children[0], f.children[0]] })],
    ['paged listing', (f: Awaited<ReturnType<typeof containerFixture>>) => f.listing.mockResolvedValue({ data: f.children, pagination: { page: 1, page_size: 2, pages: 2 } })],
    ['mismatched count', (f: Awaited<ReturnType<typeof containerFixture>>) => f.listing.mockResolvedValue({ data: f.children, pagination: { page: 1, page_size: 10, count: 3 } })],
    ['root listed as child', (f: Awaited<ReturnType<typeof containerFixture>>) => f.listing.mockResolvedValue({ data: [f.product, f.children[1]] })],
  ])('blocks a container with %s', async (_case, invalidate) => {
    const f = await containerFixture(); invalidate(f);
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('listing');
    expect(f.update).not.toHaveBeenCalled();
  });
  it.each([
    ['deeper descendants', (child: PlytixProduct) => { child.num_variations = 1; }],
    ['wrong level', (child: PlytixProduct) => { child.product_type = 'VARIANT'; }],
    ['different family', (child: PlytixProduct) => { child.product_family_id = 'other-family'; }],
    ['different parent', (child: PlytixProduct) => { child._parent_id = 'other-parent'; }],
    ['missing override evidence', (child: PlytixProduct) => { delete child.overwritten_attributes; }],
    ['malformed override evidence', (child: PlytixProduct) => { child.overwritten_attributes = [null as unknown as string]; }],
    ['missing SKU', (child: PlytixProduct) => { delete child.sku; }],
  ])('blocks container children with %s', async (_case, invalidate) => {
    const f = await containerFixture(); invalidate(f.children[0]);
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('incomplete');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('does not accept the wrong product detail for a listed descendant identity', async () => {
    const f = await containerFixture();
    vi.mocked(f.api.getProduct).mockImplementation(async id => ({ data: [structuredClone(id === 'p' ? f.product : id === 'root' ? f.root : f.children[1])] }));
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('identity');
    expect(f.update).not.toHaveBeenCalled();
  });
  it('rejects more than ten children and inherited value disagreement', async () => {
    const f = await containerFixture(); f.product.num_variations = 11;
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('bounded');
    f.product.num_variations = 2; f.children[0].attributes!.cost = 9;
    expect((await f.service.plan(f.input)).blocked[0].reason).toContain('inheritance evidence');
    expect(f.update).not.toHaveBeenCalled();
  });
  it.each(['cost', 'override', 'ancestry'] as const)('stops a stale container plan after a %s change without writing', async change => {
    const f = await containerFixture(); const plan = await f.service.plan(f.input);
    if (change === 'cost') f.children[1].attributes!.cost = 13;
    if (change === 'override') f.children[0].overwritten_attributes = ['cost'];
    if (change === 'ancestry') f.root.product_family_id = 'other-family';
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped'); expect(f.update).not.toHaveBeenCalled();
    await expect(f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes })).rejects.toThrow('consumed');
  });
  it('keeps a container result uncertain if an override marker disappears despite matching numeric readback', async () => {
    const f = await containerFixture(); const plan = await f.service.plan(f.input);
    f.update.mockImplementation(async (_id, patch) => {
      f.product.attributes.cost = patch.attributes!.cost as number;
      f.children[0].attributes!.cost = f.product.attributes.cost;
      f.children[1].overwritten_attributes = [];
      return { data: [structuredClone(f.product)] };
    });
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped'); expect(result.results[0].status).toBe('sending_or_unknown');
    expect(f.update).toHaveBeenCalledTimes(1);
    await expect(f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes })).rejects.toThrow('consumed');
  });
  it('does not verify an update when a new descendant appears during execution', async () => {
    const f = await containerFixture(); const plan = await f.service.plan(f.input);
    f.update.mockImplementation(async (_id, patch) => {
      f.product.attributes.cost = patch.attributes!.cost as number;
      f.children[0].attributes!.cost = f.product.attributes.cost;
      f.children.push({ ...structuredClone(f.children[0]), id: 'new-child', sku: 'NEW-CHILD' });
      f.product.num_variations = 3;
      return { data: [structuredClone(f.product)] };
    });
    const result = await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes });
    expect(result.state).toBe('stopped'); expect(result.results[0].status).toBe('sending_or_unknown');
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('includes a noted manual amount and its source calculation in container approval and readback', async () => {
    const f = await containerFixture();
    const plan = await f.service.plan({ ...f.input, mappings: [{ ...f.input.mappings[0], proposed_value: '11.10', review_note: 'Reviewed one-off supplier adjustment' }] });
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ calculated_value: 11.25, new_value: 11.1, review_note: 'Reviewed one-off supplier adjustment' });
    expect(plan.changes[0].descendant_impact).toMatchObject([{ new_value: 11.1, overridden: false }, { new_value: 12, overridden: true }]);
    expect((await f.service.apply({ plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes })).state).toBe('complete');
    expect(f.update).toHaveBeenCalledExactlyOnceWith('p', { attributes: { cost: 11.1 } });
  });
  it.each([
    ['11.10', '', 'review note'],
    ['11.251', 'Adjustment', 'rounding precision'],
    ['1000.01', 'Adjustment', 'rule range'],
    ['16', 'Adjustment', 'change limit'],
  ])('blocks an unreviewable or unsafe manual amount %s', async (proposed_value, review_note, reason) => {
    const f = await containerFixture();
    const plan = await f.service.plan({ ...f.input, mappings: [{ ...f.input.mappings[0], proposed_value, ...(review_note ? { review_note } : {}) }] });
    expect(plan.blocked[0].reason).toContain(reason);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('HTTP isolates credential-bound rules and refuses writes without an approval provider', async () => {
    const f = await fixture(); vi.stubEnv('PLYTIX_PRICING_DIR', f.dir);
    vi.spyOn(PlytixClient.prototype, 'verifyKnowledgeAccess').mockResolvedValue();
    const save = vi.spyOn(PricingService.prototype, 'rulesSave');
    const token = 'fixture-service-token-at-least-thirty-two-characters';
    const listener = createHttpApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: [], authToken: token, writeTools: new Set(['pricing_apply', 'pricing_rules_save']) }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener.once('listening', resolve));
    const address = listener.address();
    const url = new URL(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`);
    try {
      for (const password of ['fixture', 'different']) {
        const client = new Client({ name: 'pricing-http', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'X-MCP-Token': token, 'X-Plytix-API-Key': 'fixture', 'X-Plytix-API-Password': password } } }));
        try {
          const rules = await client.callTool({ name: 'pricing_rules_get', arguments: {} });
          expect((rules.structuredContent as any).data.rules).toHaveLength(password === 'fixture' ? 1 : 0);
          const denied = await client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 1, rules: [] } });
          expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('approval');
        } finally { await client.close(); }
      }
      expect(save).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
  });
});
