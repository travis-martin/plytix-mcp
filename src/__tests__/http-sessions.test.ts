import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createHttpApp } from '../http.js';
import { PlytixClient } from '../client.js';
import type { Server } from 'node:http';
import { PricingService } from '../pricing/service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const headers = { 'X-MCP-Token': 'fixture-secret-123456789012345678901234567890', 'X-Plytix-API-Key': 'key', 'X-Plytix-API-Password': 'password' };
async function setup(approval?: 'APPROVE' | 'NO' | 'EMPTY' | 'CHECK', maximum = 4,
  formRoute: 'standard' | 'openai/form' | 'openai/elicitation/create' = 'standard') {
  const directory = await mkdtemp(join(tmpdir(), 'http-pricing-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('PLYTIX_PRICING_DIR', directory);
  vi.spyOn(PlytixClient.prototype, 'verifyKnowledgeAccess').mockResolvedValue();
  const app = createHttpApp({ host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: [], authToken: headers['X-MCP-Token'], writeTools: new Set(['pricing_rules_save']), approvalSessions: true, maxConcurrentRequests: maximum });
  const listener = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  cleanup.push(async () => { await app.locals.closeApprovalSessions(); await new Promise<void>(resolve => { listener.closeAllConnections(); listener.close(() => resolve()); }); });
  const address = listener.address() as { port: number }; const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const extensions = formRoute === 'openai/elicitation/create' ? { 'openai/elicitation': { form: {} } }
    : formRoute === 'openai/form' ? { 'openai/form': {} } : {};
  const client = new Client({ name: 'trusted-fixture', version: '1' }, { capabilities: approval ? { elicitation: { form: {} }, extensions } : {} });
  const requests: unknown[] = [];
  if (approval) {
    const handler = async (request: { method: string; params?: unknown }) => {
      requests.push(request);
      return { action: 'accept' as const, content: approval === 'EMPTY' ? {} : { confirmation: approval } };
    };
    client.setRequestHandler(ElicitRequestSchema, handler);
    if (formRoute !== 'standard') client.setRequestHandler(z.object({ method: z.literal(formRoute), params: z.record(z.unknown()) }), handler);
  }
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await client.connect(transport);
  cleanup.push(async () => { await transport.terminateSession().catch(() => {}); await client.close(); });
  return { client, transport, url, requests, app };
}
it.each(['standard', 'openai/form', 'openai/elicitation/create'] as const)('round-trips exact approval over authenticated HTTP (%s) and persists the approved rules', async route => {
  const f = await setup('APPROVE', 4, route);
  const result = await f.client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 0, rules: [] } });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ data: { revision: 1 } });
  expect(JSON.stringify(f.requests)).toContain('expected_revision');
  expect(JSON.stringify(f.requests)).not.toContain(headers['X-Plytix-API-Password']);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ method: route === 'standard' ? 'elicitation/create' : route });
});
it.each([undefined, 'NO', 'EMPTY', 'CHECK'] as const)('refuses remote writes without exact human form approval (%s)', async approval => {
  const f = await setup(approval);
  const result = await f.client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 0, rules: [] } });
  expect(result.isError).toBe(true);
  const rules = await f.client.callTool({ name: 'pricing_rules_get', arguments: {} });
  expect(rules.structuredContent).toMatchObject({ data: { revision: 0 } });
  if (approval === 'EMPTY') expect(JSON.stringify(result)).toContain('acceptance without the required form input');
});
it('exposes negotiated support and checks native form input without approving a later write', async () => {
  const f = await setup('CHECK', 4, 'openai/form');
  const beginWrite = vi.spyOn(PlytixClient.prototype, 'beginApprovedWrite');
  const support = await f.client.callTool({ name: 'approval_capabilities', arguments: {} });
  expect(support.structuredContent).toMatchObject({ data: { route: 'openai/form', supported: true, write_authorized: false } });
  expect(f.requests).toHaveLength(0);
  const check = await f.client.callTool({ name: 'approval_check', arguments: {} });
  expect(check.structuredContent).toMatchObject({ data: { verified: true, write_authorized: false } });
  expect(f.requests).toHaveLength(1);
  expect(beginWrite).not.toHaveBeenCalled();
  const attemptedWrite = await f.client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 0, rules: [] } });
  expect(attemptedWrite.isError).toBe(true);
  expect(beginWrite).not.toHaveBeenCalled();
  expect((await f.client.callTool({ name: 'pricing_rules_get', arguments: {} })).structuredContent).toMatchObject({ data: { revision: 0 } });
});
it('rejects cross-credential session access and missing service authentication', async () => {
  const f = await setup();
  const request = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Session-Id': f.transport.sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) };
  expect((await fetch(f.url, { ...request, headers: { ...request.headers, 'X-Plytix-API-Password': 'other' } })).status).toBe(404);
  expect((await fetch(f.url, { ...request, headers: { ...request.headers, 'X-MCP-Token': '' } })).status).toBe(401);
  expect((await f.client.listTools()).tools.length).toBeGreaterThan(1);
});

it('deleting a session cancels a pending approval before its handler can mutate', async () => {
  const f = await setup('APPROVE');
  const save = vi.spyOn(PricingService.prototype, 'rulesSave');
  let arrived!: () => void; const shown = new Promise<void>(resolve => { arrived = resolve; });
  f.client.setRequestHandler(ElicitRequestSchema, async () => { arrived(); return await new Promise<never>(() => {}); });
  const call = f.client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 0, rules: [] } }).then(result => result, () => null);
  await shown;
  await f.transport.terminateSession();
  await f.client.close();
  await call;
  expect(save).not.toHaveBeenCalled();
});

it('shutdown cancels pending approvals and refuses newly initialized sessions', async () => {
  const f = await setup('APPROVE');
  const save = vi.spyOn(PricingService.prototype, 'rulesSave');
  let arrived!: () => void; const shown = new Promise<void>(resolve => { arrived = resolve; });
  f.client.setRequestHandler(ElicitRequestSchema, async () => { arrived(); return await new Promise<never>(() => {}); });
  const call = f.client.callTool({ name: 'pricing_rules_save', arguments: { expected_revision: 0, rules: [] } }).then(result => result, () => null);
  await shown;
  await f.app.locals.closeApprovalSessions();
  await f.client.close();
  await call;
  expect(save).not.toHaveBeenCalled();
  const response = await fetch(f.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'new', version: '1' } } }) });
  expect(response.status).toBe(503);
});

it('retains session capacity until cancelled work actually drains', async () => {
  const f = await setup(undefined, 1);
  let drained!: () => void;
  vi.spyOn(PlytixClient.prototype, 'waitForIdle').mockImplementation(() => new Promise<void>(resolve => { drained = resolve; }));
  await f.transport.terminateSession();
  try {
    const response = await fetch(f.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'new', version: '1' } } }) });
    expect(response.status).toBe(429);
  } finally { drained(); }
});
