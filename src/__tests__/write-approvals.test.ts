import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { elicitWriteApproval, type WriteApprovalProvider } from '../tools/register.js';
import { isWriteRequestForTool, WRITE_TOOLS } from '../policy.js';

const cleanup: Array<() => Promise<void>> = [];
const args = { product_id: 'fixture-product', label: 'Reviewed label' };
async function setup(provider?: WriteApprovalProvider, elicitationResult?: ElicitResult) {
  const api = new PlytixClient({
    apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['products_update']),
  });
  const update = vi.spyOn(api, 'updateProduct').mockResolvedValue({ data: [{ id: 'fixture-product' }] });
  const server = createServer(api, new Set(['products_update']), { requestWriteApproval: provider });
  const client = new Client({ name: 'approval-fixture', version: '1' },
    elicitationResult ? { capabilities: { elicitation: { form: {} } } } : {});
  const elicitation = vi.fn(async (_request: unknown) => elicitationResult!);
  if (elicitationResult) client.setRequestHandler(ElicitRequestSchema, elicitation);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { api, client, update, elicitation };
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()));
  vi.restoreAllMocks();
});

describe('write approval boundary', () => {
  it('blocks an allowlisted write when no trusted approval provider exists', async () => {
    const { client, update } = await setup();
    const result = await client.callTool({ name: 'products_update', arguments: { ...args, approved: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('approval is unavailable');
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the exact validated arguments and asks independently for each call', async () => {
    const approval = vi.fn<WriteApprovalProvider>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { client, update } = await setup(approval);
    const first = await client.callTool({ name: 'products_update', arguments: args });
    const second = await client.callTool({ name: 'products_update', arguments: { ...args, label: 'Different' } });
    expect(first.isError).not.toBe(true);
    expect(second.isError).toBe(true);
    expect(update).toHaveBeenCalledExactlyOnceWith('fixture-product', { label: 'Reviewed label' });
    expect(approval).toHaveBeenCalledTimes(2);
    expect(approval.mock.calls[0][0].toolName).toBe('products_update');
    expect(JSON.parse(approval.mock.calls[0][0].argumentsJson)).toEqual(args);
    expect(JSON.parse(approval.mock.calls[1][0].argumentsJson).label).toBe('Different');
    expect(Object.isFrozen(approval.mock.calls[0][0])).toBe(true);
  });

  it('does not leak approval provider errors or start a mutation', async () => {
    const { client, update } = await setup(async () => { throw new Error('fixture-secret'); });
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(update).not.toHaveBeenCalled();
  });

  it('gives approved execution its full budget after time spent awaiting the user', async () => {
    let time = Date.now();
    const { api, client, update } = await setup(async () => { time += 29_000; return true; });
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [{ access_token: 'fixture', expires_in: 900 }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'fixture-product' }] }));
    update.mockImplementation(async () => {
      // This work exceeds the original operation deadline but fits the renewed budget.
      time += 20_000;
      return api.call('/api/v2/products/fixture-product', { method: 'PATCH', body: '{"label":"Reviewed label"}' });
    });
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed for oversized arguments rather than showing a truncated approval', async () => {
    const approval = vi.fn<WriteApprovalProvider>().mockResolvedValue(true);
    const { client, update } = await setup(approval);
    const result = await client.callTool({
      name: 'products_update', arguments: { ...args, label: 'x'.repeat(16_001) },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('approval review limit');
    expect(approval).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed when the host cannot elicit user approval', async () => {
    const { client, update } = await setup(elicitWriteApproval);
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'decline' },
    { action: 'cancel' },
    { action: 'accept', content: { confirmation: 'yes' } },
  ] as ElicitResult[])('does not accept $action without exact confirmation', async response => {
    const { client, update, elicitation } = await setup(elicitWriteApproval, response);
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).toBe(true);
    expect(elicitation).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts host user elicitation for the displayed action only', async () => {
    const { client, update, elicitation } = await setup(elicitWriteApproval,
      { action: 'accept', content: { confirmation: 'APPROVE' } });
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).not.toBe(true);
    expect(update).toHaveBeenCalledOnce();
    const request = elicitation.mock.calls[0][0] as unknown as { params: { message: string } };
    expect(request.params.message).toContain('products_update');
    expect(request.params.message).toContain(JSON.stringify(args, null, 2));
  });

  it('cancels pending approval even when a provider ignores its signal', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { release = resolve; });
    const { api, client, update } = await setup(async () => { entered(); return pending; });
    const controller = new AbortController();
    const call = client.callTool({ name: 'products_update', arguments: args }, undefined, { signal: controller.signal });
    const rejected = expect(call).rejects.toBeDefined();
    await started;
    controller.abort();
    await rejected;
    await api.waitForIdle();
    release(true);
    expect(update).not.toHaveBeenCalled();
    const next = await client.callTool({ name: 'identifier_detect', arguments: { value: 'fixture-sku' } });
    expect(next.isError).not.toBe(true);
  });
});

describe('per-tool API route policy', () => {
  const routes = [
    ['products_create', 'POST', '/api/v2/products'],
    ['products_update', 'PATCH', '/api/v2/products/id'],
    ['products_set_attribute', 'PATCH', '/api/v2/products/id'],
    ['products_clear_attribute', 'PATCH', '/api/v2/products/id'],
    ['products_assign_family', 'POST', '/api/v2/products/id/family'],
    ['families_create', 'POST', '/api/v1/product_families'],
    ['families_link_attribute', 'POST', '/api/v1/product_families/id/attributes/link'],
    ['families_unlink_attribute', 'POST', '/api/v1/product_families/id/attributes/unlink'],
    ['assets_update', 'PATCH', '/api/v1/assets/id'],
    ['assets_link', 'POST', '/api/v2/products/id/assets'],
    ['assets_unlink', 'DELETE', '/api/v2/products/id/assets/asset'],
    ['categories_link', 'POST', '/api/v2/products/id/categories'],
    ['categories_unlink', 'DELETE', '/api/v2/products/id/categories/category'],
    ['variants_create', 'POST', '/api/v2/products/id/variants'],
    ['variants_link', 'POST', '/api/v2/products/id/variant/variant'],
    ['variants_unlink', 'DELETE', '/api/v2/products/id/variant/variant'],
    ['variants_resync', 'POST', '/api/v2/products/id/variants/resync'],
    ['relationships_link_product', 'POST', '/api/v2/products/id/relationships/relationship'],
    ['relationships_unlink_product', 'DELETE', '/api/v2/products/id/relationships/relationship'],
    ['relationships_set_quantity', 'PATCH', '/api/v2/products/id/relationships/relationship'],
  ];
  it('classifies every enabled mutation and rejects changed methods/routes', () => {
    expect(new Set(routes.map(([name]) => name))).toEqual(WRITE_TOOLS);
    for (const [name, method, path] of routes) {
      expect(isWriteRequestForTool(name, path, method)).toBe(true);
      expect(isWriteRequestForTool(name, `${path}/unexpected`, method)).toBe(false);
      expect(isWriteRequestForTool(name, path, 'PUT')).toBe(false);
      expect(isWriteRequestForTool('products_get', path, method)).toBe(false);
    }
    expect(isWriteRequestForTool('products_update', '/api/v2/products', 'POST')).toBe(false);
    expect(isWriteRequestForTool('constructor', '/api/v2/products', 'POST')).toBe(false);
  });
});
