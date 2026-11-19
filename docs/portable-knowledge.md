# Portable organization pricing knowledge

Organization pricing guidance is separate from the reusable MCP. Its runtime
records are good storage inputs, but a single raw file does not explain all of
their scope, precedence, status or enforcement. Use a self-contained Markdown
export for another AI and the matching versioned JSON for software integration.
Neither requires Codex to read. Current record fields still describe Plytix;
using another catalog requires an explicit mapping of identifiers and attributes.

## Create an export

The exporter is offline: it reads saved tool responses, loads no credentials,
makes no API requests and changes no runtime records. Build the checkout first
with `npm run build`, then run:

```powershell
node dist/pricing/export-cli.js --input .local/capture.json --output .local/export-2026-11-18
```

The output directory must be new. Installed packages also expose
`plytix-pricing-export` with the same arguments. The two output files are
`organization-knowledge.md` and `organization-knowledge.json`. Keep business
captures/exports outside source control; `.local/` is excluded in this checkout.
Restrictive file modes are requested, but Windows access control depends on the
destination directory's ACLs.

Prepare this capture from one explicitly selected connection/backend:

```json
{
  "organization": "Example Organization",
  "captured_at": "2026-11-18T12:00:00.000Z",
  "workflow": { "data": {}, "metadata": {} },
  "dictionary_pages": [{ "data": {}, "metadata": {} }],
  "rules": { "data": {}, "metadata": {} },
  "knowledge_status": { "configured": false },
  "provenance_notes": []
}
```

The empty objects above are placeholders: preserve each tool's actual
`structuredContent` envelope, including status, tool name and generation time.
Organization name is an operator-supplied label, not proof of membership. The
export requires matching organization workspace IDs and storage backends.

1. Read `pricing_rules_get` first. This tool can refresh advisory rule-derived
   dictionary records; it does not change prices or approve rules. Use
   `learning_mode: "proposal_only"` when the capture must not update the
   dictionary. Returned candidates are not canonical records and are not part
   of the export's dictionary pages.
2. Read `pricing_guidance_get` without filters and with `include_retired: true`.
3. Read `pricing_dictionary_get` without query/scope filters, with
   `include_retired: true`, `page_size: 100`, starting at page 1. Follow every page
   until `has_more: false`; retain all pages at the same revision.
4. Read `knowledge_status` and record its actual `configured` boolean. This is a
   separate general catalog knowledge workspace, not the pricing store. Its
   definitions/schema observations are not included by this exporter. An absent
   check must remain unknown, not be described as an empty store.
5. Re-read the source revisions after collection. If anything changed, recollect
   the records and all dictionary pages. Capture calls are sequential on hosts
   that serialize tool operations. There is no cross-file transaction: stable
   reads narrow the race window but do not establish an atomic snapshot.
6. Set `captured_at` to collection time, not a date when catalog facts were last
   validated. Optional `provenance_notes` can resolve legacy chat-local source
   references using inspected evidence. They supplement the original references;
   never invent missing reviewers, approvals, verification dates or source hashes.

The exporter rejects unsuccessful responses, mismatched workspaces/backends,
incomplete guidance, missing/inconsistent dictionary pages and duplicate records.
It cannot authenticate supplied JSON or independently establish that the operator
used the requested unfiltered calls. Preserve the collection evidence privately.
The checksum detects content changes; it is not a signature or proof of truth.

## Use the file in another platform

Attach `organization-knowledge.md` and explicitly ask the new AI to use it as
organization reference material. Ask it to identify the organization, source
revisions, applicable requirements, unresolved conflicts and evidence still
needed before starting. The full instruction text and mappings travel in the
file; access to the original chats is not required to read them. Linked source
documents and private chat URIs are references, not attached evidence.

Durable owner instructions and exceptions take precedence over learned
suggestions. Current catalog reads supply mutable facts. If they conflict,
resolve the conflict instead of silently changing the rule or pretending the
catalog is unchanged. Proposed/observed entries remain advisory, stale entries
need review, and retired records and rule history are never active instructions.
No active rule means no reusable formula was supplied by this export; a one-run
rule recorded in a private pricing run is not automatically a shared rule.

The Markdown states the exclusion conditions in plain language and preserves
their structured representation. Copying the file transfers knowledge, not the
MCP's executable safeguards, API access or approval machinery. A different system
must implement equivalent checks before writes, including inherited descendant
effects and unresolved exclusion evidence. Without live catalog access, the AI
can prepare questions or a draft but cannot claim current ownership or prices
were verified. An upload alone cannot guarantee an AI will retrieve every rule
or follow it correctly; use a review checkpoint before consequential changes.

## Maintenance and limits

Follow [Change Record Standard v1](change-history.md) for the canonical save,
readback, export refresh and any rollback. Reusable Markdown is versioned in Git;
generated organization Markdown retains the canonical source revisions and
predecessor checksum. Use the same source/reason references on every platform.

Keep one authoritative runtime workspace and regenerate dated exports. Editing
a copy does not synchronize or update the MCP. Submit corrections through the
existing reviewed tools with the current revision, then regenerate. Preserve
old exports for traceability rather than silently merging independent versions.

This is a snapshot of retained pricing guidance, not a full backup or a promise
that every chat decision was saved. It excludes credential bindings, secrets,
source documents, private imports/plans/reviews/execution audits and the separate
general knowledge store. It also excludes the full immutable revision archive;
use the history tooling and backend backups for that chain. Embedded per-record
history and the active advisory dictionary remain bounded working views.
Per-record sources and review history are available on 0.14 servers; missing
legacy history stays unknown. See [knowledge maintenance](knowledge-maintenance.md)
for retention, provenance and calculation-policy compatibility.

## Refresh after canonical changes

Collect a new complete capture using the procedure above, then run:

```powershell
node dist/pricing/export-cli.js --input .local/fresh-capture.json --previous .local/previous/organization-knowledge.json --output .local/refreshed
```

The predecessor checksum, workspace/backend and revision direction are checked.
An unchanged capture creates no new directory. A changed export retains its
predecessor checksum/revisions and a record diff, without overwriting the old
files. Changes in read timestamps alone do not count as new knowledge. Refresh
after successful reviewed imports or corrections; no scheduler or automatic
cloud-to-local synchronization is implied.

For example, after a supplier review the owner may approve one tier-selection
instruction, a supplier alias, and a dimension-aware item-price rule. Save each
approved change through its appropriate tool with fresh revisions and review
sources; read back all three results. Collect a full new capture, using
proposal-only rule reads if no additional automatic learning is authorized, then
run the refresh command with the earlier JSON export as `--previous`. The new
Markdown explains the resulting canonical rules and retains predecessor lineage.
Unapproved candidates and dated prices stay in the private review, not the
canonical export. Editing an old Markdown copy does not update either store.

## Review an imported edit

Use installed `plytix-pricing-import` or the checkout entrypoint:

```powershell
node dist/pricing/import-cli.js --mode draft --baseline .local/current/organization-knowledge.json --output .local/import-draft
node dist/pricing/import-cli.js --mode prepare --baseline .local/current/organization-knowledge.json --candidate .local/import-draft/import-candidate.json --capture .local/fresh-capture.json --output .local/import-review
node dist/pricing/import-cli.js --mode preflight --review .local/import-review/reviewed-import.json --reviewed-digest REVIEWED_SHA256 --capture .local/latest-capture.json --output .local/import-preflight
```

Edit the candidate between draft and prepare. It contains only editable business
fields tied to the verified baseline checksum. Include review sources and a
reason. Workflow arrays preserve every existing ID; retire explicitly. Dictionary
entries are patches, so omissions leave definitions unchanged. Changing a
dictionary identity requires a new ID and a separately reviewed retirement.
Rule removals must be named explicitly. New reusable supplier-cost rules must
satisfy the current full-item calculation policy.

Read `reviewed-import.md`: it shows before, requested and proposed values, exact
tool arguments, protections, retirements and status decisions. Changed learned
entries become proposals. Requests for `user_defined` or rule confirmation need
explicit per-ID decisions and still require normal host approval; copied status
is not approval. Imported history never replaces canonical history. Review the
SHA-256 digest printed in the file.

Immediately before saving, collect current records again and preflight that exact
review digest. A changed baseline requires a fresh candidate/review. Preflight
produces calls for existing `pricing_guidance_save`, `pricing_dictionary_update`
and `pricing_rules_save` tools; request those calls through the normal trusted
host flow in the listed order. The CLI never invokes tools, loads credentials or
writes runtime stores. Save-time revision checks protect against later changes.

Imports spanning files are not transactional. Stop on failed, partial or uncertain
responses, read actual results and re-review remaining work. Never replay
successful or uncertain calls. Rule saves occur last because their learning can
update the dictionary. Read back the results, then refresh the dated export.
