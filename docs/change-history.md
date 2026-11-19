# Change history standard

The **Plytix Change Record Standard, version 1**, is the default for knowledge,
rules, code and Markdown changes. The same facts and names apply regardless of
the contributor, assistant, operating system or calling platform. Use one
canonical store for organization knowledge and Git for reusable source. Never
put business data or credentials in Git merely to obtain version history.

## Required record facts

| Fact | Runtime knowledge and rules | Git and Markdown |
| --- | --- | --- |
| Identity | Server-generated content hash/change ID and document revision | Stable `Change-Id` trailer; Git commit SHA identifies the exact revision |
| Time | Server-authored UTC timestamp | Git author/commit timestamps; release notes use an explicit date |
| Change | Document/record IDs, operation, exact previous/new snapshots and digests | Focused diff and `type(scope): summary` subject |
| Reason | Required review reason for deliberate saves | `Reason` trailer |
| Sources | Required source references for deliberate saves; original file hashes where available | `Sources` trailer pointing to public issue/docs or a private review identifier without its contents |
| Attribution | Optional supplied reviewer is labeled unauthenticated; automatic observation is separate | Existing Git author/committer identity; no invented human approval |
| Validation | Saved revisions/digests read back, applicable fixture/result evidence retained in the private change record | `Validation` trailer with performed checks and outcomes |
| Rollback | Prior committed snapshot becomes a new reviewed save using current expected revisions | `Rollback` trailer naming a forward Git revert and any separate data compatibility step |

Use the optional `review.change_id` field and stable source references to connect an
organization change with its private capture, portable export and code commit
when they belong to the same change. A Git `Change-Id` and runtime content hash
have different purposes: the former groups reviewed work, while the latter
identifies exact archive contents. Neither is an approval token or signature.

Reference sources precisely: document filename, SHA-256, sheet/cell or page;
catalog family/attribute IDs and observation time; or stable decision/issue ID.
Never fabricate missing legacy dates, identities or approvals. Use the actual
source kind. State uncertainty as uncertainty. Existing user authorization is
not replaced with extra ceremony, and historical approval never grants a new
product write.

## Retained knowledge revisions

Supported local and GCS pricing stores retain immutable, content-addressed
snapshots for workflow guidance, the pricing dictionary and shared rules. The
current document's version-history head identifies the committed revision chain.
Snapshots are created before the current document is replaced. A storage failure
must fail the mutation rather than save a current value without its history.

A candidate snapshot can survive a failed optimistic-concurrency attempt.
Only snapshots reachable from the current document's head are committed history;
unreferenced candidates are not proof that a change happened. History reads
validate content digests and the linked chain before presenting revisions.

The application does not automatically delete archive revisions. The smaller
embedded per-record provenance remains a bounded working view; pruning that
view must not delete the archive. At the first upgraded write, the existing
document is retained as a baseline. History lost before this baseline cannot be
reconstructed. Report the recorded history origin honestly.

This protects the application's normal write path. It does not create a cloud
retention lock, alter bucket lifecycle rules, stop an administrator from deleting
storage, or establish an independent disaster-recovery copy. Keep the archive
and current files in the configured durable backend, include both in existing
backups, and verify applicable operator-managed storage retention. A dated
Markdown/JSON export supplements this archive but is not a complete backup of
credentials, source workbooks or private execution audits.

Deliberate guidance, dictionary and rule saves supply a review reason and at
least one source. Automatic observations use a distinct operation and machine
source; they cannot claim a human review. Proposal-only audits suppress automatic
learning. Private drafts may still be retained by explicitly selected draft
tools, while the dedicated read-only audit does not create one.

## Rollback is another reviewed change

Read committed revisions with
`pricing_history_get({document: "workflow" | "dictionary" | "rules", cursor?, limit?, include_snapshots?})`.
The default is ten revision summaries; the limit is 1–25. A cursor is the returned
archive SHA-256 reference, not a page number. To capture a rollback target, request
one revision with `limit: 1, include_snapshots: true` and save the actual response
privately. Archives use `history-{document}-{SHA256}.json` names in the existing
scoped backend; use supported readers instead of editing those files.

Prepare an offline candidate with the installed `plytix-pricing-history` command
or the built checkout entrypoint:

```text
node dist/pricing/history-cli.js --current .local/current/organization-knowledge.json --history .local/history-response.json --change-id ARCHIVE_SHA256 --review .local/rollback-review-metadata.json --output .local/rollback-candidate
```

`--change-id` selects the archive's content-addressed ID. The separate review JSON
contains sources, reason, optional reviewer and optional `change_id` shared with
the new Git/private change record. The CLI creates `rollback-candidate.json` and
`rollback-review.md` in a new directory. It loads no credentials and performs no
runtime saves. It explicitly retires newer workflow/dictionary records and lists
removed rules so the difference remains reviewable. Feed its candidate into the
existing portable import prepare/preflight flow. Restored confirmed/user-defined
statuses still require explicit import decisions and normal save authorization.

For a knowledge or rule rollback:

1. Read the committed history and select the exact prior document/revision by
   its digest. Preserve the current capture as well.
2. Prepare a rollback candidate from that snapshot. Review the full difference,
   especially rule status, retired definitions and protections. Restoring an old
   price rule can reinstate old scope or exceptions; it is not automatically safe.
3. Read the complete current guidance/rules and all dictionary pages. Use current
   expected revisions, not the historical revision number. Retire records
   explicitly rather than silently dropping them.
4. Apply only the authorized existing save-tool calls, with a reason and sources
   identifying the rollback target and decision. Stop on a conflict, partial
   failure or uncertain result. Do not overwrite raw runtime JSON.
5. Read back each result, verify the new committed history head, and refresh the
   portable export with predecessor lineage. The rollback is a new revision;
   the intervening history remains available.

A knowledge rollback never changes product costs. Any product correction has a
separate exact price plan and approval. There is no cross-document transaction:
review the outcome of each guidance/dictionary/rule save and reconcile partial
completion before another attempt.

For source and Markdown rollback, use `git revert --no-commit <commit>` and create
a new standard commit after validation. Do not reset or force-push shared history.
Revert only the intended files/hunks when later changes depend on them. A binary
rollback may require a compatible data reader; do not deploy an older strict
schema that cannot read current records. Keep the prior release artifact and
record its image/tag digest in the release's private record.

## Commit format and default enforcement

Use the tracked `.gitmessage` template. A commit contains a Conventional Commit
subject of at most 100 characters, an optional explanatory body and this final
trailer block, with one nonempty line per field:

```text
feat(history): retain source-linked knowledge revisions

Change-Id: change-20261118-chemcast-knowledge-history
Reason: Preserve prior definitions and rule scope for reviewed rollback.
Sources: approved change request; docs/change-history.md
Validation: typecheck, build and fixture tests passed; no product writes
Rollback: Forward-revert this commit; restore knowledge with a reviewed new revision.
```

Supported subject types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
`refactor`, `revert`, and `test`; scope is required. `Change-Id` is a stable
8–128 character identifier using letters, digits, `.`, `_`, `:`, or `-`, starting
with a letter or digit. This also fits runtime `review.change_id`. Use the same ID for related commits
when useful and a distinct ID for unrelated work. The Git SHA remains the unique
commit identifier. Do not place secrets or full private document contents in
trailers. “Not run” with its real reason is acceptable validation evidence;
placeholder assertions or fabricated passing checks are not.

The versioned `.change-record-policy.json` names the baseline. Historical commits
at/before it are preserved unchanged; all later commits follow this standard.
The tracked commit-msg hook validates local messages. Repository setup installs
the hook and template without replacing custom settings. The GitHub CI check
validates committed messages independently, using the actual pull-request head
rather than a platform-generated test merge. CI needs complete Git history.

```text
node scripts/install-history-hooks.mjs
node scripts/check-change-record.mjs --message-file .local/commit-message.txt
node scripts/check-change-record.mjs --ci
```

A hook can be bypassed by a Git client; CI supplies the repository-level check.
Branch protections remain operator-managed and are not silently changed. Existing
custom hook/template configuration is preserved, so the installer reports when
manual integration is needed instead of replacing it.

## Markdown, release notes and comments

Keep documentation in the same focused Git commit as the behavior it describes.
Use `CHANGELOG.md` for releases, with version/date, Added/Changed/Fixed as needed,
the change reference, validation and rollback/compatibility notes. Do not copy
private organization values into the reusable changelog. Each private release
record links the source commit, tested package, deployment artifact if authorized,
canonical knowledge revisions and export checksums.

Use factual, concise comments that explain a non-obvious reason or constraint.
Add a stable issue/change reference only when it helps locate the governing
decision. Do not stamp every comment with an assistant name, platform, current
timestamp or copied transcript; Git and server history own attribution and time.
Avoid parallel hand-maintained history sections inside every file.

Portable organization Markdown is regenerated from the canonical store after
approved saves. Preserve its previous export/checksum and source revision labels.
Never edit the generated export as though it were the live rule database. Other
platforms use this same standard and review process; copying the document does
not copy enforcement or authorize mutations.
