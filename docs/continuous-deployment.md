# Continuous deployment

The approved keyless GitHub connection and publish-only repository variables are
configured. The workflow is part of the reviewed branch changes; promotion to main
triggers publication. Automatic deployment remains off, and no Cloud Run service
exists. Secret values remain owner-entered. The local upload is deferred because
CI can publish the initial image without duplicate upload work.

Both choices build Docker images into Artifact Registry. Connecting a source
repository automates that process; it does not replace the container registry.

| Option | Setup / ongoing behavior | Additional infrastructure and access |
| --- | --- | --- |
| Cloud Run connected repository | Console integration; pushes to a selected branch build/deploy through Cloud Build. Tests must be added to the build; it does not automatically wait for GitHub CI. | Cloud Build API, GitHub app/repository connection, build trigger, build identity/roles and build logs. Developer Connect is another supported connection option with its own API/permissions. |
| GitHub Actions with OIDC (recommended here) | Extend existing CI: tested stable-branch pushes build, smoke test, publish and eventually update only the deployed image. Runs independently of the Desktop connection. | Dedicated workload identity pool/provider and keyless CI account; narrowly scoped registry, runtime actAs and existing-service update permissions. No Cloud Build or Google GitHub app connection. |

For this public repository, standard GitHub-hosted runner minutes are free under
GitHub's published policy. No larger runners, GitHub Packages or uploaded build
artifacts are proposed. Registry storage/secret/Cloud Run charges still apply.
Cloud Build's published e2-standard-2 rate is $0.006/minute before its shared
2,500-minute promotional monthly allowance: 100 five-minute builds would be $3
before that allowance, plus image storage and runtime. Recheck current billing
policies before activation; no guaranteed free claim is made.

## Recommended branch and release flow

Use `develop/cloud-run` for development and `main` as the stable release branch.
Merge the reviewed implementation and workflow only after separate Git approval;
current main still contains the earlier implementation. The draft does not deploy
development branches, pull requests, or pull_request_target events.

The [workflow](../.github/workflows/cloud-run.yml) runs
Node 22/24 typecheck, build, tests and production advisory checks. Publication
then builds and fixture-smokes the container before cloud authentication, uploads
it under its Git commit SHA and resolves the registry digest. Automatic updates
use `gcloud run services update --image` on an existing service, preserving its
runtime identity, secret reference, read-only policy, IAM and resource limits.
The initial private deployment still requires its own final reviewed approval.

All third-party action refs are pinned to official tag commit IDs verified on
2026-10-15. Publishing is approved and enabled; `MCP_AUTO_DEPLOY_ENABLED` is false.
The first main-branch push publishes only. Verify its digest and the owner-uploaded
secret version before final initial-service approval and before enabling ongoing
image-only updates. The update command cannot create a missing service, and CI
has no service-creation permission. Future security/resource changes remain reviewed.

Repository variables (metadata only): `GCP_PROJECT_ID`, `GCP_REGION`,
`MCP_IMAGE_REPOSITORY`, `MCP_SERVICE`, `MCP_WIF_PROVIDER`,
`MCP_CI_SERVICE_ACCOUNT`, and the two enable flags. No Plytix/application token or
downloadable service-account key belongs in GitHub. The workflow never reads a
Secret Manager payload. Deploying code as the runtime identity nevertheless gives
trusted release code the runtime's secret access; main/workflow write access must
be treated as production access.

## Approved CI permissions

The dedicated keyless CI identity is separate from the runtime identity. OIDC
admission is restricted by verified numeric repository/owner IDs, `refs/heads/main`,
push events and the exact workflow reference. Only that principal set receives
Workload Identity User on the CI account. The CI account receives:

- Artifact Registry Writer on the selected repository only.
- Service Account User on the dedicated runtime account only.
- Cloud Run Developer on the approved existing service only, after it exists;
  this binding is deferred while the service does not exist.

No Owner, Editor, Run Admin, IAM-policy-management, Token Creator or direct Secret
Accessor grant is assigned to CI. Required missing WIF APIs were enabled under the
same approval. The private `.local/cicd-approval.md` contains exact operator resource
names, verified IDs, trust condition and remaining actions.
GitHub main-branch protection requiring PRs and existing CI checks is recommended;
changing repository rules is separate from the approved preparation.

See the [owner finish checklist](owner-checklist.md) for private token entry,
stable-branch promotion, final deployment approval and client authorization.

Sources: [Cloud Run repository integration](https://docs.cloud.google.com/run/docs/continuous-deployment),
[Google deployment-pipeline federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[official authentication action](https://github.com/google-github-actions/auth),
[Cloud Run deployment permissions](https://docs.cloud.google.com/run/docs/deploying),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[Cloud Build pricing](https://cloud.google.com/build/pricing).
