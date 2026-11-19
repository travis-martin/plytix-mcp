# Windows connector machine authentication

The private Cloud Run connector can use a dedicated service account backed by a
non-exportable Windows TPM key. Its Google ID tokens renew without `gcloud`, user
Application Default Credentials, or a personal Google login. The existing
application token, per-request Plytix credentials and write approval controls
still apply. The server needs no code or image change.

For workloads running on Google Cloud, prefer an attached service identity. For
external workloads with a suitable machine identity provider, prefer Workload
Identity Federation. A GitHub Actions federation provider cannot authenticate a
desktop process. Do not broaden a CI trust condition to accommodate a workstation.
This TPM option is for a Windows workstation without a suitable external provider.
It uses an uploaded service-account public key; it is not keyless federation.

## Identity and credential boundaries

- Use a dedicated service account for this connector/device. Grant only
  `roles/run.invoker` on the exact Cloud Run service. The connector needs no
  project role, Token Creator, key administrator, storage access or secret access.
- Keep the private RSA key in `Microsoft Platform Crypto Provider`, non-exportable,
  in the current Windows user's certificate store. Only the public certificate
  goes to Google. No downloaded JSON private key is needed.
- Use a reviewed certificate lifetime allowed by the effective organization policy.
  Provisioning defaults to five years for a hardware-protected key. Certificate
  expiry, account/key revocation, TPM reset or loss of the Windows profile still
  requires maintenance; this is not an irrevocable permanent credential.
- A process running as that Windows user can ask the TPM to sign. Hardware storage
  prevents private-key export; it does not make a compromised Windows session safe.

## Reviewed one-time provisioning

Creating credentials, service accounts, grants or cloud changes requires the
repository's exact action-time approval. Preparation and fixture checks do not
grant that approval. Preserve the existing connection until a machine-authenticated
read succeeds.

1. Verify the service URL, current IAM policy, service identity, relevant key-upload
   policies, TPM readiness and Windows account. Use the Cloud Run `status.url` origin
   as the token audience, even if the connector endpoint uses another verified URL
   for that same service. The audience must not include `/mcp`.
2. After approval, run the provisioner with a new local output directory:

   ```powershell
   powershell.exe -NoProfile -NonInteractive -File scripts/windows-tpm-provision.ps1 -OutputDirectory "C:/PRIVATE/AUTH/NEW-IDENTITY"
   ```

   It creates one RSA-2048 TPM key and exports only a public certificate and public
   metadata. It records partial progress and refuses an existing output directory.
   Do not delete a partial record and blindly repeat the command.
3. Create the dedicated service account, upload that public certificate using
   `gcloud iam service-accounts keys upload`, and add its service-specific Invoker
   binding. Preserve unrelated IAM entries. Use an operator's existing administrative
   authorization for setup; do not grant administrative access to the connector.
4. Read back the new account, uploaded key ID, validity dates and exact IAM diff.
   Write a private, non-secret configuration file using the verified values:

   ```json
   {
     "version": 1,
     "type": "windows-tpm",
     "serviceAccount": "connector@PROJECT.iam.gserviceaccount.com",
     "keyId": "GOOGLE_UPLOADED_KEY_ID",
     "certificateThumbprint": "WINDOWS_CERTIFICATE_THUMBPRINT",
     "audience": "https://VERIFIED-SERVICE.run.app"
   }
   ```

   The file identifies a credential; it must never contain a private key, access
   token, refresh token or arbitrary OAuth endpoint. Protect its integrity and keep
   it outside the source checkout and plugin archive.
5. Validate configuration without signing or networking:

   ```powershell
   node scripts/cloud-run-headers.mjs --env-file "C:/PRIVATE/headers.env" --machine-config "C:/PRIVATE/machine.json" --check
   ```

   This emits booleans only. It does not establish certificate availability, IAM
   access or a working token exchange. The normal helper emits credentials to a
   private host pipe; never run it directly into a terminal or captured tool output.
6. Run `npm run auth-helper:build` to build a standalone, content-addressed helper
   with its signer and license. Copy the complete immutable artifact directory to
   a private runtime location outside the working checkout and verify its manifest
   checksums. Set `helper_path` in connection metadata to the copied
   `cloud-run-headers.mjs`. This prevents Git branch changes or missing checkout
   dependencies from breaking the production connector. The artifact contains no
   machine metadata or credentials; Node and the existing credential file remain
   external dependencies.
7. Prepare a new native remote plugin profile with `machine_config` instead of
   `account` and `gcloud` in its private connection metadata. Preserve the endpoint,
   environment path and timeouts. Use the supported Codex installer to activate it,
   then verify fresh machine-authenticated MCP initialization and a bounded read.
   Do not use product writes as a smoke test.

The existing account/gcloud mode remains supported for development and explicit
rollback. Machine mode rejects mixed configuration and has no personal-login
fallback. The review-panel launcher accepts the same `--machine-config` option.

## Token handling

The hidden signer validates the certificate, TPM provider, non-exportability and
validity period, then signs an RS256 assertion. The assertion's issuer is the
dedicated service account, its audience is the fixed Google OAuth token endpoint,
and its `target_audience` is the verified Cloud Run origin. The helper exchanges
it over HTTPS for a Google ID token, with redirects disabled and bounded time and
response size. Errors omit subprocess, token and credential contents.

No persistent token cache is written. Codex's header-helper refresh behavior obtains
new tokens when needed. The local review panel also refreshes after a same-origin
401/403 and retries once only when the authentication headers changed; it never
replays network failures or other HTTP failures. Every fresh helper invocation can obtain a new token without
the operator being signed into Google. A sustained connection should also be checked
across token expiry after activation; an immediate smoke test proves only fresh
authentication, not an hour-long session.

## Renewal, recovery and rollback

Keep the public provisioning record, certificate expiry and uploaded key ID with
the private operational record. Review expiry ahead of time. Hardware-protected
uploaded keys do not need frequent credential replacement merely because the
short-lived Google ID token expires.

To replace a key, obtain exact approval, provision a new TPM key, upload its public
certificate, prepare a new metadata file, and verify a fresh token and read. Switch
the metadata/profile only after verification. Revoke the previous uploaded key after
the new connection is confirmed. The connector has no permission to rotate its own
keys or expand its access. A replacement machine gets its own identity/key.

For rollback, restore the prior plugin source through the supported installer and
verify it. If it uses developer authentication, a valid human Google session will
again be required. Revoke the machine key or remove its Invoker binding only as a
separately reviewed operation. The old account, service, pricing data and runtime
identity are not changed by this client-authentication implementation.

Sources: [Google hardware-backed service-account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys#use_an_hsm_or_tpm_to_store_keys),
[Cloud Run service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service),
[service-account public-key upload](https://docs.cloud.google.com/iam/docs/keys-upload),
[Windows TPM certificate generation](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate).
