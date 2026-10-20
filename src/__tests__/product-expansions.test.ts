import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';

async function withProduct(
  run: (methods: ReturnType<typeof mockProduct>, call: (include?: string[]) => Promise<any>) => Promise<void>,
) {
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  const methods = mockProduct(api);
  const server = createServer(api);
  const client = new Client({ name: 'product-expansion-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(methods, async (include) => {
      const result = await client.callTool({
        name: 'products_get_full',
        arguments: { product_id: 'p', ...(include === undefined ? {} : { include }) },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(result.isError, text).not.toBe(true);
      return JSON.parse(text);
    });
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await server.close();
  }
}

function mockProduct(api: PlytixClient) {
  return {
    getProduct: vi.spyOn(api, 'getProduct').mockResolvedValue({ data: [{ id: 'p', product_family_id: 'f' }] }),
    getFamily: vi.spyOn(api, 'getFamily').mockResolvedValue({ data: [{ id: 'f', name: 'Family' }] }),
    getProductVariants: vi.spyOn(api, 'getProductVariants').mockResolvedValue({ data: [{ id: 'v' }] }),
    getProductCategories: vi.spyOn(api, 'getProductCategories').mockResolvedValue({ data: [{ id: 'c', name: 'Category' }] }),
    getProductAssets: vi.spyOn(api, 'getProductAssets').mockResolvedValue({ data: [{ id: 'a' }] }),
  };
}

describe('selective product expansion', () => {
  it('preserves all related sections when include is omitted', async () => {
    await withProduct(async (methods, call) => {
      expect(await call()).toEqual({
        product: { id: 'p', product_family_id: 'f' },
        family: { id: 'f', name: 'Family' },
        variants: [{ id: 'v' }],
        categories: [{ id: 'c', name: 'Category' }],
        assets: [{ id: 'a' }],
      });
      expect(Object.values(methods).every(method => method.mock.calls.length === 1)).toBe(true);
    });
  });

  it('fetches selected sections once and omits unfetched sections', async () => {
    await withProduct(async (methods, call) => {
      expect(await call(['categories', 'categories', 'assets'])).toEqual({
        product: { id: 'p', product_family_id: 'f' },
        categories: [{ id: 'c', name: 'Category' }],
        assets: [{ id: 'a' }],
      });
      expect(methods.getProduct).toHaveBeenCalledOnce();
      expect(methods.getFamily).not.toHaveBeenCalled();
      expect(methods.getProductVariants).not.toHaveBeenCalled();
      expect(methods.getProductCategories).toHaveBeenCalledOnce();
      expect(methods.getProductAssets).toHaveBeenCalledOnce();
    });
  });

  it('performs only the base product request when no sections are selected', async () => {
    await withProduct(async (methods, call) => {
      expect(await call([])).toEqual({ product: { id: 'p', product_family_id: 'f' } });
      expect(methods.getProduct).toHaveBeenCalledOnce();
      expect(methods.getFamily).not.toHaveBeenCalled();
      expect(methods.getProductVariants).not.toHaveBeenCalled();
      expect(methods.getProductCategories).not.toHaveBeenCalled();
      expect(methods.getProductAssets).not.toHaveBeenCalled();
    });
  });

  it('retains successful selected sections and reports only requested failures', async () => {
    await withProduct(async (methods, call) => {
      methods.getFamily.mockRejectedValue(new Error('Family unavailable'));
      methods.getProductCategories.mockRejectedValue(new Error('Categories unavailable'));
      expect(await call(['family', 'assets'])).toEqual({
        product: { id: 'p', product_family_id: 'f' },
        family: null,
        assets: [{ id: 'a' }],
        partial: true,
        _errors: ['family: Family unavailable'],
      });
      expect(methods.getProductCategories).not.toHaveBeenCalled();
    });
  });

  it('identifies partial family metadata returned by the documented search fallback', async () => {
    await withProduct(async (methods, call) => {
      const meta = {
        source: 'family_search', complete: false,
        reason: 'Family detail endpoint unavailable (HTTP 403); returned available search fields.',
      };
      methods.getFamily.mockResolvedValue({ data: [{ id: 'f', name: 'Family' }], meta });
      expect(await call(['family'])).toEqual({
        product: { id: 'p', product_family_id: 'f' },
        family: { id: 'f', name: 'Family' },
        partial: true,
        _retrieval: { family: meta },
      });
    });
  });
});
