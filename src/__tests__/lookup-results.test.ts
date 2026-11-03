import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { decorateResult, outputSchemaForTool, toolDataSchemas } from '../results.js';
import { z } from 'zod';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(run: (api: PlytixClient, client: Client) => Promise<void>) {
  vi.stubEnv('PLYTIX_SEARCH_FIELDS', '["sku"]');
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  const server = createServer(api);
  const client = new Client({ name: 'lookup-result-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(api, client); }
  finally { await client.close(); await server.close(); }
}

const lookup = (client: Client, identifier: string, limit = 5) => client.callTool({
  name: 'products_lookup', arguments: { identifier, type: 'sku', limit },
}) as Promise<any>;

it('keeps the first candidate and honors the requested limit for ambiguous lookup results', async () => {
  await fixture(async (api, client) => {
    vi.spyOn(api, 'searchProducts').mockResolvedValue({ data: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, sku: `ABC-${i}` })) });
    const detail = vi.spyOn(api, 'getProduct');
    const result = await lookup(client, 'ABC', 7);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.data.selected).toBeNull();
    expect(result.structuredContent.data.alternativeMatches.map((row: any) => row.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(result.structuredContent.data.retrieval).toEqual({ status: 'not_requested', source: 'none' });
    expect(detail).not.toHaveBeenCalled();
  });
});

it.each(['failure', 'empty'] as const)('marks search-only fallback partial when detail retrieval is %s', async mode => {
  await fixture(async (api, client) => {
    vi.spyOn(api, 'searchProducts').mockResolvedValue({ data: [{ id: 'p', sku: 'ABC' }] });
    const detail = vi.spyOn(api, 'getProduct');
    if (mode === 'failure') detail.mockRejectedValue(new Error('Private upstream error body'));
    else detail.mockResolvedValue({ data: [] });
    const result = await lookup(client, 'ABC');
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.data).toMatchObject({
      product: { id: 'p', sku: 'ABC' }, partial: true,
      retrieval: { status: 'unavailable', source: 'search_record' },
    });
    expect(result.structuredContent.metadata).toMatchObject({ status: 'partial', coverage: 'partial' });
    expect(result.structuredContent.metadata.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Private upstream error body');
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent.data);
  });
});

it('returns verified detail data and excludes only the selected product from alternatives', async () => {
  await fixture(async (api, client) => {
    vi.spyOn(api, 'searchProducts').mockResolvedValue({ data: [{ id: 'p', sku: 'ABC' }, { id: 'q', sku: 'DIFFERENT' }] });
    vi.spyOn(api, 'getProduct').mockResolvedValue({ data: [{ id: 'p', sku: 'ABC', attributes: { price: 15 } }] });
    const result = await lookup(client, 'ABC');
    expect(result.structuredContent.data).toMatchObject({
      selected: { id: 'p' }, alternativeMatches: [{ id: 'q' }],
      product: { attributes: { price: 15 } }, retrieval: { status: 'available', source: 'product_detail' },
    });
    expect(result.structuredContent.metadata.status).toBe('ok');
  });
});

it('publishes the typed contracts and validates real lookup, search, and dictionary envelopes', async () => {
  await fixture(async (api, client) => {
    vi.spyOn(api, 'searchProducts').mockResolvedValue({ data: [{ id: 'p', sku: 'ABC' }], pagination: { page: 1, page_size: 25, total_count: 1 } });
    vi.spyOn(api, 'getProduct').mockResolvedValue({ data: [{ id: 'p', sku: 'ABC' }] });
    vi.spyOn(api, 'searchAttributes').mockResolvedValue({ data: [{ id: 'a', name: 'Price', label: 'price', type_class: 'NumberAttribute' }] });
    const catalog = await client.listTools();
    for (const name of ['products_lookup', 'products_search', 'catalog_dictionary']) {
      const tool = catalog.tools.find(item => item.name === name)!;
      expect(JSON.stringify(tool.outputSchema)).toContain('anyOf');
      const result: any = await client.callTool({ name, arguments: name === 'products_lookup' ? { identifier: 'ABC', type: 'sku' } : {} });
      expect(result.isError).not.toBe(true);
      expect(z.object(outputSchemaForTool(name)).safeParse(result.structuredContent).success).toBe(true);
      expect(toolDataSchemas[name].safeParse(result.structuredContent.data).success).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent.data);
    }
  });
});

it('rejects malformed success payloads without exposing upstream values', () => {
  for (const name of ['products_lookup', 'products_search', 'catalog_dictionary']) {
    const result = decorateResult(name, { content: [{ type: 'text', text: JSON.stringify({ private: 'never echo' }) }] }, '', []);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('never echo');
    expect(z.object(outputSchemaForTool(name)).safeParse(result.structuredContent).success).toBe(true);
  }
});
