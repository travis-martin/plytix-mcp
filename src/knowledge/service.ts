import { randomUUID } from 'node:crypto';
import type { PlytixClient } from '../client.js';
import type { ToolResult } from '../results.js';
import { parseResult } from '../results.js';
import { KnowledgeError, definitionInput, observation, type DefinitionInput, type KnowledgeDocument } from './model.js';
import { KnowledgeRegistry, type KnowledgeContext } from './registry.js';

export class KnowledgeService {
  private contextOperation = -1;
  private contextPromise?: Promise<KnowledgeContext | undefined>;
  private approvedProposalOperation = -1;
  private readonly proposalEnabled: boolean;
  constructor(
    private readonly client: PlytixClient, private readonly registry?: KnowledgeRegistry,
    writeTools: ReadonlySet<string> = new Set(),
  ) { this.proposalEnabled = writeTools.has('knowledge_propose'); }

  /** Called only by the trusted tool wrapper after exact-argument host approval. */
  beginApprovedProposal(): void {
    this.client.checkOperationActive();
    if (!this.proposalEnabled) throw new KnowledgeError('Knowledge proposals are disabled');
    this.approvedProposalOperation = this.client.getOperationId();
  }

  async context(): Promise<KnowledgeContext | undefined> {
    if (!this.registry) return undefined;
    this.client.checkOperationActive();
    if (this.contextOperation !== this.client.getOperationId()) {
      this.contextOperation = this.client.getOperationId();
      this.contextPromise = (async () => {
        const context = await this.registry!.resolve(this.client.knowledgeFingerprint());
        if (context) await this.client.verifyKnowledgeAccess();
        return context;
      })();
    }
    return this.contextPromise;
  }

  async status() {
    const context = await this.context();
    if (!context) return {
      configured: false,
      guidance: 'Live catalog discovery is available. An operator can run plytix-knowledge-admin init and bind each colleague connection to a shared workspace.',
    };
    const document = await context.store.read();
    return {
      configured: true, workspace: context.workspace, member: context.member,
      can_propose: context.canPropose, revision: document.revision,
      counts: {
        observations: document.observations.length,
        confirmed: document.definitions.filter(item => item.status === 'confirmed').length,
        proposed: document.definitions.filter(item => item.status === 'proposed').length,
      },
      learning: 'Only observed attribute schema is learned automatically when enabled. Business definitions require operator review. This store is not a complete catalog snapshot.',
    };
  }

  async observe(tool: string, result: ToolResult): Promise<void> {
    if (!this.registry || result.isError || !['attributes_search', 'attributes_get', 'catalog_dictionary'].includes(tool)) return;
    const context = await this.context();
    if (!context?.workspace.learn_observations) {
      result.resultMetadata = { ...result.resultMetadata, learning: { status: 'disabled' } };
      return;
    }
    const data = parseResult(result) as Record<string, any>;
    const rows: unknown[] = tool === 'attributes_get' ? [data]
      : tool === 'catalog_dictionary' ? data.live_schema?.attributes ?? [] : data.attributes ?? [];
    if (!rows.length) return;
    const now = new Date().toISOString();
    const sources = this.client.getReadEvidence();
    // A cached attribute definition keeps its original observation time.
    const observedAt = sources.length ? sources.map(item => item.observed_at).sort()[0] : now;
    const records = rows.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const value = row as Record<string, any>;
      const parsed = observation.safeParse({
        label: value.label, id: value.id, name: value.name, type_class: value.type_class,
        groups: Array.isArray(value.groups) ? value.groups : undefined,
        options: Array.isArray(value.options) ? value.options.slice(0, 500) : undefined,
        options_truncated: Array.isArray(value.options) ? value.options.length > 500 : undefined,
        observed_at: observedAt, source: 'plytix_attribute_schema', observed_by: context.member,
      });
      return parsed.success ? [parsed.data] : [];
    });
    if (!records.length) return;
    this.client.checkOperationActive();
    const saved = await context.store.update(document => {
      this.client.checkOperationActive();
      const byLabel = new Map(document.observations.map(item => [item.label, item]));
      for (const record of records) {
        const previous = byLabel.get(record.label);
        if (previous && previous.observed_at > record.observed_at) continue;
        // A lightweight read without options must not make stale options appear
        // freshly observed. Replace the observation instead of merging fields.
        byLabel.set(record.label, {
          ...record,
          ...(previous?.type_class !== record.type_class && previous
            ? { previous_type: previous.type_class }
            : previous?.previous_type ? { previous_type: previous.previous_type } : {}),
        });
      }
      document.observations = [...byLabel.values()];
    });
    result.resultMetadata = { ...result.resultMetadata, learning: {
      status: 'stored', observations: records.length, revision: saved.revision,
    } };
  }

  async propose(input: DefinitionInput) {
    if (!this.proposalEnabled || this.approvedProposalOperation !== this.client.getOperationId()) {
      throw new KnowledgeError('Knowledge proposal is not authorized for this operation');
    }
    this.approvedProposalOperation = -1;
    const context = await this.context();
    if (!context?.canPropose) throw new KnowledgeError('Shared knowledge contribution is not enabled for this connection; ask the workspace operator');
    const value = definitionInput.parse(input);
    const now = new Date().toISOString();
    let id = '';
    const document = await context.store.update(document => {
      this.client.checkOperationActive();
      const duplicate = document.definitions.find(item => item.status === 'proposed' &&
        JSON.stringify(definitionInput.strip().parse(item)) === JSON.stringify(value));
      if (duplicate) { id = duplicate.id; return; }
      id = randomUUID();
      document.definitions.push({
        ...value, id, status: 'proposed', created_at: now, updated_at: now, proposed_by: context.member,
      });
    });
    return { id, status: 'proposed', revision: document.revision, guidance: 'Not an authoritative business definition until an operator confirms it.' };
  }
}

export function searchKnowledge(document: KnowledgeDocument, query: string, includeProposals: boolean) {
  const term = query.trim().toLocaleLowerCase();
  const matches = (values: string[]) => !term || values.some(value => value.toLocaleLowerCase().includes(term));
  return {
    definitions: document.definitions.filter(item =>
      (item.status === 'confirmed' || (includeProposals && item.status === 'proposed')) &&
      matches([item.term, ...item.aliases, ...item.attribute_labels])),
    observations: document.observations.filter(item => matches([item.label, item.name])),
  };
}
