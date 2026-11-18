import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';
import { calculate, calculateWithTrace } from '../pricing/calculate.js';
import { ruleSchema, type PricingRule, type SourceRow } from '../pricing/model.js';
import { PricingService } from '../pricing/service.js';
import type { PricingStore } from '../pricing/store.js';
import type { PlytixProduct } from '../types.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const lengthRule = (): PricingRule => ruleSchema.parse({
  id: 'full_item', name: 'Current raw-item supplier cost', status: 'confirmed', evidence: 'Reviewed source price per foot and catalog length in inches',
  family_ids: ['f'], target_attribute: 'supplier_1_cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency',
  unit: 'full raw item', unit_column: 'OutputUnit', operations: [], maximum: '10000', max_change_percent: 1000,
  full_item_cost: { price_basis: 'length', price_unit: 'ft', price_unit_column: 'PriceUnit', dimensions: [
    { product_attribute: 'stock_length', product_unit_attribute: 'stock_unit', source: { value_column: 'SourceLength', unit_column: 'SourceLengthUnit' } },
  ] },
});
const sourceRow = (values: Record<string, string> = {}): SourceRow => ({ source_ref: 'page 1 row 1', values: {
  SKU: 'RAW', Price: '2', Currency: 'USD', OutputUnit: 'full raw item', PriceUnit: 'ft', ...values,
} });
const product = (attributes: Record<string, unknown> = {}): PlytixProduct => ({ id: 'p', sku: 'RAW', product_type: 'STANDALONE', product_family_id: 'f', num_variations: 0,
  attributes: { supplier_1_cost: 10, supplier_1_name: 'Supplier A', primary_supplier: 'Supplier 2', stock_length: 120, stock_unit: 'in', ...attributes } });

class Store implements PricingStore {
  readonly kind = 'gcs';
  values = new Map<string, unknown>();
  async read(key: string) { return structuredClone(this.values.get(key)); }
  async create(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    const next = change(parse(await this.read(key))); this.values.set(key, structuredClone(next)); return structuredClone(next);
  }
}

async function fixture() {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request in fixture'); }));
  const store = new Store(), client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  const current = product(), records = [current];
  vi.spyOn(client, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(client, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Fixture raw stock' }] });
  vi.spyOn(client, 'getProduct').mockImplementation(async id => ({ data: structuredClone(records.filter(p => p.id === id)) }));
  vi.spyOn(client, 'getProductVariants').mockImplementation(async id => ({ data: structuredClone(records.filter(p => p._parent_id === id)) }));
  const family = vi.spyOn(client, 'getFamilyAllAttributes').mockImplementation(async () => ({ data: Object.keys(current.attributes!).map(label => ({
    id: label, label, name: label, attribute_level: current.product_type === 'VARIANT' && label === 'supplier_1_cost' ? 'variant_level' : 'parent_level',
  })) }));
  vi.spyOn(client, 'getAttributeById').mockImplementation(async id => ({ id, label: id, name: id, type_class: 'DecimalAttribute' }));
  const search = vi.spyOn(client, 'searchProducts').mockImplementation(async input => {
    const matches = input.filters?.flat().some(f => f.field === 'product_family_id') ? records : [current];
    return { data: structuredClone(matches.map(record => ({ ...record, attributes: Object.fromEntries(Object.entries(record.attributes ?? {}).filter(([label]) =>
      !input.attributes || input.attributes.includes(`attributes.${label}`))) }))) };
  });
  const write = vi.spyOn(client, 'updateProduct').mockRejectedValue(new Error('No writes expected'));
  const service = new PricingService(client, undefined, () => store);
  const imported = await service.importDocument({ source_name: 'fixture.csv', source_sha256: 'a'.repeat(64), sku_column: 'SKU', rows: [sourceRow()] });
  const rule = lengthRule();
  await service.rulesSave({ expected_revision: 0, rules: [rule] });
  const input = { import_id: imported.import_id, rule_ids: [rule.id], mappings: [{ row_index: 0, product_id: 'p', family_id: 'f' }] };
  return { store, client, current, records, family, search, write, service, input, rule };
}

describe('reusable full-item cost calculations', () => {
  it('reuses the same rule for new current lengths without a fixed stock-size multiplier', () => {
    const rule = lengthRule();
    expect(calculate(rule, sourceRow(), product())).toBe(20);
    expect(calculate(rule, sourceRow(), product({ stock_length: 144 }))).toBe(24);
    expect(calculate(rule, sourceRow(), product({ stock_length: 3048, stock_unit: 'mm' }))).toBe(20);
    expect(calculateWithTrace(rule, sourceRow(), product()).trace).toMatchObject({
      price_basis: 'length', price_unit: 'ft', full_item_quantity: { numerator: '10', denominator: '1' }, rounded_value: 20,
      dimensions: [{ product_attribute: 'stock_length', product_value: '120', product_unit_attribute: 'stock_unit', product_unit: 'in',
        source: { value_column: 'SourceLength', unit_column: 'SourceLengthUnit' } }],
    });
  });

  it('checks supplied source dimensions after exact conversion and never substitutes for missing catalog dimensions', () => {
    expect(calculate(lengthRule(), sourceRow({ SourceLength: '10', SourceLengthUnit: 'ft' }), product())).toBe(20);
    expect(() => calculate(lengthRule(), sourceRow({ SourceLength: '11', SourceLengthUnit: 'ft' }), product())).toThrow('differs from the current catalog');
    expect(() => calculate(lengthRule(), sourceRow({ SourceLength: '10' }), product())).toThrow('supplied together');
    expect(() => calculate(lengthRule(), sourceRow({ SourceLength: '10', SourceLengthUnit: 'ft' }), product({ stock_length: null }))).toThrow('missing or invalid');
    expect(() => calculate(lengthRule(), sourceRow(), product({ stock_length: 0 }))).toThrow('positive');
    expect(() => calculate(lengthRule(), sourceRow(), product({ stock_unit: null }))).toThrow('unit is missing');
    expect(() => calculate(lengthRule(), sourceRow({ PriceUnit: 'm' }), product())).toThrow('price unit differs');
    expect(() => calculate(lengthRule(), sourceRow())).toThrow('Current product dimensions');
  });

  it('calculates area from two current dimensions and validates dimensional units', () => {
    const rule = ruleSchema.parse({ ...lengthRule(), full_item_cost: { price_basis: 'area', price_unit: 'ft2', price_unit_column: 'PriceUnit', dimensions: [
      { product_attribute: 'stock_length', product_unit: 'in' }, { product_attribute: 'stock_width', product_unit: 'mm' },
    ] } });
    const row = sourceRow({ PriceUnit: 'ft2' });
    expect(calculate(rule, row, product({ stock_width: 1219.2 }))).toBe(80);
    expect(calculate(rule, row, product({ stock_width: 609.6 }))).toBe(40);
    expect(() => calculate(rule, row, product())).toThrow('missing or invalid');
    expect(() => ruleSchema.parse({ ...rule, full_item_cost: { ...rule.full_item_cost, price_unit: 'ft' } })).toThrow('price basis');
    expect(() => ruleSchema.parse({ ...rule, full_item_cost: { ...rule.full_item_cost, dimensions: [rule.full_item_cost!.dimensions[0]] } })).toThrow('requires two');
  });

  it('supports verified full-item prices and explicit pricing adjustments with final rounding only', () => {
    const rule = ruleSchema.parse({ ...lengthRule(), full_item_cost: { price_basis: 'item', price_unit: 'item', price_unit_column: 'PriceUnit', dimensions: [] },
      operations: [{ op: 'multiply', operand: '0.9', role: 'pricing_adjustment' }] });
    expect(calculate(rule, sourceRow({ Price: '1.005', PriceUnit: 'item' }))).toBe(0.90);
    expect(calculateWithTrace(rule, sourceRow({ Price: '1.005', PriceUnit: 'item' })).trace).toMatchObject({
      adjustments: [{ op: 'multiply', operand: '0.9', role: 'pricing_adjustment' }], decimals: 2, rounding: 'half_up', rounded_value: 0.9,
    });
    const legacy = { ...lengthRule(), full_item_cost: undefined, operations: [{ op: 'multiply' as const, operand: '10' }] };
    expect(calculate(legacy, sourceRow())).toBe(20);
  });
});

describe('full-item review, snapshot and durable rule boundaries', () => {
  it('records calculation evidence, reuses a changed size, and does not change primary supplier', async () => {
    const f = await fixture();
    const first = await f.service.plan(f.input);
    expect(first.blocked).toEqual([]);
    expect(first.changes[0]).toMatchObject({ new_value: 20, calculation_trace: { full_item_quantity: { numerator: '10', denominator: '1' } },
      review_evidence: { stock_length: 120, stock_unit: 'in', primary_supplier: 'Supplier 2' } });
    f.current.attributes!.stock_length = 144;
    expect((await f.service.plan(f.input)).changes[0].new_value).toBe(24);
    expect(f.current.attributes!.primary_supplier).toBe('Supplier 2');
    expect(f.write).not.toHaveBeenCalled();
  });

  it('includes custom dimension/unit attributes in batch snapshots and blocks drift after review', async () => {
    const f = await fixture(), plan = await f.service.plan(f.input);
    const snapshot = await f.service.batchSnapshot([plan]);
    expect([...snapshot.fields]).toEqual(expect.arrayContaining(['stock_length', 'stock_unit']));
    expect(await f.service.checkBatch([plan], snapshot)).toEqual(new Map());
    f.current.attributes!.stock_length = 144;
    const drifted = await f.service.batchSnapshot([plan]);
    expect((await f.service.checkBatch([plan], drifted)).get('p/supplier_1_cost')).toMatch(/changed after approval/);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('validates inherited dimensions even without a material group identifier', async () => {
    const f = await fixture();
    Object.assign(f.current, { product_type: 'VARIANT', _parent_id: 'root', num_variations: 1 });
    f.records.push({ id: 'root', sku: 'ROOT', product_type: 'PARENT', product_family_id: 'f', num_variations: 1 },
      { ...structuredClone(f.current), id: 'child', sku: 'CHILD', product_type: 'SUB_VARIANT', _parent_id: 'p', num_variations: 0, overwritten_attributes: [],
        attributes: { ...f.current.attributes, stock_length: 144 } });
    expect((await f.service.plan(f.input)).blocked[0].reason).toMatch(/different full-item/);
    f.records[2].overwritten_attributes = ['supplier_1_cost'];
    expect((await f.service.plan(f.input)).blocked).toEqual([]);
  });

  it('does not apply the dimension multiplier again to a manually reviewed full-item amount', async () => {
    const f = await fixture();
    const plan = await f.service.plan({ ...f.input, mappings: [{ ...f.input.mappings[0], proposed_value: '21', review_note: 'Reviewed full-item adjustment' }] });
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0]).toMatchObject({ new_value: 21, calculated_value: 20, calculation_trace: { rounded_value: 20 } });
  });

  it('rejects new reusable fixed size multipliers but preserves legacy records and private batches', async () => {
    const f = await fixture();
    const legacy = { ...f.rule, id: 'legacy', full_item_cost: undefined, operations: [{ op: 'multiply' as const, operand: '10' }] };
    await expect(f.service.rulesSave({ expected_revision: 1, rules: [legacy] })).rejects.toThrow('full_item_cost');
    await expect(f.service.rulesSave({ expected_revision: 1, rules: [{ ...f.rule, operations: [{ op: 'multiply', operand: '10' }] }] })).rejects.toThrow('pricing_adjustment');
    f.store.values.set('rules.json', { revision: 1, updated_at: '2026-01-01T00:00:00.000Z', rules: [legacy], history: [] });
    expect((await f.service.rulesGet()).rules[0].id).toBe('legacy');
    expect((await f.service.rulesSave({ expected_revision: 1, rules: [legacy] })).rules[0].id).toBe('legacy');
    const plan = await f.service.plan({ ...f.input, rule_ids: [], batch_rules: [legacy] });
    expect(plan.blocked).toEqual([]);
    expect(plan.changes[0].new_value).toBe(20);
    const newRule = { ...f.rule, operations: [{ op: 'multiply' as const, operand: '0.9', role: 'pricing_adjustment' as const }] };
    expect((await f.service.rulesSave({ expected_revision: 2, rules: [newRule] })).rules[0].full_item_cost).toBeDefined();
  });

  it('preserves explicit review attribution and prior snapshots when a saved rule is changed and removed', async () => {
    const f = await fixture();
    const review = { sources: [{ kind: 'user' as const, reference: 'Owner review, decision 5' }], reason: 'Retire the replaced cost rule.', reviewer: 'Owner' };
    const replacement = { ...f.rule, name: 'Reviewed replacement' };
    await f.service.rulesSave({ expected_revision: 1, rules: [replacement], review });
    const removed = await f.service.rulesSave({ expected_revision: 2, rules: [], review });
    const events = removed.record_provenance!.records[`rule:${f.rule.id}`].events;
    expect(events.map(event => event.action)).toEqual(['created', 'changed', 'removed']);
    expect(events[2]).toMatchObject({ operation: 'user_save', before: replacement, after: null, review,
      reviewer_identity: 'caller_supplied_not_authenticated' });
    expect(events[1].before).toEqual(f.rule);
    expect(removed.provenance_authority).toContain('not authenticated identity');
    expect((await f.service.rulesGet()).provenance_authority).toBe(removed.provenance_authority);
  });

  it('rejects saved rules whose current content contradicts their provenance', async () => {
    const f = await fixture();
    const stored = structuredClone(f.store.values.get('rules.json')) as { rules: PricingRule[] };
    stored.rules[0].name = 'Unexpected out-of-band change';
    f.store.values.set('rules.json', stored);
    await expect(f.service.rulesGet()).rejects.toThrow('could not be read or validated');
  });
});
