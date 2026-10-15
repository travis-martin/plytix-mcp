# Security and operational limits

## Enforcement

- Default policy hides all 20 mutation tools, rejects unknown/unclassified tools,
  and rejects API mutations before authentication. Only exact known search POSTs
  count as reads. Enabling writes requires a JSON allowlist of exact tool names.
- HTTP requires separate service authentication for remote or write-capable
  listeners. Token comparison uses constant-size SHA-256 digests and timing-safe
  equality. This single-operator shared token is not OAuth, user identity or
  per-user authorization. It must remain private.
- Cloud deployment is designed for IAM-protected Cloud Run in addition to this
  application token. No IAM trust is inferred from client headers. No public IAM
  grants or OAuth endpoints are created by the repository.
- HTTP creates a fresh Plytix client per request. JWT and schema caches never
  cross request credential boundaries. Regression coverage specifically rejects a
  wrong password with a previously successful key. Stdio caches are instance-local.
- Disallowed Origin and Host values are rejected before parsing/executing tools.
  Origin omission is allowed for non-browser MCP clients; it does not bypass
  remote service authentication. CORS never acts as authentication.
- SDK stateless JSON responses implement initialize, protocol-version checks,
  validated tool input and empty 202 notifications. Batch arrays and session IDs
  are rejected. GET and DELETE on `/mcp` return 405; no persistent SSE connection
  or affinity is required.

## Credentials and errors

HTTP requires BYOK headers on every MCP message. Stdio reads ignored local
environment configuration. No credential entry, generation, upload or IAM change
is part of local fixture testing. HTTP ignores the old raw-credential bearer format.

Upstream failures include only generic messages and HTTP status, with no response
bodies, request headers, original transport errors or serialized auth response.
Auth/API redirects are rejected. HTTPS operator overrides reject URL userinfo.
Tool results intentionally contain requested product/schema data and user inputs;
clients must treat those results as private data. No request/payload logger is
installed. Cloud logging must not add header/body capture.

## Bounded work

- HTTP: 256 KiB JSON body, 60 accepted attempts/minute/instance, four active
  requests by default. The Cloud Run template constrains platform concurrency to
  one and maximum instances to one. These are resource guards, not distributed
  account-wide quotas or a hard billing cap.
- Each tool operation: 45 seconds and 512 upstream authentication/API requests.
  Each individual fetch, including response-body consumption, has a 15-second
  timeout. Upstream JSON is limited to 5 MiB. Disconnects cancel fetches and retain
  the active slot until tool work finishes.
- Schema discovery: at most five pages of 100 IDs; four detail requests at a time.
  Larger/slow accounts can hit the operation budget and return an error. Narrower
  metadata discovery is future work; partial schema is not cached as authoritative.
- Concurrent stdio tool calls on one client are rejected while another tool runs;
  internal tool reads can still run in bounded parallel groups.
- Reads retry at most once after 401 or 429. Rate-limit retry waits are capped at
  two seconds; longer Retry-After values return a rate-limit failure immediately.
  No automatic network/5xx retries and no automatic mutation retries occur.

Cancellation does not roll back a write already accepted by Plytix. Inspect actual
state before deciding whether to repeat an ambiguous mutation. This repository
does not provide transactionality, idempotency keys, distributed quotas, per-user
audit history or an external OAuth authorization server.

Lookup fallbacks can handle unsupported query/not-found responses; authentication,
rate-limit, transport and server failures remain failures rather than reporting an
empty match. Full-product reads explicitly include errors for failed related reads.

## Before allowing writes

Review exact tool names, intended products/fields, account credential permissions,
the caller's authentication and any family/inheritance consequences. Use fixtures
first, then only an explicitly approved bounded live operation. An MCP annotation
is a hint to a client; registration policy and API checks enforce the default.
