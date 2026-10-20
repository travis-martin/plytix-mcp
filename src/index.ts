#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlytixClient } from './client.js';
import { createServer } from './server.js';
import { parseWriteTools } from './policy.js';
import { elicitWriteApproval } from './tools/register.js';

async function main() {
  const writes = parseWriteTools(process.env.PLYTIX_WRITE_TOOLS);
  const client = new PlytixClient({ allowWrites: writes.size > 0, writeTools: writes });
  await createServer(client, writes, { requestWriteApproval: elicitWriteApproval }).connect(new StdioServerTransport());
}
main().catch(() => {
  console.error('Plytix MCP startup failed; check local configuration');
  process.exitCode = 1;
});
