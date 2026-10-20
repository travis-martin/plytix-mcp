import { afterEach, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';

const credentials = { apiKey: 'fixture', apiPassword: 'fixture' };
const auth = () => Response.json({ data: [{ access_token: 'fixture' }] });
afterEach(() => vi.restoreAllMocks());

it('deduplicates concurrent and sequential identical reads only within one invocation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).includes('/auth/') ? auth() : Response.json({ data: [{ id: 'p', label: 'Original' }] }));
  const api = new PlytixClient(credentials);
  await api.runOperation(async () => {
    const [a, b] = await Promise.all([api.getProduct('p'), api.getProduct('p')]);
    a.data[0].label = 'Changed by consumer';
    expect(b.data[0].label).toBe('Original');
    expect((await api.getProduct('p')).data[0].label).toBe('Original');
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  await api.runOperation(() => api.getProduct('p'));
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('invalidates prior reads before a write so verification cannot return stale state', async () => {
  let label = 'Before';
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('/auth/')) return auth();
    if (init?.method === 'PATCH') label = 'After';
    return Response.json({ data: [{ id: 'p', label }] });
  });
  const api = new PlytixClient({ ...credentials, allowWrites: true, writeTools: new Set(['products_update']) });
  await api.runOperation(async () => {
    expect((await api.getProduct('p')).data[0].label).toBe('Before');
    await api.updateProduct('p', { label: 'After' });
    expect((await api.getProduct('p')).data[0].label).toBe('After');
  }, undefined, 'products_update');
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('does not retain a rejected read and respects cancellation even on a cache hit', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth())
    .mockResolvedValueOnce(new Response('', { status: 403 }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'p' }] }));
  const api = new PlytixClient(credentials);
  const controller = new AbortController();
  await api.runOperation(async () => {
    await expect(api.getProduct('p')).rejects.toThrow('HTTP 403');
    await api.getProduct('p');
    controller.abort();
    await expect(api.getProduct('p')).rejects.toThrow('cancelled');
  }, controller.signal);
  expect(fetch).toHaveBeenCalledTimes(3);
});
