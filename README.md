# Plytix MCP

MCP tools for interactive Plytix product QA, schema discovery, assets, families,
variants and relationships. Complements existing synchronization systems.

Node/TypeScript provides one shared implementation for stdio and stateless
Streamable HTTP. Read tools are enabled by default. Mutation tools are hidden and
the API client rejects writes until explicitly enabled.

## Local development

Use Node 24 LTS (Node 22 is also tested).

```powershell
npm ci --ignore-scripts
npm run test:all
```

The checks use fixtures and local processes/listeners. They do not need a Plytix
account or make live Plytix requests. Build before running `npm test` directly:
the stdio smoke test launches the built entry point.

For authorized local read-only use, copy `.env.example` to `.env` and enter your
existing approved credentials locally. Do not paste them in chat or arguments.

```powershell
npm run build
npm run start:stdio
# Or loopback HTTP on 127.0.0.1:8080:
npm start
```

For stdio, configure an MCP client with `node` and the absolute path to
`dist/index.js`; provide `PLYTIX_API_KEY` and `PLYTIX_API_PASSWORD` through its
private environment configuration. HTTP uses `/mcp` and requires
`X-Plytix-API-Key` and `X-Plytix-API-Password` on every request. HTTP never falls
back to server-held Plytix credentials. `GET /health` checks the listener only.

The official SDK client is tested over both transports. Actual Codex and hosted
AI-client setup remains to be verified with approved credentials; no client
connection or OAuth grant has been configured by this change.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `PLYTIX_API_KEY`, `PLYTIX_API_PASSWORD` | Required by stdio; HTTP uses request headers |
| `PLYTIX_WRITE_TOOLS` | JSON array, default `[]`; exact mutation tool names only |
| `HOST`, `PORT` | Local `127.0.0.1:8080`; Cloud Run/container `0.0.0.0:$PORT` |
| `MCP_AUTH_TOKEN` | Independent service secret; at least 32 characters, required for remote HTTP or any HTTP writes |
| `MCP_ALLOWED_HOSTS` | Exact comma-separated hostnames without ports; defaults to loopback names |
| `MCP_ALLOWED_ORIGINS` | Exact comma-separated browser origins; defaults to none |
| `PLYTIX_API_BASE`, `PLYTIX_AUTH_URL` | Operator-only HTTPS overrides; official Plytix endpoints by default |
| `PLYTIX_SEARCH_FIELDS` | JSON array; defaults to `sku`, `label`, `gtin` |
| `PLYTIX_MPN_LABELS`, `PLYTIX_MNO_LABELS` | JSON arrays for account-specific attribute labels |

Remote requests supply the independent secret in `X-MCP-Token`. Raw Plytix
credentials in `Authorization: Bearer key:password` are not accepted.
`Authorization` remains available for Cloud Run IAM/OIDC authentication.
Local loopback reads may omit the service token. Origins, when present, must be
explicitly allowed even on loopback. Host checks ignore forwarded host headers.

Writes require an explicit reviewed allowlist such as
`["products_update"]`; this is configuration syntax, not approval to enable it.
See [security and limitations](docs/security.md) before enabling any mutation.

## Container and Cloud Run

```powershell
docker build -t plytix-mcp:local .
```

The image runs as the non-root `node` user. Starting a remote/container listener
without a separately supplied service token fails closed. No credentials are
baked into the image. See [deployment readiness](docs/deployment.md) and the
[unrendered manifest](deploy/cloud-run.template.yaml) for approvals, cost choices
and private-client compatibility. Nothing deploys automatically.

Run `node scripts/container-smoke.mjs` after building to repeat the fixture-only
resource and protocol check. See [validation evidence](docs/validation.md).

## Migration

The Cloudflare entry point, request caches, deployment configuration, duplicate
client/lookup implementation and credential-dependent live test scripts were
removed. The SDK exposes all 44 former Worker tool names when all writes are
explicitly enabled, plus three local identifier primitives. API endpoint and
payload helpers remain shared with stdio. Default visibility deliberately changes
to read-only. SDK validation now applies equally to HTTP and stdio.

No legacy SSE endpoint, durable session, database, background worker or
organization-specific extension is included. Historical API notes are retained in
`docs/solutions/api-quirks/`; they are snapshots, not a current live verification.

## License

MIT. The original copyright and permission notice are preserved in [LICENSE](LICENSE).
