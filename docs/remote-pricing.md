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
response. Use at least four concurrent requests, one CPU and a 120-second timeout
for this mode. Keep IAM invocation required, a maximum of one instance initially,
session affinity enabled, minimum zero and no browser origins. Session affinity
is best effort; a lost session fails closed. Stored pricing reservation survives
instance replacement. The independent service token remains in Secret Manager;
Plytix credentials are supplied per request, never configured on the server.

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
