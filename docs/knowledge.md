# Shared discovery and catalog knowledge

Version 0.5 adds a catalog dictionary, a discovery guide, shared schema learning,
reviewed business definitions, and a common result contract. It works without a
knowledge workspace: discovery guidance and live schema search remain available.
No business names, account identifiers, product values, or credentials are shipped
in the reusable package.

## Start exploring

1. Call `discovery_guide` for routes from common questions to useful tools.
2. Call `knowledge_status` to see whether this connection has a shared workspace.
3. Call `catalog_dictionary` with a concept such as `{"query":"thickness"}`.
   Confirmed aliases expand the live schema search to the mapped attribute labels.
4. Use `products_filters` to discover supported operators and `products_search`
   to retrieve current values with explicit field projections.

`catalog_dictionary` returns confirmed definitions, dated schema observations and
current schema results in distinct sections. Proposals are excluded unless
`include_proposals: true` is requested. Multiple matching meanings remain visible;
the server never chooses a business meaning based on confidence alone. Family
applicability is explicit through `family_ids`.

Set `live: false` to search saved knowledge only. This still validates the bound
Plytix credentials; it is not an offline bypass. Each result section has its own
pagination. A page or an accumulated observation store is not a complete catalog.
The static guide is also available as `plytix://guides/discovery`, and server
instructions explain the discovery sequence to compatible clients.

## Initial operator setup

Build with `npm run build`. From a checkout, use `npm run knowledge:admin -- ...`;
from an installed package, use `plytix-knowledge-admin ...` (or
`node dist/knowledge/admin.js ...`). `--help` lists all commands.

With existing approved credentials in the private environment, create a workspace:

```powershell
npm run knowledge:admin -- init --scope "business/account-identifier" --name "Example Business" --member "catalog-owner" --domain "example.com" --account-id "account-identifier" --learn --contributor
```

This creates `.local/knowledge/config.json`. It does not contact Plytix, create
credentials, or prove that the credentials belong to the named account. The
operator must verify that association before binding it. `--scope` is a stable
operator-chosen ID; an actual Plytix account ID is a useful component. Domain and
account ID are descriptive metadata, never proof of membership.

Set the private environment configuration:

```dotenv
MCP_KNOWLEDGE_CONFIG=C:/private/plytix-knowledge/config.json
MCP_KNOWLEDGE_WRITE_TOOLS='["knowledge_propose"]'
```

Use the path actually created, or choose the private destination with `--config`
during setup. Restart the server to load the path and tool allowlist. Registry
contents are reloaded on each knowledge operation, so subsequent binding removal
and learning-mode changes also apply to existing stdio sessions.

Seed the dictionary by calling `catalog_dictionary` without a query, using
`page_size: 100` and increasing `page` while the upstream pagination indicates
more results. This is explicit, bounded discovery, not a startup scan. Ordinary
`attributes_search`, `attributes_get` and `catalog_dictionary` calls then refresh
the encountered schema automatically when `--learn` is enabled.

## Sharing with colleagues

Use the same registry/storage on a shared server, or the same local filesystem
volume for processes on one machine. For each colleague, supply their existing
credentials through a private environment and run:

```powershell
npm run knowledge:admin -- bind --scope "business/account-identifier" --member "colleague-name" --contributor --config "C:/private/plytix-knowledge/config.json"
```

Omit `--contributor` for read access only. Binding is an explicit grant to read all
knowledge in that workspace, including schema observed by its other members.
Only bind people whose intended shared visibility matches that scope. This is
not a substitute for per-product Plytix permissions. Use separate workspaces for
groups that must not share metadata or definitions.

The registry stores a SHA-256 fingerprint of the credential pair and upstream
endpoint identities, never the credentials themselves. Treat the registry as
private authorization configuration. At runtime the server both matches that
binding and authenticates the supplied credentials before returning shared data.
A changed password, endpoint, or API key needs a new binding. A matching key with
the wrong password cannot reuse another member's knowledge.

An MCP caller cannot select a workspace by supplying an ID, domain, path or header.
HTTP uses the existing per-request Plytix credentials. Existing HTTP service-token
and host/origin controls continue to apply. Connections sharing one API credential
pair share one member identity; individual audit attribution requires distinct
bindings/credentials.

To revoke a member or pause automatic observations:

```powershell
npm run knowledge:admin -- unbind --member "colleague-name" --config "C:/private/plytix-knowledge/config.json"
npm run knowledge:admin -- learning --scope "business/account-identifier" --mode off --config "C:/private/plytix-knowledge/config.json"
```

Member names should be unique across the registry: `unbind` removes every binding
with that member name. Removing membership does not delete their earlier
contributions.

## Learning and reviewing meanings

Automatic learning stores only structural attribute metadata: labels, IDs, names,
types, groups and bounded options, with observation time and contributor. It
does not store product values, search transcripts or credentials. A later partial
schema read does not refresh the timestamp on previously observed fields that
were not returned. Unseen attributes are not declared deleted. Type changes are
flagged with `previous_type`; confirmed business definitions are never rewritten.

Business meanings use a separate lifecycle:

1. A contributor calls `knowledge_propose` with a term, aliases, meaning,
   attribute labels, optional family IDs and supporting evidence.
2. The tool must be separately allowlisted and the host must approve the exact
   arguments. The saved status is always `proposed`. This never changes Plytix.
3. An operator inspects proposals using the local administration command and
   explicitly confirms or rejects one.
4. Confirmed definitions participate in normal dictionary search. Corrections
   are new proposals; retire the old confirmed definition before confirming an
   overlapping replacement. Retired/rejected records remain available to the
   administrator as history.

```powershell
npm run knowledge:admin -- list --scope "business/account-identifier"
npm run knowledge:admin -- review --scope "business/account-identifier" --id "<proposal-uuid>" --status confirmed --reviewer "catalog-owner" --note "Checked against our specification" --revision 12
```

Use the current revision from `list`. If knowledge changes during review, the
command refuses the outdated revision. Overlapping terms/aliases cannot be
confirmed silently; definitions scoped to distinct families may coexist.
Review occurs through local operator access, not a model-supplied `approved`
field. Filesystem permissions protect administrative authority.

For clients without approval support, an operator can submit a definition JSON
file through `propose --scope ID --member NAME --file PATH` and then review it.
The file accepts `term`, `aliases`, `meaning`, `attribute_labels`, `family_ids`
and `evidence`. It cannot set its own status or reviewer.

Standalone HTTP still has no trusted approval provider, so it cannot submit
proposals through MCP until embedded with one. Automatic schema learning remains
available when explicitly enabled. This release does not make HTTP write approval
or multi-user login automatic.

## Result contract

Successful registered tool calls return:

```json
{
  "structuredContent": {
    "data": {},
    "metadata": {
      "schema_version": 1,
      "tool": "catalog_dictionary",
      "generated_at": "2026-10-20T12:00:00.000Z",
      "status": "ok",
      "source": "mixed",
      "freshness": "mixed",
      "sources": [],
      "coverage": "not_asserted",
      "warnings": []
    }
  }
}
```

The actual `data` is the existing tool result, including arrays where applicable.
The first text block preserves the previous payload; a second compact text block
exposes the same metadata for clients that only consume text. An `outputSchema`
declares the envelope and metadata contract. Existing tool-specific data shapes
remain unchanged. SDK validation failures/unknown tools are protocol responses
outside this application wrapper.

`generated_at` is response generation time. Each `sources` entry has the time
its evidence was observed. `live`, `cached`, `mixed`, `not_applicable`, and
`not_asserted` describe freshness; they do not promise a transactional snapshot.
Cached attribute definitions preserve their observation timestamps. Product
identifier lookup no longer retains matches across calls.

`coverage` is asserted only when the underlying tool establishes it; pagination
and samples otherwise remain explicitly unasserted or partial. `status: ok`
means the tool returned successfully, not that a mutation was verified or a whole
catalog was inspected. Tool-specific mutation acceptance/readback fields still
govern verification. Errors carry `isError`, an error code and a conservative
retry hint. Successful schema learning adds `learning` with saved observation
count and revision; a storage failure produces a warning without discarding a
successful API read.

## Storage and packaging

The registry and `data/` directory are outside source and excluded from the npm
package. The initial backend uses bounded validated JSON snapshots, restrictive
file creation modes, exclusive writer locks and atomic replacement. Concurrent
processes on the same supported local volume serialize updates. Keep the directory
private using host ACLs; POSIX file modes alone do not configure Windows ACLs.
Filesystem encryption and backups are operator responsibilities.

Back up the registry and data directory together. Stop writers before moving,
restoring or manually maintaining the files. A stale `.lock` is never stolen:
after a crash, verify no writer is active before removing it. Corrupt or oversized
files fail closed rather than being reset.

This is a single-volume backend, not a distributed database. Independent machines
with separate copies do not synchronize. Ephemeral Cloud Run/container storage
will not preserve knowledge across replacement and must not be used for durable
sharing. Do not assume network/object-store mounts provide local atomic-lock
semantics. Before a horizontally scaled hosted release, implement the
`KnowledgeStore` interface using a transactional durable backend and preserve the
same tenant authorization boundary.

`npm pack` produces an installable package containing the built server and admin
command, README, this guide and MIT license. `private: true` continues to block
accidental registry publication; publishing or deploying is a separate action.
No database, cloud service, permissions, credentials, or business workspace is
provisioned by this code release.
