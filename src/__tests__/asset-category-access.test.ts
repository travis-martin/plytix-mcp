import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { PlytixError } from '../types.js';
import { registerAssetTools } from '../tools/assets.js';
import { configureToolPolicy } from '../tools/register.js';

afterEach(() => vi.restoreAllMocks());

async function withAssetTools(
  run: (api: PlytixClient, call: (args?: Record<string, unknown>) => Promise<{
    isError: boolean; text: string;
  }>) => Promise<void>,
) {
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  const server = new McpServer({ name: 'asset-category-test', version: '1' });
  configureToolPolicy(server, new Set(), api);
  registerAssetTools(server, api);
  const client = new Client({ name: 'asset-category-test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(api, async (args = {}) => {
      const result = await client.callTool({ name: 'asset_categories_search', arguments: args });
      return {
        isError: result.isError === true,
        text: (result.content as Array<{ text: string }>)[0].text,
      };
    });
  } finally {
    await client.close();
    await server.close();
  }
}

describe('asset category access limitations', () => {
  it('preserves full category results when the taxonomy endpoint is accessible', async () => {
    await withAssetTools(async (api, call) => {
      vi.spyOn(api, 'searchAssetCategories').mockResolvedValue({
        data: [{ id: 'category', name: 'Photos', path: ['Photos'] }],
      });
      const filters = vi.spyOn(api, 'getAssetFilters');
      const result = await call();
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toEqual({
        categories: [{ id: 'category', name: 'Photos', path: ['Photos'] }],
      });
      expect(filters).not.toHaveBeenCalled();
    });
  });

  it('returns paginated accessible IDs without pretending the name query or ordering succeeded', async () => {
    await withAssetTools(async (api, call) => {
      vi.spyOn(api, 'searchAssetCategories').mockRejectedValue(new PlytixError('Forbidden category settings', 403));
      vi.spyOn(api, 'getAssetFilters').mockResolvedValue({
        data: [{ key: 'categories', options: ['a', 'b', 'a', 'c', 'd', '', null, { id: 'unsupported' }] }],
      });
      const result = await call({ query: 'Photos', pagination: { page: 2, page_size: 2, order: '-name' } });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({
        categories: null,
        partial: true,
        _retrieval: { source: 'assets_filters', reason: expect.stringContaining('HTTP 403') },
        fallback_scope: expect.stringContaining('IDs'),
        requested_query: 'Photos',
        query_applied: false,
        requested_order: '-name',
        order_applied: false,
        available_category_ids: ['c', 'd'],
        available_category_ids_pagination: {
          page: 2, page_size: 2, count: 2, total_count: 4, has_more: false, truncated: true,
        },
        ignored_filter_options: 3,
        errors: [{ section: 'asset_categories', message: 'Forbidden category settings' }],
      });
    });
  });

  it('limits the fallback to one requested page without a catalog scan', async () => {
    await withAssetTools(async (api, call) => {
      const categories = vi.spyOn(api, 'searchAssetCategories').mockRejectedValue(new PlytixError('Forbidden', 403));
      const filters = vi.spyOn(api, 'getAssetFilters').mockResolvedValue({
        data: [{ field: 'categories', options: Array.from({ length: 120 }, (_, index) => `id-${index}`) }],
      });
      const result = JSON.parse((await call({ pagination: { page_size: 100 } })).text);
      expect(result.available_category_ids).toHaveLength(100);
      expect(result.available_category_ids_pagination).toMatchObject({ total_count: 120, has_more: true, truncated: true });
      expect(categories).toHaveBeenCalledTimes(1);
      expect(filters).toHaveBeenCalledTimes(1);
    });
  });

  it('retains both errors when fallback discovery also fails', async () => {
    await withAssetTools(async (api, call) => {
      vi.spyOn(api, 'searchAssetCategories').mockRejectedValue(new PlytixError('Forbidden categories', 403));
      vi.spyOn(api, 'getAssetFilters').mockRejectedValue(new PlytixError('Unavailable filters', 503));
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text)).toEqual({
        categories: null,
        available_category_ids: null,
        partial: true,
        errors: [
          { section: 'asset_categories', message: 'Forbidden categories' },
          { section: 'assets_filters', message: 'Unavailable filters' },
        ],
      });
    });
  });

  it.each([
    { key: 'categories' },
    { key: 'categories', options: [{ id: 'unknown-shape' }] },
  ])('does not mistake unavailable category options for an empty taxonomy: %j', async filter => {
    await withAssetTools(async (api, call) => {
      vi.spyOn(api, 'searchAssetCategories').mockRejectedValue(new PlytixError('Forbidden', 403));
      vi.spyOn(api, 'getAssetFilters').mockResolvedValue({ data: [filter] });
      const result = await call();
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.text);
      expect(data.available_category_ids).toBeNull();
      expect(data.errors).toHaveLength(2);
    });
  });

  it.each([401, 404, 422, 429, 503])('does not run a permission fallback after HTTP %s', async status => {
    await withAssetTools(async (api, call) => {
      vi.spyOn(api, 'searchAssetCategories').mockRejectedValue(new PlytixError(`HTTP ${status}`, status));
      const filters = vi.spyOn(api, 'getAssetFilters');
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.text).toContain(`HTTP ${status}`);
      expect(filters).not.toHaveBeenCalled();
    });
  });
});
