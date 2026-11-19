# Record source and review history

Workflow instructions, structured exclusions, pricing dictionary entries and
shared calculation rules can retain record-level change histories. The optional
`record_provenance` field lives in each existing pricing document and is committed
atomically with the corresponding record changes. It is not a second editable
source of business rules.

Existing documents remain readable. An old record with no provenance has unknown
prior history: the server does not invent an author, review date or original
approval. Its first tracked edit preserves the exact prior record and marks the
origin `legacy_history_unknown`. Newly created tracked records use
`tracked_creation`.

## Supplying review evidence

From version 0.16, deliberate guidance, dictionary and shared-rule saves require
a `review` object. Existing stored documents remain readable without invented
review metadata. Use the same source/reason convention across calling platforms:

```json
{
  "sources": [
    {
      "kind": "user",
      "reference": "Owner decision 7, dated 2026-11-18"
    }
  ],
  "reason": "The owner reviewed the corrected supplier scope.",
  "reviewer": "Catalog owner",
  "change_id": "change-20261118-chemcast-knowledge-history"
}
```

`sources` requires one to eight records. Source kinds are `document`, `plytix`,
`user`, `pricing_rule` and `other`. Each source has a reference of up to 1,000
characters and may include a SHA-256 hash and an actual `observed_at` timestamp.
The reason is required and limited to 1,500 characters. The reviewer name is
optional and limited to 160 characters. Do not invent a reviewer or observation
date when the source does not establish one.

An optional `change_id` is an 8–128 character stable reference using letters,
digits, `.`, `_`, `:`, or `-`, starting with a letter or digit. Use the same value
as the Git `Change-Id` for related work. This supplied correlation reference is
different from the archive's server-generated content-addressed `change_id`.

Review metadata records supplied attribution, not authenticated identity or a
new permission grant. `reviewer_identity: caller_supplied_not_authenticated`
makes that distinction explicit when a name is supplied. Existing write
allowlists, host approval and current-revision checks still apply. A supplied
review does not confirm a proposed calculation rule or dictionary suggestion.

Any change to an existing active structured exclusion, including retirement,
requires review sources and a reason. A conflicting new source cannot silently
weaken a protection. Preserve it until the explicitly reviewed change passes the
normal save approval. New exclusions continue to require their original
`source_ref`; unchanged legacy saves remain supported.

Dictionary corrections retain explicitly supplied evidence, including its source
reference and document hash. They no longer replace it with a generic correction
reference. If no detailed evidence is supplied, that missing provenance remains
visible; review metadata can provide the supporting source trail separately.

## Server-authored events and retention

Each tracked event contains the document revision, server time, operation,
action, full before/after record snapshots and their content digests. A supplied
review can also record an explicit review of unchanged content. Automatic
observations and rule-index refreshes are marked separately and cannot claim a
user review. Repeated unchanged automatic observations do not add events.

Save inputs reject caller-supplied provenance. Copies and imports may carry old
history as evidence, but cannot replace server history through a save payload.
Content hashes detect accidental edits and link consecutive retained snapshots;
they are not signatures or proof that a reviewer identity was authenticated.

The embedded working view is bounded to 16 events per record and 2 MiB of
provenance per pricing document, within the existing overall 8 MiB file limit.
The oldest embedded events can be dropped, with `dropped_events` recording the
omitted prefix. Older removed-record histories can be discarded from this view
with `omitted_records` incremented. The latest complete event for every current
tracked record is preserved; a mutation fails if that minimum history cannot fit.

Version 0.16 additionally retains immutable document snapshots in the configured
local/GCS backend with no automatic archive pruning. The current history head
identifies the committed chain; failed-write candidates are not committed history.
Archive capture precedes the current-file update and a capture failure blocks the
save. Legacy contents become a baseline on the first upgraded write. This archive
preserves revisions beyond the embedded working window; it cannot reconstruct
history already lost before installation. See the
[change history standard](change-history.md) for rollback, storage and backup
limits. External administrators and storage lifecycle policies remain outside
the application's retention guarantee.

Scoped guidance reads and paginated dictionary reads return provenance only for
the records returned. Dictionary responses label this
`provenance_coverage: returned_records_only`. Merge all unfiltered pages for a
portable export of current records; do not sum their repeated global
`omitted_records` counts. Removed/pruned dictionary history is not included in
that current-record export.

## Release compatibility

Version 0.16 adds the version-history head to canonical pricing documents. All
readers and writers sharing that backend must support it before the first
upgraded save. A prior executable alone is not a safe rollback after new-format
documents are written. Preserve archive snapshots and use a compatible reviewed
restore path; never strip new history fields to force an old binary to load.

Older servers use strict document schemas and cannot read documents containing
the new `record_provenance` field. Deploy a compatible version to every writer
before saving provenance-bearing records. Do not use older local binaries with
the upgraded shared store. Code validation or export creation alone does not
authorize deployment, migrate remote records or modify Plytix.
