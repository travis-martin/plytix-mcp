import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../http.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { KnowledgeRegistry } from '../knowledge/registry.js';
import { FileKnowledgeStore } from '../knowledge/store.js';
import { runAdmin } from '../knowledge/admin.js';
import { PlytixError } from '../types.js';
import { KnowledgeService } from '../knowledge/service.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) {
      throw new Error('Unexpected fixture directory');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
const envA = { PLYTIX_API_KEY: 'fixture-key-a', PLYTIX_API_PASSWORD: 'fixture-password-a' };
const envB = { PLYTIX_API_KEY: 'fixture-key-b', PLYTIX_API_PASSWORD: 'fixture-password-b' };
const envC = { PLYTIX_API_KEY: 'fixture-key-c', PLYTIX_API_PASSWORD: 'fixture-password-c' };
const term = { term: 'Gauge', aliases: ['Thickness'], meaning: 'Reviewed thickness meaning',
  attribute_labels: ['thickness'], family_ids: [], evidence: 'Owner supplied fixture specification' };
const schema = { id: 'field-id', name: 'Sheet thickness', label: 'thickness', type_class: 'NumberAttribute', options: ['one'] };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'plytix-knowledge-test-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  const admin = (args: string[], env = envA) => runAdmin([...args, '--config', path], env);
  await admin(['init', '--scope', 'business-a/account', '--name', 'Business A', '--member', 'Alice', '--domain', 'a.example', '--learn', '--contributor']);
  await admin(['bind', '--scope', 'business-a/account', '--member', 'Bob', '--contributor'], envB);
  await admin(['init', '--scope', 'business-c/account', '--name', 'Business C', '--member', 'Carol'], envC);
  const store = new FileKnowledgeStore(join(directory, 'data'), 'business-a/account');
  return { directory, path, admin, store };
}

async function connect(path?: string, env = envA, proposals = false, approval = true) {
  const api = new PlytixClient({ apiKey: env.PLYTIX_API_KEY, apiPassword: env.PLYTIX_API_PASSWORD });
  const auth = vi.spyOn(api, 'verifyKnowledgeAccess').mockResolvedValue();
  const search = vi.spyOn(api, 'searchAttributes').mockResolvedValue({ data: [schema] });
  const server = createServer(api, new Set(), {
    knowledgeRegistry: path ? new KnowledgeRegistry(path) : undefined,
    knowledgeWriteTools: proposals ? new Set(['knowledge_propose']) : new Set(),
    requestWriteApproval: async () => approval,
  });
  const client = new Client({ name: 'knowledge-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  return {
    api, auth, search, client,
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>,
    close: async () => { await client.close(); await server.close(); },
  };
}

it('offers discovery without setup and validates structured metadata through the SDK', async () => {
  const session = await connect();
  try {
    const guide = await session.call('discovery_guide');
    expect(guide.structuredContent.metadata).toMatchObject({ status: 'ok', source: 'local', freshness: 'not_applicable' });
    expect(JSON.parse(guide.content[0].text)).toHaveProperty('routes');
    expect((await session.client.listTools()).tools.find(item => item.name === 'catalog_dictionary')?.outputSchema).toBeDefined();
    expect((await session.call('knowledge_status')).structuredContent.data.configured).toBe(false);
    const dictionary = await session.call('catalog_dictionary', { query: 'thickness' });
    expect(dictionary.structuredContent.data.live_schema.attributes).toEqual([schema]);
    expect(session.auth).not.toHaveBeenCalled();
    expect((await session.call('knowledge_propose', term)).isError).toBe(true);
  } finally { await session.close(); }
});

it('learns only structural observations and shares them with explicitly bound colleagues', async () => {
  const { path, store } = await fixture();
  const alice = await connect(path);
  try {
    alice.search.mockResolvedValue({ data: [{ ...schema, secret_product_value: 'do-not-store' }] });
    await alice.call('catalog_dictionary');
    const document = await store.read();
    expect(document.observations).toHaveLength(1);
    expect(document.observations[0]).toMatchObject({ label: 'thickness', observed_by: 'Alice' });
    expect(JSON.stringify(document)).not.toContain('do-not-store');
    expect(alice.auth).toHaveBeenCalledOnce();
  } finally { await alice.close(); }
  const bob = await connect(path, envB), carol = await connect(path, envC);
  try {
    const shared = await bob.call('catalog_dictionary', { live: false });
    expect(shared.structuredContent.data.observations).toHaveLength(1);
    expect(shared.structuredContent.metadata).toMatchObject({ source: 'shared_knowledge', freshness: 'cached' });
    expect(bob.search).not.toHaveBeenCalled();
    expect((await carol.call('catalog_dictionary', { live: false })).structuredContent.data.observations).toEqual([]);
  } finally { await bob.close(); await carol.close(); }
});

it('does not accept caller-selected scopes, a wrong password or a revoked binding', async () => {
  const { path, admin } = await fixture();
  const alice = await connect(path, envA, true);
  try {
    await alice.call('knowledge_propose', term);
    await admin(['unbind', '--member', 'Alice']);
    expect((await alice.call('knowledge_status')).structuredContent.data.configured).toBe(false);
    expect((await alice.call('knowledge_propose', { ...term, term: 'Other' })).isError).toBe(true);
  } finally { await alice.close(); }
  const stranger = await connect(path, { ...envA, PLYTIX_API_PASSWORD: 'wrong' });
  try {
    const result = await stranger.call('catalog_dictionary', { live: false, scope_id: 'business-a/account', domain: 'a.example' });
    expect(result.structuredContent.data.workspace).toBeNull();
    expect(result.structuredContent.data.definitions).toEqual([]);
    expect(stranger.auth).not.toHaveBeenCalled();
  } finally { await stranger.close(); }
});

it('does not serve shared knowledge when upstream authentication fails', async () => {
  const { path } = await fixture();
  const session = await connect(path);
  try {
    session.auth.mockRejectedValue(new PlytixError('Plytix authentication failed (HTTP 401)', 401));
    const result = await session.call('catalog_dictionary', { live: false });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.metadata.error_code).toBe('authentication_failed');
    expect(JSON.stringify(result)).not.toContain('Business A');
    expect(session.search).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('requires exact approval, contributor membership and review before applying an alias', async () => {
  const { path, admin, store } = await fixture();
  const denied = await connect(path, envA, true, false);
  try {
    expect((await denied.call('knowledge_propose', term)).isError).toBe(true);
    expect((await store.read()).definitions).toEqual([]);
  } finally { await denied.close(); }
  const session = await connect(path, envA, true);
  try {
    const saved = (await session.call('knowledge_propose', term)).structuredContent.data;
    const duplicate = (await session.call('knowledge_propose', term)).structuredContent.data;
    expect(duplicate.id).toBe(saved.id);
    expect((await store.read()).definitions).toHaveLength(1);
    expect((await session.call('catalog_dictionary', { query: 'Gauge', live: false })).structuredContent.data.definitions).toEqual([]);
    expect((await session.call('catalog_dictionary', { query: 'Gauge', live: false, include_proposals: true })).structuredContent.data.definitions[0].status).toBe('proposed');
    await expect(admin(['review', '--scope', 'business-a/account', '--id', saved.id,
      '--status', 'confirmed', '--reviewer', 'Owner', '--note', 'Verified', '--revision', '0'])).rejects.toThrow('changed');
    const revision = (await store.read()).revision;
    await admin(['review', '--scope', 'business-a/account', '--id', saved.id,
      '--status', 'confirmed', '--reviewer', 'Owner', '--note', 'Verified', '--revision', String(revision)]);
    const result = await session.call('catalog_dictionary', { query: 'Gauge' });
    expect(result.structuredContent.data.definitions[0]).toMatchObject({ status: 'confirmed', reviewed_by: 'Owner' });
    expect(session.search.mock.lastCall?.[0]?.filters).toContainEqual([{ field: 'label', operator: 'eq', value: 'thickness' }]);
    const carol = await connect(path, envC, true);
    try { expect((await carol.call('knowledge_propose', term)).isError).toBe(true); }
    finally { await carol.close(); }
  } finally { await session.close(); }
});

it('retains observations across concurrent writers and fails closed on corrupt storage', async () => {
  const { store, directory } = await fixture();
  const second = new FileKnowledgeStore(join(directory, 'data'), 'business-a/account');
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : second).update(document => {
    document.observations.push({
      label: `field${index}`, id: `id${index}`, name: 'Field', type_class: 'TextAttribute',
      source: 'plytix_attribute_schema', observed_at: new Date().toISOString(), observed_by: 'fixture',
    });
  })));
  expect((await store.read()).observations).toHaveLength(12);
  expect((await store.read()).revision).toBe(12);
  await writeFile(store.path, '{"broken":true}');
  await expect(store.read()).rejects.toThrow('validated');
  await expect(store.update(() => {})).rejects.toThrow('validated');
  expect(await readFile(store.path, 'utf8')).toBe('{"broken":true}');
});

it('honors disabled learning, keeps partial schema failures explicit and bounds dictionary pages', async () => {
  const { path, admin, store } = await fixture();
  const session = await connect(path);
  try {
    await admin(['learning', '--scope', 'business-a/account', '--mode', 'off']);
    await session.call('catalog_dictionary');
    expect((await store.read()).observations).toEqual([]);
    session.search.mockRejectedValue(new PlytixError('Plytix request failed (HTTP 403)', 403));
    const result = await session.call('catalog_dictionary');
    expect(result.structuredContent.metadata.status).toBe('partial');
    expect(result.structuredContent.data.live_schema).toEqual({ status: 'unavailable', attributes: null });
    expect((await session.call('catalog_dictionary', { page_size: 101 })).isError).toBe(true);
  } finally { await session.close(); }
});

it('refuses to overwrite an existing workspace or silently broaden a connection binding', async () => {
  const { path, admin } = await fixture();
  const before = await readFile(path, 'utf8');
  await expect(admin(['init', '--scope', 'business-a/account', '--name', 'Overwrite', '--member', 'X'])).rejects.toThrow('exists');
  await expect(admin(['bind', '--scope', 'business-c/account', '--member', 'Alice'])).rejects.toThrow('already bound');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(before).not.toContain(envA.PLYTIX_API_KEY);
  expect(before).not.toContain(envA.PLYTIX_API_PASSWORD);
});

it('uses the same shared knowledge and result contract across stateless HTTP requests', async () => {
  const { path } = await fixture();
  vi.spyOn(PlytixClient.prototype, 'verifyKnowledgeAccess').mockResolvedValue();
  vi.spyOn(PlytixClient.prototype, 'searchAttributes').mockResolvedValue({ data: [schema] });
  const listener = createHttpApp({
    host: '127.0.0.1', allowedHosts: ['127.0.0.1'], allowedOrigins: [], writeTools: new Set(),
    knowledgeRegistry: new KnowledgeRegistry(path),
  }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const address = listener.address();
  const url = new URL(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`);
  const client = new Client({ name: 'http-knowledge-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: {
      'X-Plytix-API-Key': envA.PLYTIX_API_KEY, 'X-Plytix-API-Password': envA.PLYTIX_API_PASSWORD,
    } } }));
    const first = await client.callTool({ name: 'catalog_dictionary', arguments: {} }) as any;
    expect(first.structuredContent.metadata.learning.status).toBe('stored');
    const next = await client.callTool({ name: 'catalog_dictionary', arguments: { live: false } }) as any;
    expect(next.structuredContent.data.observations).toHaveLength(1);
    expect(next.structuredContent.metadata.source).toBe('shared_knowledge');
    expect((await client.listResources()).resources[0].uri).toBe('plytix://guides/discovery');
  } finally {
    await client.close();
    await new Promise<void>(resolve => { listener.closeAllConnections(); listener.close(() => resolve()); });
  }
});

it('authenticates the actual supplied credential pair before serving saved knowledge', async () => {
  const { path } = await fixture();
  const session = await connect(path);
  session.auth.mockRestore();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ access_token: 'fixture-token' }] }));
  try {
    expect((await session.call('knowledge_status')).structuredContent.data.configured).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      api_key: envA.PLYTIX_API_KEY, api_password: envA.PLYTIX_API_PASSWORD,
    });
    fetch.mockResolvedValue(new Response('', { status: 401 }));
    const revoked = await session.call('knowledge_status');
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain(envA.PLYTIX_API_PASSWORD);
    expect(JSON.stringify(revoked)).not.toContain('Business A');
  } finally { await session.close(); }
});

it('keeps schema drift visible, does not refresh absent options and preserves reviewed meanings', async () => {
  const { path, store } = await fixture();
  const session = await connect(path);
  try {
    await session.call('catalog_dictionary');
    session.search.mockResolvedValue({ data: [{ ...schema, type_class: 'TextAttribute', options: undefined }] });
    await session.call('catalog_dictionary');
    await session.call('catalog_dictionary');
    const observation = (await store.read()).observations[0];
    expect(observation.previous_type).toBe('NumberAttribute');
    expect(observation.options).toBeUndefined();
    expect((await store.read()).definitions).toEqual([]);
  } finally { await session.close(); }
});

it('enforces proposal authorization in the service independently of tool visibility', async () => {
  const { path, store } = await fixture();
  const api = new PlytixClient({ apiKey: envA.PLYTIX_API_KEY, apiPassword: envA.PLYTIX_API_PASSWORD });
  vi.spyOn(api, 'verifyKnowledgeAccess').mockResolvedValue();
  const service = new KnowledgeService(api, new KnowledgeRegistry(path), new Set(['knowledge_propose']));
  await api.runOperation(async () => {
    await expect(service.propose(term)).rejects.toThrow('not authorized');
    service.beginApprovedProposal();
    await service.propose(term);
    await expect(service.propose(term)).rejects.toThrow('not authorized');
  });
  await api.runOperation(async () => {
    await expect(service.propose(term)).rejects.toThrow('not authorized');
  });
  expect((await store.read()).definitions).toHaveLength(1);
});

it('requires explicit retirement to replace overlapping reviewed meanings and retains history', async () => {
  const { directory, admin, store } = await fixture();
  const file = join(directory, 'definition.json');
  await writeFile(file, JSON.stringify({ ...term, status: 'confirmed' }));
  await expect(admin(['propose', '--scope', 'business-a/account', '--member', 'Owner', '--file', file])).rejects.toThrow();
  const propose = async (meaning: string) => {
    await writeFile(file, JSON.stringify({ ...term, meaning }));
    return await admin(['propose', '--scope', 'business-a/account', '--member', 'Owner', '--file', file]) as any;
  };
  const review = async (id: string, status: string) => admin([
    'review', '--scope', 'business-a/account', '--id', id, '--status', status,
    '--reviewer', 'Owner', '--note', 'Checked specification', '--revision', String((await store.read()).revision),
  ]);
  const first = await propose('First meaning');
  await review(first.id, 'confirmed');
  const next = await propose('Corrected meaning');
  await expect(review(next.id, 'confirmed')).rejects.toThrow('Overlapping');
  await review(first.id, 'retired');
  await review(next.id, 'confirmed');
  expect((await store.read()).definitions.map(item => item.status)).toEqual(['retired', 'confirmed']);
});
