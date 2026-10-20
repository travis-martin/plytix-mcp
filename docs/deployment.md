# Cloud Run readiness

The explicitly approved billing linkage and bounded preparation are complete:
required APIs, an empty private image repository, a keyless runtime identity and
an empty application-secret container with runtime-only explicit accessor binding.
No image, secret value or Cloud Run service has been deployed. This remains a
deployment plan and unrendered template.

For the dated operator snapshot, see [project handoff](project-handoff.md) and
[current approval bundle](cloud-approval.md). The 2026-10-15 checks verified the
refreshed work login, existing project, approved billing linkage and prepared
resources. Owner secret entry, stable-branch promotion and final deployment remain.
The account-independent deployment guidance below still requires fresh metadata
and exact action-time approvals.

See [continuous deployment](continuous-deployment.md) for tested stable-branch
updates. Approved keyless CI trust and publish-only settings are configured.
The local image upload is deferred to that pipeline; no service is deployed.
The [owner finish checklist](owner-checklist.md) records the remaining steps.

## Resolve identity first

The inspected Desktop SDK configuration had no selected project. Its authorized
read-only project listing did not identify the historical Plytix project. Select
the correct existing account and verify the exact project ID, project number,
billing account and region before rendering any template. Do not infer a project
from a familiar display name, create a replacement, or change another service.

For an expired existing work login, the supported owner-run refresh is
`gcloud auth login EXISTING_WORK_ACCOUNT --no-activate`. This updates local CLI
authorization while preserving the active account. It grants no project IAM
permissions. Do not add Drive scopes, update ADC or create a service-account key.
If additional consent is requested, stop for owner review. Verify project/billing,
enabled APIs and selected resource metadata after that refresh; do not access
secret payloads. See [Google's login reference](https://docs.cloud.google.com/sdk/gcloud/reference/auth/login).

## Proposed small configuration

`deploy/cloud-run.template.yaml` proposes a new `plytix-mcp` service with:

- First generation, request-based billing; 0.25 vCPU, 256 MiB RAM.
- Minimum instances zero, maximum instances one, concurrency one, 60-second timeout.
- Startup CPU boost disabled; non-root Node 24 container and no background worker.
- Empty write allowlist, exact service hostname, no browser origins by default.
- Independent application token from one explicitly approved secret at a pinned
  numeric version; IAM invocation checks enabled.

Fractional CPU requires first generation, concurrency one and request-based billing.
A quarter CPU is a small starting point for a Node SDK/API proxy. Local resource
limits are verified separately; cloud cold-start and real-account latency still
require an approved smoke test. Max instances can be temporarily exceeded by
platform maintenance/revisions and is not a spend cap.

Read the [Cloud Run MCP hosting guide](https://docs.cloud.google.com/run/docs/host-mcp-servers),
[CPU constraints](https://docs.cloud.google.com/run/docs/configuring/services/cpu)
and [pricing](https://cloud.google.com/run/pricing) before approving resources.
Scale-to-zero reduces idle compute charges; it does not guarantee zero total cost.
Shared billing-account free allowances, build execution, Artifact Registry image
storage, networking, logs and secret storage/access can still cost money.
Avoid a VPC connector, database, scheduler, load balancer or minimum-instance pool.

For an illustrative us-central1 workload of 10,000 HTTP requests/month at five
billed seconds each, the selected CPU/RAM and request count cost about $0.34/month
before shared free allowances, cold starts, storage, networking and logging.
This is a usage assumption, not an observed or guaranteed bill.

## Required permission scope

Reuse verified existing permissions before proposing any grants:

| Action | Minimum relevant scope |
| --- | --- |
| Deploy/create service | Cloud Run Developer; service creation needs project scope |
| Use runtime identity | Service Account User on that account only |
| Push image | Artifact Registry Writer on the selected repository only |
| Read application-token secret | Runtime account: Secret Accessor on that single secret only |
| Invoke privately | Caller: Cloud Run Invoker on the MCP service only |
| Change invocation binding | Service-specific setIamPolicy permission, only for the reviewed diff |

Verify Cloud Run's managed service-agent image-read access. First enabling its
API can create a managed identity/role and requires explicit approval for that
change. No new managed identity, API enablement or resource creation is implicit
in a login refresh. See [deployment permissions](https://docs.cloud.google.com/run/docs/deploying).

## Exact decisions and approvals needed

1. Confirm the actual existing project ID/number, account, region, billing account
   and acceptable small usage/storage budget. Any billing attachment, API enablement,
   image-repository creation or build identity changes need separate approval.
2. Approve a new isolated service and exact immutable image digest. Prefer local
   Docker build plus an existing approved image registry; approve registry push/storage
   separately. Do not run source deploy if it creates unreviewed build resources.
3. Reuse an appropriate least-privilege runtime identity if available. Any identity
   creation and grants need approval specifying principal, role and resource. No
   project-wide Editor grant. Approve secret access only to that individual secret
   and a pinned version. User enters/uploads the token through a private local or
   console handoff; never chat or command-line arguments.
4. Keep invocation private. Inspect service IAM for `allUsers` and
   `allAuthenticatedUsers`; approve only the exact intended caller if it lacks
   invocation permission. Do not create a public endpoint for compatibility.
5. Approve reuse of existing bounded read-only Plytix credentials and a specific
   smoke test after deployment. No synthetic live product changes.

After those decisions, render placeholders to ignored `deploy/*.local.yaml` and
review the complete configuration and IAM diff before deployment. The template
alone cannot establish a private IAM policy; verify it separately. Confirm the
final generated service hostname and configure it exactly. A TCP listener probe
can be used during a private initial revision before the external hostname is known.

## Clients

Local stdio is the first supported route. For a private Cloud Run service,
`gcloud run services proxy SERVICE --project PROJECT --region REGION` can provide
a loopback endpoint using existing approved caller access. The MCP client still
needs `X-MCP-Token` and Plytix BYOK headers. Configure Host validation for the proxy's
actual Host behavior rather than blindly widening the allowlist.

The IAM proxy serves clients on that local machine. It does not make a private
service usable by a hosted AI provider. Direct hosted clients need a compatible
authenticated integration that presents Cloud Run identity plus required
application/Plytix headers, or a separately reviewed OAuth/gateway design. No such
integration has been verified, and no OAuth grants are authorized by this plan.

## Read-only and approved-write connections

Use one implementation with two named connections or separately configured
services. The read-only connection fixes `PLYTIX_WRITE_TOOLS=[]`; the approved-write
connection uses the smallest reviewed list of tool names and appropriately scoped
Plytix credentials. A read-only connection must retain its empty allowlist even
when the same operator also has a write connection.

Local stdio supports per-invocation approval through MCP form elicitation: the
host must show the exact arguments and return the user's typed `APPROVE`.
Unsupported hosts, rejection, cancellation and timeout all fail closed. The
[stdio connection template](../deploy/codex-stdio-modes.template.toml) illustrates
the separation without credential values. Fixture verification covers the
protocol exchange; no live write or actual host approval UI was tested.
Allow at least 90 seconds for the write client's tool call: approval may take
30 seconds and approved execution receives its own 45-second budget.

The standalone HTTP service remains read-only in practice: selected writes can
be listed by configuration, but they cannot execute without a trusted embedding
application's approval provider. Do not equate the application service token
with user approval. A future cloud write service needs authenticated per-user
authorization, account-bound credentials and exact-action approvals before
enabling writes. Hosted-client OAuth compatibility, durable audit/replay controls
and cancellation behavior must be verified as part of that deployment. See
[write enforcement and approval](security.md#before-allowing-writes).
The current 60-second service timeout is suitable for the read-only deployment
plan. A write gateway, its client and upstream proxies must allow at least
90 seconds; review that configuration with the future write deployment.

No cloud write deployment, credential creation, permission grant or public access
change is authorized by this local implementation.

## Verification after approved deployment

Verify private IAM, zero minimum instances, maximum one, selected resources,
immutable image, pinned secret, service identity and exact Host/Origin values.
Confirm unauthenticated access is denied and only read tools are listed. Run the
approved bounded read and inspect status-only logs without headers or payloads.
Review actual cold-start/memory/cost behavior before changing resource limits.
