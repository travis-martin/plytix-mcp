#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlytixClient } from './client.js';
import { createServer } from './server.js';
import { parseWriteTools, parseKnowledgeWriteTools } from './policy.js';
import { elicitWriteApproval } from './tools/register.js';
import { KnowledgeRegistry } from './knowledge/registry.js';

async function main() {
  const writes = parseWriteTools(process.env.PLYTIX_WRITE_TOOLS);
  const client = new PlytixClient({ allowWrites: writes.size > 0, writeTools: writes });
  await createServer(client, writes, {
    requestWriteApproval: elicitWriteApproval,
    knowledgeWriteTools: parseKnowledgeWriteTools(process.env.MCP_KNOWLEDGE_WRITE_TOOLS),
    knowledgeRegistry: process.env.MCP_KNOWLEDGE_CONFIG ? new KnowledgeRegistry(process.env.MCP_KNOWLEDGE_CONFIG) : undefined,
  }).connect(new StdioServerTransport());
}
main().catch(() => {
  console.error('Plytix MCP startup failed; check local configuration');
  process.exitCode = 1;
});
