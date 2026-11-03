#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlytixClient } from './client.js';
import { createServer } from './server.js';
import { parseWriteTools, parseKnowledgeWriteTools, parseWriteApprovalMode } from './policy.js';
import { elicitWriteApproval } from './tools/register.js';
import { KnowledgeRegistry } from './knowledge/registry.js';

async function main() {
  const writes = parseWriteTools(process.env.PLYTIX_WRITE_TOOLS);
  const writeApprovalMode = parseWriteApprovalMode(process.env.MCP_WRITE_APPROVAL_MODE);
  const client = new PlytixClient({ allowWrites: writes.size > 0, writeTools: writes });
  await createServer(client, writes, {
    writeApprovalMode,
    requestWriteApproval: writeApprovalMode === 'form' ? elicitWriteApproval : undefined,
    knowledgeWriteTools: parseKnowledgeWriteTools(process.env.MCP_KNOWLEDGE_WRITE_TOOLS),
    knowledgeRegistry: process.env.MCP_KNOWLEDGE_CONFIG ? new KnowledgeRegistry(process.env.MCP_KNOWLEDGE_CONFIG) : undefined,
  }).connect(new StdioServerTransport());
}
main().catch(() => {
  console.error('Plytix MCP startup failed; check local configuration');
  process.exitCode = 1;
});
