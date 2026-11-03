# Security and operational limits

## Shared knowledge boundary (0.5)

Shared knowledge is optional and requires an operator-owned registry. Connection
bindings include fingerprints of both credential values and endpoint identities;
every shared knowledge operation authenticates with Plytix before serving data.
Neither a domain, a tool argument, nor a caller-selected account ID grants
membership. Binding a colleague explicitly grants visibility to the workspace's
shared schema and definitions. It does not grant new Plytix API permissions.

Schema learning is operator opt-in and retains structural metadata only.
Business definitions remain unreviewed proposals until a local operator confirms
them. `knowledge_propose` has its own `MCP_KNOWLEDGE_WRITE_TOOLS` allowlist and
exact-argument host approval; it cannot authorize any Plytix write route.
Default stateless HTTP cannot supply that approval. Opt-in trusted-host HTTP
sessions use the same form approval as stdio; see the HTTP approval section below.
Registry changes are loaded per operation so revoked membership applies to
existing sessions.

Knowledge content is untrusted contextual data, never executable instructions.
The filesystem backend is private single-volume storage with bounded validated
snapshots, serialized writes and atomic replacement; it is not durable storage
for ephemeral Cloud Run instances or a distributed authorization system.
See [knowledge operations and limitations](knowledge.md).

## Enforcement

- Default policy hides all product and rule mutation tools, rejects unknown/unclassified tools,
  and rejects API mutations before authentication. Only exact known search POSTs
  count as reads. Enabling writes requires a JSON allowlist of exact tool names.
  The API client independently requires that allowlist, an active operation for
  the named tool, and the tool's permitted HTTP method and endpoint. A read tool
  cannot mutate data even when a different write tool is enabled.
- `pricing_import` and `pricing_plan` are explicit local/cloud draft-storage tools,
  exposed by default with `readOnlyHint: false`, `destructiveHint: false`, and
  `idempotentHint: false`. They save private source/plan files but receive no API
  mutation authority. `pricing_rules_save` and `pricing_apply` remain hidden until
  separately allowlisted and require exact host approval.
- Every product, pricing-rule or shared-knowledge mutation requires a trusted approval provider to approve the
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
- Default stateless HTTP creates a fresh Plytix client per request. JWT and schema caches never
  cross request credential boundaries. Regression coverage specifically rejects a
  wrong password with a previously successful key. Stdio caches are instance-local.
- Identical reads within one tool invocation share an upstream request and return
  independent copies. This cache is cleared after the invocation and before any
  mutation, never reused for stale post-write verification. Errors are not cached;
  cancellation and deadlines are checked even when a read is already cached.
- Disallowed Origin and Host values are rejected before parsing/executing tools.
  Origin omission is allowed for non-browser MCP clients; it does not bypass
  remote service authentication. CORS never acts as authentication.
  Duplicate security headers are rejected to avoid disagreement with proxy/header
  parsers. Configured hosts must be exact hostnames; origins must be exact HTTP(S)
  origins. Wildcards and invalid resource limits fail startup.
- Default SDK stateless JSON responses implement initialize, protocol-version checks,
  validated tool input and empty 202 notifications. Batch arrays and session IDs
  are rejected. GET and DELETE on `/mcp` return 405; no persistent SSE connection
  or affinity is required.
- `MCP_APPROVAL_SESSIONS=true` opts into bounded private MCP sessions, authenticated
  on every message by the service token and the initiating Plytix credential pair.
  Credentials are compared through fixed-length digests. Another credential pair
  cannot inspect, approve, cancel or terminate the session. No caller-supplied
  account ID or unverified proxy header grants access. Sessions expire after ten
  minutes, and closed sessions retain their capacity slot until work drains.

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
  requests (stateless mode) or four sessions (approval mode) by default. Each
  session allows one active tool operation. The default read-only Cloud Run
  template constrains concurrency to one; approval sessions require concurrent
  requests for form responses and use a separately reviewed configuration.
  These are resource guards, not distributed
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
The operation deadline/resource budgets still apply. This limitation describes
default stateless mode. Opt-in sessions route cancellation to the matching SDK
session. A disconnected tool stream, DELETE, expiry, or process shutdown cancels
that session and its pending approvals. Clients should close their own pending
request/transport when a session disappears. Neither mode promises rollback.

Cancellation does not roll back a write already accepted by Plytix. Inspect actual
state before deciding whether to repeat an ambiguous mutation. This repository
does not provide transactionality, upstream idempotency keys, distributed quotas,
general per-user audit history or an external OAuth authorization server. Pricing
adds credential-scoped persisted per-plan/per-change audit and one-shot reservation.

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

### HTTP approval modes

The default stateless HTTP entry point has no write approval provider. A nonempty
allowlist can advertise selected write tools, but invoking them returns an
approval-unavailable error and performs no mutation. This is deliberate:
stateless JSON HTTP cannot assume a working interactive form exchange.

An operator may explicitly enable `MCP_APPROVAL_SESSIONS=true` for trusted private
MCP clients. The same form provider used by stdio then shows the complete immutable
arguments and requires typed `APPROVE`. Unsupported clients fail closed. Trust in
the host to display a human approval is identical to stdio; this does not turn a
shared service secret into public multi-user identity or OAuth. The service token
is mandatory even on loopback in this mode. Sessions are ephemeral; durable pricing
plans and their consumed state remain in the configured file/GCS backend.

An embedding application may supply the code-level `requestWriteApproval`
callback to `createHttpApp`. It must obtain an independent user approval for the
exact tool and immutable `argumentsJson` snapshot, honor cancellation, and bind
approval to the authenticated caller and credential/account context. The third
callback argument is the current HTTP request so trusted middleware can inspect
its verified authentication context; never log its credential headers. Returning
`true` without that interaction is an unsafe integration, not an approval mode.
The shared application token provides no per-user identity, so this hook alone
does not make the current service a multi-user authorization system.

For a public or multi-user cloud gateway, implement and verify user authentication, per-user
tool policy, credential isolation, exact-action approval and an appropriate audit
trail in the chosen gateway. A signed approval-token design also needs expiry,
account binding and durable one-time consumption across instances and restarts.
None of those controls is implied by an HTTP header or an in-memory token cache.
Keep public/shared hosted writes disabled until that integration is ready. Private
trusted-host sessions must pass real client compatibility checks before enabling
their write allowlist. The default 60-second Cloud Run template is for read-only
stateless use. With four application sessions, use sixteen platform concurrent
requests, one CPU, 512 MiB memory and a 120-second timeout so idle SSE streams
cannot starve approval/control traffic. Increasing a timeout alone does not enable approval.
See [private remote pricing](remote-pricing.md).

## Durable pricing files

`PLYTIX_PRICING_DIR` selects private single-volume JSON storage. For ephemeral or
multi-instance hosting, `PLYTIX_PRICING_GCS_BUCKET` selects an approved private
bucket and takes precedence over the directory; errors never fall back to local
files. Calls authenticate with Plytix before selecting a credential/endpoint hash
scope. Operator configuration supplies the storage location, never tool arguments.

GCS reads pin object generations; writes use generation compare-and-swap.
Plan reservation is durable and single-use across competing processes and restarts.
Rule history is committed atomically with current rules. All files are limited
to 8 MiB. Storage conflicts may retry bounded state reads, but product mutations
never automatically retry. A crashed/unknown execution stays consumed for review.
Uploaded source extracts, pricing, conditions and review evidence are private
business data; enforce host ACLs or private bucket access and approved retention.
Google runtime access uses Application Default Credentials without packaged keys.
Resource creation and grants require exact action-time approval; see
[pricing workflow and boundaries](pricing.md).
