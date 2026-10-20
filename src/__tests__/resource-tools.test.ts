import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerAssetTools } from '../tools/assets.js';
import { registerProductTools } from '../tools/products.js';
import { registerRelationshipTools } from '../tools/relationships.js';
import { registerVariantTools } from '../tools/variants.js';
import { registerCapabilityTools } from '../tools/capabilities.js';
import { configureToolPolicy } from '../tools/register.js';
import { WRITE_TOOLS } from '../policy.js';

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<Result>;

function toolsFor(register: (server: McpServer, client: PlytixClient) => void, methods: Record<string, unknown> = {}) {
  const definitions = new Map<string, { inputSchema: ZodRawShape; description: string; callback: Callback }>();
  const server = {
    registerTool(name: string, definition: { inputSchema: ZodRawShape; description: string }, callback: Callback) {
      definitions.set(name, { ...definition, callback });
    },
  } as unknown as McpServer;
  const client = {
    runOperation: <T>(work: () => Promise<T>) => work(),
    beginApprovedWrite: () => {},
    ...methods,
  } as unknown as PlytixClient;
  configureToolPolicy(server, WRITE_TOOLS, client, { requestWriteApproval: async () => true });
  register(server, client);
  return {
    definitions,
    async call(name: string, args: Record<string, unknown> = {}) {
      const definition = definitions.get(name)!;
      const result = await definition.callback(z.object(definition.inputSchema).parse(args), {
        signal: new AbortController().signal,
      });
      return { ...result, json: result.isError ? undefined : JSON.parse(result.content[0].text) };
    },
  };
}

describe('asset discovery and metadata tools', () => {
  it('passes requested fields, OR-of-AND filters, and ordering to asset search', async () => {
    const searchAssets = vi.fn().mockResolvedValue({ data: [{ id: 'a', alt_text: 'Sheet edge' }] });
    const tools = toolsFor(registerAssetTools, { searchAssets });
    const filters = [[{ field: 'filename', operator: '!like', value: 'draft' }]];
    const result = await tools.call('assets_search', {
      attributes: ['filename', 'alt_text'], filters, pagination: { order: '-modified' },
    });
    expect(searchAssets).toHaveBeenCalledWith({
      attributes: ['filename', 'alt_text'], filters, pagination: { order: '-modified' },
    });
    expect(result.json.assets[0].alt_text).toBe('Sheet edge');
  });

  it('requests useful hierarchy fields from asset category search', async () => {
    const searchAssetCategories = vi.fn().mockResolvedValue({ data: [{ id: 'c', path: ['Images', 'Details'] }] });
    const tools = toolsFor(registerAssetTools, { searchAssetCategories });
    await tools.call('asset_categories_search', { query: 'Details' });
    expect(searchAssetCategories).toHaveBeenCalledWith(expect.objectContaining({
      attributes: ['name', 'path', 'parents_ids', 'n_children', 'order'],
      filters: [[{ field: 'name', operator: 'like', value: 'Details' }]],
    }));
  });

  it('permits clearing alt text while rejecting more than the documented 512 characters', async () => {
    const updateAsset = vi.fn().mockResolvedValue({ data: [{ id: 'a' }] });
    const tools = toolsFor(registerAssetTools, { updateAsset });
    await tools.call('assets_update', { asset_id: 'a', alt_text: '' });
    expect(updateAsset).toHaveBeenCalledWith('a', { alt_text: '' });
    await expect(tools.call('assets_update', { asset_id: 'a', alt_text: 'x'.repeat(513) })).rejects.toThrow();
    expect(updateAsset).toHaveBeenCalledTimes(1);
  });

  it('requires the destination media attribute before linking an asset', async () => {
    const linkProductAsset = vi.fn().mockResolvedValue({ data: [{ id: 'a' }] });
    const tools = toolsFor(registerAssetTools, { linkProductAsset });
    await expect(tools.call('assets_link', { product_id: 'p', asset_id: 'a' })).rejects.toThrow();
    expect(linkProductAsset).not.toHaveBeenCalled();
    await tools.call('assets_link', { product_id: 'p', asset_id: 'a', attribute_label: 'thumbnail' });
    expect(linkProductAsset).toHaveBeenCalledWith('p', 'a', 'thumbnail');
  });
});

describe('product tool contracts', () => {
  it('keeps AND groups intact, supports field arrays, and forwards documented sort order', async () => {
    const searchProducts = vi.fn().mockResolvedValue({ data: [] });
    const tools = toolsFor(registerProductTools, { searchProducts });
    const filters = [
      [{ field: 'sku', operator: 'like', value: 'A' }, { field: 'status', operator: 'eq', value: 'Draft' }],
      [{ field: ['sku', 'label'], operator: 'text_search', value: 'sheet' }],
    ];
    await tools.call('products_search', { filters, pagination: { order: '-modified' } });
    expect(searchProducts).toHaveBeenCalledWith({
      filters, pagination: { order: '-modified', page: 1, page_size: 25 },
    });
    expect(tools.definitions.get('products_search')!.inputSchema.filters.description).toContain('AND');
  });

  it('rejects an oversized field projection before searching', async () => {
    const searchProducts = vi.fn();
    const tools = toolsFor(registerProductTools, { searchProducts });
    await expect(tools.call('products_search', { attributes: Array(51).fill('sku') })).rejects.toThrow();
    expect(searchProducts).not.toHaveBeenCalled();
  });

  it('forwards product v2 relationship presence filters without rewriting groups', async () => {
    const searchProducts = vi.fn().mockResolvedValue({ data: [] });
    const tools = toolsFor(registerProductTools, { searchProducts });
    const relationship_filters = [[{ relationship_id: 'related-parts', operator: '!exists' }]];
    const filters = [[{ field: 'status', operator: 'eq', value: 'Completed' }]];
    await tools.call('products_search', { relationship_filters, filters });
    expect(searchProducts).toHaveBeenCalledWith({ relationship_filters, filters });
  });

  it('rejects relationship filters for different relationship IDs before searching', async () => {
    const searchProducts = vi.fn();
    const tools = toolsFor(registerProductTools, { searchProducts });
    await expect(tools.call('products_search', { relationship_filters: [
      [{ relationship_id: 'related-parts', operator: 'exists' }],
      [{ relationship_id: 'substitutes', operator: '!exists' }],
    ] })).rejects.toThrow('Relationship filters must reference a single relationship_id.');
    expect(searchProducts).not.toHaveBeenCalled();
  });

  it('does not claim variant creation succeeded without a returned ID', async () => {
    const tools = toolsFor(registerVariantTools, { createVariant: vi.fn().mockResolvedValue({ data: [] }) });
    const result = await tools.call('variants_create', { parent_product_id: 'p', sku: 'V' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('before retrying');
  });
});

describe('relationship mutation readback', () => {
  it('distinguishes a silently ignored link from a verified link', async () => {
    const getProduct = vi.fn().mockResolvedValue({ data: [{ id: 'p', relationships: [] }] });
    const tools = toolsFor(registerRelationshipTools, {
      getProduct, linkProductRelationship: vi.fn().mockResolvedValue({ data: [] }),
    });
    const args = { product_id: 'p', relationship_id: 'r', related_product_id: 'other', quantity: 2 };
    const ignored = await tools.call('relationships_link_product', args);
    expect(ignored.json).toMatchObject({ accepted: true, verification: 'not_verified' });
    expect(ignored.json.success).toBeUndefined();
    getProduct.mockResolvedValue({ data: [{
      id: 'p', relationships: [{ relationship_id: 'r', related_products: [{ product_id: 'other', quantity: 2 }] }],
    }] });
    const confirmed = await tools.call('relationships_link_product', args);
    expect(confirmed.json.verification).toBe('verified');
  });

  it('does not report a failed readback as a failed write', async () => {
    const tools = toolsFor(registerRelationshipTools, {
      getProduct: vi.fn().mockRejectedValue(new Error('Read failed')),
      updateProductRelationship: vi.fn().mockResolvedValue({ data: [] }),
    });
    const result = await tools.call('relationships_set_quantity', {
      product_id: 'p', relationship_id: 'r', related_product_id: 'other', quantity: 3,
    });
    expect(result.isError).not.toBe(true);
    expect(result.json).toMatchObject({ accepted: true, verification: 'not_verified' });
  });

  it('verifies removal only from a structurally valid product readback', async () => {
    const getProduct = vi.fn().mockResolvedValue({ data: [{ id: 'p' }] });
    const tools = toolsFor(registerRelationshipTools, {
      getProduct, unlinkProductRelationship: vi.fn().mockResolvedValue({ data: [] }),
    });
    const args = { product_id: 'p', relationship_id: 'r', related_product_id: 'other' };
    expect((await tools.call('relationships_unlink_product', args)).json.verification).toBe('not_verified');
    getProduct.mockResolvedValue({ data: [{ id: 'p', relationships: [] }] });
    expect((await tools.call('relationships_unlink_product', args)).json.verification).toBe('verified');
  });
});

it('explains public API gaps without making upstream requests', async () => {
  const tools = toolsFor(registerCapabilityTools);
  const result = await tools.call('server_capabilities');
  expect(result.json.versions.products).toContain('v2 preferred');
  expect(result.json.limitations.channels).toContain('does not document');
  expect(result.json.limitations.product_lists).toContain('No product-list management endpoint');
});
