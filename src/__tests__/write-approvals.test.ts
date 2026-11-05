import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema, type ClientCapabilities, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { configureToolPolicy, elicitApprovalCheck, elicitWriteApproval, getWriteApprovalSupport, registerTool, serializeWriteApprovalArguments, writeApprovalArgumentLimit, type WriteApprovalProvider } from '../tools/register.js';
import { isWriteRequestForTool, LOCAL_DRAFT_TOOLS, READ_TOOLS, WRITE_TOOLS } from '../policy.js';

const cleanup: Array<() => Promise<void>> = [];
const args = { product_id: 'fixture-product', label: 'Reviewed label' };
async function setup(provider?: WriteApprovalProvider, elicitationResult?: ElicitResult, capabilities?: ClientCapabilities) {
  const api = new PlytixClient({
    apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['products_update']),
  });
  const update = vi.spyOn(api, 'updateProduct').mockResolvedValue({ data: [{ id: 'fixture-product' }] });
  const server = createServer(api, new Set(['products_update']), { requestWriteApproval: provider });
  const client = new Client({ name: 'approval-fixture', version: '1' },
    { capabilities: capabilities ?? (elicitationResult ? { elicitation: { form: {} } } : {}) });
  const elicitation = vi.fn(async (_request: unknown) => elicitationResult!);
  if (elicitationResult) {
    if (!capabilities || capabilities.elicitation) client.setRequestHandler(ElicitRequestSchema, elicitation);
    for (const method of ['openai/form', 'openai/elicitation/create'] as const) {
      client.setRequestHandler(z.object({ method: z.literal(method), params: z.record(z.unknown()) }), elicitation);
    }
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { api, server, client, update, elicitation };
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()));
  vi.restoreAllMocks();
});

describe('write approval boundary', () => {
  it('permits larger exact snapshots only for batch application, protected guidance and complete option snapshots', () => {
    const largeSnapshots = new Set(['pricing_review_apply', 'pricing_guidance_save', 'attributes_update_options']);
    for (const tool of largeSnapshots) expect(writeApprovalArgumentLimit(tool)).toBe(64_000);
    for (const tool of WRITE_TOOLS) if (!largeSnapshots.has(tool)) expect(writeApprovalArgumentLimit(tool)).toBe(16_000);
  });
  it('preserves every field while compacting batch and guidance approval arguments', () => {
    const input = { plans: [{ plan_id: 'fixture', changes: [{ note: 'Quoted "value"\nwith newline', children: [{ old_value: 20, new_value: 30, override: false }] }] }] };
    const snapshot = serializeWriteApprovalArguments('pricing_review_apply', input);
    expect(JSON.parse(snapshot)).toEqual(input);
    expect(snapshot).toBe(JSON.stringify(input));
    const guidance = { expected_revision: 1, instructions: [{ id: 'fixture', text: 'Quoted "value"\nwith newline' }], exclusions: [] };
    expect(serializeWriteApprovalArguments('pricing_guidance_save', guidance)).toBe(JSON.stringify(guidance));
    expect(serializeWriteApprovalArguments('products_update', input)).toBe(JSON.stringify(input, null, 2));
    const options = { expected_options: ['12\"', '2\"'], options: ['2\"', '6 mm', '12\"'], add_options: ['6 mm'] };
    expect(JSON.parse(serializeWriteApprovalArguments('attributes_update_options', options))).toEqual(options);
    expect(serializeWriteApprovalArguments('attributes_update_options', options)).toBe(JSON.stringify(options));
  });

  it('executes the complete compact batch snapshot and refuses oversized batches before approval', async () => {
    const approval = vi.fn<WriteApprovalProvider>().mockResolvedValue(true);
    const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: true, writeTools: new Set(['pricing_review_apply']) });
    const server = new McpServer({ name: 'batch-fixture', version: '1' });
    configureToolPolicy(server, new Set(['pricing_review_apply']), api, { requestWriteApproval: approval });
    const handler = vi.fn(async (_args: Record<string, unknown>) => ({ content: [{ type: 'text', text: '{}' }] }));
    registerTool(server, 'pricing_review_apply', { description: 'Fixture exact batch', inputSchema: { payload: z.string() } }, handler);
    const client = new Client({ name: 'batch-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });
    const input = { payload: 'quoted " value\n'.repeat(1500) };
    const accepted = await client.callTool({ name: 'pricing_review_apply', arguments: input });
    expect(accepted.isError).not.toBe(true);
    expect(approval.mock.calls[0][0].argumentsJson.length).toBeGreaterThan(16_000);
    expect(approval.mock.calls[0][0].argumentsJson).toBe(JSON.stringify(input));
    expect(handler).toHaveBeenCalledExactlyOnceWith(input);
    const oversized = await client.callTool({ name: 'pricing_review_apply', arguments: { payload: 'x'.repeat(64_000) } });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized)).toContain('approval review limit');
    expect(approval).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });
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
    expect(JSON.stringify(result)).toContain('did not advertise a supported approval form');
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

  it.each([
    { action: 'accept' },
    { action: 'accept', content: {} },
  ] as ElicitResult[])('reports a generic acceptance without form content and never mutates', async response => {
    const { client, update } = await setup(elicitWriteApproval, response);
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('acceptance without the required form input');
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    [{ extensions: { 'openai/elicitation': { form: {} }, 'openai/form': {} }, elicitation: { form: {} } }, 'openai/elicitation/create'],
    [{ extensions: { 'openai/form': {} }, elicitation: { form: {} } }, 'openai/form'],
    [{ elicitation: { form: {} } }, 'elicitation/create'],
  ] as const)('uses the negotiated form route without generic approval fallback (%j)', async (capabilities, method) => {
    const { server, client, update, elicitation } = await setup(elicitWriteApproval,
      { action: 'accept', content: { confirmation: 'APPROVE' } }, capabilities);
    expect(getWriteApprovalSupport(server)).toMatchObject({ supported: true, route: method });
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).not.toBe(true);
    expect(elicitation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method }), expect.anything());
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not retry declined native forms through another approval route', async () => {
    const { client, update, elicitation } = await setup(elicitWriteApproval, { action: 'decline' },
      { extensions: { 'openai/elicitation': { form: {} }, 'openai/form': {} }, elicitation: { form: {} } });
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).toBe(true);
    expect(elicitation).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('checks the native form without authorizing or executing any write', async () => {
    const { api, server, update, elicitation } = await setup(elicitWriteApproval,
      { action: 'accept', content: { confirmation: 'CHECK' } }, { extensions: { 'openai/elicitation': { form: {} } } });
    const beginWrite = vi.spyOn(api, 'beginApprovedWrite');
    const result = await elicitApprovalCheck(server);
    expect(result).toMatchObject({ verified: true, write_authorized: false, route: 'openai/elicitation/create' });
    expect(elicitation).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(beginWrite).not.toHaveBeenCalled();
  });

  it('does not treat CHECK as approval for a write', async () => {
    const { client, update } = await setup(elicitWriteApproval,
      { action: 'accept', content: { confirmation: 'CHECK' } }, { extensions: { 'openai/form': {} } });
    const result = await client.callTool({ name: 'products_update', arguments: args });
    expect(result.isError).toBe(true);
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
  it('separates read diagnostics, persisted review drafts and the batch write tool', async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    for (const name of ['approval_capabilities', 'approval_check', 'pricing_review_get']) {
      expect(READ_TOOLS.has(name)).toBe(true);
      expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
      expect(isWriteRequestForTool(name, '/api/v2/products/p', 'PATCH')).toBe(false);
    }
    for (const name of ['pricing_review_create', 'pricing_review_update', 'pricing_review_plan']) {
      expect(LOCAL_DRAFT_TOOLS.has(name)).toBe(true);
      expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(isWriteRequestForTool(name, '/api/v2/products/p', 'PATCH')).toBe(false);
    }
    expect(tools.some(tool => tool.name === 'pricing_review_apply')).toBe(false);
  });
  const routes = [
    ['products_create', 'POST', '/api/v2/products'],
    ['products_update', 'PATCH', '/api/v2/products/id'],
    ['products_set_attribute', 'PATCH', '/api/v2/products/id'],
    ['products_clear_attribute', 'PATCH', '/api/v2/products/id'],
    ['attributes_update_options', 'PATCH', '/api/v1/attributes/product/id'],
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
    const storageOnly = ['pricing_rules_save', 'pricing_guidance_save'];
    expect(new Set([...routes.map(([name]) => name), 'pricing_apply', 'pricing_review_apply', ...storageOnly])).toEqual(WRITE_TOOLS);
    for (const tool of ['pricing_apply', 'pricing_review_apply']) {
      expect(isWriteRequestForTool(tool, '/api/v2/products/p', 'PATCH')).toBe(true);
      expect(isWriteRequestForTool(tool, '/api/v2/products', 'POST')).toBe(false);
      expect(isWriteRequestForTool(tool, '/api/v2/products/p', 'DELETE')).toBe(false);
      expect(isWriteRequestForTool(tool, '/api/v2/products/p/variants/resync', 'POST')).toBe(false);
    }
    for (const tool of storageOnly) {
      for (const [, method, path] of routes) expect(isWriteRequestForTool(tool, path, method)).toBe(false);
    }
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
