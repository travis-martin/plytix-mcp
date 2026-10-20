import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { KnowledgeError, registrySchema, type Registry, type Workspace } from './model.js';
import { FileKnowledgeStore, readBoundedJson, type KnowledgeStore } from './store.js';

export function credentialFingerprint(apiKey: string, apiPassword: string, baseUrl = 'https://pim.plytix.com', authUrl = 'https://auth.plytix.com/auth/api/get-token'): string {
  return createHash('sha256').update(JSON.stringify([
    baseUrl.replace(/\/+$/, ''), authUrl.replace(/\/+$/, ''), apiKey, apiPassword,
  ])).digest('hex');
}
export interface KnowledgeContext {
  workspace: Workspace;
  member: string;
  canPropose: boolean;
  store: KnowledgeStore;
}
export async function readRegistry(path: string): Promise<Registry> {
  try { return registrySchema.parse(await readBoundedJson(path)); }
  catch { throw new KnowledgeError('Knowledge registry could not be read or validated; ask the operator to check configuration'); }
}

/** Operator-owned registry, reloaded per access so revocation applies to stdio
 * sessions too. Neither an email domain nor an MCP argument selects a workspace.
 */
export class KnowledgeRegistry {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  async resolve(fingerprint: string): Promise<KnowledgeContext | undefined> {
    const registry = await readRegistry(this.path);
    const binding = registry.bindings.find(item => item.fingerprint === fingerprint);
    if (!binding) return undefined;
    const workspace = registry.workspaces.find(item => item.id === binding.scope_id)!;
    return {
      workspace, member: binding.member, canPropose: binding.can_propose,
      store: new FileKnowledgeStore(join(dirname(this.path), 'data'), workspace.id),
    };
  }
}
