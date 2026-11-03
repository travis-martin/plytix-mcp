# Plytix Catalog plugin

The plugin packages the same TypeScript stdio server used by the HTTP deployment.
Its four skills cover catalog exploration, quality audits, inheritance, and reviewed
price-list updates. It contains no credentials, customer data, account defaults,
dependency directory, or separate implementation of product behavior.

## Build and validate

```powershell
npm run test:all
npm run plugin:build
npm run plugin:check
npm run plugin:test
```

The build bundles the runtime into
`build/plugin-artifacts/plytix-catalog/server/index.mjs`, validates the manifest and
skills, creates a versioned `.tgz` next to the package directory, and inspects the
archive's full file list. `plugin:test` extracts the archive to a temporary directory
outside this repository, starts it without dependency folders or real credentials,
disables fetch, checks default tool discovery and draft annotations, and calls a
harmless identifier tool and both guide/workspace resources. It also rejects
fixtures containing credential configuration or an environment file. No live
catalog mutation or plugin installation occurs.

## Local connection

Install the generated directory/archive through the host's supported plugin flow.
The portable `mcp.json` uses Node 22 or later and `${PLUGIN_ROOT}`. Enter existing
Plytix credentials using private host environment configuration, never in this
package. Leave `PLYTIX_WRITE_TOOLS=[]` initially. Supply private absolute paths for
configured knowledge and pricing storage. Runtime files belong outside the plugin
directory so reinstalling does not discard learning or run records.

Verify discovery and a harmless call in the actual host after installation. Verify
the exact approval UI before enabling specific write tools. An installed server
does not establish that a host supports interactive views or approval forms.

For this checkout's private installation, `npm run plugin:prepare-local` creates
an ignored marketplace under `.local/plugin-marketplace` from the validated
portable package. Its private `mcp.json` references the existing `.env` by absolute
path, uses `.local/pricing` for durable local records, and explicitly exposes only
`pricing_rules_save`, `pricing_apply` and `pricing_review_apply` as approved writes. It never copies or
prints credentials, edits the existing direct MCP connection, or installs itself.
The default private preparation uses the additional trusted host approval form.
The portable archive keeps its default product-write-disabled configuration.

For an explicitly authorized private operator installation, pass
`node scripts/plugin-prepare-local.mjs --host-writes --all-write-tools` to use native
host tool permissions with all named catalog writes. Omit `--all-write-tools`
to retain just the three pricing writes. Omit `--host-writes` to retain the
additional server form. Neither flag changes the portable package defaults.
Host mode relies on the client's permission policy; use `writes` to prompt for
writes while allowing read-only tools, or `prompt` to ask for every tool.

When the remote connection is primary, prepare a clearly labeled local fallback:

```powershell
node scripts/plugin-prepare-local.mjs --host-writes --all-write-tools --local-backup
```

`--local-backup` labels only the private prepared package **Plytix Catalog (Local
Backup)** and adds `+local-backup.1` to its source version for host cache refresh.
The plugin name `plytix-catalog`, marketplace identity, portable package and server
behavior remain unchanged. Omit the flag and prepare again to restore the portable
display name/version, then use the supported host reload/reinstall flow. The label
does not select a connection automatically or synchronize local and remote data.

Install that prepared private source with the supported local CLI:

```powershell
codex plugin marketplace add "C:/Git/BP/Plytix/plytix-mcp/.local/plugin-marketplace" --json
codex plugin add plytix-catalog@plytix-local --json
```

Repeat preparation and the host's refresh/reinstall flow after a new build; do not
edit the installed cache. See the [official marketplace format](https://developers.openai.com/plugins/build/plugins#marketplace-metadata).

## Remote connection and parity

The HTTP service shares `src/server.ts` and the same registered tools, rules and
write policy. Build and deploy it using the existing reviewed repository process.
The local package cannot start a process for a web/mobile user. A remote package
must point at a verified deployed `/mcp` endpoint using its actual authentication;
do not substitute a dashboard URL or include credentials in an archive.

The HTTP service requires independent service authentication and Plytix credentials
on each request. Its default stateless mode has no interactive write approval.
Opt-in `MCP_APPROVAL_SESSIONS=true` supplies credential-bound sessions. The default
form mode requires exact form elicitation from a trusted compatible host;
`MCP_WRITE_APPROVAL_MODE=host` uses that client's normal tool permissions without
the duplicate form. Verify authentication and the configured approval behavior in
the actual host; fixture roundtrips alone do not prove compatibility. Keep
deployment, credentials, permissions and publishing under their existing approval
requirements. See the repository's `docs/remote-pricing.md`.

## Pricing workflow

For CSV, import source text with provenance. For PDF, spreadsheets, images and
other uploaded documents, the host extracts cited rows first using its document
tools; the server does not contain PDF/OCR/spreadsheet parsers. Suggest family
mappings first, resolve ambiguous rows, then create a proposal using reviewed
rules and current inheritance/value evidence. Review exact old/new values and
calculation traces before execution. Read back applied changes and distinguish
verified from uncertain outcomes. See `skills/update-prices/SKILL.md` in the package.

Pricing records use persistent `PLYTIX_PRICING_DIR` files or the explicit
`PLYTIX_PRICING_GCS_BUCKET` object adapter with generation checks. Without workspace
bindings, all records are credential-private. Explicit
`PLYTIX_PRICING_SCOPE_BINDINGS` can share workflow guidance, rules and dictionary
definitions among bound credentials using the same backend; imports, plans,
reviews and execution audits remain credential-private. Local file copies and
remote cloud objects do not synchronize automatically, even with the same
workspace binding. Before switching backends, review and transfer the latest
guidance and required records rather than relying on an older local copy. The
portable package ships workflow skills, never organization-specific rules or data.
