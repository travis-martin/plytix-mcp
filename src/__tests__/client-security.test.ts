import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlytixClient } from '../client.js';
import { PlytixLookup } from '../lookup/lookup.js';

const auth = () => Response.json({ data: [{ access_token: 'fixture-jwt', expires_in: 900 }] });
const credentials = { apiKey: 'fixture-key', apiPassword: 'fixture-password' };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Plytix API security boundaries', () => {
  it('blocks writes before authentication and permits exact search POSTs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
    const client = new PlytixClient(credentials);
    await expect(client.createProduct({ sku: 'fixture' })).rejects.toThrow('Writes are disabled');
    await expect(client.call('/api/v2/products/search/extra', { method: 'POST' })).rejects.toThrow('Writes are disabled');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(auth()).mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(client.searchProducts({})).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenLastCalledWith('https://pim.plytix.com/api/v2/products/search', expect.objectContaining({ method: 'POST', redirect: 'error' }));
  });

  it('does not reuse a JWT for the same key with a wrong password in another client', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth()).mockResolvedValueOnce(Response.json({ data: [{ id: 'fixture' }] }))
      .mockResolvedValueOnce(new Response('fixture-password should never leak', { status: 401 }));
    await new PlytixClient(credentials).getProduct('fixture');
    const changed = new PlytixClient({ ...credentials, apiPassword: 'wrong-fixture-password' });
    await expect(changed.getProduct('fixture')).rejects.toThrow('authentication failed (HTTP 401)');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe('https://auth.plytix.com/auth/api/get-token');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).api_password).toBe('wrong-fixture-password');
  });

  it('refreshes a rejected token once for reads and strips response bodies from errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response('secret', { status: 401 }))
      .mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response('secret', { status: 403 }));
    const error = await new PlytixClient(credentials).getProduct('fixture').catch(e => e);
    expect(String(error)).toContain('HTTP 403');
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.response).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([401, 429, 503])('never retries a write after HTTP %s', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(new Response('secret', { status, headers: { 'Retry-After': '0' } }));
    await expect(new PlytixClient({ ...credentials, allowWrites: true }).createProduct({ sku: 'fixture' })).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds rate-limit delays, retries one short read delay, and stops long waits', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth())
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const result = new PlytixClient(credentials).getProduct('fixture');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
    await expect(new PlytixClient(credentials).getProduct('fixture')).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('times out the response body and suppresses transport error details', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(auth()).mockImplementationOnce(async (_url, init) => {
      return new Response(new ReadableStream({ start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error('fixture-secret')));
      } }));
    });
    await expect(new PlytixClient({ ...credentials, timeoutMs: 20 }).getProduct('fixture')).rejects.toThrow('Plytix request failed or timed out');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe endpoint overrides and path traversal before sending credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(() => new PlytixClient({ ...credentials, baseUrl: 'http://untrusted.invalid' })).toThrow('HTTPS');
    const client = new PlytixClient(credentials);
    await expect(client.call('https://untrusted.invalid')).rejects.toThrow('Invalid API path');
    await expect(client.getProduct('..')).rejects.toThrow('Invalid API path');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports rejected authentication for schema discovery and product lookup', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('fixture-secret', { status: 401 }));
    await expect(new PlytixClient(credentials).getProductAttributes()).rejects.toThrow('authentication failed');
    const lookup = new PlytixLookup(new PlytixClient(credentials));
    await expect(lookup.findByIdentifier('fixture-sku')).rejects.toThrow('authentication failed');
    await expect(lookup.findProducts({ sku: 'fixture-sku' })).rejects.toThrow('authentication failed');
  });

  it('bounds metadata pagination and detail concurrency and rejects incomplete schema', async () => {
    const client = new PlytixClient(credentials);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/auth/') ? auth() :
      Response.json({ data: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) }));
    await expect(client.searchAttributeIds()).rejects.toThrow('five-page limit');
    vi.restoreAllMocks();
    vi.spyOn(client, 'searchAttributeIds').mockResolvedValue(Array.from({ length: 25 }, (_, i) => String(i)));
    let active = 0, peak = 0;
    vi.spyOn(client, 'getAttributeById').mockImplementation(async id => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { id, label: `field_${id}`, name: id, type_class: 'TextAttribute' };
    });
    await expect(client.getAttributeByLabel('field_24')).resolves.toMatchObject({ id: '24' });
    expect(peak).toBe(4);
    const failing = new PlytixClient(credentials);
    vi.spyOn(failing, 'searchAttributeIds').mockResolvedValue(['1']);
    vi.spyOn(failing, 'getAttributeById').mockRejectedValue(new Error('fixture failure'));
    await expect(failing.getAttributeByLabel('missing')).rejects.toThrow('fixture failure');
  });

  it('bounds each operation and cancellation stops future requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/auth/') ? auth() : Response.json({ data: [] }));
    const client = new PlytixClient(credentials);
    await expect(client.runOperation(async () => {
      for (let i = 0; i < 513; i++) await client.getProduct('fixture');
    })).rejects.toThrow('512 request budget');
    await expect(client.runOperation(() => client.getProduct('fixture'))).resolves.toEqual({ data: [] });
    client.cancel();
    await expect(client.getProduct('fixture')).rejects.toThrow('cancelled');
  });

  it('discovers 250 attributes through real client requests within the operation budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/auth/')) return auth();
      if (String(url).endsWith('/search')) {
        const page = JSON.parse(String(init?.body)).pagination.page;
        const start = (page - 1) * 100;
        return Response.json({ data: Array.from({ length: Math.min(100, 250 - start) }, (_, i) => ({ id: String(start + i) })) });
      }
      const id = String(url).split('/').at(-1)!;
      return Response.json({ data: [{ id, label: `field_${id}`, name: id, type_class: 'TextAttribute' }] });
    });
    const client = new PlytixClient(credentials);
    await expect(client.runOperation(() => client.getAttributeByLabel('field_249'))).resolves.toMatchObject({ id: '249' });
  });
});
