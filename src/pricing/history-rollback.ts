import { z } from 'zod';
import { guidanceDocument } from './guidance.js';
import { memoryEntrySchema } from './memory.js';
import { rulesDocument } from './model.js';
import { reviewMetadataSchema } from './provenance.js';
import { verifyPortableExport } from './portable-export.js';
import { importCandidateSchema } from './reviewed-import.js';
import { historyDocumentName, validateRevisionArchive } from './version-history.js';

/** Pure offline proposal. Restores business fields, never old revisions, history,
 * provenance, approval, identity or storage pointers. Current state must still be
 * freshly checked by the existing reviewed-import prepare/preflight workflow. */
export function prepareHistoryRollback(input: { current: unknown; history: unknown; change_id: string; review: unknown }) {
  const current = verifyPortableExport(input.current), review = reviewMetadataSchema.parse(input.review);
  const envelope = z.object({ metadata: z.object({ tool: z.literal('pricing_history_get'), status: z.enum(['ok', 'partial']) }), data: z.object({
    state: z.literal('retained'), document: historyDocumentName, current_revision: z.number().int().nonnegative(),
    storage_scope: z.object({ mode: z.literal('organization'), workspace_id: z.string() }), storage_backend: z.enum(['file', 'gcs']),
    revisions: z.array(z.unknown()).min(1).max(1),
  }) }).parse(input.history);
  const history = envelope.data;
  if (history.storage_scope.workspace_id !== current.organization.workspace_id || history.storage_backend !== current.source.backend) {
    throw new Error('Rollback cannot cross organization workspaces or storage backends');
  }
  if (history.current_revision !== current.source[history.document].revision) throw new Error('History and current export revisions differ; recapture both');
  const archive = validateRevisionArchive(history.revisions[0], history.document, input.change_id);
  if (archive.revision >= history.current_revision) throw new Error('Rollback must select an older committed revision');
  const candidate = importCandidateSchema.parse({ format: 'organization-pricing-import-candidate', schema_version: 1,
    base_export_sha256: current.integrity.sha256, review });
  if (history.document === 'workflow') {
    const old = guidanceDocument.parse(archive.snapshot);
    const merge = <T extends { id: string; status: string }>(desired: T[], present: T[]) => {
      const ids = new Set(desired.map(item => item.id));
      return [...desired, ...present.filter(item => !ids.has(item.id)).map(item => ({ ...item, status: 'retired' as const }))];
    };
    candidate.workflow = { instructions: merge(old.instructions, current.workflow.instructions), exclusions: merge(old.exclusions, current.workflow.exclusions) };
  } else if (history.document === 'dictionary') {
    const old = z.object({ entries: z.array(memoryEntrySchema).max(500) }).parse(archive.snapshot).entries;
    const ids = new Set(old.map(item => item.id));
    candidate.dictionary = [...old, ...current.dictionary.entries.filter(item => !ids.has(item.id)).map(item => ({ ...item, status: 'retired' as const }))]
      .map(item => { const latest = item.evidence.at(-1); return { id: item.id, value: item.value, status: item.status, note: item.note,
        ...(latest ? { evidence: Object.fromEntries(Object.entries(latest).filter(([key]) => key !== 'observed_at')) } : {}) }; }) as typeof candidate.dictionary;
  } else {
    const old = rulesDocument.parse(archive.snapshot);
    const ids = new Set(old.rules.map(item => item.id));
    candidate.rules = { current: old.rules, remove_rule_ids: current.calculation_rules.current.filter(item => !ids.has(item.id)).map(item => item.id) };
  }
  const result = importCandidateSchema.parse(candidate);
  const markdown = ['# Pricing history rollback proposal', '', `Document: ${history.document}`, `Current revision: ${history.current_revision}`,
    `Restore business fields from revision: ${archive.revision}`, `Archive SHA256: ${archive.change_id}`,
    `Change-Id: ${review.change_id ?? '(not supplied; runtime generates its canonical revision ID)'}`, '',
    'This is an offline proposal, not a restore or approval. Prepare and preflight it through plytix-pricing-import using a fresh complete capture, then request the exact existing save tools.', '',
    'Newer workflow and dictionary IDs remain recorded as retired; omitted rules are explicit removal requests. Review protection changes and retirements. Imported confirmed rules and user-defined dictionary meanings require explicit per-ID decisions. Retired dictionary entries cannot be reactivated through the import workflow; resolve those cases separately. Stored history, approval, timestamps and revision numbers are never overwritten.', '',
    'If combining older records with newer retirement records exceeds current workflow or dictionary limits, prepare a smaller explicitly reviewed restoration; the helper fails instead of silently dropping records.', '',
    'Offline checks validate the supplied capture, not live freshness or authenticated attribution. No credentials, product updates or runtime writes are performed.', '',
  ].join('\n');
  return { candidate: result, markdown };
}
