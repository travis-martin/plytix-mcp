# Plytix MCP

MCP tools for interactive Plytix product QA, schema discovery, assets, families,
variants and relationships. Complements existing synchronization systems.

This development branch is converting the remote Cloudflare implementation to
Node/TypeScript for local testing and a private, scale-to-zero Cloud Run service.
Deployment and security instructions are in development. No deployment is automatic.

## Development

Use Node 22 or later. Install with `npm ci`, then `npm run build` and `npm test`.
Keep credentials in ignored local configuration; never commit them.
Live integration scripts must not run without explicit authorization.

## License

MIT. The original copyright and permission notice are preserved in [LICENSE](LICENSE).
