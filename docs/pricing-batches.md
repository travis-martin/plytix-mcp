# Streamlined reviewed pricing batches

The prepared manifest fixes every owner, attribute, old/new cost, inherited
effect, preserved override and transport choice. Row decisions remain private
drafts. The existing exact-action approval gate is required before any send.
The implementation is shared by stdio and HTTP.

## Execution

1. Read current family metadata and products once per bounded page/field block.
   Compare the selected changes with the approved source, calculations, guidance,
   supplier slots, raw-stock dimensions, hierarchy and explicit override markers.
   Hold a conflicted material group; unrelated approved groups can continue.
2. Save the baseline and reserve the batch durably. Combine all approved numeric
   attributes for each owner. Send one bulk update containing those owners.
   Never write inherited child values or reset their overrides.
3. Poll the saved job ID. A `Finished` label alone is insufficient: completed
   counters must cover every submitted owner. Delayed row-error details remain
   visible and can be polled again without reposting.
4. Validate all owners and children together with fresh paginated family reads.
   Verify inherited costs and preserved overrides, other supplier slots, primary
   suppliers, raw dimensions and captured identity/restriction fields. Unexpected
   changes to excluded or unrelated family members are reported, never repaired
   automatically. A request's acceptance is not readback verification.

There is no artificial sleep between requests. Only an actual HTTP 429 causes
rate-limit backoff; Retry-After persists across continuations. Request, response
and execution budgets still apply. There is no transaction or compare-and-set
at Plytix: an external edit can race the preflight snapshot.

## Transport contract

| Choice | Behavior |
| --- | --- |
| `auto` | Bulk first; fall back to PATCH only after a definite bulk HTTP 403, 404 or 405 rejection |
| `bulk` | Bulk only; a rejected job/submission does not silently change transport |
| `patch` | One sequential `PATCH /api/v2/products/{id}` per owner, combining approved attributes; one final batch validation |

Bulk uses `POST /api/v1/bulk/products` with
`{action:"update",products:[{id,data:{attributes:{...}}}]}` and polls
`GET /api/v1/bulk/products/{job_id}`. The payload supports at most 1,000 distinct
owners; the review's existing limit is 100 comparisons and 64,000 approval
characters, often fewer when descendant evidence is large. Search pages contain
at most 100 products and 50 requested fields, bounded to 100 pages per family
and field block. Catalog-wide `total_count` is not treated as filtered count.

The bulk contract comes from the Plytix-authored
[bulk API draft](https://github.com/Supplyline/plytix-mcp/blob/main/docs/features/batch-update/plytix-bulk-actions-draft-2021.pdf).
Its adapter and failure handling are fixture-tested here. Live bulk acceptance
and job behavior on the deployment's account still require a separately approved
product update; read-only probes do not establish mutation permissions.

A missing job ID, timeout or ambiguous 5xx never triggers fallback or another
submission. No automatic rollback, job cancellation or catalog-wide write sweep
is supported.

## Material consistency

Prefer a nonempty `material_id`; use supplier MPN when material ID is absent.
Qualify it with family, supplier, target attribute, color, grade, series, shape,
actual thickness/diameter, raw length/width, calculation method, currency and unit.
An MPN alone is insufficient when natural and reprocessed materials share it.
Different full-stock lengths may have different full-item costs.

Each reviewed family is checked in full. Conflicting proposed costs, conflicting
MPNs within a material group, or additional unapproved owners needing the new
cost hold the group for review. Grouping never expands the approved set. Explicit
child cost overrides remain exceptions. Scope is the selected families, not an
assertion that every matching identifier across the entire account was checked.
Preparation checks the actually selected owners, and keeps a material group
together when fitting the approval size limit; pending members are not approval.

## Status and recovery

| Per-line state | Meaning / next action |
| --- | --- |
| `queued` | No successful submission recorded; continue the exact manifest through the approved apply tool |
| `submitted` | Accepted; poll the existing job or validate without resending |
| `validation_pending` | Expected values or preserved fields do not yet match; refresh and inspect |
| `verified` / `unchanged` | Completed comparison; do not send again |
| `conflict` | Evidence changed before send; correct/reprepare and review the affected group |
| `failed` | Definite rejection; review current values before preparing a new approval |
| `sending_or_unknown` | A write might have succeeded; never replay it automatically |

`pricing_review_get` reads the saved audit. `pricing_review_refresh` polls known
jobs and validates with reads only. It cannot resume queued writes. The review
returns exact `continuations` for queued rows; its workspace button requests the
normal trusted approval flow in the conversation. Reusing the exact manifest
sends only still-queued rows after fresh preflight. A changed review revision or
manifest is rejected. Modified proposals require recalculation and selection.

Durable before/after-send checkpoints and a generation-checked lease prevent
concurrent or replayed sends. If an operation ends before final validation,
refresh resumes validation only. Audit revisions prevent a slower finishing
request from overwriting a newer result. Do not run older pricing writers against
active v0.10.0 batch records; disable writes before a rollback.

## Fixture evidence

The 38-owner fixture includes 228 children, four excluded owners with 24 children,
and one family root: 295 records. It uses one bulk submission and three product
searches per preflight/final validation pass, with zero per-owner detail GETs or
child PATCHes. Tests include explicit overrides, qualified MPN grouping, missing
row results, partial failures, actual 429 responses, ambiguous writes, queued
continuations and final detection of preserved-field changes. These counts are
fixture results, not a live latency or throughput benchmark.
