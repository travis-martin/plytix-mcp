import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { GcsPricingStore, GooglePricingObjects, PricingStoreConflict, createPricingStore, type PricingObjectBackend, type VersionedObject } from '../pricing/store.js';
import { PricingService } from '../pricing/service.js';
import { PlytixClient } from '../client.js';
import { ruleSchema } from '../pricing/model.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

class MemoryObjects implements PricingObjectBackend {
  objects = new Map<string, VersionedObject>();
  version = 0;
  async read(key: string) {
    const object = this.objects.get(key);
    await Promise.resolve();
    return object ? { generation: object.generation, bytes: Buffer.from(object.bytes) } : undefined;
  }
  async write(key: string, bytes: Buffer, expectedGeneration: string | 0) {
    await Promise.resolve();
    const object = this.objects.get(key);
    if ((object?.generation ?? 0) !== expectedGeneration) throw new PricingStoreConflict();
    this.objects.set(key, { generation: String(++this.version), bytes: Buffer.from(bytes) });
  }
}
const scope = 'a'.repeat(64);
const parseCounter = (value: unknown) => value as { count: number };

describe('cloud pricing CAS storage', () => {
  it('does not upload unchanged advisory memory or create an extra generation', async () => {
    const backend = new MemoryObjects(), store = new GcsPricingStore(backend, scope);
    await store.create('dictionary.json', { revision: 1 });
    const write = vi.spyOn(backend, 'write');
    expect(await store.update('dictionary.json', value => value, value => value)).toEqual({ revision: 1 });
    expect(write).not.toHaveBeenCalled();
  });
  it('does not lose concurrent updates across independent store instances', async () => {
    const backend = new MemoryObjects(); const a = new GcsPricingStore(backend, scope), b = new GcsPricingStore(backend, scope);
    await a.create('rules.json', { count: 0 });
    await Promise.all([a.update('rules.json', parseCounter, old => ({ count: old.count + 1 })), b.update('rules.json', parseCounter, old => ({ count: old.count + 1 }))]);
    expect(await a.read('rules.json')).toEqual({ count: 2 });
  });
  it('permits exactly one concurrent durable reservation and refuses replay after restart', async () => {
    const backend = new MemoryObjects(); const a = new GcsPricingStore(backend, scope), b = new GcsPricingStore(backend, scope);
    const key = `${randomUUID()}.json`; await a.create(key, { state: 'draft' });
    const reserve = (store: GcsPricingStore) => store.update(key, v => v as { state: string }, old => {
      if (old.state !== 'draft') throw new Error('Consumed');
      return { state: 'executing' };
    });
    const results = await Promise.allSettled([reserve(a), reserve(b)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(reserve(new GcsPricingStore(backend, scope))).rejects.toThrow('Consumed');
  });
  it('refuses duplicate creation and isolates credential prefixes', async () => {
    const backend = new MemoryObjects(); const a = new GcsPricingStore(backend, scope), b = new GcsPricingStore(backend, 'b'.repeat(64));
    await a.create('rules.json', { private: 'A' });
    expect(await b.read('rules.json')).toBeUndefined();
    await expect(a.create('rules.json', {})).rejects.toThrow('already exists');
    await expect(a.read('../rules.json')).rejects.toThrow('key');
  });
  it('bounds conflict retries, JSON decoding and document size', async () => {
    const backend = new MemoryObjects(); const store = new GcsPricingStore(backend, scope);
    await expect(store.create('rules.json', { text: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow('size');
    backend.objects.set(`pricing/${scope}/rules.json`, { generation: '1', bytes: Buffer.from('not json') });
    await expect(store.read('rules.json')).rejects.toThrow('valid JSON');
    backend.objects.clear();
    const write = vi.spyOn(backend, 'write').mockRejectedValue(new PricingStoreConflict());
    await expect(store.update('rules.json', () => ({}), value => value)).rejects.toThrow('busy');
    expect(write).toHaveBeenCalledTimes(5);
  });
  it('fails closed on cloud configuration instead of falling back to local files', () => {
    vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', 'invalid/bucket');
    expect(() => createPricingStore(scope, '/tmp/local-fallback')).toThrow('bucket');
    vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', 'reviewed-bucket');
    expect(createPricingStore(scope, '/tmp/local-fallback').kind).toBe('gcs');
  });
  it('pins object downloads to the metadata generation and sets CAS on writes', async () => {
    const generations: unknown[] = []; const save = vi.fn().mockResolvedValue(undefined);
    const storage = { bucket: () => ({ file: (_key: string, options?: { generation: string }) => {
      generations.push(options?.generation);
      return { getMetadata: async () => [{ generation: '123456789012345678', size: '13' }], createReadStream: () => Readable.from([Buffer.from('{"value":1}')]), save };
    } }) };
    const backend = new GooglePricingObjects('bucket', storage as any);
    expect((await backend.read('key'))?.generation).toBe('123456789012345678');
    expect(generations).toContain('123456789012345678');
    await backend.write('key', Buffer.from('{}'), '123456789012345678');
    expect(save.mock.calls[0][1].preconditionOpts.ifGenerationMatch).toBe('123456789012345678');
  });
  it('distinguishes storage absence from permission errors and sanitizes provider errors', async () => {
    const storage = { bucket: () => ({ file: () => ({ getMetadata: vi.fn().mockRejectedValue({ code: 403, message: 'private credential payload' }) }) }) };
    const backend = new GooglePricingObjects('bucket', storage as any);
    await expect(backend.read('key')).rejects.toThrow('unavailable');
    await expect(backend.read('key')).rejects.not.toThrow('credential');
  });
  it('runs the real plan/apply service on the cloud adapter with one-shot replay protection', async () => {
    const backend = new MemoryObjects();
    const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
    vi.spyOn(api, 'verifyKnowledgeAccess').mockResolvedValue();
    const product = { id: 'p', sku: 'A', product_family_id: 'f', product_type: 'STANDALONE' as const, num_variations: 0, attributes: { cost: 10 } };
    vi.spyOn(api, 'searchProducts').mockImplementation(async () => ({ data: [structuredClone(product)] }));
    vi.spyOn(api, 'getProduct').mockImplementation(async () => ({ data: [structuredClone(product)] }));
    vi.spyOn(api, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Family' }] });
    vi.spyOn(api, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'a', name: 'Cost', label: 'cost', attribute_level: 'parent_level' }] });
    vi.spyOn(api, 'getAttributeById').mockResolvedValue({ id: 'a', name: 'Cost', label: 'cost', type_class: 'DecimalAttribute' });
    const write = vi.spyOn(api, 'updateProduct').mockImplementation(async (_id, value) => { product.attributes.cost = value.attributes!.cost as number; return { data: [structuredClone(product)] }; });
    const factory = (fingerprint: string) => new GcsPricingStore(backend, fingerprint);
    const service = new PricingService(api, undefined, factory);
    const rule = ruleSchema.parse({ id: 'cost', name: 'Cost', status: 'confirmed', evidence: 'Source', family_ids: ['f'], target_attribute: 'cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency', unit: 'each', unit_column: 'Unit', operations: [], maximum: '100', max_change_percent: 50 });
    await service.rulesSave({ expected_revision: 0, rules: [rule] });
    const imported = await service.importDocument({ source_name: 'fixture.pdf', source_sha256: 'f'.repeat(64), sku_column: 'SKU', rows: [{ source_ref: 'p1', values: { SKU: 'A', Price: '12', Currency: 'USD', Unit: 'each' } }] });
    const plan = await service.plan({ import_id: imported.import_id, rule_ids: ['cost'], mappings: [{ row_index: 0, product_id: 'p', family_id: 'f' }] });
    const input = { plan_id: plan.plan_id, digest: plan.digest, changes: plan.changes };
    expect((await service.apply(input)).state).toBe('complete');
    await expect(new PricingService(api, undefined, factory).apply(input)).rejects.toThrow('consumed');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
