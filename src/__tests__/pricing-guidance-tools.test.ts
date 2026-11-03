import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { WRITE_TOOLS } from '../policy.js';
import type { ToolPolicyOptions } from '../tools/register.js';

const sessions: Array<() => Promise<void>> = [];
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pricing-guidance-tools-'));
  vi.stubEnv('PLYTIX_PRICING_DIR', directory);
  vi.stubEnv('PLYTIX_PRICING_GCS_BUCKET', '');
  vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', '');
});
afterEach(async () => {
  for (const close of sessions.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\') && !resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true });
});

const instruction = { id: 'full_item_cost', title: 'Store full item cost', text: 'Verify the current raw dimensions before converting the source unit price.',
  scope: { family_ids: [] }, priority: 'required', status: 'active', source_ref: 'Explicit owner instruction, fixture conversation' };
const exclusion = { id: 'custom_color', title: 'Protect custom color', status: 'active', family_ids: ['fixture-family'], target_attributes: [],
  all: [{ attribute: 'color_name', operator: 'equals', values: ['Custom violet'] }],
  reason: 'A custom quoted price must not follow the ordinary price list.', source_ref: 'Explicit owner instruction, fixture conversation' };
const saveArguments = { expected_revision: 0, instructions: [instruction], exclusions: [exclusion] };
function authenticate() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) !== 'https://auth.plytix.com/auth/api/get-token') throw new Error('Unexpected fixture upstream destination');
    return Response.json({ data: [{ access_token: 'fixture-token', expires_in: 900 }] });
  });
}
async function connect(password = 'fixture-password-a', writes = new Set<string>(), options: ToolPolicyOptions = { writeApprovalMode: 'host' }) {
  const api = new PlytixClient({ apiKey: 'fixture-key', apiPassword: password, allowWrites: writes.size > 0, writeTools: writes });
  const server = createServer(api, writes, options);
  // No elicitation capability: host-approved guidance editing must need no second form.
  const client = new Client({ name: 'guidance-integration-fixture', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  sessions.push(async () => { await client.close(); await server.close(); });
  return { api, client, path: join(directory, api.knowledgeFingerprint()),
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any> };
}

it('offers authenticated guidance reads by default but hides and rejects protected saves', async () => {
  const fetch = authenticate(), session = await connect();
  const names = (await session.client.listTools()).tools.map(tool => tool.name);
  expect(names).toContain('pricing_guidance_get');
  expect(names).not.toContain('pricing_guidance_save');
  expect((await session.call('pricing_guidance_save', saveArguments)).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  const read = await session.call('pricing_guidance_get', { include_retired: true });
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent.data).toMatchObject({ revision: 0, instructions: [], exclusions: [], complete_for_save: true,
    storage_backend: 'file', storage_scope: { mode: 'credential', drafts_and_audits: 'credential_private', shared_files: [] } });
  expect(fetch).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual([]);
});

it('saves exact allowlisted guidance in host mode while granting no product mutation route', async () => {
  const fetch = authenticate(), session = await connect('fixture-password-a', new Set(['pricing_guidance_save']));
  const saved = await session.call('pricing_guidance_save', saveArguments);
  expect(saved.isError).not.toBe(true);
  expect(saved.structuredContent.data).toMatchObject({ revision: 1, instructions: [instruction], exclusions: [exclusion], storage_backend: 'file' });
  const read = await session.call('pricing_guidance_get', { include_retired: true });
  expect(read.structuredContent.data).toMatchObject({ revision: 1, complete_for_save: true, digest: saved.structuredContent.data.digest,
    instructions: [instruction], exclusions: [exclusion] });
  const persisted = await readFile(join(session.path, 'workflow.json'), 'utf8');
  expect(JSON.parse(persisted)).toMatchObject({ revision: 1, instructions: [instruction], exclusions: [exclusion] });
  await expect(session.api.runOperation(async () => {
    session.api.beginApprovedWrite();
    await session.api.updateProduct('fixture-product', { label: 'Forbidden side effect' });
  }, undefined, 'pricing_guidance_save')).rejects.toThrow('not authorized for this tool operation');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('advertises guidance with the supported writes and declares host authorization and review limits accurately', async () => {
  const session = await connect('fixture-password-a', WRITE_TOOLS);
  const listed = (await session.client.listTools()).tools;
  expect(new Set(listed.filter(tool => tool.annotations?.destructiveHint).map(tool => tool.name))).toEqual(WRITE_TOOLS);
  expect(listed.find(tool => tool.name === 'pricing_guidance_get')?.annotations?.readOnlyHint).toBe(true);
  expect(listed.find(tool => tool.name === 'pricing_guidance_save')?.annotations?.readOnlyHint).toBe(false);
  const support = (await session.call('approval_capabilities')).structuredContent.data;
  expect(support).toMatchObject({ mode: 'host', nested_form_required: false, write_authorized: false,
    argument_limits: { default: 16_000, pricing_guidance_save: 64_000 } });
  expect(new Set(support.enabled_write_tools)).toEqual(WRITE_TOOLS);
});

it('does not authenticate or persist a protected save rejected by the configured approval provider', async () => {
  const fetch = authenticate(), approval = vi.fn(async () => false);
  const session = await connect('fixture-password-a', new Set(['pricing_guidance_save']), { requestWriteApproval: approval });
  const result = await session.call('pricing_guidance_save', saveArguments);
  expect(result.isError).toBe(true);
  expect(approval).toHaveBeenCalledOnce();
  expect(JSON.parse(approval.mock.calls[0]?.[0]?.argumentsJson ?? '{}')).toEqual(saveArguments);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it('shares guidance only among explicitly bound credentials and exposes safe organization metadata', async () => {
  const fetch = authenticate(), alice = await connect('fixture-password-a', new Set(['pricing_guidance_save']));
  const bob = await connect('fixture-password-b'), stranger = await connect('fixture-password-c', new Set(['pricing_guidance_save']));
  vi.stubEnv('PLYTIX_PRICING_SCOPE_BINDINGS', JSON.stringify({
    [alice.api.knowledgeFingerprint()]: 'fixture-organization', [bob.api.knowledgeFingerprint()]: 'fixture-organization',
  }));
  const saved = await alice.call('pricing_guidance_save', saveArguments);
  expect(saved.isError).not.toBe(true);
  const shared = await bob.call('pricing_guidance_get', { include_retired: true });
  expect(shared.structuredContent.data).toMatchObject({ revision: 1, instructions: [instruction], exclusions: [exclusion],
    storage_scope: { mode: 'organization', workspace_id: 'fixture-organization', drafts_and_audits: 'credential_private' } });
  expect(shared.structuredContent.data.storage_scope.shared_files).toContain('workflow.json');
  expect(JSON.stringify(shared)).not.toContain(alice.api.knowledgeFingerprint());
  expect(JSON.stringify(shared)).not.toContain(bob.api.knowledgeFingerprint());
  expect((await stranger.call('pricing_guidance_get')).isError).toBe(true);
  expect((await stranger.call('pricing_guidance_save', saveArguments)).isError).toBe(true);
  expect((await bob.call('pricing_guidance_get')).structuredContent.data.revision).toBe(1);
  expect(await readdir(directory)).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it('reauthenticates every read and save before accessing persistent instructions', async () => {
  const fetch = authenticate(), session = await connect('fixture-password-a', new Set(['pricing_guidance_save']));
  await session.call('pricing_guidance_save', saveArguments);
  const before = await readFile(join(session.path, 'workflow.json'), 'utf8');
  fetch.mockResolvedValue(new Response('fixture-private-upstream-message', { status: 401 }));
  const deniedRead = await session.call('pricing_guidance_get', { include_retired: true });
  const deniedSave = await session.call('pricing_guidance_save', { ...saveArguments, expected_revision: 1 });
  expect(deniedRead.isError).toBe(true); expect(deniedSave.isError).toBe(true);
  expect(JSON.stringify(deniedRead)).not.toMatch(/fixture-private-upstream-message|full_item_cost|Custom violet/);
  expect(JSON.stringify(deniedSave)).not.toContain('fixture-private-upstream-message');
  expect(await readFile(join(session.path, 'workflow.json'), 'utf8')).toBe(before);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('round-trips a guidance set above the ordinary argument limit and rejects oversized saves intact', async () => {
  const fetch = authenticate(), session = await connect('fixture-password-a', new Set(['pricing_guidance_save']));
  const instructions = Array.from({ length: 8 }, (_, index) => ({ ...instruction, id: `instruction_${index}`, text: `${index}:` + 'x'.repeat(2998) }));
  const result = await session.call('pricing_guidance_save', { ...saveArguments, instructions });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent.data.instructions).toEqual(instructions);
  const before = await readFile(join(session.path, 'workflow.json'), 'utf8');
  const tooMany = Array.from({ length: 24 }, (_, index) => ({ ...instruction, id: `instruction_${index}`, text: 'x'.repeat(3000) }));
  const rejected = await session.call('pricing_guidance_save', { ...saveArguments, expected_revision: 1, instructions: tooMany });
  expect(rejected.isError).toBe(true);
  expect(JSON.stringify(rejected)).toContain('approval review limit');
  expect(await readFile(join(session.path, 'workflow.json'), 'utf8')).toBe(before);
  expect(fetch).toHaveBeenCalledOnce();
});
