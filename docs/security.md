# Security and operational limits

## Enforcement

- Default policy hides all mutation tools, rejects unknown/unclassified tools,
  and rejects API mutations before authentication. Only exact known search POSTs
  count as reads. Enabling writes requires a JSON allowlist of exact tool names.
  The API client independently requires that allowlist, an active operation for
  the named tool, and the tool's permitted HTTP method and endpoint. A read tool
  cannot mutate data even when a different write tool is enabled.
- Every registered write requires a trusted approval provider to approve the
  exact validated argument snapshot for that invocation. No `approved` tool
  argument, annotation, service token or previous approval grants this permission.
  Missing, rejected, cancelled, expired or failed approval stops before the handler.
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
  Duplicate security headers are rejected to avoid disagreement with proxy/header
  parsers. Configured hosts must be exact hostnames; origins must be exact HTTP(S)
  origins. Wildcards and invalid resource limits fail startup.
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
  timeout. Upstream JSON is limited to 5 MiB per response and 8 MiB cumulatively
  per operation, before buffering or schema caching. Disconnects cancel fetches and retain
  the active slot until tool work finishes.
- Write approval has its own 30-second deadline and a 16,000-character argument
  review limit. A successfully approved write starts a fresh 45-second execution
  budget while retaining the same concurrency slot. Its total lifetime can reach
  75 seconds; configure a write client's tool timeout to at least 90 seconds.
  Oversized actions are refused, never approved from a truncated preview.
  Each subsequent invocation asks again.
- Attribute label lookup: one exact-label search followed by one detail read;
  it does not scan all attributes. Successful definitions are cached for five
  minutes, with a maximum of 500 entries per client.
- Attribute/group search returns a requested page of at most 100 entries.
  Attribute usage profiles inspect at most 500 products across five pages and at
  most ten labels; their metadata reads can run concurrently. Results describe
  the bounded product sample, not formula/channel usage or an account-wide audit.
  Larger/slow reads can still reach the operation budget and return an error.
- Concurrent stdio tool calls on one client are rejected while another tool runs;
  internal tool reads can still run in bounded parallel groups.
- Reads retry at most once after 401 or 429. Rate-limit retry waits are capped at
  two seconds; longer Retry-After values return a rate-limit failure immediately.
  No automatic network/5xx retries and no automatic mutation retries occur.

Stdio honors the SDK operation cancellation signal: in-flight fetches are aborted
and a cancelled operation cannot send a later API request. The next operation on
the shared stdio client can proceed normally.

Stateless HTTP has no cross-request cancellation registry. A cancellation
notification on another HTTP request is accepted as a notification but cannot
locate an earlier request's server instance. To stop HTTP work, the client must
abort the original HTTP connection and that disconnect must reach this process
(proxies can delay it); closing only the client's pending promise or
sending a separate cancellation notification does not guarantee cancellation.
The operation deadline/resource budgets still apply. Keep HTTP writes disabled
until the chosen client's behavior has been verified; this change does not add
stateful cancellation routing or advertise transactional cancellation.

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

### Stdio approval

The stdio entry point uses MCP form elicitation. A compatible host displays the
tool name and the complete validated arguments and asks the user to type
`APPROVE`. Only an accepted form with that exact confirmation permits the
invocation. Hosts without form elicitation cannot execute writes. The host is
trusted to present the form to a human; a malicious host can impersonate that
human, just as it already controls the locally supplied Plytix credentials.
Verify the chosen host's actual approval UI before enabling its write connection.

Use separate named connections with `PLYTIX_WRITE_TOOLS=[]` for read-only work
and an explicit minimal list for approved writes. These use the same implementation
and can use separate Plytix credentials with appropriate account permissions.
Set the host's own tool approval mode to prompt as an additional safeguard.

### HTTP approval and future cloud use

The standalone HTTP entry point has no write approval provider. A nonempty
allowlist can advertise selected write tools, but invoking them returns an
approval-unavailable error and performs no mutation. This is deliberate:
stateless JSON HTTP cannot assume a working interactive form exchange.

An embedding application may supply the code-level `requestWriteApproval`
callback to `createHttpApp`. It must obtain an independent user approval for the
exact tool and immutable `argumentsJson` snapshot, honor cancellation, and bind
approval to the authenticated caller and credential/account context. The third
callback argument is the current HTTP request so trusted middleware can inspect
its verified authentication context; never log its credential headers. Returning
`true` without that interaction is an unsafe integration, not an approval mode.
The shared application token provides no per-user identity, so this hook alone
does not make the current service a multi-user authorization system.

Before shipping cloud writes, implement and verify user authentication, per-user
tool policy, credential isolation, exact-action approval and an appropriate audit
trail in the chosen gateway. A signed approval-token design also needs expiry,
account binding and durable one-time consumption across instances and restarts.
None of those controls is implied by an HTTP header or an in-memory token cache.
Keep the deployed HTTP connection read-only until that integration is ready.
The current 60-second Cloud Run timeout is for read-only use. A future write
gateway and its upstream proxies must allow at least 90 seconds for approval
plus execution; increasing that timeout alone does not enable write approval.
