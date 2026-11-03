import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { createHttpApp, loadHttpConfig } from '../http.js';
import { parseWriteApprovalMode } from '../policy.js';
import { elicitWriteApproval, type ToolPolicyOptions } from '../tools/register.js';

const cleanup: Array<() => Promise<void>> = [];
const arguments_ = { product_id: 'fixture-product', label: 'Reviewed label' };
const authResponse = () => Response.json({ data: [{ access_token: 'fixture-token', expires_in: 900 }] });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function memory(mode?: 'form' | 'host', writes = new Set(['products_update'])) {
  const api = new PlytixClient({ apiKey: 'fixture-key', apiPassword: 'fixture-password', allowWrites: writes.size > 0, writeTools: writes });
  const provider = vi.fn(elicitWriteApproval);
  const options: ToolPolicyOptions = { ...(mode === 'host' ? {} : { requestWriteApproval: provider }), ...(mode ? { writeApprovalMode: mode } : {}) };
  const server = createServer(api, writes, options);
  // Deliberately no elicitation support: host mode must not need the second form.
  const client = new Client({ name: 'host-permission-fixture', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { api, client, provider };
}

function upstreamFixture() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === 'https://auth.plytix.com/auth/api/get-token') return authResponse();
    if (String(url) !== 'https://pim.plytix.com/api/v2/products/fixture-product') throw new Error('Unexpected fixture destination');
    if (init?.method === 'PATCH') expect(JSON.parse(String(init.body))).toEqual({ label: 'Reviewed label' });
    else expect(init?.method).toBe('GET');
    return Response.json({ data: [{ id: 'fixture-product', label: 'Reviewed label' }] });
  });
}

it('defaults to form and accepts only the two explicit operator modes', () => {
  expect(parseWriteApprovalMode()).toBe('form');
  expect(parseWriteApprovalMode('form')).toBe('form');
  expect(parseWriteApprovalMode('host')).toBe('host');
  expect(loadHttpConfig({ MCP_WRITE_APPROVAL_MODE: 'host' }).writeApprovalMode).toBe('host');
});

it.each(['', 'HOST', 'true', 'none', 'auto', '*'])('rejects invalid mode %j instead of relaxing approval', mode => {
  expect(() => parseWriteApprovalMode(mode)).toThrow();
  expect(() => loadHttpConfig({ MCP_WRITE_APPROVAL_MODE: mode })).toThrow();
});

it('retains the default form requirement and cannot switch mode through tool arguments', async () => {
  const fetch = upstreamFixture(), fixture = await memory();
  const result = await fixture.client.callTool({ name: 'products_update', arguments: { ...arguments_, writeApprovalMode: 'host', approved: true } });
  expect(result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(fixture.provider).toHaveBeenCalledOnce();
});

it('executes an allowlisted host-mode update without a form and allows independent readback', async () => {
  const fetch = upstreamFixture(), fixture = await memory('host');
  const begin = vi.spyOn(fixture.api, 'beginApprovedWrite');
  const result = await fixture.client.callTool({ name: 'products_update', arguments: arguments_ });
  expect(result.isError).not.toBe(true);
  expect(begin).toHaveBeenCalledOnce();
  expect(fixture.provider).not.toHaveBeenCalled();
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    ['https://auth.plytix.com/auth/api/get-token', 'POST'],
    ['https://pim.plytix.com/api/v2/products/fixture-product', 'PATCH'],
  ]);
  const readback = await fixture.client.callTool({ name: 'products_get', arguments: { product_id: 'fixture-product' } });
  expect(readback.isError).not.toBe(true);
  expect(JSON.stringify(readback)).toContain('Reviewed label');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('host mode still stops rejected API authentication before sending a mutation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fixture-secret', { status: 401 }));
  const fixture = await memory('host');
  const result = await fixture.client.callTool({ name: 'products_update', arguments: arguments_ });
  expect(result.isError).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0][0])).toBe('https://auth.plytix.com/auth/api/get-token');
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

it('host mode neither advertises nor executes omitted tools', async () => {
  const fetch = upstreamFixture(), fixture = await memory('host', new Set());
  expect((await fixture.client.listTools()).tools.some(tool => tool.name === 'products_update')).toBe(false);
  const result = await fixture.client.callTool({ name: 'products_update', arguments: arguments_ });
  expect(result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('host mode keeps API route isolation even if a handler tries a different write route', async () => {
  const fetch = upstreamFixture(), fixture = await memory('host');
  vi.spyOn(fixture.api, 'updateProduct').mockImplementation(() => fixture.api.createProduct({ sku: 'forbidden-create' }));
  const result = await fixture.client.callTool({ name: 'products_update', arguments: arguments_ });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('not authorized for this tool operation');
  expect(fetch).not.toHaveBeenCalled();
});

it('host mode does not execute after cancellation or silently truncate large arguments', async () => {
  const fetch = upstreamFixture(), fixture = await memory('host');
  const tooLarge = await fixture.client.callTool({ name: 'products_update', arguments: { ...arguments_, label: 'x'.repeat(16_001) } });
  expect(tooLarge.isError).toBe(true);
  fixture.api.cancel();
  const cancelled = await fixture.client.callTool({ name: 'products_update', arguments: arguments_ });
  expect(cancelled.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(fixture.provider).not.toHaveBeenCalled();
});

it('diagnostics identify host reliance without claiming that a human approval was verified', async () => {
  const fixture = await memory('host');
  const result = await fixture.client.callTool({ name: 'approval_capabilities', arguments: {} });
  expect(result.structuredContent).toMatchObject({ data: { mode: 'host', nested_form_required: false, write_authorized: false } });
});

it.each([false, true])('authenticated HTTP host mode persists rules without elicitation (sessions=%s)', async approvalSessions => {
  const directory = await mkdtemp(join(tmpdir(), 'host-mode-pricing-fixture-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('PLYTIX_PRICING_DIR', directory);
  vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', '');
  const originalFetch = globalThis.fetch;
  const upstream = vi.fn(async () => authResponse());
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, init);
    if (String(url) !== 'https://auth.plytix.com/auth/api/get-token') throw new Error('Unexpected fixture upstream request');
    return upstream();
  });
  const token = 'fixture-service-token-long-enough-for-testing';
  const app = createHttpApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: [], authToken: token,
    writeTools: new Set(['pricing_rules_save']), approvalSessions, writeApprovalMode: 'host' });
  const listener = await new Promise<Server>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  cleanup.push(async () => {
    await app.locals.closeApprovalSessions?.();
    await new Promise<void>(resolve => { listener.closeAllConnections(); listener.close(() => resolve()); });
  });
  const address = listener.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  expect((await originalFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  const client = new Client({ name: 'host-mode-http-fixture', version: '1' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: {
    'X-MCP-Token': token, 'X-Plytix-API-Key': 'fixture-key', 'X-Plytix-API-Password': 'fixture-password',
  } } });
  await client.connect(transport);
  cleanup.push(async () => { if (approvalSessions) await transport.terminateSession(); await client.close(); });
  const saved = await client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 0, rules: [] } });
  expect(saved.isError).not.toBe(true);
  expect(saved.structuredContent).toMatchObject({ data: { revision: 1 } });
  expect(upstream).toHaveBeenCalledOnce();
  const readback = await client.callTool({ name: 'pricing_rules_get', arguments: {} });
  expect(readback.structuredContent).toMatchObject({ data: { revision: 1, rules: [] } });
  expect(upstream).toHaveBeenCalledTimes(2);
});
