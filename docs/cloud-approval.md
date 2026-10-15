# Cloud approval checklist

Prepared 2026-10-15. This account-independent checklist grants no authorization.
Exact operator identities, project and billing identifiers, observed IAM inventory,
and proposed billing command are kept only in `.local/cloud-approval.md`, excluded
from Git. That private bundle records verified metadata; it must be refreshed
before action. The original external approval note remains unchanged.

## Staged decisions

1. **Billing only:** the verified existing project has billing disabled and its
   linked account is closed. An accessible open account exists. The owner must
   approve the exact project and intended payer before linking them. Billing
   applies to all project resources. Linking permission is not yet verified; stop
   on denial without granting new permissions. No billing action has been run.
2. **Metadata verification:** re-read billing, selected APIs, regional services and
   repositories, identities and secret names. A billing/API failure does not prove
   a resource is absent. Never access secret payloads during preparation.
3. **API/resource approval:** reuse enabled APIs and suitable resources. Separately
   approve exact missing API enablements, repository, dedicated runtime identity
   and application-token secret. Avoid an existing runtime account with Editor.
   Reuse verified caller/service-agent permissions; no blanket grants.
4. **Image upload:** approve the reviewed source commit, exact repository and one
   upload. Build locally to avoid Cloud Build provisioning. Read the registry
   manifest digest after upload; a local Docker image ID is not that digest.
5. **Secret and IAM:** the owner privately generates/enters/uploads the independent
   application token. Approve only runtime Secret Accessor on that single secret,
   pinned to a numeric version. No keys, OAuth grants or chat/argument secret values.
6. **Deployment:** approve the immutable image, full rendered YAML, runtime identity,
   secret version, exact Host settings and actual IAM diff. Keep invocation private.
   A reviewed initial TCP-probed private revision may be needed to resolve the host.
7. **Client/read test:** separately approve existing Plytix credential use and a
   bounded read. Verify the local IAM proxy's actual Host behavior. Hosted clients
   require a compatible authenticated design; do not make the endpoint public.

Proposed runtime is Node 24, gen1/request billing in `us-central1`, 0.25 CPU,
256 MiB, concurrency 1, timeout 60s, min 0/max 1, startup CPU boost off,
`PLYTIX_WRITE_TOOLS=[]`, and no browser origins. No project-wide Editor or Secret
Accessor grant, database, scheduler, VPC connector, load balancer, build trigger,
subscription or always-on worker is proposed. Unrelated services are excluded.

See [Google's billing link reference](https://docs.cloud.google.com/sdk/gcloud/reference/billing/projects/link),
[billing scope/permissions](https://docs.cloud.google.com/billing/docs/how-to/modify-project)
and [deployment guidance](deployment.md).

## Cost assumptions

Illustrative USD list rates checked 2026-10-15. At 10,000 HTTP requests/month
averaging five billed seconds, 0.25 CPU/0.25 GiB uses 12,500 vCPU-seconds and
12,500 GiB-seconds:

| Item | Estimate before free allowances |
| --- | --- |
| CPU: 12,500 x $0.000024 | $0.30000 |
| Memory: 12,500 x $0.0000025 | $0.03125 |
| Requests: 10,000 x $0.40 / million | $0.00400 |
| Registry: budget 1 GiB-month x ~$0.10 | ~$0.10 |
| One active secret version with automatic replication | ~$0.06/month |
| Independent budget of 10,000 secret reads | $0.03 |
| Local build / Cloud Build execution | $0 cloud execution; local cost excluded |
| Illustrative subtotal | ~$0.53/month |

This excludes cold starts/shutdown time, egress, logs, taxes and existing project
charges. Actual registry storage varies and grows with retained images. Secret
read volume is an independent assumption, not one read per MCP request. Paid
scanning is not proposed; recheck API/repository metadata before upload.

Shared monthly allowances include 180,000 Cloud Run vCPU-seconds, 360,000 GiB-seconds
and 2 million requests; 0.5 GiB registry storage; six active secret versions and
10,000 secret accesses. Remaining billing-account allowance has not been measured.
Scale-to-zero does not guarantee free service, and max instances is not a spend
cap. A proposed $5/month review threshold is not a configured budget or alert.

Sources: [Cloud Run](https://cloud.google.com/run/pricing),
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing),
[Secret Manager](https://cloud.google.com/secret-manager/pricing).
