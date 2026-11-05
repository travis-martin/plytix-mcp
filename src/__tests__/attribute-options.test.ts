import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { isWriteRequestForTool } from '../policy.js';

afterEach(() => vi.restoreAllMocks());
const original = { id: 'field', label: 'size', name: 'Size', type_class: 'MultiSelectAttribute',
  options: ['12"', '2"', 'unused,'], modified: 'before', manual_sorting: false,
  restricted: false, sort_ascending: false, groups: ['dimensions'], description: 'Keep this' };
const args = { attribute_id: 'field', expected_label: 'size', expected_modified: 'before',
  expected_options: original.options, options: ['2"', '12"'] };

async function fixture(run: (f: {
  client: Client; api: PlytixClient; state: typeof original; writes: unknown[];
  reads: string[]; searches: unknown[]; call: (overrides?: Record<string, unknown>) => Promise<any>;
}) => Promise<void>, config: {
  allow?: boolean; approve?: boolean; usage?: unknown; changeBeforeWrite?: boolean;
  wrongReadback?: boolean; ambiguous?: boolean; initial?: Partial<typeof original>;
} = {}) {
  const state = { ...structuredClone(original), ...config.initial };
  const writes: unknown[] = [], reads: string[] = [], searches: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/api/get-token') return Response.json({ data: [{ access_token: 'fixture', expires_in: 900 }] });
    if (path === '/api/v2/products/search') {
      searches.push(JSON.parse(String(init?.body)));
      return Response.json(config.usage ?? { data: [], pagination: { count: 0, total_count: 12000 } });
    }
    if (path === '/api/v1/attributes/product/field' && init?.method === 'GET') {
      reads.push(path);
      if (config.changeBeforeWrite && reads.length === 2) state.modified = 'changed';
      return Response.json({ data: [state] });
    }
    if (path === '/api/v1/attributes/product/field' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); writes.push(body);
      Object.assign(state, body, { modified: 'after' });
      if (config.wrongReadback) state.options = ['wrong'];
      if (config.ambiguous) return new Response('do not leak upstream body', { status: 503 });
      return Response.json({ data: [state] });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const allow = config.allow !== false;
  const writeTools = new Set(allow ? ['attributes_update_options'] : []);
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: allow, writeTools });
  const server = createServer(api, writeTools, { requestWriteApproval: async () => config.approve !== false });
  const client = new Client({ name: 'attribute-options-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try { await run({ client, api, state, writes, reads, searches,
    call: overrides => client.callTool({ name: 'attributes_update_options', arguments: { ...args, ...overrides } }),
  }); } finally { await client.close(); await server.close(); }
}

describe('guarded option cleanup', () => {
  it('adds only explicitly reviewed values without requiring product-value edits', async () => {
    await fixture(async f => {
      const options = [...original.options, '6 mm (1/4")'];
      const result = await f.call({ options, add_options: ['6 mm (1/4")'] });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.data.added_options).toEqual(['6 mm (1/4")']);
      expect(f.writes).toEqual([{ options, manual_sorting: true }]);
      expect(f.searches).toEqual([]);
    });
  });
  it('initializes an empty existing option list with declared values', async () => {
    await fixture(async f => {
      const result = await f.call({ expected_options: [], options: ['2"', '12"'], add_options: ['12"', '2"'] });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.data.added_options).toEqual(['2"', '12"']);
      expect(f.searches).toEqual([]);
    }, { initial: { options: [] } });
  });
  it.each([
    { options: [...original.options, 'new'], add_options: [] },
    { options: original.options, add_options: ['new'] },
    { options: [...original.options, 'new'], add_options: ['new', 'extra'] },
    { options: [...original.options, 'new'], add_options: ['new', 'new'] },
    { options: original.options, add_options: ['12"'] },
  ])('rejects mismatched or duplicate addition declarations %j', async overrides => {
    await fixture(async f => { expect((await f.call(overrides)).isError).toBe(true); expect(f.writes).toEqual([]); });
  });
  it('checks removals even when explicitly adding new options in the same call', async () => {
    await fixture(async f => {
      const result = await f.call({ options: ['2"', '12"', 'new'], add_options: ['new'] });
      expect(result.isError).toBe(true); expect(f.writes).toEqual([]);
    }, { usage: { data: [{ id: 'used' }], pagination: { count: 1 } } });
  });

  it('removes only unused values, keeps exact quotes, orders numerically as supplied and reads back uncached', async () => {
    await fixture(async f => {
      const result = await f.call();
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.data).toMatchObject({ success: true, changed: true, verified: true, removed_options: ['unused,'] });
      expect(f.writes).toEqual([{ options: ['2"', '12"'], manual_sorting: true }]);
      expect(f.reads).toHaveLength(3);
      expect(f.searches).toEqual([{ filters: [[{ field: 'attributes.size', operator: 'in', value: ['unused,'] }]],
        attributes: ['sku', 'attributes.size'], pagination: { page: 1, page_size: 1 } }]);
      expect(f.state.description).toBe('Keep this');
      expect(f.state.restricted).toBe(false);
      expect(f.state.sort_ascending).toBe(false);
    });
  });
  it('rejects tool use without allowlisting and does not fetch', async () => {
    await fixture(async f => {
      expect((await f.client.listTools()).tools.some(t => t.name === 'attributes_update_options')).toBe(false);
      expect((await f.call()).isError).toBe(true); expect(fetch).not.toHaveBeenCalled();
    }, { allow: false });
  });
  it('respects declined approval before any API access', async () => {
    await fixture(async f => { expect((await f.call()).isError).toBe(true); expect(fetch).not.toHaveBeenCalled(); }, { approve: false });
  });
  it.each([
    { expected_label: 'other' }, { expected_modified: 'old' }, { expected_options: ['other'] },
    { options: ['new'] }, { options: ['2"', '2"'] }, { options: [] },
  ])('rejects an unreviewed or invalid change %j', async overrides => {
    await fixture(async f => { expect((await f.call(overrides)).isError).toBe(true); expect(f.writes).toEqual([]); });
  });
  it('rejects unsupported attribute types', async () => {
    await fixture(async f => { expect((await f.call()).isError).toBe(true); expect(f.writes).toEqual([]); }, { initial: { type_class: 'TextAttribute' } });
  });
  it.each([
    { data: [{ id: 'used' }], pagination: { count: 1, total_count: 12000 } },
    { data: [], pagination: { total_count: 0 } },
    { data: [], pagination: { count: 1 } },
    { data: [{ id: 'unexpected' }], pagination: { count: 0 } },
  ])('fails closed for positive or incomplete usage evidence %j', async usage => {
    await fixture(async f => { expect((await f.call()).isError).toBe(true); expect(f.writes).toEqual([]); }, { usage });
  });
  it('detects changed definitions on the second uncached preflight read', async () => {
    await fixture(async f => {
      const result = await f.call(); expect(result.isError).toBe(true);
      expect(result.structuredContent.data.write_attempted).toBe(false); expect(f.writes).toEqual([]);
    }, { changeBeforeWrite: true });
  });
  it.each([{ wrongReadback: true }, { ambiguous: true }])('reports uncertain writes and never retries %j', async config => {
    await fixture(async f => {
      const result = await f.call(); expect(result.isError).toBe(true);
      expect(result.structuredContent.data).toMatchObject({ verified: false, write_attempted: true, requires_inspection: true });
      expect(f.writes).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('do not leak upstream body');
    }, config);
  });
  it('skips usage lookup when only reordering', async () => {
    await fixture(async f => {
      expect((await f.call({ options: [...original.options].reverse() })).isError).not.toBe(true);
      expect(f.searches).toEqual([]);
    });
  });
  it('returns a verified no-op without PATCH for an already matching manual order', async () => {
    await fixture(async f => {
      const result = await f.call({ options: original.options });
      expect(result.structuredContent.data).toMatchObject({ success: true, changed: false, verified: true });
      expect(f.writes).toEqual([]);
    }, { initial: { manual_sorting: true } });
  });
  it('restricts the write route to this tool and attribute PATCH only', () => {
    expect(isWriteRequestForTool('attributes_update_options', '/api/v1/attributes/product/field', 'PATCH')).toBe(true);
    expect(isWriteRequestForTool('products_update', '/api/v1/attributes/product/field', 'PATCH')).toBe(false);
    expect(isWriteRequestForTool('attributes_update_options', '/api/v2/products/field', 'PATCH')).toBe(false);
    expect(isWriteRequestForTool('attributes_update_options', '/api/v1/attributes/product/field', 'DELETE')).toBe(false);
  });
  it('blocks direct client mutation without an approved operation before authentication', async () => {
    await fixture(async f => {
      await expect(f.api.updateAttributeOptions('field', ['2"'])).rejects.toThrow('not authorized');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
