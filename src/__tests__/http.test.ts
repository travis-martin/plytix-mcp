import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp, loadHttpConfig, type HttpConfig } from '../http.js';
import { PlytixClient } from '../client.js';
import { READ_TOOLS, WRITE_TOOLS, parseWriteTools } from '../policy.js';

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  'X-Plytix-API-Key': 'fixture-key', 'X-Plytix-API-Password': 'fixture-password' };
const config: HttpConfig = { host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: [], writeTools: new Set() };
const listeners: Server[] = [];
async function start(options: Partial<HttpConfig> = {}) {
  const listener = createHttpApp({ ...config, ...options }).listen(0, '127.0.0.1');
  listeners.push(listener);
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const address = listener.address();
  return new URL(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(listeners.splice(0).map(listener => new Promise<void>(resolve => { listener.closeAllConnections(); listener.close(() => resolve()); })));
});

describe('stateless Streamable HTTP', () => {
  it('supports SDK initialize, listing and validated read calls, with writes hidden and blocked', async () => {
    const get = vi.spyOn(PlytixClient.prototype, 'getProduct').mockResolvedValue({ data: [{ id: 'fixture', sku: 'FIXTURE' }] });
    const writes = vi.spyOn(PlytixClient.prototype, 'createProduct');
    const transport = new StreamableHTTPClientTransport(await start(), { requestInit: { headers } });
    const client = new Client({ name: 'fixture-client', version: '1' });
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeUndefined();
      const list = await client.listTools();
      expect(new Set(list.tools.map(t => t.name))).toEqual(READ_TOOLS);
      expect(list.tools.every(t => t.annotations?.readOnlyHint)).toBe(true);
      const result = await client.callTool({ name: 'products_get', arguments: { product_id: 'fixture' } });
      expect(JSON.stringify(result)).toContain('FIXTURE');
      const invalid = await client.callTool({ name: 'products_get', arguments: { product_id: 4 } });
      expect(invalid.isError).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
      const denied = await client.callTool({ name: 'products_create', arguments: { sku: 'fixture' } });
      expect(denied.isError).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it('enables only named write tools behind an independent service token', async () => {
    const token = 'fixture-service-token-long-enough-for-testing';
    const url = await start({ authToken: token, writeTools: parseWriteTools('["products_update"]') });
    expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(401);
    const client = new Client({ name: 'fixture-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { ...headers, 'X-MCP-Token': token } } }));
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names).toContain('products_update');
      expect(names.filter(name => WRITE_TOOLS.has(name))).toEqual(['products_update']);
    } finally { await client.close(); }
  });

  it('does not treat the service token or an approved argument as write approval', async () => {
    const token = 'fixture-service-token-long-enough-for-testing';
    const update = vi.spyOn(PlytixClient.prototype, 'updateProduct');
    const url = await start({ authToken: token, writeTools: new Set(['products_update']) });
    const client = new Client({ name: 'fixture-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { ...headers, 'X-MCP-Token': token } },
    }));
    try {
      const result = await client.callTool({ name: 'products_update',
        arguments: { product_id: 'fixture', label: 'Changed', approved: true } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('approval is unavailable');
      expect(update).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it('permits an approved write through a trusted host integration and still hides other writes', async () => {
    const token = 'fixture-service-token-long-enough-for-testing';
    const update = vi.spyOn(PlytixClient.prototype, 'updateProduct').mockResolvedValue({ data: [{ id: 'fixture' }] });
    const approval = vi.fn(async () => true);
    const url = await start({ authToken: token, writeTools: new Set(['products_update']), requestWriteApproval: approval });
    const client = new Client({ name: 'fixture-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { ...headers, 'X-MCP-Token': token } },
    }));
    try {
      const result = await client.callTool({ name: 'products_update',
        arguments: { product_id: 'fixture', label: 'Changed' } });
      expect(result.isError).not.toBe(true);
      expect(update).toHaveBeenCalledExactlyOnceWith('fixture', { label: 'Changed' });
      expect(approval).toHaveBeenCalledOnce();
      const denied = await client.callTool({ name: 'products_create', arguments: { sku: 'fixture' } });
      expect(denied.isError).toBe(true);
      expect(approval).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });

  it('retains the complete former Worker catalog plus identifier primitives when explicitly enabled', async () => {
    const token = 'fixture-service-token-long-enough-for-testing';
    const url = await start({ authToken: token, writeTools: WRITE_TOOLS });
    const client = new Client({ name: 'fixture-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { ...headers, 'X-MCP-Token': token } } }));
    try {
      const tools = (await client.listTools()).tools;
      expect(new Set(tools.map(t => t.name))).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS]));
      expect(tools).toHaveLength(READ_TOOLS.size + WRITE_TOOLS.size);
      expect(tools.filter(t => !t.annotations?.readOnlyHint)).toHaveLength(WRITE_TOOLS.size);
    } finally { await client.close(); }
  });

  it('rejects disallowed Origin and Host before tools, including non-browser requests', async () => {
    const url = await start();
    expect((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' }, body: '{}' })).status).toBe(403);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(badHost).toBe(403);
    expect((await fetch(url, { headers: { 'X-Forwarded-Host': 'evil.invalid' } })).status).toBe(405);
    const allowed = await start({ allowedOrigins: ['https://client.example'] });
    const response = await fetch(allowed, { method: 'OPTIONS', headers: { Origin: 'https://client.example' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
  });

  it('rejects raw credential bearer auth, missing BYOK headers, sessions, batches and oversized bodies', async () => {
    const url = await start();
    expect((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Plytix-API-Key': '', Authorization: 'Bearer fixture-key:fixture-password' }, body: '{}' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, 'MCP-Session-Id': 'fixture' }, body: '{}' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: '[]' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ oversized: 'x'.repeat(270_000) }) })).status).toBe(413);
    const invalid = await fetch(url, { method: 'POST', headers, body: '{ fixture-secret' });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('fixture-secret');
  });

  it('returns empty 202 notifications, no session header, and 405 for GET/DELETE', async () => {
    const url = await start();
    const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(result.status).toBe(202);
    expect(await result.text()).toBe('');
    expect(result.headers.get('Mcp-Session-Id')).toBeNull();
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(405);
    const protocol = await fetch(url, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': 'invalid' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(protocol.status).toBe(400);
  });

  it('applies a bounded per-instance request rate', async () => {
    const url = await start({ requestsPerMinute: 1 });
    await fetch(url, { method: 'POST', headers, body: '{}' });
    const limited = await fetch(url, { method: 'POST', headers, body: '{}' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
  });

  it('holds concurrency capacity until a disconnected handler actually completes', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(PlytixClient.prototype, 'getProduct').mockImplementation(async () => {
      entered(); await pending; return { data: [] };
    });
    const cancel = vi.spyOn(PlytixClient.prototype, 'cancel');
    const url = await start({ maxConcurrentRequests: 1 });
    const controller = new AbortController();
    const first = fetch(url, { method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'products_get', arguments: { product_id: 'fixture' } } }) }).catch(() => undefined);
    await started;
    controller.abort(); await first;
    expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(429);
    release();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).not.toBe(429));
  });

  it('fails startup for unauthenticated remote or write-capable listeners and unknown writes', () => {
    expect(() => createHttpApp({ ...config, host: '0.0.0.0' })).toThrow('require MCP_AUTH_TOKEN');
    expect(() => createHttpApp({ ...config, writeTools: new Set(['products_update']) })).toThrow('require MCP_AUTH_TOKEN');
    expect(() => parseWriteTools('["products_typo"]')).toThrow('unknown write tool');
    expect(() => parseWriteTools('true')).toThrow();
    expect(() => createHttpApp({ ...config, allowedHosts: ['*'] })).toThrow('exact hostnames');
    expect(() => createHttpApp({ ...config, allowedOrigins: ['https://example.com/path'] })).toThrow('exact HTTP');
    expect(() => createHttpApp({ ...config, maxConcurrentRequests: 0 })).toThrow('positive integers');
    expect(() => createHttpApp({ ...config, requestsPerMinute: Number.NaN })).toThrow('positive integers');
    expect(() => createHttpApp({ ...config, authToken: 'fixture-token-long-enough-for-testing',
      writeTools: new Set(['unknown_write']) })).toThrow('unknown write tool');
  });

  it('trims configured host lists and normalizes hostname casing', async () => {
    const loaded = loadHttpConfig({ MCP_ALLOWED_HOSTS: ' LOCALHOST, 127.0.0.1 ',
      MCP_ALLOWED_ORIGINS: ' https://client.example ' });
    expect(loaded.allowedHosts).toEqual(['localhost', '127.0.0.1']);
    expect(loaded.allowedOrigins).toEqual(['https://client.example']);
    const url = await start({ allowedHosts: ['LOCALHOST', '127.0.0.1'] });
    const response = await fetch(url, { method: 'POST', headers: { ...headers, Host: 'LOCALHOST' }, body: '{}' });
    expect(response.status).not.toBe(403);
  });

  it('rejects duplicate security headers instead of allowing proxy parser disagreement', async () => {
    const url = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST',
        headers: { ...headers, 'X-Plytix-API-Key': ['first-fixture-key', 'second-fixture-key'] },
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(400);
  });
});
