import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';

export function registerCapabilityTools(server: McpServer) {
  registerTool<Record<string, never>>(server, 'server_capabilities', {
    title: 'Plytix API Capabilities',
    description: 'Explain supported data discovery, API version choices, public API gaps, and write approval requirements.',
    inputSchema: {},
  }, async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        documentation: 'https://apidocs.plytix.com/',
        reviewed_on: '2026-10-20',
        versions: {
          products: 'v2, documented by Plytix as an open beta',
          variant_listing: 'v1; no GET variants route is documented for v2',
          schema_and_assets: 'v1',
          strategy: 'Use documented versions per operation; a higher version number does not imply a stable release.',
        },
        discovery: [
          'Product values, parent IDs, overwritten attributes, relationships, categories, and assets',
          'Attribute labels, display names, types, groups, allowed options, filter operators, and completeness members',
          'Family attributes and inheritance levels',
          'Product and asset category paths, parents, and ordering',
          'Asset metadata and alt_text where returned by the API',
        ],
        limitations: {
          channels: 'The public API reference does not document channel configuration, formulas, mapping, processing, or export endpoints.',
          product_lists: 'No product-list management endpoint is documented. Product records may expose static_list_ids; product filters may expose list options. Dynamic list definitions are not documented.',
          attribute_purpose: 'Use names, groups, completeness membership, family assignments, and actual values as evidence. Business purpose is not guaranteed by the public attribute schema.',
          completeness: 'The API exposes CompletenessAttribute member definitions and product values. A completeness percentage alone is not evidence of business quality.',
          inheritance: 'Family levels describe inheritance configuration; product overwritten_attributes describes exceptions. Equal values alone do not establish inheritance.',
          asset_metadata: 'GET asset returns available metadata. The documented mutable fields are filename, categories, and alt_text (maximum 512 characters).',
        },
        write_safety: {
          default: 'Read-only. Write tools are hidden unless explicitly allowlisted.',
          enforcement: 'Tool allowlist and API-layer write authorization apply to stdio and HTTP.',
          approval: 'Every write requires approval of the exact arguments through a trusted host approval provider. The stdio host uses MCP form elicitation; unsupported clients fail closed. A tool argument is not proof of human approval.',
          live_verification: 'Automated tests use mocks. Live writes and deployment require exact action-time approval.',
        },
      }, null, 2),
    }],
  }));
}
