# Contributing

Keep the server account-independent. Put organization-specific pricing meanings,
exceptions and reviewed calculations in the configured organization store; never
commit supplier price lists, product snapshots, credentials or private approvals.

Use the [change history standard](docs/change-history.md) for source, Markdown,
knowledge and rules. It applies equally to people, assistants, CLI clients and
hosted integrations. Git records source changes; the pricing store records
canonical knowledge revisions. A portable export is a dated view, not a second
editable source of truth.

Repository setup installs the tracked commit hook and message template by
running `node scripts/install-history-hooks.mjs`. Existing custom hook/template
settings are preserved and must be integrated with this check. CI validates every
new commit after the versioned policy baseline, even when a client skips hooks.

Before committing code changes, run:

```text
npm run typecheck
npm run build
npm test
node --test scripts/change-record.test.mjs
```

Run the plugin build/check/test commands when packaged skills, metadata or tools
change. Record exact successful checks and meaningful limitations in the
`Validation` trailer. Tests use fixtures; product mutations, deployment, grants
and credentials remain subject to the repository approval contract.

Do not change product prices to test history or proposal-only workflows. A
rollback test prepares and validates a candidate with fixtures. A real rollback
uses current revisions and separately authorized changes; it does not erase the
original history.
