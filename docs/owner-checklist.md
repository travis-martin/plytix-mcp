# Owner finish checklist

Status checked 2026-10-16. Exact private resource links and account metadata are in
the ignored `.local/owner-checklist.md`; no credential values belong in this repo.

## Completed and verified

- [x] Work Google Cloud login and intended project/billing verified; default account preserved.
- [x] Private registry, keyless runtime account and empty application-secret container prepared.
- [x] Runtime Secret Accessor granted on that one secret only; no runtime project roles.
- [x] Keyless GitHub federation restricted to numeric repository/owner IDs, main push events and this exact deployment workflow.
- [x] CI receives only repository Writer and runtime Service Account User. No CI project role, key or direct Secret Accessor.
- [x] Publication enabled; automatic deployment disabled. No Cloud Run service created.

## When back at the computer

1. **Privately add the application token.** In the prepared Secret Manager secret,
   choose **Add new version**, enter a new random token of at least 32 characters, and
   save it in your password manager. This protects MCP and is separate from Plytix
   credentials. Do not paste it in chat or send its value to the agent. Tell the
   project chat only that a version was added. The agent can inspect numeric
   version metadata without reading the payload.
   [Google secret-version guide](https://docs.cloud.google.com/secret-manager/docs/add-secret-version)
2. **Promote reviewed code to main.** Review the prepared implementation/workflow
   pull request and passing CI. Merge only when ready for the stable release.
   The main-branch workflow publishes the first tested image automatically; no
   manual Docker upload is needed. Development branches cannot authenticate to
   Google Cloud through this trust. If a merge was expressly authorized and
   completed, this step will instead be reported as complete in the project chat.
3. **Approve the final initial deployment.** After image publication and token
   entry, the agent will show the actual registry digest, numeric secret version,
   runtime identity, exact YAML, IAM policy and hostname setup. Proposed limits:
   private service, read-only tools, 0.25 CPU, 256 MiB, concurrency 1, timeout 60s,
   min 0/max 1. No initial deployment is authorized by CI setup alone. Confirm
   whether to enable ongoing main-branch image-only updates after this first deploy.
4. **Authorize the client and one bounded read.** The agent can prepare the local
   IAM proxy and non-secret client settings after deployment; privately provide
   the MCP token and existing approved read-only Plytix credentials to the client.
   Start with tool approval set to prompt. Confirm permission for one explicitly
   scoped product read before sending real credentials/data. No writes are enabled.
   [Official OpenAI MCP configuration](https://developers.openai.com/codex/mcp)

The disabled [HTTP client template](../deploy/codex-http.template.toml) maps headers
to environment-variable names and contains no credential values. Exact proxy Host
behavior and the deployed endpoint still need verification. Codex supports
environment-backed HTTP headers; hosted/web-provider compatibility remains a
separate unverified route. This server does not expose an OAuth login flow.

No final deployment, live Plytix credential use, public endpoint, Helper change,
subscription change or extra project-wide role is included in this checklist.
