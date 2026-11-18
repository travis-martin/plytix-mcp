import { z } from 'zod';
import { guidanceSaveInput } from './guidance.js';
import { memoryEntryId, memoryEvidence, memoryUpdateInput, memoryValue } from './memory.js';
import { rulesInput, ruleSchema } from './model.js';
import { assertReusableCostRules } from './calculate.js';
import { reviewMetadataSchema } from './provenance.js';
import { createPortableExport, portableContentDigest, verifyPortableExport, type ExportDocument } from './portable-export.js';

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const dictionaryEdit = z.object({ id: checksum, value: memoryValue,
  status: z.enum(['observed', 'proposed', 'reviewed_rule', 'user_defined', 'retired']),
  evidence: memoryEvidence.optional(), note: z.string().max(1000).optional(),
}).strict();
export const importCandidateSchema = z.object({
  format: z.literal('organization-pricing-import-candidate'), schema_version: z.literal(1), base_export_sha256: checksum,
  workflow: z.object({ instructions: guidanceSaveInput.shape.instructions, exclusions: guidanceSaveInput.shape.exclusions }).strict().optional(),
  // Dictionary is a patch: omitted entries are unchanged, never deleted.
  dictionary: z.array(dictionaryEdit).max(500).optional(),
  rules: z.object({ current: z.array(ruleSchema).max(100), remove_rule_ids: z.array(z.string()).max(100).default([]) }).strict().optional(),
  decisions: z.object({ user_defined_dictionary_ids: z.array(checksum).max(500).default([]),
    confirm_rule_ids: z.array(z.string()).max(100).default([]) }).strict().default({ user_defined_dictionary_ids: [], confirm_rule_ids: [] }),
  review: reviewMetadataSchema.optional(),
}).strict();
type Candidate = z.infer<typeof importCandidateSchema>;
export interface ImportChange {
  section: 'instructions' | 'exclusions' | 'dictionary' | 'rules'; id: string;
  change: 'added' | 'changed' | 'retired' | 'removed'; before: unknown | null; requested: unknown | null; proposed: unknown | null;
  flags: string[];
}
type ToolCall =
  | { tool: 'pricing_guidance_save'; arguments: z.infer<typeof guidanceSaveInput> }
  | { tool: 'pricing_dictionary_update'; arguments: z.infer<typeof memoryUpdateInput> }
  | { tool: 'pricing_rules_save'; arguments: z.infer<typeof rulesInput> };
const fail = (message: string): never => { throw new Error(message); };
const same = (a: unknown, b: unknown) => portableContentDigest(a) === portableContentDigest(b);
function unique(values: string[], name: string) { if (new Set(values).size !== values.length) fail(`Duplicate IDs in ${name}`); }
function editableEntry(entry: ExportDocument['dictionary']['entries'][number]) {
  const latest = entry.evidence[entry.evidence.length - 1];
  const evidence = latest ? Object.fromEntries(Object.entries(latest).filter(([key]) => key !== 'observed_at')) : undefined;
  return dictionaryEdit.parse({ id: entry.id, value: entry.value, status: entry.status, evidence, note: entry.note });
}

/** Editable fields only; stored history, timestamps and membership cannot be imported. */
export function createImportCandidate(exportInput: unknown) {
  const baseline = verifyPortableExport(exportInput);
  return importCandidateSchema.parse({ format: 'organization-pricing-import-candidate', schema_version: 1,
    base_export_sha256: baseline.integrity.sha256, workflow: { instructions: baseline.workflow.instructions, exclusions: baseline.workflow.exclusions },
    dictionary: baseline.dictionary.entries.map(editableEntry),
    rules: { current: baseline.calculation_rules.current, remove_rule_ids: [] },
  });
}

function receipt(document: ExportDocument) {
  return { workspace_id: document.organization.workspace_id, backend: document.source.backend,
    workflow: { revision: document.source.workflow.revision, digest: document.source.workflow.digest,
      records_sha256: portableContentDigest(document.workflow) },
    dictionary: { revision: document.source.dictionary.revision, records_sha256: portableContentDigest(document.dictionary) },
    rules: { revision: document.source.rules.revision, records_sha256: portableContentDigest(document.calculation_rules) },
  };
}
function assertCurrent(baseline: ExportDocument, current: ExportDocument) {
  if (baseline.organization.workspace_id !== current.organization.workspace_id || baseline.source.backend !== current.source.backend) {
    fail('Import cannot cross organization workspaces or storage backends');
  }
  if (!same(receipt(baseline), receipt(current))) fail('Import baseline is stale; refresh the export and review the candidate against current records');
}
function recordDiff<T extends { id: string; status?: string }>(section: ImportChange['section'], before: T[], requested: T[], next: T[]) {
  unique(requested.map(item => item.id), section);
  const old = new Map(before.map(item => [item.id, item]));
  const proposals = new Map(next.map(item => [item.id, item]));
  const changes: ImportChange[] = [];
  for (const item of requested) {
    const previous = old.get(item.id), proposed = proposals.get(item.id)!;
    if (same(previous ?? null, proposed)) continue;
    const flags: string[] = [];
    if (section === 'exclusions') flags.push(previous ? 'PROTECTION_CHANGED: review the full predicate, scope, targets and status' : 'PROTECTION_ADDED');
    if (section === 'instructions') flags.push('OWNER_REQUIREMENT_CHANGED: review the exact text, scope, priority and status');
    if (proposed.status === 'retired') flags.push('EXPLICIT_RETIREMENT');
    changes.push({ section, id: item.id, change: !previous ? 'added' : proposed.status === 'retired' && previous.status !== 'retired' ? 'retired' : 'changed',
      before: previous ?? null, requested: item, proposed, flags });
  }
  for (const previous of before) if (!proposals.has(previous.id)) changes.push({ section, id: previous.id, change: 'removed', before: previous, requested: null, proposed: null, flags: ['EXPLICIT_REMOVAL'] });
  return changes;
}

/** Produces proposals only. Status choices are review requests, never proof of human approval. */
export function prepareReviewedImport(input: { baseline: unknown; candidate: unknown; capture: unknown }) {
  const baseline = verifyPortableExport(input.baseline);
  const candidate = importCandidateSchema.parse(input.candidate);
  if (candidate.base_export_sha256 !== baseline.integrity.sha256) fail('Candidate does not name this verified baseline export');
  const current = createPortableExport(input.capture).document;
  assertCurrent(baseline, current);
  unique(candidate.decisions.user_defined_dictionary_ids, 'dictionary decisions'); unique(candidate.decisions.confirm_rule_ids, 'rule decisions');
  const calls: ToolCall[] = [], changes: ImportChange[] = [], warnings: string[] = [];
  if (candidate.workflow) {
    for (const section of ['instructions', 'exclusions'] as const) {
      const requestedIds = new Set(candidate.workflow[section].map(item => item.id));
      if (current.workflow[section].some(item => !requestedIds.has(item.id))) fail('Preserve every workflow ID; explicitly retire a record instead of omitting it');
    }
    const next = guidanceSaveInput.parse({ expected_revision: current.source.workflow.revision, ...candidate.workflow,
      ...(candidate.review ? { review: candidate.review } : {}) });
    const workflowChanges = [
      ...recordDiff('instructions', current.workflow.instructions, next.instructions, next.instructions),
      ...recordDiff('exclusions', current.workflow.exclusions, next.exclusions, next.exclusions),
    ];
    changes.push(...workflowChanges);
    if (workflowChanges.length) calls.push({ tool: 'pricing_guidance_save', arguments: next });
  }

  const dictionaryArguments: z.infer<typeof memoryUpdateInput>['entries'] = [];
  if (candidate.dictionary) {
    unique(candidate.dictionary.map(item => item.id), 'dictionary candidate');
    const old = new Map(current.dictionary.entries.map(item => [item.id, item]));
    const explicitUserIds = new Set(candidate.decisions.user_defined_dictionary_ids);
    for (const requested of candidate.dictionary) {
      if (memoryEntryId(requested.value) !== requested.id) fail('Dictionary identity changed; create an explicitly new ID and separately retire the old entry if appropriate');
      const existing = old.get(requested.id), before = existing ? editableEntry(existing) : null;
      if (same(before, requested)) continue;
      if (existing?.status === 'retired' && requested.status !== 'retired') fail('A retired dictionary entry cannot be silently reactivated by import');
      let status: 'proposed' | 'user_defined' | 'retired' = requested.status === 'retired' ? 'retired' : 'proposed';
      const flags: string[] = [];
      if (requested.status === 'user_defined') {
        if (!explicitUserIds.has(requested.id) || requested.evidence?.source !== 'user') {
          fail('Imported user-defined dictionary changes need an explicit per-ID decision and user source evidence');
        }
        status = 'user_defined'; flags.push('USER_DEFINED_REQUEST: explicit source and per-ID decision still require host approval');
      } else if (requested.status !== 'retired') {
        flags.push('ADVISORY_IMPORT: changed observations and rule-derived meanings are proposed, never confirmed automatically');
      }
      if (existing && ['user_defined', 'reviewed_rule'].includes(existing.status) && status === 'proposed') {
        flags.push(same(existing.value, requested.value)
          ? 'PROTECTED_NO_VALUE_CHANGE: the server retains the existing definition, status and evidence; only review provenance is recorded'
          : 'PENDING_ONLY: the existing user-defined or rule-derived meaning stays protected; this creates a pending suggestion');
      }
      if (status === 'retired') flags.push('EXPLICIT_RETIREMENT');
      const proposed = memoryUpdateInput.shape.entries.element.parse({ value: requested.value, status, evidence: requested.evidence, note: requested.note });
      dictionaryArguments.push(proposed);
      changes.push({ section: 'dictionary', id: requested.id, change: !existing ? 'added' : status === 'retired' ? 'retired' : 'changed',
        before, requested, proposed, flags });
    }
    for (const id of explicitUserIds) if (!changes.some(change => change.section === 'dictionary' && change.id === id &&
      (change.proposed as { status?: string } | null)?.status === 'user_defined')) {
      fail('A dictionary decision must refer to a changed entry in the candidate');
    }
    let nextRevision = current.source.dictionary.revision;
    let batch: typeof dictionaryArguments = [];
    const argsFor = (entries: typeof dictionaryArguments) => memoryUpdateInput.parse({ expected_revision: nextRevision, entries,
      ...(candidate.review ? { review: candidate.review } : {}) });
    for (const entry of dictionaryArguments) {
      const proposedBatch = [...batch, entry];
      if (proposedBatch.length > 50 || Buffer.byteLength(JSON.stringify(argsFor(proposedBatch)), 'utf8') > 16000) {
        if (!batch.length) fail('One dictionary update exceeds the supported 16,000-byte tool argument limit');
        calls.push({ tool: 'pricing_dictionary_update', arguments: argsFor(batch) }); nextRevision++; batch = [];
      }
      batch.push(entry);
      if (Buffer.byteLength(JSON.stringify(argsFor(batch)), 'utf8') > 16000) fail('One dictionary update exceeds the supported 16,000-byte tool argument limit');
    }
    if (batch.length) calls.push({ tool: 'pricing_dictionary_update', arguments: argsFor(batch) });
  } else if (candidate.decisions.user_defined_dictionary_ids.length) fail('Dictionary decisions require a dictionary candidate section');

  if (candidate.rules) {
    unique(candidate.rules.current.map(rule => rule.id), 'rules candidate'); unique(candidate.rules.remove_rule_ids, 'rule removals');
    const old = new Map(current.calculation_rules.current.map(rule => [rule.id, rule]));
    const requestedIds = new Set(candidate.rules.current.map(rule => rule.id));
    for (const id of candidate.rules.remove_rule_ids) if (!old.has(id) || requestedIds.has(id)) fail('Explicit rule removals must name an existing omitted rule');
    for (const rule of current.calculation_rules.current) if (!requestedIds.has(rule.id) && !candidate.rules.remove_rule_ids.includes(rule.id)) fail('Omitted rules require explicit remove_rule_ids');
    const confirmIds = new Set(candidate.decisions.confirm_rule_ids);
    const nextRules = candidate.rules.current.map(rule => {
      if (same(rule, old.get(rule.id))) return rule;
      if (rule.status === 'confirmed' && !confirmIds.has(rule.id)) {
        warnings.push(`Rule ${rule.id} was imported as proposed; its copied confirmed status is not trusted.`);
        return ruleSchema.parse({ ...rule, status: 'proposed' });
      }
      return rule;
    });
    for (const id of confirmIds) if (!candidate.rules.current.some(rule => rule.id === id && rule.status === 'confirmed' && !same(rule, old.get(id)))) {
      fail('A confirmation decision must name a changed confirmed rule in the candidate');
    }
    assertReusableCostRules(nextRules, current.calculation_rules.current);
    const ruleChanges = recordDiff('rules', current.calculation_rules.current, candidate.rules.current, nextRules);
    for (const change of ruleChanges) if (confirmIds.has(change.id)) change.flags.push('CONFIRMATION_REQUEST: per-ID decision still requires current host approval');
    changes.push(...ruleChanges);
    if (ruleChanges.length) calls.push({ tool: 'pricing_rules_save', arguments: rulesInput.parse({
      expected_revision: current.source.rules.revision, rules: nextRules, ...(candidate.review ? { review: candidate.review } : {}),
    }) });
  } else if (candidate.decisions.confirm_rule_ids.length) fail('Rule confirmation decisions require a rules candidate section');
  for (const call of calls) {
    const limit = call.tool === 'pricing_guidance_save' ? 64000 : 16000;
    if (Buffer.byteLength(JSON.stringify(call.arguments), 'utf8') > limit) fail(`Exact ${call.tool} arguments exceed the supported ${limit}-byte limit; reduce the complete reviewed set without implicitly dropping records`);
  }
  if (!candidate.review && calls.length) fail('Import changes require structured review sources and a reason');
  if (calls.some(call => call.tool === 'pricing_rules_save')) warnings.push('Saving rules may update their advisory dictionary index. Execute rule saves last, then recapture and refresh the export.');
  const payload = { format: 'organization-pricing-import-review' as const, schema_version: 1 as const,
    baseline, candidate, expected: receipt(current), changes, calls, warnings,
    execution: 'PROPOSAL_ONLY: review the exact calls, preflight with a fresh complete capture and the reviewed digest, then use the existing host-approved MCP tools in order. This offline check validates supplied evidence; it cannot prove that a capture reflects the current remote state. Stop on any failure or uncertainty; recapture and re-review remaining changes. Never directly write runtime files.' };
  return { ...payload, review_digest: portableContentDigest(payload) };
}

/** A fresh preflight does not bypass host permissions or authorize the returned mutations. */
export function preflightReviewedImport(input: { review: unknown; reviewed_digest: string; capture: unknown }) {
  const raw = z.record(z.string(), z.unknown()).parse(input.review);
  const expectedDigest = checksum.parse(input.reviewed_digest);
  const savedDigest = checksum.parse(raw.review_digest);
  const { review_digest: _digest, ...payload } = raw;
  if (expectedDigest !== savedDigest || portableContentDigest(payload) !== savedDigest) fail('Reviewed import digest mismatch');
  if (raw.format !== 'organization-pricing-import-review' || raw.schema_version !== 1) fail('Unsupported import review version');
  const regenerated = prepareReviewedImport({ baseline: raw.baseline, candidate: raw.candidate, capture: input.capture });
  if (regenerated.review_digest !== savedDigest) fail('Reviewed import changed; review the newly prepared proposal before proceeding');
  return { status: 'ready_for_existing_host_approval' as const, reviewed_digest: savedDigest,
    calls: regenerated.calls, changes: regenerated.changes, warnings: regenerated.warnings, execution: regenerated.execution };
}

export function renderImportReview(review: ReturnType<typeof prepareReviewedImport>): string {
  const text = JSON.stringify({ expected: review.expected, changes: review.changes, calls: review.calls, warnings: review.warnings }, null, 2);
  const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return ['# Organization pricing import review', '',
    `Review digest: ${review.review_digest}`, '', `${review.changes.length} changed records; ${review.calls.length} proposed tool calls.`, '',
    review.execution, '',
    'Review every before, requested and proposed value below. Imported statuses are not evidence of approval. Protection changes, retirements and user-defined/confirmed requests are called out explicitly.', '',
    'Preflight with a fresh complete capture and this exact digest immediately before requesting these calls through the existing host-approved tools. Execute in the listed order. A partial failure requires a fresh capture and a new review; do not replay successful or uncertain calls.', '',
    `${fence}json`, text, fence, ''].join('\n');
}
