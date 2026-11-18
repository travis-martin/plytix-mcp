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
   dictionary records; it does not change prices or approve rules.
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

Keep one authoritative runtime workspace and regenerate dated exports. Editing
a copy does not synchronize or update the MCP. Submit corrections through the
existing reviewed tools with the current revision, then regenerate. Preserve
old exports for traceability rather than silently merging independent versions.

This is a snapshot of retained pricing guidance, not a full backup or a promise
that every chat decision was saved. It excludes credential bindings, secrets,
source documents, private imports/plans/reviews/execution audits and the separate
general knowledge store. History and advisory retention are bounded upstream.
Provenance can be incomplete in older records. Recommended next schema work is
per-record source/reviewer/review dates, explicit supersession, and a reviewed
import/diff path; the export does not imply those features already exist.
