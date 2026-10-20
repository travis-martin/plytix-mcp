/**
 * Product Family Tools
 *
 * Tools for listing and retrieving product families and their attributes.
 * Useful for understanding product-level inheritance settings and attribute assignments.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { registerTool } from './register.js';
import { stripAttributesPrefix } from '../utils/attribute-labels.js';

async function resolveAttributeIds(client: PlytixClient, labels: string[]) {
  const normalized = [...new Set(labels.map(stripAttributesPrefix))];
  if (normalized.some(label => !label)) throw new Error('Attribute labels cannot be empty');
  const ids: string[] = [];
  for (const label of normalized) {
    const attribute = await client.getAttributeByLabel(label);
    if (!attribute?.id) throw new Error(`Attribute not found: ${label}`);
    ids.push(attribute.id);
  }
  return { labels: normalized, ids };
}

export function registerFamilyTools(server: McpServer, client: PlytixClient) {
  // ─────────────────────────────────────────────────────────────
  // families.list - Search/list product families
  // ─────────────────────────────────────────────────────────────

  registerTool<{ query?: string; page: number; page_size: number }>(
    server,
    'families_list',
    {
      title: 'List Product Families',
      description: 'List product families.',
      inputSchema: {
        query: z.string().optional().describe('Search query to filter families by name'),
        page: z.number().int().positive().default(1).describe('Page number'),
        page_size: z.number().int().positive().max(100).default(25).describe('Results per page'),
      },
    },
    async ({ query, page, page_size }) => {
      try {
        const body: Record<string, unknown> = {
          filters: [],
          attributes: ['name', 'total_products', 'total_attributes', 'total_models', '_created_at', 'modified'],
          pagination: { page, page_size },
        };

        if (query) {
          body.filters = [[{ field: 'name', operator: 'like', value: query }]];
        }

        const result = await client.searchFamilies(body);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  families: result.data,
                  pagination: result.pagination,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing families: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families.get - Get single family with details
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string }>(
    server,
    'families_get',
    {
      title: 'Get Product Family',
      description: 'Get one product family.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      try {
        const result = await client.getFamily(family_id);

        if (!result.data?.[0]) {
          return {
            content: [{ type: 'text', text: `Family not found: ${family_id}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result.data[0], null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_create - Create a product family
  // ─────────────────────────────────────────────────────────────

  registerTool<{ name: string; parent_id?: string }>(
    server,
    'families_create',
    {
      title: 'Create Product Family',
      description: 'Create a product family.',
      inputSchema: {
        name: z.string().min(1).describe('Name for the new family'),
        parent_id: z.never().optional().describe('Unsupported legacy argument; families do not have parent families'),
      },
    },
    async ({ name, parent_id }) => {
      try {
        if (parent_id !== undefined) throw new Error('parent_id is unsupported: product families do not have parent families');
        const result = await client.createFamily({ name });
        const family = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  accepted: true,
                  action: family?.id ? 'created' : 'create_requested',
                  verified: Boolean(family?.id),
                  family: family ? { id: family.id, name: family.name } : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error creating family: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_link_attribute - Link one or more attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string; attribute_labels: string[] }>(
    server,
    'families_link_attribute',
    {
      title: 'Link Attributes to Family',
      description: 'Link attributes to a family.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
        attribute_labels: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Attribute labels to link to the family'),
      },
    },
    async ({ family_id, attribute_labels }) => {
      try {
        const resolved = await resolveAttributeIds(client, attribute_labels);
        await client.linkFamilyAttributes(family_id, resolved.ids);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  accepted: true,
                  action: 'link_requested',
                  family_id,
                  attribute_labels: resolved.labels,
                  attribute_ids: resolved.ids,
                  count: resolved.ids.length,
                  verified: false,
                  verification: 'The API accepts this operation asynchronously. Read family attributes again to verify the final state.',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error linking family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_unlink_attribute - Unlink one or more attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string; attribute_labels: string[] }>(
    server,
    'families_unlink_attribute',
    {
      title: 'Unlink Attributes from Family',
      description: 'Unlink attributes from a family.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
        attribute_labels: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Attribute labels to unlink from the family'),
      },
    },
    async ({ family_id, attribute_labels }) => {
      try {
        const resolved = await resolveAttributeIds(client, attribute_labels);
        await client.unlinkFamilyAttributes(family_id, resolved.ids);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  accepted: true,
                  action: 'unlink_requested',
                  family_id,
                  attribute_labels: resolved.labels,
                  attribute_ids: resolved.ids,
                  count: resolved.ids.length,
                  verified: false,
                  verification: 'The API accepts this operation asynchronously. Read family attributes again to verify the final state.',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error unlinking family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_list_attributes - Custom family attributes and their inheritance settings
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string }>(
    server,
    'families_list_attributes',
    {
      title: 'List Family Attributes',
      description: 'List custom attributes assigned to a family and their API inheritance settings (parent_level, variant_level, no_level).',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      try {
        const result = await client.getFamilyAttributes(family_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  family_id,
                  attributes: result.data,
                  count: result.data?.length ?? 0,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // families_list_all_attributes - Custom + system family attributes
  // ─────────────────────────────────────────────────────────────

  registerTool<{ family_id: string }>(
    server,
    'families_list_all_attributes',
    {
      title: 'List All Family Attributes',
      description: 'List custom and system family attributes with product-level inheritance settings. This is not a parent-family ancestry traversal.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      try {
        const result = await client.getFamilyAllAttributes(family_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  family_id,
                  attributes: result.data,
                  count: result.data?.length ?? 0,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing all family attributes: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  registerTool<{ family_id: string }>(
    server,
    'families_inspect',
    {
      title: 'Inspect Family Schema and Inheritance',
      description: 'Combine family metadata with custom and system attribute inheritance settings. Reports unavailable sections explicitly.',
      inputSchema: {
        family_id: z.string().min(1).describe('The product family ID'),
      },
    },
    async ({ family_id }) => {
      const [family, custom, all] = await Promise.allSettled([
        client.getFamily(family_id),
        client.getFamilyAttributes(family_id),
        client.getFamilyAllAttributes(family_id),
      ]);
      const sections = { family, custom_attributes: custom, all_attributes: all };
      const errors = Object.entries(sections).flatMap(([section, result]) =>
        result.status === 'rejected'
          ? [{ section, message: result.reason instanceof Error ? result.reason.message : 'Request failed' }]
          : []
      );
      const output = {
        family_id,
        family: family.status === 'fulfilled' ? family.value.data?.[0] ?? null : null,
        custom_attributes: custom.status === 'fulfilled' ? custom.value.data : null,
        all_attributes: all.status === 'fulfilled' ? all.value.data : null,
        section_status: Object.fromEntries(Object.entries(sections).map(([section, result]) => [
          section, result.status === 'fulfilled' ? 'available' : 'unavailable',
        ])),
        inheritance_notes: [
          'Family attributes describe inheritance between product levels, not a hierarchy of parent families.',
          'parent_level means Level 1 inheritance, variant_level means Level 2 inheritance, and no_level means inheritance is off.',
          'all_attributes includes system attributes. Preserve the API configuration as returned; actual product overrides require product data.',
        ],
        partial: errors.length > 0,
        ...(errors.length ? { errors } : {}),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        ...(errors.length === 3 ? { isError: true } : {}),
      };
    }
  );
}
