# Persistent pricing workspaces

Pricing has two storage modes. With no organization binding configuration, every
file remains private to the exact Plytix API key/password and endpoint fingerprint.
Changing a credential pair selects another namespace; it does not move or delete
earlier files. Local filesystem and remote GCS stores are also separate unless both
connections explicitly use the same backend.

An operator can bind approved credential fingerprints to a stable organization
workspace with the private `PLYTIX_PRICING_SCOPE_BINDINGS` environment setting:

```text
{"<64-character credential fingerprint>":"organization/catalog"}
```

This is server/operator configuration, never an MCP tool argument. Keep it outside
source control and plugin packages. The binding records no raw API credentials.
The existing fingerprint includes the API key, password and upstream endpoints.
Workspace names, email domains and catalog text do not prove membership. The
current implementation receives an access token and expiry from authentication;
it does not infer organization membership from an unverified account claim.

When this setting is present, every pricing connection must have an explicit
binding. An unknown or rotated credential fails with a membership error instead
of silently opening a new empty private namespace. Each access still authenticates
the supplied Plytix credentials before opening its pricing store. Adding or
removing bindings is an operator action; runtime/environment changes may require
restart or deployment. A binding does not grant Plytix API mutation privileges.

Only these reusable files are shared between credentials bound to the same workspace:

- `rules.json` and immutable `rules-revision-*.json` copies
- `dictionary.json`
- `workflow.json`

UUID-named source imports, calculated plans, review decisions and execution audits
remain private to their original credential pair. Shared guidance uses a stable,
domain-separated SHA-256 namespace derived from the workspace ID. Private records
retain their existing namespace and one-shot execution reservations. The store's
scope status reports the mode and workspace name without exposing the credential
fingerprint.

After an explicitly approved credential rotation, the newly bound credential can
reuse organization guidance but cannot read the old credential's UUID source or
execution records. Those old files remain intact. Recovering private run history
requires a separate, reviewed migration; do not reconstruct it as unconsumed drafts.

Sharing requires both the same binding and the same storage backend. For example,
local and remote clients must access the same approved GCS bucket to see one
canonical organization workspace. A local filesystem copy with the same workspace
name is still a different store. This configuration does not create cloud access,
alter IAM, install credentials, or automatically synchronize files. Prefer the
existing remote connection when local cloud authentication is not configured.

Every bound connection can read the shared files. Existing tool classifications,
write allowlists, trusted host approval, schema validation and revision checks still
govern edits. Bind only credential holders permitted to share the complete rules,
dictionary and workflow context. Use separate workspaces when visibility differs.

## Explicit migration

Enabling a workspace does not enumerate, copy, merge or delete any old namespace.
Prepare a migration from explicitly identified source files, review conflicting
rule IDs and definitions, then write the new shared files using generation/revision
preconditions. Retain source copies and compare hashes/readback. Never migrate or
restore consumed execution reservations as fresh drafts. User guidance files kept
outside the runtime pricing store are not automatically imported by this setting.

For review or editing, prefer the workflow/dictionary/rule tools and their current
revision. Direct file inspection is useful, but raw edits bypass input validation
and can race another session. Use validated imports or tools for corrections; keep
source evidence and correction history.
