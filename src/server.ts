import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PlytixClient } from './client.js';
import { configureToolPolicy } from './tools/register.js';
import { registerProductTools } from './tools/products.js';
import { registerFamilyTools } from './tools/families.js';
import { registerAttributeTools } from './tools/attributes.js';
import { registerAssetTools } from './tools/assets.js';
import { registerCategoryTools } from './tools/categories.js';
import { registerVariantTools } from './tools/variants.js';
import { registerIdentifierTools } from './tools/identifier.js';
import { registerProductAttributeTools } from './tools/product-attributes.js';
import { registerRelationshipTools } from './tools/relationships.js';

export function createServer(client: PlytixClient, writeTools: ReadonlySet<string> = new Set()) {
  const server = new McpServer({ name: 'plytix-mcp', version: '0.3.0' });
  configureToolPolicy(server, writeTools, client);
  registerProductTools(server, client);
  registerFamilyTools(server, client);
  registerAttributeTools(server, client);
  registerAssetTools(server, client);
  registerCategoryTools(server, client);
  registerVariantTools(server, client);
  registerProductAttributeTools(server, client);
  registerRelationshipTools(server, client);
  registerIdentifierTools(server);
  return server;
}
