# Local validation

Verified on 2026-10-15, using fixture data only:

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Pass on Desktop Node 22.14.0 |
| `npm run typecheck` and `npm run build` | Pass |
| `npm test` | 60 tests pass across eight files |
| `npm audit --audit-level=moderate` | Zero reported advisories in the resolved tree |
| `docker build -t plytix-mcp:local .` | Pass with Node 24.22.0 |
| `node scripts/container-smoke.mjs` | Pass with 0.25 CPU and 256 MiB limit |

The container test used a non-root user, read-only filesystem, dropped Linux
capabilities, no-new-privileges and a randomly assigned loopback-only published port.
It verified the authenticated SDK handshake, 27 read-only tools, a local identifier
operation, unauthenticated rejection and mutation-tool denial. Observed fixture
memory usage was about 36.5 MiB. The test container was stopped and removed.

Tests cover all original lookup/identifier cases, API route/payload compatibility,
all 47 tools with explicit write enablement, default write hiding and API rejection,
invalid SDK inputs, Origin/Host enforcement, stateless notification/protocol
behavior, request/body limits, disconnect capacity, JWT password isolation,
credential-safe errors, bounded retries and schema discovery. A 250-attribute
fixture exercises actual client request accounting. No live Plytix requests occurred.

An independent focused review found and prompted fixes to unbounded schema fan-out,
disconnect concurrency accounting and masked lookup failures. A follow-up identified
an interaction between discovery size and the request budget; the budget now covers
bounded discovery and has regression coverage. Concurrent stdio calls are deliberately
rejected while a prior tool runs.

Not verified: real Plytix accounts, direct hosted AI clients, production Cloud Run
deployment, Google IAM/secret policy, cloud cold-start behavior or billed cost. Those
require confirmed project identity and the approvals in [deployment.md](deployment.md).
Dependency advisories and base images can change; recheck before deployment.

A fresh review of commit 179acdc found SDK cancellation was not propagated into
stdio operations, and schema discovery lacked a cumulative byte limit. The fixes
wire operation-scoped AbortSignal handling without disabling the next stdio call,
and enforce an 8 MiB aggregate response budget. Fixture regressions cover a
cancelled pending write, cancellation of an in-flight fetch, subsequent operation
recovery and cumulative response exhaustion. Stateless HTTP cross-request
cancellation remains a documented transport limitation.
