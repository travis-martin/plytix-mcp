/**
 * Asset Tools
 *
 * Tools for listing assets linked to products.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import type { PlytixSearchBody } from '../types.js';
import { PlytixError } from '../types.js';
import { registerTool } from './register.js';
import { filterSchema } from '../utils/search-schema.js';

export function registerAssetTools(server: McpServer, client: PlytixClient) {
  // GET single asset by ID
  registerTool<{ asset_id: string }>(
    server,
    'assets_get',
    {
      title: 'Get Asset',
      description: 'Get an asset with its available metadata, categories, usage counts, URLs, and alt text.',
      inputSchema: {
        asset_id: z.string().min(1).describe('The asset ID'),
      },
    },
    async ({ asset_id }) => {
      try {
        const result = await client.getAsset(asset_id);
        const asset = result.data?.[0];

        if (!asset) {
          return {
            content: [{ type: 'text', text: `Asset not found: ${asset_id}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(asset, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // SEARCH assets
  registerTool<{
    attributes?: string[];
    filters?: PlytixSearchBody['filters'];
    pagination?: { page?: number; page_size?: number; order?: string };
    sort?: unknown;
  }>(
    server,
    'assets_search',
    {
      title: 'Search Assets',
      description: 'Search assets and select metadata fields. Use assets_filters to discover valid fields and operators.',
      inputSchema: {
        attributes: z.array(z.string().min(1)).max(50).optional()
          .describe('Metadata fields to return, such as filename, alt_text, categories, url, content_type, file_size, or n_products.'),
        filters: z
          .array(z.array(filterSchema))
          .optional()
          .describe('Search filters in Plytix OR-of-ANDs format'),
        pagination: z
          .object({
            page: z.number().int().positive().optional(),
            page_size: z.number().int().positive().max(100).optional(),
            order: z.string().optional(),
          })
          .optional()
          .describe('Pagination options'),
        sort: z.unknown().optional().describe('Optional sort payload'),
      },
    },
    async ({ attributes, filters, pagination, sort }) => {
      try {
        const result = await client.searchAssets({
          ...(attributes !== undefined ? { attributes } : {}),
          ...(filters !== undefined ? { filters } : {}),
          ...(pagination !== undefined ? { pagination } : {}),
          ...(sort !== undefined ? { sort } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  assets: result.data,
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
              text: `Error searching assets: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  registerTool<{ query?: string; pagination?: { page?: number; page_size?: number; order?: string } }>(
    server,
    'asset_categories_search',
    {
      title: 'Search Asset Categories',
      description: 'Find asset categories with hierarchy details. If category settings are forbidden, returns only accessible category IDs from asset filters, with explicit limitations.',
      inputSchema: {
        query: z.string().optional().describe('Optional category name contains filter'),
        pagination: z.object({
          page: z.number().int().positive().optional(),
          page_size: z.number().int().positive().max(100).optional(),
          order: z.string().optional().describe('Field to sort by; prefix with - for descending'),
        }).optional(),
      },
    },
    async ({ query, pagination }) => {
      try {
        const result = await client.searchAssetCategories({
          attributes: ['name', 'path', 'parents_ids', 'n_children', 'order'],
          filters: query ? [[{ field: 'name', operator: 'like', value: query }]] : [],
          pagination,
        });
        return { content: [{ type: 'text', text: JSON.stringify({
          categories: result.data,
          pagination: result.pagination,
        }, null, 2) }] };
      } catch (error) {
        if (error instanceof PlytixError && error.status === 403) {
          const errors = [{ section: 'asset_categories', message: error.message }];
          try {
            const filters = await client.getAssetFilters();
            const categoryFilter = filters.data.find(filter => (filter.key ?? filter.field) === 'categories');
            if (!Array.isArray(categoryFilter?.options)) {
              throw new Error('Asset filters did not provide category ID options');
            }
            const options = categoryFilter.options;
            const stringIds = options.filter((option): option is string =>
              typeof option === 'string' && option.trim().length > 0);
            if (options.length > 0 && stringIds.length === 0) {
              throw new Error('Asset filters did not provide supported category ID options');
            }
            const ids = [...new Set(stringIds)];
            const page = pagination?.page ?? 1;
            const pageSize = pagination?.page_size ?? 25;
            const start = (page - 1) * pageSize;
            const availableIds = ids.slice(start, start + pageSize);
            return { content: [{ type: 'text', text: JSON.stringify({
              categories: null,
              partial: true,
              _retrieval: {
                source: 'assets_filters',
                reason: 'Asset category search returned HTTP 403. Category names and hierarchy are unavailable with this connection.',
              },
              fallback_scope: 'Category IDs exposed as asset filter options only; this does not establish a complete category hierarchy.',
              requested_query: query ?? null,
              query_applied: false,
              requested_order: pagination?.order ?? null,
              order_applied: false,
              available_category_ids: availableIds,
              available_category_ids_pagination: {
                page,
                page_size: pageSize,
                count: availableIds.length,
                total_count: ids.length,
                has_more: start + pageSize < ids.length,
                truncated: availableIds.length < ids.length,
              },
              ignored_filter_options: options.length - stringIds.length,
              errors,
            }, null, 2) }] };
          } catch (fallbackError) {
            errors.push({
              section: 'assets_filters',
              message: fallbackError instanceof Error ? fallbackError.message : 'Request failed',
            });
            return {
              content: [{ type: 'text', text: JSON.stringify({
                categories: null,
                available_category_ids: null,
                partial: true,
                errors,
              }, null, 2) }],
              isError: true,
            };
          }
        }
        return {
          content: [{ type: 'text', text: `Error searching asset categories: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // UPDATE documented writable asset metadata.
  registerTool<{ asset_id: string; filename?: string; categories?: string[]; alt_text?: string }>(
    server,
    'assets_update',
    {
      title: 'Update Asset',
      description: 'Update asset filename, categories, or alternative text. Filename extensions cannot be changed.',
      inputSchema: {
        asset_id: z.string().min(1).describe('The asset ID'),
        filename: z.string().optional().describe('New filename for the asset'),
        categories: z.array(z.string()).optional().describe('Category IDs to assign to the asset'),
        alt_text: z.string().max(512).optional().describe('Alternative description, up to 512 characters. Empty string clears it.'),
      },
    },
    async ({ asset_id, filename, categories, alt_text }) => {
      try {
        if (filename === undefined && categories === undefined && alt_text === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error updating asset: provide at least one of filename, categories, or alt_text',
              },
            ],
            isError: true,
          };
        }

        await client.updateAsset(asset_id, {
          ...(filename !== undefined ? { filename } : {}),
          ...(categories !== undefined ? { categories } : {}),
          ...(alt_text !== undefined ? { alt_text } : {}),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  action: 'updated',
                  asset_id,
                  ...(filename !== undefined ? { filename } : {}),
                  ...(categories !== undefined ? { categories } : {}),
                  ...(alt_text !== undefined ? { alt_text } : {}),
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
              text: `Error updating asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // LIST product assets
  registerTool<{ product_id: string }>(
    server,
    'assets_list',
    {
      title: 'List Assets',
      description: 'List assets linked to a product.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID to fetch assets for'),
      },
    },
    async ({ product_id }) => {
      try {
        const result = await client.getProductAssets(product_id);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error fetching assets: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // LINK asset to product
  registerTool<{ product_id: string; asset_id: string; attribute_label: string }>(
    server,
    'assets_link',
    {
      title: 'Link Asset',
      description: 'Link an asset to an existing product media attribute or thumbnail. Replaces a single-media value; appends to a gallery.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        asset_id: z.string().min(1).describe('The asset ID to link'),
        attribute_label: z
          .string()
          .min(1)
          .describe('Required media attribute label or thumbnail'),
      },
    },
    async ({ product_id, asset_id, attribute_label }) => {
      try {
        const result = await client.linkProductAsset(product_id, asset_id, attribute_label);
        const linked = result.data?.[0];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  asset: linked ? { id: linked.id, name: linked.name, url: linked.url } : { id: asset_id },
                  ...(attribute_label ? { attribute_label } : {}),
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
              text: `Error linking asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // UNLINK asset from product
  registerTool<{ product_id: string; asset_id: string }>(
    server,
    'assets_unlink',
    {
      title: 'Unlink Asset',
      description: 'Unlink an asset from a product.',
      inputSchema: {
        product_id: z.string().min(1).describe('The product ID'),
        asset_id: z.string().min(1).describe('The asset ID to unlink'),
      },
    },
    async ({ product_id, asset_id }) => {
      try {
        await client.unlinkProductAsset(product_id, asset_id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  product_id,
                  asset_id,
                  action: 'unlinked',
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
              text: `Error unlinking asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
