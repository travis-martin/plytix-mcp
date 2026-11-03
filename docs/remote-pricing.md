# Private remote pricing

Local stdio and remote HTTP use the same pricing handlers, rules, calculations,
plan checks and API policy. HTTP remains stateless and without write approval by
default. `MCP_APPROVAL_SESSIONS=true` explicitly enables an authenticated,
credential-bound MCP session with form elicitation for a trusted desktop client.
The client must actually present the complete form to the user, just as with stdio.
This is private operator access, not a public multi-user OAuth service.

Every message requires the independent service token and the same Plytix API
credential pair used to initialize that session. A different pair cannot inspect,
approve, cancel or terminate it. Unsupported form clients cannot write. Approval
uses the existing exact argument snapshot; no tool argument can assert approval.
Sessions expire after ten minutes and are bounded to four by default. A dropped
tool stream cancels its session; a restart loses pending approvals. Reconnect and
inspect persisted plans after a disconnect, never blindly replay a mutation.

Use `PLYTIX_PRICING_GCS_BUCKET` for remote rules and audit persistence. The
credential-scoped JSON objects use generation preconditions for updates and
one-shot plan reservation. No ephemeral filesystem fallback is permitted when
GCS is selected. Source documents and commercial pricing are private business
data: keep public access prevention and uniform bucket-level access enabled.
Runtime access should be scoped to the dedicated bucket, not the project.

Cloud Run must accept concurrent requests while the tool awaits an elicitation
response. Use sixteen concurrent requests for the default four application sessions,
one CPU, 512 MiB memory, and a 120-second timeout. Each SDK session can hold an idle
SSE stream, an active tool request, and a separate form-response request; a platform
limit of four can starve all control traffic when four sessions connect.
Keep IAM invocation required, a maximum of one instance initially,
session affinity enabled, minimum zero and no browser origins. Session affinity
is best effort; a lost session fails closed. Stored pricing reservation survives
instance replacement. The independent service token remains in Secret Manager;
Plytix credentials are supplied per request, never configured on the server.

The account-independent [pricing deployment template](../deploy/cloud-run-pricing.template.yaml)
contains these opt-in settings and a TCP startup probe. The original
`cloud-run.template.yaml` remains the smaller stateless read-only template.
Render only a reviewed private copy with an immutable image digest, pinned secret
version, approved bucket and runtime identity, and exact service hostname. The
deterministic hostname uses the project **number**, in the form
`SERVICE-PROJECT_NUMBER.REGION.run.app`; verify it against service metadata.
Session affinity is cookie-based, so verify that the actual client/proxy preserves
the affinity cookie; it is always best effort and never an authorization mechanism.
See Google's [concurrency](https://docs.cloud.google.com/run/docs/about-concurrency),
[session affinity](https://docs.cloud.google.com/run/docs/configuring/session-affinity),
and [service URL](https://docs.cloud.google.com/run/docs/triggering/https-request#deterministic-url) guidance.

Explicit write allowlists should contain only `pricing_rules_save` and
`pricing_apply` for the pricing connection. All writes still require individual
form approval. Use a separate connection with an empty write allowlist for
exploration. Set the desktop tool timeout to at least 120 seconds.

Release requires fixture tests for both transports, cross-credential rejection,
form approval/decline/unavailable, storage CAS conflicts and replay prevention,
and a bounded authenticated read from the selected desktop client. Live product
changes are not a deployment smoke test. A real price-list run additionally needs
the uploaded document, reviewed family/attribute rules and exact change approval.

Creating the bucket, assigning runtime storage access and creating/updating the
Cloud Run service require a concrete action-time approval under AGENTS.md.
Document the immutable image digest, pinned secret version, bucket name, runtime
identity, exact hostname and resource limits before executing those actions.

## Native Codex connection

For an existing authorized local developer account, use a direct HTTPS MCP
connection with Codex's `http_headers_helper`. The reusable configuration is
`deploy/codex-http.template.toml`; replace only the verified service hostname,
absolute helper/environment/gcloud paths, and chosen existing account. Leave the
connection disabled until deployment and a bounded read check are approved.
This uses the native MCP transport, including resource views and form elicitation,
without a protocol bridge or a long-running local proxy.

`scripts/cloud-run-headers.mjs` reads the explicitly selected private environment
file for `MCP_AUTH_TOKEN`, `PLYTIX_API_KEY` and `PLYTIX_API_PASSWORD`. It captures
`gcloud auth print-identity-token --account=... --quiet` into memory and emits the
four HTTP headers as one JSON object exclusively to Codex's private helper pipe.
It does not create credentials, change gcloud's active account, grant permissions,
or write token files. Existing invocation permission is still required.

The helper requires absolute file and gcloud paths and an explicit account.
Windows `.cmd`, `.bat`, `.ps1`, or executable launchers are supported; PowerShell
launchers retain the system execution policy. The subprocess has a seven-second
deadline, below Codex's ten-second helper budget. Its output and errors are never
included in error messages. Do not run the normal helper in a terminal, chat tool,
or log capture: its successful stdout contains credentials by design.

For human-readable configuration validation, use only `--check`:

```powershell
node scripts/cloud-run-headers.mjs --env-file "C:/PRIVATE/PATH/.env" --account "operator@example.com" --gcloud "C:/ABSOLUTE/PATH/gcloud.cmd" --check
```

That mode emits boolean status only and never calls gcloud or acquires a token.
It confirms field formatting and file availability, not credential validity,
IAM permission, remote connectivity, or host approval compatibility. Fixture
tests exercise the normal header-building path with a mocked subprocess; no
real environment file or gcloud token is used by tests.

Codex caches helper headers for the connection and refreshes once following a
same-origin POST 401/403, retrying only when headers change. Avoid competing
`Authorization`, bearer-token, or stored OAuth settings: they can override the
helper's refreshed token. The helper is supported for connections originating in
the local environment, not hosted execution environments. Google documents user
gcloud identity tokens for developer access; production unattended invocation
requires its own reviewed identity design. Sources: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp#streamable-http-servers),
[helper implementation](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/http_headers.rs),
[Cloud Run developer authentication](https://docs.cloud.google.com/run/docs/authenticating/developers).
