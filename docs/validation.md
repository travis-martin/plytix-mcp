# Validation

## Version 0.9.0 — November 3, 2026

- Local typecheck/build and all 396 fixture tests across 34 files passed,
  including protected guidance, organization isolation, enforcement and MCP
  authorization/argument-limit integration checks.
- The browser fixture passed 52 checks at 1440×1100 and 390×844. Guidance coverage
  includes complete unfiltered reads, current revision/digest checks, retired
  record preservation, exact edited handoffs, malformed/partial draft refusal,
  and concurrent edits without losing the user's draft. The UI never directly
  saves guidance or writes products.
- Policy source defines 51 default read/draft tools and 24 separately enabled
  catalog/pricing writes, for 75 standard tools with all those writes enabled.
  Shared-knowledge proposals remain separately configured.
- Portable archive validation and isolated startup pass: 10 files, four skills,
  51 default tools and the workspace resource. The package test blocks network
  requests and uses fixture credentials; injected credential/private files are
  rejected by validation.

Protected guidance is separate from learned dictionary observations and executable
pricing rules. Fixtures cover custom exclusions, missing evidence, owner and
inheriting-child impacts, preserved overrides, stale guidance, legacy plans and
readback changes. Organization sharing is explicit: reusable files share a stable
workspace only on the same backend, while imports, reviews, plans and execution
records retain credential isolation. Local/browser checks use fixtures and do not
establish upstream API write permissions or production throughput.

Implementation checkpoint `984bffb` was pushed to both branches. Both CI runs
passed, and release run `41638808611` passed Node 22/24 validation, container
smoke testing and image publication. The immutable tested image digest is
`sha256:d5f3953b3a593a7b80e32ec793aaa1aefb042d2626bf0173c8ec8a1399e7af52`.

A fresh client against the prepared private local package verified v0.9.0,
75 tools, 24 enabled writes, host mode, organization scope and saved guidance/
dictionary reads using current credentials. It made no catalog mutations.
The desktop plugin installer returned Windows access-denied errors activating
the cache; the installed plugin registry still reported v0.8.0. Prepared-package
verification does not establish activation in an existing desktop chat.

Remote v0.9.0 deployment, hosted readback and live catalog mutation are not
claimed here; deployment needs separate exact action-time approval. Earlier
release evidence below is historical and does not establish that the remote
service is running v0.9.0.

Older binaries do not enforce workflow guidance or organization bindings. After
activation, use a compatible writer or disable pricing writes before rolling back
to an older implementation; retain all private execution/audit records. See
[storage compatibility](pricing.md#storage-and-activation).

## Version 0.8.0 — November 3, 2026

- Implementation checkpoint: `8cd0989`, pushed to main and develop/cloud-run.
- Local typecheck/build and all 346 fixture tests across 30 files passed.
- The browser fixture passed 42 checks at 1440×1100 and 390×844, including large
  selections, deferred work, mixed ready/changed rows and scoped dictionary reads.
- Portable archive validation and isolated startup passed: 10 files, four skills,
  50 default tools, no network or real credentials in package tests.
- The installed private local plugin reports 0.8.0, 73 tools, 23 enabled catalog
  writes and host approval mode. Current credentials passed bounded rule and
  dictionary reads; no catalog mutation was used for verification.
- Both branch CI runs passed. Release run `41633583193` passed Node 22/24
  validation, container smoke testing and immutable image publication.

Fixture performance evidence: 100 source SKUs require one search instead of 100;
100 compatible review lines produce one plan with one source/rule/history read.
The 26-owner, 260-descendant case fits one exact approval and preserves overrides
with sequential writes and readback. These are call-count/behavior fixtures, not
a production throughput benchmark. Payload, request and execution-time limits
can still defer work; verified and uncertain outcomes remain protected from replay.

Dictionary tests cover bounded retention, repeat-event stability, source evidence,
manual/retirement protection, stale rule aliases, credential isolation and storage
failure reporting. Current Plytix schema remains authoritative. See
[pricing storage compatibility](pricing.md) before rolling back to an older binary.

The exact v0.8.0 image received separate deployment approval and is active on ready
revision `plytix-mcp-00004-6qh` with 100% traffic. Before/after checks confirm the
existing environment, runtime, resources, scaling, sessions and private IAM are
unchanged. Fresh remote SDK reads verify version 0.8.0, 73 tools, 23 writes and
host mode; native Codex capabilities and rules reads also pass. No product writes
were performed. The current credential scope has no saved rules or dictionary
entries, so automatic indexing of existing rules was not exercised live. New
workflow inputs will populate that scope; fixture tests verify persistence behavior.

## Version 0.7.1 — November 3, 2026

- Typecheck/build and 305 fixture tests pass. Sixteen new tests cover explicit host
  authorization, default form enforcement, authentication, route/tool restrictions,
  cancellation and rule persistence through both HTTP modes without elicitation.
- Portable archive checks pass with read-only defaults; private installed local
  plugin and remote service each expose 71 tools including 23 catalog writes.
- Explicitly approved remote activation uses host authorization. Fresh SDK reads
  and native Codex `server_capabilities` confirm mode `host` and no nested form.
- Current credentials pass bounded reads. No live product writes or rule changes
  were used as tests, so upstream API-key write privileges remain unverified.
- Both branch CI and release publication passed for implementation commit 5e92001.
  Private deployment readback confirms the approved image and settings. Native
  client policy uses `writes` to keep write prompts while allowing read-only tools.

The server delegates human authorization to the trusted host in this opt-in mode;
diagnostics do not claim to have verified a human prompt. API authentication,
explicit tool/route limits, pricing plan checks, reservation and readback remain.

## Version 0.7.0 — November 3, 2026

| Check | Result |
| --- | --- |
| Typecheck / build / fixture tests | Pass; 289 tests across 26 files on Windows |
| Container owners | Verified root ancestry, family attribute level, complete child membership, explicit overrides, bounded parallel reads and structural/numeric readback covered |
| Durable review | Individual/batch decisions, manual amounts, original source preservation, revision conflicts, exact selected manifests, execution races, historical uncertainty and retry prevention covered |
| Representative batch | Fixture with 26 containers and 260 children passes; every owner verified and each explicit child override preserved; writes remain sequential |
| Approval protocol | Native modern/legacy and standard routes, exact input, empty/generic acceptance rejection, harmless check, complete compact manifests and size refusal covered |
| Interactive workspace | 31 browser checks pass at 1440×1100 and 390×844, including direct review opening, checked subsets, saved instruction handoff and oversized-manifest refusal |
| Portable plugin | Build/archive validation and isolated no-network startup pass; 48 default tools; private records excluded |
| Dependency audit | No production vulnerabilities reported by npm audit |
| Actual host form | Native route advertised by the current desktop client; a helper-agent CHECK was immediately declined without visible form; main-chat human input round trip remains unverified |
| Remote release / real price-list execution | Pending deployment approval and main-chat harmless form check; no live product mutation performed |

Mock timing does not establish live API latency, rate-limit behavior or cloud
execution time. Persisted per-line outcomes remain authoritative after a timeout;
uncertain plans cannot be replayed. Native route advertisement and fixture UI
checks do not prove the desktop displayed an approval form. A helper-agent decline
without visible UI is not evidence of a human rejection.

## Version 0.6.0 — November 3, 2026

| Check | Result |
| --- | --- |
| Typecheck / build / fixture tests | Pass; 214 tests across 25 files on Windows |
| Lookup contracts | Ambiguous first candidate retained; failed detail hydration returns explicit partial provenance |
| Pricing workflow | CSV/extracted rows, family mapping, decimal calculations, restrictions, inheritance impact, exact approval, stale/replay guards and readback tested with fixtures |
| Durable storage | File locking and GCS generation-pinned reads/CAS writes tested with mocks; actual cloud access requires deployment verification |
| Approval sessions | SDK HTTP roundtrips cover approve/decline/unsupported clients, credential isolation, cancellation, shutdown and draining capacity |
| Interactive workspace | Fixture-host browser checks cover search/selection, inheritance, dictionary, price import/mapping/plan and context attachment; desktop and narrow viewport checked |
| Portable plugin | Archive inspection and isolated no-network runtime checks pass; 42 default tools and UI resource available |
| Installed local plugin | Fresh-process discovery and bounded existing-account reads pass; no product writes |
| Container | Node 24, non-root, 0.25 CPU / 256 MiB fixture smoke passed; authenticated SDK handshake and blocked catalog mutation verified |
| Remote header helper | Sixteen fixture checks cover configuration, private header output, safe errors, subprocess bounds and Windows launchers |
| CI / image publication | Node 22/24 validation and image publication passed for 30f3bf; clean runner now builds host modules before container smoke |
| Initial private cloud deployment | Approved deployment completed; ready revision, pinned image/secret, private IAM, scoped bucket access and single-instance caps verified |
| Remote reads / connection | Authenticated SDK discovers 44 tools; five bounded read calls and workspace resource pass; native Codex remote configuration installed |
| Live price updates | Not performed; require uploaded source, reviewed rules and exact change approval |

The pricing HTTP mode has a separate deployment template with one CPU, 512 MiB,
concurrency 16 and a 120-second timeout so persistent event streams do not starve
approval responses. The constrained container check above verifies the default
stateless mode. Fixture approval roundtrips do not prove actual desktop form UI
support. No real price list, confirmed business rules, or catalog mutations were
used for release testing. PDF/XLSX extraction remains the host's responsibility.

The installed plugin requires host refresh/new-task discovery before its tools
appear in an already-open chat. Local and remote handlers share source, but their
private file stores do not synchronize automatically.
The remote credential helper was also executed with privately captured output;
only pass/fail was logged. It reuses the existing Google sign-in and does not
create credentials. The actual Codex approval form still needs a user-reviewed
pricing action in a refreshed chat; deployment checks never approve a mutation.

## Version 0.5.0 — October 20, 2026

| Check | Result |
| --- | --- |
| `npm run typecheck` / `npm run build` | Pass |
| `npm test` | 161 tests pass across 19 files |
| Shared workspace isolation | Fixtures verify colleague sharing, other-workspace isolation, wrong passwords, removed bindings and upstream authentication failure |
| Knowledge lifecycle | Fixtures verify proposal approval/allowlist enforcement, contributor restrictions, review revisions, alias conflicts, retirement and history |
| Storage | Concurrent writers preserve updates; corrupt storage fails closed; schema observations exclude arbitrary product fields |
| Transports | SDK stdio and stateless HTTP exercise discovery, guide resources and structured metadata |
| Package | `npm pack` produces an installable 0.5.0 tarball; manifest inspection excludes credentials, private stores and dependencies |
| Extracted package smoke | Built stdio handshake, version, discovery tools/resource and hidden writes pass |
| Live account reads / business workspace activation / deployment | Not performed for this release |

These are fixture and local packaging checks, not evidence of hosted durability,
production membership setup, client human-approval UI support or live catalog
initialization. The filesystem knowledge backend requires a private durable local
volume; a distributed hosted backend remains separate work.

## Version 0.4.1 — October 20, 2026

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | 144 tests pass across 17 files |
| `npm audit --omit=dev --audit-level=high` | Zero reported production vulnerabilities |
| Fresh SDK stdio session against the configured local account | All 34 advertised read tools exercised in 40 bounded calls |
| Live read results | 36 successful calls, four explicit partial results, zero failed or unchecked tools |
| Live mutations / permission changes / cloud deployment | Not performed |

Direct family detail and asset-category search still return HTTP 403 with
`No permissions to access this resource.` Both routes match the public reference.
The server now recovers family metadata through an exact-ID family search and
asset-category IDs through asset filter options. These are permitted API reads,
not changes to the connection's role or permissions.

`families_get`, `families_inspect`, and `products_get_full` explicitly mark the
recovered family metadata as partial. `asset_categories_search` marks its ID-only
fallback as partial; category names, hierarchy, name filtering and requested sort
order remain unavailable. See [API coverage](api-coverage.md#restricted-metadata).

Live checks also verified product-only and assets-only expansion, and v2 product
search with relationship presence and absence filters. An initial unpaced audit
hit HTTP 429 on its final call; adding a short pause between tool calls allowed
the complete audit to finish without failures. The read audit remains opt-in.

New fixture coverage verifies fallback status/ID guards, missing or malformed
category options, fallback pagination, selective expansion, duplicate read
sharing, independent result copies, cancellation, mutation cache invalidation,
lookup OR semantics and duplicate-product matching. Request and response budgets
remain tested using distinct reads. No cross-call product cache was introduced.

The prior container check below remains historical. Human approval UI
compatibility, live writes, multi-user OAuth and cloud deployment have not been
validated by this release.

## Version 0.4.0 — October 20, 2026

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | 114 tests pass across 13 files |
| `npm audit --omit=dev --audit-level=high` | Zero reported production vulnerabilities |
| Fresh SDK stdio session against the configured local account | All 34 advertised read tools exercised in 36 bounded calls |
| Live read results | 32 successful calls, two explicit partial results, two upstream HTTP 403 restrictions |
| Live mutations | Not performed; tested with fixtures only |
| Cloud deployment / IAM / credentials changes | Not performed |

The read checks use existing ignored local credentials and force
`PLYTIX_WRITE_TOOLS=[]` in a fresh subprocess. The repeatable command is
`npm run test:live:read`. Its output contains statuses, not product records or
credentials. Access restrictions are reported separately from implementation or
protocol failures; a successful exit does not mean every endpoint is accessible.

### Live findings and fixes

- Attribute discovery formerly returned zero custom and system attributes because
  it read the filter wrapper as a field. It now preserves both `attributes` and
  `properties`, including parent/variant filter operators.
- Asset search formerly returned HTTP 422 without filters. It now supplies empty
  filters and requests useful metadata, including alt text.
- Variant listing formerly used a v2 GET route that returned HTTP 405. The
  documented v1 route succeeds.
- Attribute lookups now filter by exact label and fetch one definition instead of
  scanning and hydrating the entire account. Prefix-normalized lookup was verified.
- Schema search, group membership, completeness type filtering, family attribute
  lists, product ancestry inspection, bounded value profiling, products, assets,
  categories, relationships and identifier lookups were exercised live.

### Remaining access restrictions

`families_get` and `asset_categories_search` receive HTTP 403 from Plytix with the
current account. The documented route shapes were checked. Other authenticated
calls succeed, so this is not evidence of globally missing/invalid credentials.
No role, permission or credential changes were attempted.

`families_inspect` and `products_get_full` preserve available data and explicitly
report the unavailable family-detail section. This is a partial result, not proof
that the family is absent. Product inheritance inspection obtains the accessible
family attribute configuration independently.

### Fixture and security coverage

Tests cover actual nested filter shapes, matching-count versus account-count
pagination, metadata projections, zero/false values, completeness members,
bounded and duplicate-page sampling, inheritance cycles/depth/partial access,
system/custom attribute label collisions, and required asset destinations.

Both transports share the same tool registration and API client. Fixtures cover
read-only defaults, exact write allowlists and API route checks, per-invocation
approval, rejected/expired/cancelled approvals, immutable reviewed arguments,
separate approval/execution budgets, no mutation retries, asynchronous acceptance,
and relationship readback that does not confuse ignored writes with completion.

HTTP tests cover authentication, credential isolation, duplicate security headers,
Host/Origin enforcement, request/body/concurrency limits and SDK protocol behavior.
Operation cancellation and cumulative response limits remain enforced.

Actual human approval UI compatibility, live mutations, multi-user OAuth, cloud
approval/audit integration, production deployment, and downstream channel
processing remain unverified. Channels/formula/list definitions lack documented
public routes; see [API coverage](api-coverage.md).

## Previous container validation — October 15, 2026

The previous 0.3 code passed a Node 24.22.0 image build and fixture container
smoke check under a 0.25 CPU / 256 MiB limit. The container ran as `node` with a
read-only filesystem, dropped capabilities and a loopback-only published port.
Observed fixture memory was about 36.5 MiB. This is historical evidence; the
0.4 image/container check has not been rerun. The smoke script now checks the
complete expected read-tool set instead of a stale fixed count.

Dependency advisories and base images can change. Recheck the intended image and
client before any separately approved deployment.
