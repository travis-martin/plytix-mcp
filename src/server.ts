import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PlytixClient } from './client.js';
import { configureToolPolicy, type ToolPolicyOptions } from './tools/register.js';
import { registerProductTools } from './tools/products.js';
import { registerFamilyTools } from './tools/families.js';
import { registerAttributeTools } from './tools/attributes.js';
import { registerAssetTools } from './tools/assets.js';
import { registerCategoryTools } from './tools/categories.js';
import { registerVariantTools } from './tools/variants.js';
import { registerIdentifierTools } from './tools/identifier.js';
import { registerProductAttributeTools } from './tools/product-attributes.js';
import { registerRelationshipTools } from './tools/relationships.js';
import { registerCapabilityTools } from './tools/capabilities.js';
import { registerSchemaTools } from './tools/schema.js';
import { registerInheritanceTools } from './tools/inheritance.js';

export function createServer(
  client: PlytixClient, writeTools: ReadonlySet<string> = new Set(), options: ToolPolicyOptions = {},
) {
  const server = new McpServer({ name: 'plytix-mcp', version: '0.4.0' });
  configureToolPolicy(server, writeTools, client, options);
  registerProductTools(server, client);
  registerFamilyTools(server, client);
  registerAttributeTools(server, client);
  registerAssetTools(server, client);
  registerCategoryTools(server, client);
  registerVariantTools(server, client);
  registerProductAttributeTools(server, client);
  registerRelationshipTools(server, client);
  registerIdentifierTools(server);
  registerCapabilityTools(server);
  registerSchemaTools(server, client);
  registerInheritanceTools(server, client);
  return server;
}
