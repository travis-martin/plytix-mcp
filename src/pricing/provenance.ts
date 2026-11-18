import { createHash } from 'node:crypto';
import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const recordKey = z.string().regex(/^[a-z][a-z0-9_-]*:[a-zA-Z0-9_-]{1,160}$/);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 32 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value).every(item => isJsonValue(item, depth + 1));
}
// Snapshots have already passed the corresponding record schema. Validate JSON
// without recursively cloning every historical value again on each read.
const snapshot = z.custom<JsonObject>(value => value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value));

export const provenanceSourceSchema = z.object({
  kind: z.enum(['document', 'plytix', 'user', 'pricing_rule', 'other']),
  reference: z.string().trim().min(1).max(1000),
  sha256: digest.optional(), observed_at: timestamp.optional(),
}).strict();
/** Attribution supplied with an approved tool call is evidence, not authenticated
 * identity or an independent grant of approval. Never accept approval flags here. */
export const reviewMetadataSchema = z.object({
  sources: z.array(provenanceSourceSchema).min(1).max(8),
  reason: z.string().trim().min(1).max(1500),
  reviewer: z.string().trim().min(1).max(160).optional(),
}).strict();
export type ReviewMetadata = z.infer<typeof reviewMetadataSchema>;

export const PROVENANCE_EVENTS_PER_RECORD = 16;
export const PROVENANCE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 1000;
const operationSchema = z.enum(['user_save', 'automatic_observation', 'rule_sync']);
const eventSchema = z.object({
  sequence: z.number().int().min(1), at: timestamp, revision: count,
  operation: operationSchema,
  action: z.enum(['created', 'changed', 'retired', 'restored', 'removed', 'reviewed']),
  before: snapshot.nullable(), after: snapshot.nullable(),
  before_digest: digest.nullable(), after_digest: digest.nullable(),
  review: reviewMetadataSchema.optional(),
  reviewer_identity: z.literal('caller_supplied_not_authenticated').optional(),
}).strict();
const historySchema = z.object({
  origin: z.enum(['tracked_creation', 'legacy_history_unknown']),
  dropped_events: count,
  events: z.array(eventSchema).min(1).max(PROVENANCE_EVENTS_PER_RECORD),
}).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function provenanceDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** This optional document field is written atomically with its records. Missing
 * legacy provenance remains unknown; no reviewer or historical date is invented. */
export const recordProvenanceSchema = z.object({
  version: z.literal(1), records: z.record(recordKey, historySchema), omitted_records: count,
}).strict().superRefine((value, context) => {
  let invalid = Object.keys(value.records).length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(value), 'utf8') > PROVENANCE_MAX_BYTES;
  for (const history of Object.values(value.records)) {
    for (const [index, event] of history.events.entries()) {
      if (event.sequence !== history.dropped_events + index + 1 ||
          event.before_digest !== (event.before === null ? null : provenanceDigest(event.before)) ||
          event.after_digest !== (event.after === null ? null : provenanceDigest(event.after)) ||
          (event.operation !== 'user_save' && event.review !== undefined) ||
          Boolean(event.reviewer_identity) !== Boolean(event.review?.reviewer)) invalid = true;
      if ((event.before === null && event.after === null) ||
          event.action !== action(event.before, event.after, event.before_digest === event.after_digest,
            event.sequence > 1 ? history : undefined) ||
          (event.action === 'reviewed' && !event.review) ||
          (event.sequence === 1 && (history.origin === 'tracked_creation') !== (event.before === null))) invalid = true;
      const previous = history.events[index - 1];
      if (previous && (event.before_digest !== previous.after_digest || event.revision <= previous.revision)) invalid = true;
    }
  }
  if (invalid) context.addIssue({ code: 'custom', message: 'Invalid record provenance history' });
});
export type RecordProvenance = z.infer<typeof recordProvenanceSchema>;
type Event = z.infer<typeof eventSchema>;
export interface ProvenanceRecord { key: string; value: object }

/** After recordProvenanceSchema validation, reject contradictory histories instead of displaying a
 * source trail for different current content. Missing legacy histories remain
 * allowed; this verifies integrity, never the truth of supplied attribution. */
export function assertRecordProvenance(value: RecordProvenance | undefined, currentRecords: ProvenanceRecord[], revision: number): void {
  if (!value) return;
  const current = new Map(currentRecords.map(item => [item.key, provenanceDigest(item.value)]));
  for (const [key, history] of Object.entries(value.records)) {
    const terminal = history.events[history.events.length - 1];
    if (terminal.after_digest !== (current.get(key) ?? null) || terminal.revision > revision) {
      throw new Error('Current record does not match its stored provenance');
    }
  }
}

function plainSnapshot(value: object | undefined): z.infer<typeof snapshot> | null {
  return value === undefined ? null : snapshot.parse(JSON.parse(JSON.stringify(value)));
}
function action(before: z.infer<typeof snapshot> | null, after: z.infer<typeof snapshot> | null,
  unchanged: boolean, previous?: z.infer<typeof historySchema>): Event['action'] {
  if (unchanged) return 'reviewed';
  if (!after) return 'removed';
  if (!before) return previous ? 'restored' : 'created';
  if (after.status === 'retired' && before.status !== 'retired') return 'retired';
  if (before.status === 'retired' && after.status !== 'retired') return 'restored';
  return 'changed';
}

/** Call only inside the same synchronous store update as the record mutation.
 * Callers provide semantic records, never imported provenance. CAS retries are
 * side-effect-free, and unchanged automatic reads do not manufacture history. */
export function appendRecordProvenance(previous: RecordProvenance | undefined, input: {
  before: ProvenanceRecord[]; after: ProvenanceRecord[];
  at: string; revision: number; operation: z.infer<typeof operationSchema>;
  review?: ReviewMetadata; review_keys?: string[];
}): RecordProvenance | undefined {
  timestamp.parse(input.at); count.parse(input.revision); operationSchema.parse(input.operation);
  const review = input.review === undefined ? undefined : reviewMetadataSchema.parse(input.review);
  if (input.operation !== 'user_save' && review) throw new Error('Automatic observations cannot record a user review');
  // Store parsers validated previous once; the newly built history is validated
  // once below. Avoid repeatedly hashing the same retained history on one save.
  const current = previous ?? { version: 1 as const, records: {}, omitted_records: 0 };
  const records = structuredClone(current.records);
  const before = new Map(input.before.map(item => [recordKey.parse(item.key), plainSnapshot(item.value)]));
  const after = new Map(input.after.map(item => [recordKey.parse(item.key), plainSnapshot(item.value)]));
  if (before.size !== input.before.length || after.size !== input.after.length) throw new Error('Duplicate provenance record keys');
  const reviewed = new Set(review ? input.review_keys ?? [] : []);
  let changed = false;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key) ?? null, next = after.get(key) ?? null;
    const oldDigest = old === null ? null : provenanceDigest(old), nextDigest = next === null ? null : provenanceDigest(next);
    if (oldDigest === nextDigest && !reviewed.has(key)) continue;
    const history = records[key] ?? { origin: old === null ? 'tracked_creation' as const : 'legacy_history_unknown' as const,
      dropped_events: 0, events: [] };
    const last = history.events[history.events.length - 1];
    if (last && last.after_digest !== oldDigest) throw new Error('Record content does not match its stored provenance');
    const event: Event = { sequence: (last?.sequence ?? 0) + 1, at: input.at, revision: input.revision, operation: input.operation,
      action: action(old, next, oldDigest === nextDigest, records[key]), before: old, after: next, before_digest: oldDigest, after_digest: nextDigest,
      ...(review && reviewed.has(key) ? { review, ...(review.reviewer ? { reviewer_identity: 'caller_supplied_not_authenticated' as const } : {}) } : {}) };
    history.events.push(event);
    while (history.events.length > PROVENANCE_EVENTS_PER_RECORD) { history.events.shift(); history.dropped_events++; }
    records[key] = history; changed = true;
  }
  if (!changed) return previous;
  const result: RecordProvenance = { version: 1, records, omitted_records: current.omitted_records };
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  // Retain the latest complete before/after snapshot for every current record.
  // Older prefixes and deleted-record histories have explicitly reported limits.
  while (size() > PROVENANCE_MAX_BYTES || Object.keys(records).length > MAX_RECORDS) {
    const removed = Object.entries(records).filter(([, history]) => history.events[history.events.length - 1].after === null)
      .sort(([a, x], [b, y]) => x.events[x.events.length - 1].at.localeCompare(y.events[y.events.length - 1].at) || a.localeCompare(b))[0];
    if (removed) { delete records[removed[0]]; result.omitted_records++; continue; }
    const oldest = Object.entries(records).filter(([, history]) => history.events.length > 1)
      .sort(([a, x], [b, y]) => x.events[0].at.localeCompare(y.events[0].at) || a.localeCompare(b))[0];
    if (!oldest) throw new Error('Record provenance exceeds its retention limit; shorten source references or consolidate records');
    oldest[1].events.shift(); oldest[1].dropped_events++;
  }
  return recordProvenanceSchema.parse(result);
}

export const provenanceAuthority = 'Change times, revisions and snapshots are recorded by the server. Review sources, reason and reviewer name are supplied attribution, not authenticated identity or independent approval. Missing legacy record history is unknown. Retention drops oldest events explicitly; this is not a complete historical audit.';

/** Narrow reads return only provenance for returned records. Full unfiltered
 * exports should use the complete document-level provenance map. */
export function selectRecordProvenance(value: RecordProvenance | undefined, keys: string[]): RecordProvenance | undefined {
  if (!value) return undefined;
  const selected = new Set(keys);
  return { ...value, records: Object.fromEntries(Object.entries(value.records).filter(([key]) => selected.has(key))) };
}
