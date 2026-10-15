import { afterEach, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';

afterEach(() => vi.restoreAllMocks());

it('preserves v1/v2 routes, methods and payloads for representative operations', async () => {
  const apiCalls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).includes('/auth/')) return Response.json({ data: [{ access_token: 'fixture', expires_in: 900 }] });
    apiCalls.push({ url: String(url), method: String(options?.method), body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json({ data: [] });
  });
  const client = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true });
  await client.searchProducts({ pagination: { page: 1, page_size: 25 }, attributes: ['sku'] });
  await client.updateProduct('product/fixture', { attributes: { field: null } });
  await client.assignProductFamily('p', 'f');
  await client.updateAsset('a', { filename: 'fixture.png', categories: ['c'] });
  await client.linkProductCategory('p', 'c');
  await client.linkProductAsset('p', 'a', 'image');
  await client.linkProductRelationship('p', 'r', [{ product_id: 'other', quantity: 2 }]);
  await client.resyncVariants('p', ['field'], ['variant']);
  expect(apiCalls).toEqual([
    { url: 'https://pim.plytix.com/api/v2/products/search', method: 'POST', body: { pagination: { page: 1, page_size: 25 }, attributes: ['sku'] } },
    { url: 'https://pim.plytix.com/api/v2/products/product%2Ffixture', method: 'PATCH', body: { attributes: { field: null } } },
    { url: 'https://pim.plytix.com/api/v2/products/p/family', method: 'POST', body: { product_family_id: 'f' } },
    { url: 'https://pim.plytix.com/api/v1/assets/a', method: 'PATCH', body: { filename: 'fixture.png', categories: [{ id: 'c' }] } },
    { url: 'https://pim.plytix.com/api/v2/products/p/categories', method: 'POST', body: { id: 'c' } },
    { url: 'https://pim.plytix.com/api/v2/products/p/assets', method: 'POST', body: { id: 'a', attribute_label: 'image' } },
    { url: 'https://pim.plytix.com/api/v2/products/p/relationships/r', method: 'POST', body: { product_relationships: [{ product_id: 'other', quantity: 2 }] } },
    { url: 'https://pim.plytix.com/api/v2/products/p/variants/resync', method: 'POST', body: { attribute_labels: ['field'], variant_ids: ['variant'] } },
  ]);
});
