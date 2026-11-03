import { describe, expect, it } from 'vitest';
import { PricingMemory, memoryValue, memoryScope, ruleMemoryValues, type MemoryValue } from '../pricing/memory.js';
import { ruleSchema } from '../pricing/model.js';
import type { PricingChange } from '../pricing/model.js';
import { learnImport, learnPlan, learnSchema } from '../pricing/learning.js';
import type { PricingStore } from '../pricing/store.js';

class FixtureStore implements PricingStore {
  readonly kind = 'file' as const;
  data = new Map<string, unknown>();
  updates = 0;
  async read(key: string) { return structuredClone(this.data.get(key)); }
  async create(key: string, value: unknown) { this.data.set(key, structuredClone(value)); }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    const next = change(parse(await this.read(key))); this.updates++;
    this.data.set(key, structuredClone(next)); return next;
  }
}
const timestamp = '2026-11-03T12:00:00.000Z';
const evidence = { source: 'document' as const, reference: 'Price list, sheet 1', source_sha256: 'a'.repeat(64) };
const value = (overrides: Partial<MemoryValue> = {}): MemoryValue => ({
  kind: 'color', term: 'NAT', canonical_term: 'Natural', definition: 'Source color notation; verify the current catalog option.',
  scope: { supplier: 'Example supplier', family_id: 'family-one' }, attribute_labels: ['color'], ...overrides,
});
const rule = () => ruleSchema.parse({ id: 'cost_rule', name: 'Sheet cost', status: 'confirmed', evidence: 'Reviewed source',
  family_ids: ['family-one'], target_attribute: 'supplier_cost', source_column: 'Sheet', currency: 'USD', currency_column: 'Currency',
  unit: 'sheet', unit_column: 'Unit', operations: [], maximum: '1000', max_change_percent: 10,
  review_attributes: ['material', 'color'], associations: [{ kind: 'supplier', column: 'Supplier', attribute: 'supplier', aliases: [{ from: 'Ex', to: 'Example' }] }],
});

describe('bounded pricing workflow dictionary', () => {
  it('requires source scope and rejects arbitrary price/product snapshots', () => {
    expect(() => memoryScope.parse({ family_id: 'family-one' })).toThrow();
    expect(() => memoryValue.parse({ ...value(), price: '12.99', product: { sku: 'X' } })).toThrow();
  });

  it('deduplicates repeated source observations without inflating revision or evidence', async () => {
    const store = new FixtureStore(), memory = new PricingMemory(store, () => timestamp);
    const first = await memory.record([value(), value()], evidence);
    const second = await memory.record([value()], evidence);
    const read = await memory.get();
    expect(first.revision).toBe(1); expect(second.revision).toBe(1);
    expect(read.total).toBe(1); expect(read.entries[0]).toMatchObject({ status: 'observed', live_validation_required: true });
    expect(read.entries[0].evidence).toHaveLength(1);
    expect(read.advisory).toContain('Re-read Plytix');
  });

  it('keeps suppliers, source namespaces and families separate', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.record([value(), value({ scope: { supplier: 'Other supplier', family_id: 'family-one' } }),
      value({ scope: { supplier: 'Example supplier', family_id: 'family-two' } }),
      value({ scope: { source_namespace: 'Document A', family_id: 'family-one' } })], evidence);
    expect((await memory.get()).total).toBe(4);
    const scoped = await memory.get({ scope: { supplier: 'example SUPPLIER', family_id: 'family-one' } });
    expect(scoped.entries).toHaveLength(1);
    expect((await memory.get({ scope: { source_namespace: 'Missing' } })).matched).toBe(0);
  });

  it('preserves manual corrections and retains one conflicting automatic suggestion', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.record([value()], evidence);
    const corrected = value({ canonical_term: 'Unpigmented', definition: 'User clarified the source meaning.' });
    await memory.update({ expected_revision: 1, entries: [{ value: corrected, status: 'user_defined', note: 'Explicit correction' }] });
    const observation = await memory.record([value()], { ...evidence, reference: 'New list' });
    const saved = (await memory.get()).entries[0];
    expect(observation.conflicts).toBe(1);
    expect(saved.status).toBe('user_defined'); expect(saved.value.canonical_term).toBe('Unpigmented');
    expect(saved.pending?.value.canonical_term).toBe('Natural');
    expect((await memory.get()).retained_history_revisions).toBe(1);
  });

  it('retains retirement tombstones so automation cannot revive discarded definitions', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.update({ expected_revision: 0, entries: [{ value: value(), status: 'retired', note: 'Misleading alias' }] });
    const result = await memory.record([value()], evidence);
    expect(result.protected).toBe(1); expect((await memory.get()).matched).toBe(0);
    expect((await memory.get({ include_retired: true })).entries[0].status).toBe('retired');
  });

  it('requires real source provenance for proposed tool updates and preserves manual definitions', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await expect(memory.update({ expected_revision: 0, entries: [{ value: value(), status: 'proposed' }] })).rejects.toThrow('source evidence');
    await memory.update({ expected_revision: 0, entries: [{ value: value(), status: 'proposed', evidence }] });
    expect((await memory.get()).entries[0].evidence[0]).toMatchObject(evidence);
    const corrected = value({ canonical_term: 'Unpigmented' });
    await memory.update({ expected_revision: 1, entries: [{ value: corrected, status: 'user_defined' }] });
    const suggestion = await memory.update({ expected_revision: 2, entries: [{ value: value(), status: 'proposed', evidence }] });
    expect(suggestion.conflicts).toBe(1);
    expect((await memory.get()).entries[0]).toMatchObject({ status: 'user_defined', value: corrected, pending: { evidence } });
    await memory.update({ expected_revision: 3, entries: [{ value: corrected, status: 'retired' }] });
    expect((await memory.update({ expected_revision: 4, entries: [{ value: value(), status: 'proposed', evidence }] })).protected).toBe(1);
    expect((await memory.get({ include_retired: true })).entries[0].status).toBe('retired');
  });

  it('requires the current revision for corrections and stores the previous definition', async () => {
    const store = new FixtureStore(), memory = new PricingMemory(store, () => timestamp);
    await memory.record([value()], evidence);
    await expect(memory.update({ expected_revision: 0, entries: [{ value: value(), status: 'user_defined' }] })).rejects.toThrow('changed');
    await memory.update({ expected_revision: 1, entries: [{ value: value({ canonical_term: 'White' }), status: 'user_defined' }] });
    const raw = await store.read('dictionary.json') as { history: Array<{ previous: Array<{ value: MemoryValue }> }> };
    expect(raw.history[0].previous[0].value.canonical_term).toBe('Natural');
  });

  it('bounds evidence and entries while preserving manual corrections', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.update({ expected_revision: 0, entries: [{ value: value(), status: 'user_defined' }] });
    const values = Array.from({ length: 550 }, (_, i) => value({ term: `Source ${i}` }));
    const result = await memory.record(values, evidence);
    expect(result.total).toBe(500); expect(result.skipped).toBe(51);
    expect((await memory.get({ query: 'NAT' })).entries.some(item => item.status === 'user_defined')).toBe(true);
    const retained = (await memory.get()).entries.find(item => item.status !== 'user_defined')!;
    for (let i = 0; i < 7; i++) await memory.record([retained.value], { ...evidence, reference: `Page ${i}` });
    expect((await memory.get({ query: retained.value.term, page_size: 100 })).entries.find(item => item.id === retained.id)?.evidence).toHaveLength(4);
  });

  it('skips overflow without churning repeated large observations or failing on protected capacity', async () => {
    const store = new FixtureStore(); let at = timestamp;
    const memory = new PricingMemory(store, () => at);
    const values = Array.from({ length: 1000 }, (_, i) => value({ term: `Term ${i}` }));
    expect((await memory.record(values, evidence)).skipped).toBe(500);
    const first = await store.read('dictionary.json'); at = '2026-11-04T12:00:00.000Z';
    expect((await memory.record(values, evidence)).skipped).toBe(500);
    expect(await store.read('dictionary.json')).toEqual(first);
    for (let page = 1; page <= 5; page++) {
      const entries = (await memory.get({ page, page_size: 100 })).entries;
      for (let start = 0; start < 100; start += 50) await memory.update({ expected_revision: (await memory.get()).revision,
        entries: entries.slice(start, start + 50).map(item => ({ value: item.value, status: 'user_defined' })) });
    }
    expect((await memory.record([value({ term: 'No remaining capacity' })], evidence)).skipped).toBe(1);
    expect((await memory.get()).total).toBe(500);
  });

  it('paginates and reports exact matched coverage instead of returning the entire store', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.record(Array.from({ length: 70 }, (_, i) => value({ term: `Color ${i}` })), evidence);
    const first = await memory.get(), last = await memory.get({ page: 3 });
    expect(first.entries).toHaveLength(25); expect(first.has_more).toBe(true); expect(first.matched).toBe(70);
    expect(last.entries).toHaveLength(20); expect(last.has_more).toBe(false);
  });

  it('records reviewed rule pointers and aliases without copying executable calculations', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.recordRules([rule()], 1);
    const read = await memory.get();
    expect(read.entries).toHaveLength(5);
    expect(read.entries.every(item => item.status === 'reviewed_rule' && item.live_validation_required)).toBe(true);
    expect(read.entries.find(item => item.value.term === 'Ex')?.value.canonical_term).toBe('Example');
    expect(JSON.stringify(read)).not.toContain('max_change_percent');
    expect(ruleMemoryValues([rule()]).some(item => item.kind === 'review_attribute')).toBe(true);
    const retained = read.entries[0];
    await memory.record([retained.value], evidence);
    expect((await memory.get()).entries.find(item => item.id === retained.id)?.status).toBe('reviewed_rule');
  });

  it('bounds large rule indexes and leaves repeated rule reads stable', async () => {
    const store = new FixtureStore(); let at = timestamp;
    const memory = new PricingMemory(store, () => at), large = rule();
    large.family_ids = ['one', 'two', 'three', 'four', 'five'];
    large.associations[0].aliases = Array.from({ length: 100 }, (_, index) => ({ from: `Alias ${index}`, to: `Canonical ${index}` }));
    const first = await memory.recordRules([large], 1);
    expect(first.total).toBe(500); expect(first.truncated).toBe(true); expect(first.skipped).toBeGreaterThan(0);
    const saved = await store.read('dictionary.json'); at = '2026-11-04T12:00:00.000Z';
    await memory.recordRules([large], 1);
    expect(await store.read('dictionary.json')).toEqual(saved);
  });

  it('refreshes derived definitions from changed reviewed rules and marks removed sources stale', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.recordRules([rule()], 1);
    const changed = rule(); changed.unit = 'panel';
    await memory.recordRules([changed], 2);
    expect((await memory.get({ query: 'Sheet' })).entries.find(item => item.value.kind === 'attribute_setup')?.value.definition).toContain('per panel');
    await memory.recordRules([], 3);
    expect((await memory.get()).entries.every(item => item.stale_source)).toBe(true);
  });

  it('marks removed aliases within an active rule stale while retaining manual corrections', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await memory.recordRules([rule()], 1);
    const alias = (await memory.get({ query: 'Ex' })).entries.find(item => item.value.term === 'Ex')!;
    await memory.update({ expected_revision: 1, entries: [{ value: { ...alias.value, canonical_term: 'Explicit correction' }, status: 'user_defined' }] });
    const revised = rule(); revised.associations = []; revised.source_column = 'Panel';
    await memory.recordRules([revised], 2);
    const saved = await memory.get();
    expect(saved.entries.find(item => item.value.term === 'Ex')).toMatchObject({ stale_source: true, status: 'user_defined', value: { canonical_term: 'Explicit correction' } });
    expect(saved.entries.find(item => item.value.term === 'Sheet' && item.value.kind === 'attribute_setup')?.stale_source).toBe(true);
    expect(saved.entries.find(item => item.value.term === 'Panel')?.stale_source).toBe(false);
  });

  it('cannot auto-confirm a definition through the public observation path', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    await expect(memory.record([value()], evidence, 'reviewed_rule' as 'observed')).rejects.toThrow('cannot confirm');
  });

  it('rejects corrupt data rather than silently resetting learning', async () => {
    const store = new FixtureStore(); store.data.set('dictionary.json', { version: 1, entries: [] });
    await expect(new PricingMemory(store).get()).rejects.toThrow('could not be read');
  });
});

describe('automatic pricing workflow learning', () => {
  const source = { source_name: 'Supplier November list', source_sha256: 'b'.repeat(64), source_context: { supplier: 'Example supplier', source_namespace: 'sheet-prices' } };

  it('saves import headings and proposed family associations with one bounded store update', async () => {
    const store = new FixtureStore(), memory = new PricingMemory(store, () => timestamp);
    await learnImport(memory, { ...source, sku_column: 'Part', columns: ['Part', 'Price', 'Color'], family_suggestions: [{ family_id: 'family-one', name: 'Sheet products' }] });
    expect(store.updates).toBe(1);
    const saved = await memory.get();
    expect(saved.entries).toHaveLength(5);
    expect(saved.entries.every(item => item.status === 'proposed' && item.live_validation_required)).toBe(true);
    expect(saved.entries.find(item => item.value.kind === 'family_mapping')?.value.scope).toMatchObject({ family_id: 'family-one', supplier: 'Example supplier', source_namespace: 'sheet-prices' });
    expect(saved.entries[0].evidence[0].source_sha256).toBe(source.source_sha256);
  });

  it('reuses an explicit namespace across source versions without growing duplicate definitions', async () => {
    const memory = new PricingMemory(new FixtureStore(), () => timestamp);
    const details = { sku_column: 'Part', columns: ['Part', 'Price'], family_suggestions: [{ family_id: 'family-one' }] };
    await learnImport(memory, { ...source, ...details });
    await learnImport(memory, { ...source, ...details, source_name: 'Supplier December list', source_sha256: 'c'.repeat(64) });
    const saved = await memory.get();
    expect(saved.total).toBe(4); expect(saved.entries[0].evidence).toHaveLength(2);
    await learnImport(memory, { ...source, ...details, source_name: 'Unrelated list', source_context: undefined });
    expect((await memory.get()).total).toBe(7);
  });

  it('stores validated plan setup without product IDs, SKUs, values or descendant data', async () => {
    const store = new FixtureStore(), memory = new PricingMemory(store, () => timestamp);
    const change = { attribute: 'supplier_cost', family_id: 'family-one', inheritance_level: 'variant_level', rule_id: 'cost_rule',
      product_id: 'private-product-id', sku: 'PRIVATE-SKU-123', old_value: 13.37, new_value: 14.99,
      review_evidence: { secret_value: 'Do not retain raw product values' }, descendant_impact: [{ product_id: 'private-child-id' }] } as unknown as PricingChange;
    await learnPlan(memory, { ...source, changes: [change, { ...change, product_id: 'another-id', new_value: 25.99 }], rules: [rule()] });
    expect(store.updates).toBe(1);
    const saved = await memory.get();
    expect(saved.entries).toHaveLength(3);
    expect(JSON.stringify(saved)).not.toMatch(/private-product-id|PRIVATE-SKU|13\.37|14\.99|25\.99|secret_value|private-child-id/);
    expect(saved.entries.find(item => item.value.kind === 'product_setup')?.value.definition).toContain('variant_level');
    await learnPlan(memory, { ...source, changes: [{ ...change, old_value: 200, new_value: 210 }], rules: [rule()] });
    expect((await memory.get()).total).toBe(3);
  });

  it('retains only live structural schema pointers and makes no freshness claim on repeat lookup', async () => {
    const store = new FixtureStore(); let at = timestamp;
    const memory = new PricingMemory(store, () => at);
    const schema = { id: 'attr-one', label: 'color', name: 'Color Name', type_class: 'SingleSelectionAttribute', options: ['private-option'], product: { sku: 'private-sku' }, price: 9.99 };
    await learnSchema(memory, [schema]); at = '2026-11-04T12:00:00.000Z';
    await learnSchema(memory, [schema]);
    const saved = await memory.get();
    expect(saved.entries[0].evidence[0].observed_at).toBe(timestamp);
    expect(saved.entries[0].live_validation_required).toBe(true);
    expect(saved.entries[0].value.definition).toContain('attr-one');
    expect(saved.entries[0].value.definition).toContain('Color Name');
    expect(JSON.stringify(saved)).not.toMatch(/private-option|private-sku|9\.99/);
    const invalid = await learnSchema(memory, [{ id: 'x', label: 'not valid', type_class: 'NumberAttribute' }]);
    expect(invalid.ignored).toBe(1);
    await learnSchema(memory, [{ ...schema, type_class: 'TextAttribute' }]);
    const changed = (await memory.get()).entries[0];
    expect(changed.value.definition).toContain('TextAttribute');
    expect(changed.evidence[0].observed_at).toBe(at);
  });
});
