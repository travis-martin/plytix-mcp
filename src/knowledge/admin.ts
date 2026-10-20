#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { definitionInput, registrySchema, workspace, type Registry } from './model.js';
import { credentialFingerprint, readRegistry } from './registry.js';
import { FileKnowledgeStore, readBoundedJson, updateJsonFile } from './store.js';

const HELP = `Shared catalog knowledge administration (local operator only)

init --scope ID --name NAME --member NAME [--domain DOMAIN] [--account-id ID] [--learn] [--contributor]
bind --scope ID --member NAME [--contributor]
unbind --member NAME
learning --scope ID --mode on|off
list --scope ID
propose --scope ID --member NAME --file definition.json
review --scope ID --id UUID --status confirmed|rejected|retired --reviewer NAME --note TEXT --revision N

All commands accept --config PATH (or MCP_KNOWLEDGE_CONFIG).
Default registry: .local/knowledge/config.json. init/bind fingerprint existing
PLYTIX_API_KEY and PLYTIX_API_PASSWORD from the private environment; never pass
credentials on the command line. They make no API requests and do not establish
account ownership. Verify account and intended sharing outside this command.
Domain/account ID are labels, not authorization. Bind only colleagues permitted
to read this workspace's shared metadata and business definitions.
Review uses the revision from list to reject changes made since inspection.
`;

export function safeAdminError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const safeMessages = [
    'Supply exactly one command', 'Existing private environment credentials are required',
    'Existing registry could not be read or validated', 'Member not found',
    'Workspace exists; use bind or learning', 'Workspace not found', 'Mode must be on or off',
    'Connection already bound; unbind it before reassignment', 'Invalid revision', 'Invalid review status',
    'Knowledge changed; list and review the current revision', 'Definition not found',
    'Only proposals can be confirmed/rejected; only confirmed definitions can be retired',
    'Overlapping confirmed term or alias; retire the previous definition before confirming',
    'Unknown command; use --help', 'Knowledge registry could not be read or validated; ask the operator to check configuration',
    'Knowledge store could not be read or validated', 'Knowledge store exceeds size limit',
    'Knowledge file exceeds size limit', 'Knowledge store is busy; retry or ask the operator to inspect the lock',
  ];
  if (safeMessages.includes(message) || /^Missing --(scope|name|member|mode|file|id|status|reviewer|note|revision)$/.test(message)) return message;
  return 'Check command arguments, file access, field limits and registry validity. No private values are printed.';
}

export async function runAdmin(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      config: { type: 'string' }, scope: { type: 'string' }, name: { type: 'string' },
      member: { type: 'string' }, domain: { type: 'string' }, 'account-id': { type: 'string' },
      learn: { type: 'boolean' }, contributor: { type: 'boolean' }, mode: { type: 'string' },
      file: { type: 'string' }, id: { type: 'string' }, status: { type: 'string' },
      reviewer: { type: 'string' }, note: { type: 'string' }, revision: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) return { help: HELP };
  if (positionals.length !== 1) throw new Error('Supply exactly one command');
  const path = resolve(values.config ?? env.MCP_KNOWLEDGE_CONFIG ?? '.local/knowledge/config.json');
  const requireValue = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing --${name}`);
    return value;
  };
  const fingerprint = () => {
    if (!env.PLYTIX_API_KEY || !env.PLYTIX_API_PASSWORD) throw new Error('Existing private environment credentials are required');
    return credentialFingerprint(env.PLYTIX_API_KEY, env.PLYTIX_API_PASSWORD, env.PLYTIX_API_BASE, env.PLYTIX_AUTH_URL);
  };

  if (['init', 'bind', 'unbind', 'learning'].includes(command)) {
    const load = async (): Promise<Registry> => {
      if (command !== 'init') return readRegistry(path);
      try { return registrySchema.parse(await readBoundedJson(path)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: [], bindings: [] };
        throw new Error('Existing registry could not be read or validated');
      }
    };
    await updateJsonFile(path, load, registry => {
      if (command === 'unbind') {
        const member = requireValue('member');
        if (!registry.bindings.some(item => item.member === member)) throw new Error('Member not found');
        registry.bindings = registry.bindings.filter(item => item.member !== member);
      } else {
        const scope = requireValue('scope');
        if (command === 'init') {
          if (registry.workspaces.some(item => item.id === scope)) throw new Error('Workspace exists; use bind or learning');
          registry.workspaces.push(workspace.parse({
            id: scope, name: requireValue('name'), domain: values.domain,
            plytix_account_id: values['account-id'], learn_observations: values.learn ?? false,
          }));
        }
        const target = registry.workspaces.find(item => item.id === scope);
        if (!target) throw new Error('Workspace not found');
        if (command === 'learning') {
          if (!['on', 'off'].includes(requireValue('mode'))) throw new Error('Mode must be on or off');
          target.learn_observations = values.mode === 'on';
        } else {
          const identity = fingerprint();
          if (registry.bindings.some(item => item.fingerprint === identity)) throw new Error('Connection already bound; unbind it before reassignment');
          registry.bindings.push({
            fingerprint: identity, scope_id: scope, member: requireValue('member'),
            can_propose: values.contributor ?? false,
          });
        }
      }
      return registrySchema.parse(registry);
    });
    return { status: 'saved', config: path, command };
  }

  const scope = requireValue('scope');
  const registry = await readRegistry(path);
  if (!registry.workspaces.some(item => item.id === scope)) throw new Error('Workspace not found');
  const store = new FileKnowledgeStore(join(dirname(path), 'data'), scope);
  if (command === 'list') return store.read();
  if (command === 'propose') {
    const input = definitionInput.parse(await readBoundedJson(resolve(requireValue('file'))));
    const now = new Date().toISOString(), id = randomUUID();
    const document = await store.update(document => {
      document.definitions.push({
        ...input, id, status: 'proposed', created_at: now, updated_at: now,
        proposed_by: requireValue('member'),
      });
    });
    return { id, status: 'proposed', revision: document.revision };
  }
  if (command === 'review') {
    const revision = Number(requireValue('revision'));
    const status = requireValue('status');
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision');
    if (!['confirmed', 'rejected', 'retired'].includes(status)) throw new Error('Invalid review status');
    const document = await store.update(document => {
      if (document.revision !== revision) throw new Error('Knowledge changed; list and review the current revision');
      const entry = document.definitions.find(item => item.id === requireValue('id'));
      if (!entry) throw new Error('Definition not found');
      if (status === 'retired' ? entry.status !== 'confirmed' : entry.status !== 'proposed') {
        throw new Error('Only proposals can be confirmed/rejected; only confirmed definitions can be retired');
      }
      // Conflicting confirmed meanings need explicit retirement, never silent replacement.
      const names = [entry.term, ...entry.aliases].map(item => item.toLowerCase());
      if (status === 'confirmed' && document.definitions.some(item => item.id !== entry.id && item.status === 'confirmed' &&
        [item.term, ...item.aliases].some(name => names.includes(name.toLowerCase())) &&
        (!item.family_ids.length || !entry.family_ids.length || item.family_ids.some(id => entry.family_ids.includes(id))))) {
        throw new Error('Overlapping confirmed term or alias; retire the previous definition before confirming');
      }
      entry.status = status as 'confirmed' | 'rejected' | 'retired';
      entry.reviewed_by = requireValue('reviewer');
      entry.review_note = requireValue('note');
      entry.updated_at = new Date().toISOString();
    });
    return { status, revision: document.revision };
  }
  throw new Error('Unknown command; use --help');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAdmin(process.argv.slice(2)).then(value => {
    console.log(JSON.stringify(value, null, 2));
  }).catch(error => {
    // Files and validation errors can contain private business data or paths.
    console.error(`Knowledge administration failed: ${safeAdminError(error)}`);
    process.exitCode = 1;
  });
}
