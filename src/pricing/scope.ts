import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PlytixError } from '../types.js';

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceId = z.string().trim().min(1).max(160).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const bindingsSchema = z.record(fingerprintSchema, workspaceId).refine(value => Object.keys(value).length <= 256);

export interface PricingScope {
  mode: 'credential' | 'organization';
  workspace_id?: string;
  /** Internal storage namespaces, never an authorization mechanism by themselves. */
  shared_namespace: string;
  private_namespace: string;
}

/** Operator configuration only. Never derive membership from caller-supplied names,
 * email domains, product data, or an unverified token/account claim. */
export function resolvePricingScope(fingerprint: string, configured = process.env.PLYTIX_PRICING_SCOPE_BINDINGS): PricingScope {
  if (!fingerprintSchema.safeParse(fingerprint).success) throw new PlytixError('Invalid pricing credential scope');
  if (configured === undefined || configured.trim() === '') return {
    mode: 'credential', shared_namespace: fingerprint, private_namespace: fingerprint,
  };
  let bindings: Record<string, string>;
  try {
    if (Buffer.byteLength(configured, 'utf8') > 64_000) throw new Error();
    bindings = bindingsSchema.parse(JSON.parse(configured));
  } catch { throw new PlytixError('Pricing workspace bindings are invalid; ask the operator to review configuration'); }
  const scope = bindings[fingerprint];
  if (!scope) throw new PlytixError('This credential is not bound to a pricing workspace; ask the operator to review membership before continuing');
  return {
    mode: 'organization', workspace_id: scope,
    shared_namespace: createHash('sha256').update(JSON.stringify(['pricing-workspace-v1', scope])).digest('hex'),
    private_namespace: fingerprint,
  };
}

export const SHARED_PRICING_FILES = ['rules.json', 'rules-revision-*.json', 'dictionary.json', 'workflow.json'] as const;
export function isSharedPricingFile(key: string): boolean {
  return /^(?:rules|rules-revision-\d+|dictionary|workflow)\.json$/.test(key);
}

/** Safe status fields omit the credential fingerprint and do not claim live authentication. */
export function pricingScopeStatus(scope: PricingScope) {
  return {
    mode: scope.mode,
    ...(scope.workspace_id ? { workspace_id: scope.workspace_id } : {}),
    shared_files: scope.mode === 'organization' ? [...SHARED_PRICING_FILES] : [],
    drafts_and_audits: 'credential_private' as const,
    guidance: scope.mode === 'organization'
      ? 'Explicitly bound credentials share rules, dictionary and workflow guidance only when they use the same storage backend. Imports, plans, reviews and execution audits remain private to each credential.'
      : 'Pricing files are private to this credential pair. Key/password changes select a different namespace; no organization sharing or migration is implied.',
  };
}
export type PricingScopeStatus = ReturnType<typeof pricingScopeStatus>;
