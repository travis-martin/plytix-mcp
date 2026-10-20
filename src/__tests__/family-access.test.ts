import { afterEach, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';

const credentials = { apiKey: 'fixture', apiPassword: 'fixture' };
afterEach(() => vi.restoreAllMocks());

it('recovers permitted family metadata with an exact-ID search and marks incomplete detail', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('/auth/')) return Response.json({ data: [{ access_token: 'fixture' }] });
    if (init?.method === 'GET') return new Response('', { status: 403 });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      filters: [[{ field: 'id', operator: 'eq', value: 'family' }]],
      pagination: { page: 1, page_size: 2 },
    });
    return Response.json({ data: [{ id: 'family', name: 'Example', total_attributes: 12 }] });
  });
  const result = await new PlytixClient(credentials).getFamily('family');
  expect(result.data).toEqual([{ id: 'family', name: 'Example', total_attributes: 12 }]);
  expect(result.meta).toMatchObject({ source: 'family_search', complete: false });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([401, 404, 429, 500])('does not use family search to mask HTTP %s', async status => {
  const api = new PlytixClient(credentials);
  const search = vi.spyOn(api, 'searchFamilies');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).includes('/auth/') ? Response.json({ data: [{ access_token: 'fixture' }] }) :
      new Response('', { status, headers: { 'Retry-After': '120' } }));
  await expect(api.getFamily('family')).rejects.toThrow(`HTTP ${status}`);
  expect(search).not.toHaveBeenCalled();
});

it('does not turn an empty or wrong-ID fallback into a missing-family result', async () => {
  const api = new PlytixClient(credentials);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).includes('/auth/') ? Response.json({ data: [{ access_token: 'fixture' }] }) : new Response('', { status: 403 }));
  vi.spyOn(api, 'searchFamilies').mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [{ id: 'other', name: 'Other' }] });
  await expect(api.getFamily('family')).rejects.toThrow('HTTP 403');
  await expect(api.getFamily('family')).rejects.toThrow('HTTP 403');
});
