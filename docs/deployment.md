# Cloud Run readiness

No Google Cloud resources, credentials, IAM bindings, billing changes or live
Plytix writes have been created. This is a deployment plan and unrendered template.

## Resolve identity first

The inspected Desktop SDK configuration had no selected project. Its authorized
read-only project listing did not identify the historical Plytix project. Select
the correct existing account and verify the exact project ID, project number,
billing account and region before rendering any template. Do not infer a project
from a familiar display name, create a replacement, or change another service.

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

## Verification after approved deployment

Verify private IAM, zero minimum instances, maximum one, selected resources,
immutable image, pinned secret, service identity and exact Host/Origin values.
Confirm unauthenticated access is denied and only read tools are listed. Run the
approved bounded read and inspect status-only logs without headers or payloads.
Review actual cold-start/memory/cost behavior before changing resource limits.
