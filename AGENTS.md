# Repository guidance

- Build reusable, account-independent Plytix tools. No organization-specific defaults.
- Keep the MIT copyright and permission notice intact.
- Default to read-only tools; writes require an explicit tool allowlist and API-layer enforcement.
- Use fixtures/mocks for automated tests. No live mutations, credential creation,
  grants, IAM expansion or deployment without exact action-time approval.
- Keep secrets out of source, logs, test output and error messages.
- Run npm run typecheck, npm run build and npm test before committing code changes.
- Keep one shared implementation for stdio and HTTP tool behavior.
- Follow `docs/change-history.md` for every knowledge, rule, code or Markdown
  change. Supply source and reason metadata for reviewed knowledge saves, retain
  immutable revision history, and roll back through a new reviewed revision.
- Use the versioned commit template and required change-record trailers. Run
  `node scripts/check-change-record.mjs --message-file <commit-message-file>`
  before committing. Do not rewrite historical commits to satisfy the new standard.
