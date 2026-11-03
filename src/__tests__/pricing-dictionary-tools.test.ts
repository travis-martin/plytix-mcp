import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { ruleSchema } from '../pricing/model.js';

const directories: string[] = [], sessions: Array<() => Promise<void>> = [];
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pricing-dictionary-tools-')); directories.push(directory);
  vi.stubEnv('PLYTIX_PRICING_DIR', directory); vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', '');
});
afterEach(async () => {
  for (const close of sessions.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + '\\') && !resolve(path).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected test directory');
    await rm(path, { recursive: true, force: true });
  }
});
const definition = { kind: 'color', term: 'NAT', canonical_term: 'Natural', definition: 'Supplier list notation; validate current catalog color.',
  scope: { supplier: 'Fixture supplier', source_namespace: 'sheet-list', family_id: 'family' }, attribute_labels: ['color'] };
const evidence = { source: 'document', reference: 'Supplier list page 1', source_sha256: 'a'.repeat(64) };
const proposal = { value: definition, status: 'proposed', evidence };
const schema = { id: 'attribute-color', label: 'color', name: 'Color', type_class: 'SingleSelectionAttribute', options: ['option-not-for-memory'], secret_product: 'private-product-value' };

function authenticate() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) !== 'https://auth.plytix.com/auth/api/get-token') throw new Error('Unexpected fixture upstream destination');
    return Response.json({ data: [{ access_token: 'fixture-token', expires_in: 900 }] });
  });
}
async function connect(password = 'fixture-password-a', writes = new Set<string>()) {
  const api = new PlytixClient({ apiKey: 'fixture-key', apiPassword: password, allowWrites: writes.size > 0, writeTools: writes });
  const approval = vi.fn(async () => { throw new Error('Draft operation must not request a write form'); });
  const server = createServer(api, writes, writes.size ? { writeApprovalMode: 'host' } : { requestWriteApproval: approval });
  const client = new Client({ name: 'dictionary-integration-fixture', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  sessions.push(async () => { await client.close(); await server.close(); });
  return { api, client, approval, path: join(directory, api.knowledgeFingerprint()),
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any> };
}

it('advertises advisory drafts without write permission while preserving API mutation enforcement', async () => {
  const fetch = authenticate(), session = await connect();
  const names = (await session.client.listTools()).tools.map(item => item.name);
  expect(names).toContain('pricing_dictionary_update'); expect(names).toContain('pricing_dictionary_get');
  expect(names).not.toContain('products_update'); expect(names).not.toContain('pricing_rules_save');
  expect((await session.call('pricing_dictionary_update', { expected_revision: 0, entries: [{ value: definition, status: 'proposed' }] })).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  const saved = await session.call('pricing_dictionary_update', { expected_revision: 0, entries: [proposal] });
  expect(saved.isError).not.toBe(true); expect(saved.structuredContent.data.revision).toBe(1);
  const read = await session.call('pricing_dictionary_get', { scope: { supplier: 'Fixture supplier' } });
  expect(read.structuredContent.data.entries[0]).toMatchObject({ status: 'proposed', evidence: [evidence], live_validation_required: true });
  expect(session.approval).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(session.api.runOperation(() => session.api.updateProduct('p', { label: 'Unauthorized' }), undefined, 'pricing_dictionary_update')).rejects.toThrow();
  expect((await session.call('products_update', { product_id: 'p', label: 'Unauthorized' })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('isolates private dictionaries by credentials and reauthenticates before every access', async () => {
  const fetch = authenticate(), alice = await connect(), bob = await connect('fixture-password-b');
  await alice.call('pricing_dictionary_update', { expected_revision: 0, entries: [proposal] });
  expect((await bob.call('pricing_dictionary_get')).structuredContent.data.total).toBe(0);
  expect(alice.path).not.toBe(bob.path);
  expect((await alice.call('pricing_dictionary_get')).structuredContent.data.total).toBe(1);
  const before = await readFile(join(alice.path, 'dictionary.json'), 'utf8');
  fetch.mockResolvedValue(new Response('private-upstream-failure', { status: 401 }));
  const deniedRead = await alice.call('pricing_dictionary_get');
  const deniedWrite = await alice.call('pricing_dictionary_update', { expected_revision: 1, entries: [proposal] });
  expect(deniedRead.isError).toBe(true); expect(deniedWrite.isError).toBe(true);
  expect(JSON.stringify(deniedRead)).not.toContain('private-upstream-failure');
  expect(await readFile(join(alice.path, 'dictionary.json'), 'utf8')).toBe(before);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('rejects stale revisions and cannot confirm executable rules through dictionary definitions', async () => {
  authenticate(); const session = await connect();
  await session.call('pricing_dictionary_update', { expected_revision: 0, entries: [proposal] });
  const stale = await session.call('pricing_dictionary_update', { expected_revision: 0, entries: [proposal] });
  expect(stale.isError).toBe(true); expect(JSON.stringify(stale)).toContain('changed');
  expect((await session.call('pricing_dictionary_update', { expected_revision: 1, entries: [{ ...proposal, status: 'reviewed_rule' }] })).isError).toBe(true);
  expect((await session.call('pricing_dictionary_get')).structuredContent.data.revision).toBe(1);
  await expect(readFile(join(session.path, 'rules.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('returns current live schema and learns only compact structural definitions', async () => {
  authenticate(); const session = await connect();
  const search = vi.spyOn(session.api, 'searchAttributes').mockResolvedValue({ data: [schema] });
  const first = await session.call('catalog_dictionary', { query: 'color' });
  expect(first.structuredContent.data.live_schema.attributes).toEqual([schema]);
  expect(first.structuredContent.data.pricing_learning.status).toBe('stored');
  const stored = await readFile(join(session.path, 'dictionary.json'), 'utf8');
  expect(stored).toContain('SingleSelectionAttribute'); expect(stored).not.toMatch(/option-not-for-memory|private-product-value/);
  const changed = { ...schema, type_class: 'TextAttribute' };
  search.mockResolvedValue({ data: [changed] });
  const second = await session.call('catalog_dictionary', { query: 'color' });
  expect(second.structuredContent.data.live_schema.attributes).toEqual([changed]);
  expect(second.structuredContent.data.pricing_dictionary.entries).toHaveLength(1);
  expect(second.structuredContent.data.pricing_dictionary.entries[0].value.definition).toContain('TextAttribute');
  expect(search).toHaveBeenCalledTimes(2);
});

it('keeps fresh live evidence visible when advisory storage fails', async () => {
  authenticate(); const session = await connect();
  await mkdir(session.path); await writeFile(join(session.path, 'dictionary.json'), 'Fixture corrupt advisory storage');
  vi.spyOn(session.api, 'searchAttributes').mockResolvedValue({ data: [schema] });
  const result = await session.call('catalog_dictionary', { query: 'color' });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.data.live_schema).toMatchObject({ status: 'available', attributes: [schema] });
  expect(result.structuredContent.data.pricing_learning.status).toBe('unavailable');
  expect(result.structuredContent.data.pricing_dictionary).toBeNull();
  expect(result.structuredContent.metadata.warnings.join(' ')).toContain('could not be saved');
});

it('indexes saved rules, imports and validated plans without changing full rule records', async () => {
  const fetch = authenticate(), session = await connect('fixture-password-a', new Set(['pricing_rules_save']));
  const rule = ruleSchema.parse({ id: 'cost_rule', name: 'Cost rule', status: 'confirmed', evidence: 'Reviewed fixture list',
    family_ids: ['family'], target_attribute: 'cost', source_column: 'Price', currency: 'USD', currency_column: 'Currency',
    unit: 'each', unit_column: 'Unit', operations: [{ op: 'multiply', operand: '0.9' }], maximum: '1000', max_change_percent: 50,
    review_attributes: ['brand'], associations: [{ kind: 'brand', column: 'Brand', attribute: 'brand', aliases: [{ from: 'ACME Co', to: 'Acme' }] }] });
  const product = { id: 'private-product-id', sku: 'PRIVATE-SKU', product_family_id: 'family', product_type: 'STANDALONE' as const,
    num_variations: 0, attributes: { cost: 10, brand: 'Acme' } };
  vi.spyOn(session.api, 'searchProducts').mockResolvedValue({ data: [product] });
  vi.spyOn(session.api, 'getProduct').mockResolvedValue({ data: [product] });
  vi.spyOn(session.api, 'getFamily').mockResolvedValue({ data: [{ id: 'family', name: 'Sheet family' }] });
  vi.spyOn(session.api, 'getFamilyAllAttributes').mockResolvedValue({ data: [{ id: 'attr-cost', name: 'Cost', label: 'cost', attribute_level: 'parent_level' }] });
  vi.spyOn(session.api, 'getAttributeById').mockResolvedValue({ id: 'attr-cost', name: 'Cost', label: 'cost', type_class: 'DecimalAttribute' });
  const saved = await session.call('pricing_rules_save', { expected_revision: 0, rules: [rule] });
  expect(saved.isError).not.toBe(true); expect(saved.structuredContent.data.learning.status).toBe('stored');
  const before = await readFile(join(session.path, 'rules.json'), 'utf8');
  expect(JSON.parse(before).rules).toEqual([rule]);
  const imported = await session.call('pricing_import', { source_name: 'Fixture November list', source_sha256: 'b'.repeat(64),
    source_context: { supplier: 'Fixture supplier', source_namespace: 'stable-list' }, sku_column: 'SKU',
    rows: [{ source_ref: 'page 1', values: { SKU: 'PRIVATE-SKU', Price: '12.50', Currency: 'USD', Unit: 'each', Brand: 'ACME Co' } }] });
  expect(imported.isError).not.toBe(true); expect(imported.structuredContent.data.learning.status).toBe('stored');
  const planned = await session.call('pricing_plan', { import_id: imported.structuredContent.data.import_id, rule_ids: ['cost_rule'],
    mappings: [{ row_index: 0, product_id: product.id, family_id: 'family' }] });
  expect(planned.isError).not.toBe(true); expect(planned.structuredContent.data.blocked).toEqual([]);
  expect(planned.structuredContent.data.learning.status).toBe('stored');
  const dictionary = (await session.call('pricing_dictionary_get')).structuredContent.data;
  expect(dictionary.entries.some((item: any) => item.status === 'reviewed_rule')).toBe(true);
  expect(dictionary.entries.some((item: any) => item.value.kind === 'product_setup')).toBe(true);
  expect(dictionary.entries.some((item: any) => item.value.scope.source_namespace === 'stable-list')).toBe(true);
  expect(JSON.stringify(dictionary)).not.toMatch(/private-product-id|PRIVATE-SKU|12\.50/);
  expect(await readFile(join(session.path, 'rules.json'), 'utf8')).toBe(before);
  expect(JSON.parse(await readFile(join(session.path, 'rules-revision-1.json'), 'utf8')).rules).toEqual([rule]);
  expect(fetch.mock.calls.every(([url]) => String(url) === 'https://auth.plytix.com/auth/api/get-token')).toBe(true);
});
