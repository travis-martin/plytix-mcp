import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { PricingAuditService } from '../pricing/audit.js';
import { auditInput } from '../pricing/audit-model.js';
import { calculateWithTrace } from '../pricing/calculate.js';
import { applyInput, calculationTraceSchema, ruleSchema } from '../pricing/model.js';
import { storedPlan } from '../pricing/service.js';
import type { PricingStore } from '../pricing/store.js';
import type { PlytixProduct } from '../types.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  vi.spyOn(api, 'verifyKnowledgeAccess').mockResolvedValue();
  const product: PlytixProduct = { id: 'owner', sku: 'OWNER', product_family_id: 'f', product_type: 'PARENT', num_variations: 80,
    overwritten_attributes: [], attributes: { supplier_1_cost: 1.01, supplier_1_name: 'Example', width: 48, length: 96, gauge: 0.118, color: 'Clear' } };
  const productRead = vi.spyOn(api, 'getProduct').mockImplementation(async id => ({ data: id === product.id ? [structuredClone(product)] : [] }));
  const familyRead = vi.spyOn(api, 'getFamilyAllAttributes').mockResolvedValue({ data: [
    { id: 'cost', label: 'supplier_1_cost', name: 'Cost', attribute_level: 'parent_level' },
    ...['supplier_1_name', 'width', 'length', 'gauge', 'color'].map(label => ({ id: label, label, name: label, attribute_level: 'parent_level' as const })),
  ] });
  vi.spyOn(api, 'getAttributeById').mockResolvedValue({ id: 'cost', label: 'supplier_1_cost', name: 'Cost', type_class: 'DecimalAttribute' });
  const descendants = vi.spyOn(api, 'getProductVariants').mockRejectedValue(new Error('Descendants must not be read by audit'));
  const update = vi.spyOn(api, 'updateProduct').mockRejectedValue(new Error('Audit must not change products'));
  const read = vi.fn<PricingStore['read']>().mockResolvedValue(undefined);
  const create = vi.fn<PricingStore['create']>(), change = vi.fn<PricingStore['update']>();
  const store: PricingStore = { kind: 'file', read, create, update: change };
  const rule = ruleSchema.parse({ id: 'area', name: 'Reviewed area calculation', status: 'proposed', evidence: 'Synthetic source category and units',
    family_ids: ['f'], target_attribute: 'supplier_1_cost', source_column: 'Rate', currency: 'USD', currency_column: 'Currency',
    unit: 'full sheet', unit_column: 'Unit', operations: [], minimum: '0', maximum: '10000', max_change_percent: 10,
    full_item_cost: { price_basis: 'area', price_unit: 'ft2', price_unit_column: 'PriceUnit', dimensions: [
      { product_attribute: 'width', product_unit: 'in' }, { product_attribute: 'length', product_unit: 'in' },
    ] }, associations: [{ kind: 'supplier', attribute: 'supplier_1_name', column: 'Supplier' }],
    conditions: [{ source: 'product', field: 'gauge', operator: 'equals', values: ['0.118'] },
      { source: 'document', field: 'Gauge', operator: 'equals', values: ['0.118'] }],
  });
  const input = auditInput.parse({ source_name: 'synthetic.xlsx', source_sha256: 'a'.repeat(64), sku_column: 'SKU',
    rows: [{ source_ref: 'Sheet1!D12', values: { SKU: 'OWNER', Rate: '0.031406250000000001', Currency: 'USD', Unit: 'full sheet', PriceUnit: 'ft2', Supplier: 'Example', Gauge: '0.118' } }],
    rules: [rule], mappings: [{ row_index: 0, product_id: 'owner', family_id: 'f', rule_id: 'area' }],
  });
  return { api, product, productRead, familyRead, descendants, update, read, create, change, input, rule, service: new PricingAuditService(api, undefined, () => store) };
}

describe('proposal-only owner pricing audit', () => {
  it('compares a parent with 80 descendants without reads or writes beyond owner evidence', async () => {
    const f = fixture();
    const audit = await f.service.compare(f.input);
    expect(audit).toMatchObject({ kind: 'pricing_audit', learning_mode: 'proposal_only', persisted: false, executable: false,
      coverage: 'explicit_mapped_owners_only', descendant_impact: 'not_inspected', summary: { owners: 1, matched: 1, differences: 0, protected: 0, blocked: 0 } });
    expect(audit.comparisons[0]).toMatchObject({ current_value: 1.01, calculated_value: 1.01, difference: 0,
      source_rate: '0.031406250000000001', inheritance_level: 'parent_level', reported_descendant_count: 80,
      calculation_trace: { source_price: '0.031406250000000001', full_item_quantity: { numerator: '32', denominator: '1' } } });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('workflow.json');
    for (const mutation of [f.create, f.change, f.update, f.descendants]) expect(mutation).not.toHaveBeenCalled();
    expect(storedPlan.safeParse(audit).success).toBe(false);
    expect(applyInput.safeParse(audit).success).toBe(false);
  });

  it('checks Level 2 ancestry using current family configuration but never treats inherited leaves as owners', async () => {
    const f = fixture();
    Object.assign(f.product, { product_type: 'VARIANT', _parent_id: 'root', num_variations: 11 });
    f.productRead.mockImplementation(async id => ({ data: id === 'owner' ? [f.product] : id === 'root'
      ? [{ id: 'root', sku: 'ROOT', product_family_id: 'f', product_type: 'PARENT', num_variations: 12 }] : [] }));
    const family = await f.familyRead.getMockImplementation()!('f');
    family.data[0].attribute_level = 'variant_level'; f.familyRead.mockResolvedValue(family);
    expect((await f.service.compare(f.input)).comparisons[0]).toMatchObject({ status: 'matched', owner_ancestry: { parent_id: 'root' } });
    f.product.product_type = 'SUB_VARIANT';
    expect((await f.service.compare(f.input)).comparisons[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Level 2 owner') });
    f.product.product_type = 'VARIANT'; family.data[0].attribute_level = 'parent_level';
    expect((await f.service.compare(f.input)).comparisons[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('root owner') });
    expect(f.descendants).not.toHaveBeenCalled();
  });

  it('keeps owner exclusions visible and never proposes a protected correction', async () => {
    const f = fixture(); f.product.attributes!.supplier_1_cost = 1;
    f.read.mockResolvedValue({ version: 1, revision: 1, updated_at: '2026-01-01T00:00:00Z', instructions: [], history: [], exclusions: [{
      id: 'protected', title: 'Protected source', family_ids: ['f'], target_attributes: ['supplier_1_cost'], status: 'active',
      all: [{ attribute: 'color', operator: 'equals', values: ['Clear'] }], reason: 'Use the separately reviewed custom source', source_ref: 'Owner decision',
    }] });
    expect((await f.service.compare(f.input)).comparisons[0]).toMatchObject({ status: 'protected', calculated_value: 1.01, owner_protections: [{ id: 'protected' }] });
    delete f.product.attributes!.color;
    expect((await f.service.compare(f.input)).comparisons[0].owner_protections![0].reason).toContain('Cannot determine');
    expect(f.create).not.toHaveBeenCalled(); expect(f.change).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong supplier', (f: ReturnType<typeof fixture>) => { f.input.rows[0].values.Supplier = 'Other'; }, 'association'],
    ['wrong gauge', (f: ReturnType<typeof fixture>) => { f.input.rows[0].values.Gauge = '0.125'; }, 'restriction'],
    ['wrong currency', (f: ReturnType<typeof fixture>) => { f.input.rows[0].values.Currency = 'CAD'; }, 'currency'],
    ['wrong source unit', (f: ReturnType<typeof fixture>) => { f.input.rows[0].values.PriceUnit = 'item'; }, 'price unit'],
    ['missing dimensions', (f: ReturnType<typeof fixture>) => { delete f.product.attributes!.width; }, 'unavailable'],
    ['unavailable quote', (f: ReturnType<typeof fixture>) => { f.input.rows[0].values.Rate = 'X'; }, 'plain decimal'],
    ['excess source precision', (f: ReturnType<typeof fixture>) => { f.input.rows[0].values.Rate = '0.0314062500000000001'; }, 'plain decimal'],
  ])('blocks %s without inventing a price', async (_name, mutate, reason) => {
    const f = fixture(); mutate(f);
    expect((await f.service.compare(f.input)).comparisons[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining(reason) });
    expect(f.update).not.toHaveBeenCalled();
  });

  it('reports differences outside a change limit without implying execution readiness', async () => {
    const f = fixture(); f.product.attributes!.supplier_1_cost = 0.5;
    const result = await f.service.compare(f.input);
    expect(result.comparisons[0]).toMatchObject({ status: 'difference', calculated_value: 1.01, within_reviewed_change_limit: false });
    expect(result.executable).toBe(false);
  });

  it('rejects duplicate owner comparisons and unknown fields before any reads', async () => {
    const f = fixture(); f.input.mappings.push(f.input.mappings[0]);
    await expect(f.service.compare(f.input)).rejects.toThrow('each product/attribute owner once');
    expect(f.read).not.toHaveBeenCalled();
    expect(auditInput.safeParse({ ...f.input, learning_mode: 'automatic' }).success).toBe(false);
    expect(auditInput.safeParse({ ...f.input, proposed_value: '99' }).success).toBe(false);
  });

  it('exposes the read-only tool by default and leaves real storage empty after a complete audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pricing-owner-audit-'));
    vi.stubEnv('PLYTIX_PRICING_DIR', directory); vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', '');
    const f = fixture(), server = createServer(f.api);
    const client = new Client({ name: 'owner-audit-fixture', version: '1' });
    try {
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(right); await client.connect(left);
      const tools = (await client.listTools()).tools;
      expect(tools.find(tool => tool.name === 'pricing_audit')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.some(tool => tool.name === 'products_update')).toBe(false);
      const result = await client.callTool({ name: 'pricing_audit', arguments: f.input });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { persisted: false, executable: false, summary: { matched: 1 } } });
      expect(await readdir(directory)).toEqual([]);
      expect(f.descendants).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    } finally {
      await client.close(); await server.close(); vi.unstubAllEnvs();
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected audit fixture directory');
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('supplier source precision', () => {
  it('preserves long cached source decimals through the shared calculation trace, with unchanged output bounds', () => {
    const f = fixture();
    const result = calculateWithTrace(f.rule, f.input.rows[0], f.product);
    expect(result.value).toBe(1.01);
    expect(calculationTraceSchema.parse(result.trace).source_price).toBe('0.031406250000000001');
    expect(calculateWithTrace(f.rule, { ...f.input.rows[0], values: { ...f.input.rows[0].values, Rate: '0.031406' } }, f.product).value).toBe(1);
    expect(ruleSchema.safeParse({ ...f.rule, decimals: 7 }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...f.rule, operations: [{ op: 'multiply', operand: '0.1234567' }] }).success).toBe(false);
  });
});
