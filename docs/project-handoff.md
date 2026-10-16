# Plytix MCP project handoff

Verified 2026-10-15 UTC. This public handoff describes implementation decisions
and validation. Exact operator identities, project/billing identifiers, conversation
references, IAM inventory and pending action commands are retained only in
`.local/project-handoff.md` and `.local/cloud-approval.md`, excluded from Git.

## Direction and implementation

Connect Codex and other AI agents to Plytix: local testing first, then a private,
small Cloud Run service. Keep tools reusable across accounts and costs low.
The current project chat owns subsequent implementation/runtime work; earlier
conversation history is preserved.

Runtime source is commit `32b381c4ecc953d332252ce5f8aa137e97902126` on
`develop/cloud-run`. At verification, local `main` and `origin/main` remained
`b6062eb2703e23ec2c7001aab073afb7cec34a11`. Earlier changes:

- `c902234`: neutralized branding and preserved required MIT attribution.
- `c17872e`: shared hardened Node stdio and SDK Streamable HTTP implementation.
- `179acdc`: small container, fixture smoke test and deployment preparation.
- `32b381c`: operation-scoped SDK cancellation and aggregate response limits.

Shared server/tool handlers expose 27 read tools by default and hide 20 mutation
tools. Exact write allowlists control registration; API checks separately reject
mutations. Remote HTTP requires an independent application token and per-message
Plytix BYOK headers. Cloud Run IAM adds another layer. Host/Origin checks,
isolated JWT caching, sanitized errors, bounded retries and request budgets are
implemented. Responses are limited to 5 MiB individually and 8 MiB per operation.
See [security.md](security.md).

## Verified status

| Check | Result |
| --- | --- |
| Typecheck and build | Pass |
| Fixture tests | 60 pass across eight files |
| Dependency audit | Zero reported vulnerabilities |
| Existing local Node 24.22.0 image | Constrained smoke test passes at 0.25 CPU / 256 MiB |
| Container behavior | Non-root, authenticated SDK handshake, 27 reads, mutation denial; about 41 MiB observed |
| Work login / selected existing project | Verified using explicit caller selection; active default account preserved |
| Cloud readiness | Approved billing/preparation and restricted keyless CI trust verified; publication enabled, auto-deployment off; image, secret version and service still pending |

Fixture tests needed normal local temporary-file and loopback access after sandbox
restrictions caused environmental failures. The container smoke test removed its
test container. The existing image was inspected/tested without an upload; its
local image ID is not a deployable registry manifest digest.

Cloud mutations were limited to approved billing, API enablement, isolated runtime
resources and the exact resource-scoped CI trust/bindings. No CI/runtime project
role, user-managed key or direct CI Secret Accessor was created. No credential value,
secret payload, live product write or unrelated service/subscription was touched.
No Codex internal database was inspected or edited.

## Remaining work

1. Billing-only approval was executed and verified. The active default account was
   preserved. Exact evidence is in the private local bundle.
2. Approved preparation is complete; secret version and image inventories are
   empty. Earlier filtered API checks were incomplete: use a bounded full API
   inventory with local exact-name selection for subsequent verification.
3. Restricted [CI setup](continuous-deployment.md) is approved/configured, with
   publication on and deployment off. Review/promotion to main publishes the first
   image. Owner handles secret entry; final private deployment still needs the
   actual digest/version/configuration and explicit final approval.
4. Verify actual Codex/local IAM-proxy setup with approved credentials; hosted
   provider authentication still needs a compatible reviewed integration.

Proposed runtime: Node 24, gen1/request-based Cloud Run in `us-central1`, 0.25 CPU,
256 MiB, concurrency 1, timeout 60s, min 0/max 1, startup CPU boost off, empty write
allowlist and no browser origins. See [deployment.md](deployment.md) and the
[account-independent approval checklist](cloud-approval.md).

Stateless HTTP has no cross-request cancellation registry; keep writes disabled.
Cloud cold starts, production costs, real Plytix accounts and hosted clients remain
unverified. No deployment approval may contain unresolved image/secret/host values.
