import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';

afterEach(() => vi.restoreAllMocks());

it('honors SDK cancellation before a pending write and permits the next stdio operation', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const api = new PlytixClient({
    apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['products_set_attribute']),
  });
  vi.spyOn(api, 'getAttributeByLabel').mockImplementation(async () => {
    entered(); await pending;
    return { id: 'fixture-field', label: 'field', name: 'Field', type_class: 'TextAttribute' };
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).includes('/auth/')) return Response.json({ data: [{ access_token: 'fixture', expires_in: 900 }] });
    return Response.json({ data: [{ id: 'fixture', sku: 'FIXTURE' }] });
  });
  const server = createServer(api, new Set(['products_set_attribute']), { requestWriteApproval: async () => true });
  const client = new Client({ name: 'fixture-stdio-cancel', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const controller = new AbortController();
    const work = client.callTool({ name: 'products_set_attribute', arguments: {
      product_id: 'fixture', attribute_label: 'field', value: 'fixture',
    } }, undefined, { signal: controller.signal });
    const rejected = expect(work).rejects.toBeDefined();
    await started;
    controller.abort(); await rejected;
    release(); await api.waitForIdle();
    expect(fetchMock).not.toHaveBeenCalled();
    const next = await client.callTool({ name: 'products_get', arguments: { product_id: 'fixture' } });
    expect(next.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { release(); await client.close(); await server.close(); }
});

it('aborts an in-flight fetch on operation cancellation without poisoning future work', async () => {
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ data: [{ access_token: 'fixture', expires_in: 900 }] }))
    .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      entered(); init?.signal?.addEventListener('abort', () => reject(new Error('fixture abort')));
    }))
    .mockResolvedValueOnce(Response.json({ data: [] }));
  const controller = new AbortController();
  const work = api.runOperation(() => api.getProduct('fixture'), controller.signal);
  const rejected = expect(work).rejects.toThrow('Plytix request failed or timed out');
  await started; controller.abort(); await rejected;
  await expect(api.runOperation(() => api.getProduct('fixture'))).resolves.toEqual({ data: [] });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('bounds cumulative JSON retained across otherwise acceptable upstream responses', async () => {
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  const body = JSON.stringify({ data: [], padding: 'x'.repeat(3 * 1024 * 1024) });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/auth/') ?
    Response.json({ data: [{ access_token: 'fixture', expires_in: 900 }] }) : new Response(body));
  await expect(api.runOperation(async () => {
    for (let i = 0; i < 3; i++) await api.getProduct('fixture');
  })).rejects.toThrow('aggregate response size limit');
  await expect(api.runOperation(() => api.getProduct('fixture'))).resolves.toMatchObject({ data: [] });
});
