# Validation

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
| Live price updates / initial cloud deployment | Not performed; require exact action approval |

The pricing HTTP mode has a separate deployment template with one CPU, 512 MiB,
concurrency 16 and a 120-second timeout so persistent event streams do not starve
approval responses. The constrained container check above verifies the default
stateless mode. Fixture approval roundtrips do not prove actual desktop form UI
support. No real price list, confirmed business rules, or catalog mutations were
used for release testing. PDF/XLSX extraction remains the host's responsibility.

The installed plugin requires host refresh/new-task discovery before its tools
appear in an already-open chat. Local and remote handlers share source, but their
private file stores do not synchronize automatically.

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
