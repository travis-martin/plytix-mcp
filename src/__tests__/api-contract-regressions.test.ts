import { afterEach, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';

const credentials = { apiKey: 'fixture', apiPassword: 'fixture' };
const auth = () => Response.json({ data: [{ access_token: 'fixture' }] });
afterEach(() => vi.restoreAllMocks());

it('unwraps real filter envelopes and preserves supported operators/options', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).includes('/auth/') ? auth() : Response.json({ data: [{ attributes: [
      { key: 'sku', filter_type: 'TextAttribute', operators: ['eq', '!like'] },
      { key: 'attributes.finish', filter_type: 'DropdownAttribute', options: ['Matte'], operators: ['eq'] },
    ], properties: [{ key: '_has_variations', filter_type: 'BooleanAttribute', operators: ['eq'] }] }] }));
  const result = await new PlytixClient(credentials).getProductAttributes();
  expect(result.system).toEqual(['sku', '_has_variations']);
  expect(result.custom).toEqual([{ key: 'attributes.finish', filter_type: 'DropdownAttribute', options: ['Matte'], operators: ['eq'] }]);
});

it('supplies required empty filters and useful asset metadata projection without overriding caller choices', async () => {
  const bodies: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('/auth/')) return auth();
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ data: [] });
  });
  const api = new PlytixClient(credentials);
  await api.searchAssets({ pagination: { page: 1, page_size: 2 } });
  await api.searchAssets({ filters: [[{ field: 'filename', operator: '!like', value: 'old' }]], attributes: ['alt_text'] });
  expect(bodies[0]).toMatchObject({ filters: [], attributes: expect.arrayContaining(['filename', 'alt_text', 'url']) });
  expect(bodies[1]).toEqual({ filters: [[{ field: 'filename', operator: '!like', value: 'old' }]], attributes: ['alt_text'] });
});

it('uses the documented variants read route and rejects silent product field truncation', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).includes('/auth/') ? auth() : Response.json({ data: [] }));
  const api = new PlytixClient(credentials);
  await api.getProductVariants('parent');
  expect(fetchMock).toHaveBeenLastCalledWith('https://pim.plytix.com/api/v1/products/parent/variants', expect.anything());
  await expect(api.searchProducts({ attributes: Array.from({ length: 51 }, (_, i) => `field${i}`) })).rejects.toThrow('at most 50');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('accepts documented empty mutation success bodies but not empty read/auth responses', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const api = new PlytixClient({ ...credentials, allowWrites: true, writeTools: new Set(['relationships_set_quantity']) });
  await expect(api.runOperation(() => api.updateProductRelationship('p', 'r', []), undefined, 'relationships_set_quantity')).resolves.toEqual({ data: [] });
  await expect(api.getProduct('p')).rejects.toThrow('Empty upstream response');
});

it('requires both an exact allowlist and the matching operation even if broad writes are enabled', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const api = new PlytixClient({ ...credentials, allowWrites: true, writeTools: new Set(['products_update']) });
  await expect(api.updateProduct('p', {})).rejects.toThrow('not authorized');
  await expect(api.runOperation(() => api.createProduct({ sku: 'x' }), undefined, 'products_update')).rejects.toThrow('not authorized');
  await expect(api.runOperation(() => api.createProduct({ sku: 'x' }), undefined, 'products_create')).rejects.toThrow('not authorized');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not cache rejected or mismatched attribute metadata', async () => {
  const api = new PlytixClient(credentials);
  const search = vi.spyOn(api, 'searchAttributes').mockResolvedValue({ data: [{ id: 'a', label: 'finish' } as never] });
  vi.spyOn(api, 'getAttributeById').mockRejectedValueOnce(new Error('access denied'))
    .mockResolvedValueOnce({ id: 'a', label: 'other', name: 'Other', type_class: 'TextAttribute' });
  await expect(api.getAttributeByLabel('finish')).rejects.toThrow('access denied');
  await expect(api.getAttributeByLabel('finish')).rejects.toThrow('inconsistent label');
  expect(search).toHaveBeenCalledTimes(2);
});

it('rejects malformed read responses instead of treating them as empty data', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth()).mockResolvedValueOnce(Response.json({ error: 'private diagnostic' }));
  await expect(new PlytixClient(credentials).getProduct('p')).rejects.toThrow('Invalid Plytix response envelope');
});
