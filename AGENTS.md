# Repository guidance

- Build reusable, account-independent Plytix tools. No organization-specific defaults.
- Keep the MIT copyright and permission notice intact.
- Default to read-only tools; writes require an explicit tool allowlist and API-layer enforcement.
- Use fixtures/mocks for automated tests. No live mutations, credential creation,
  grants, IAM expansion or deployment without exact action-time approval.
- Keep secrets out of source, logs, test output and error messages.
- Run npm run typecheck, npm run build and npm test before committing code changes.
- Keep one shared implementation for stdio and HTTP tool behavior.
