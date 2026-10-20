/**
 * Read-only schema discovery and bounded product-value profiling.
 * Results describe API evidence, not inferred business meaning or channel usage.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import type { PlytixSearchFilter, PlytixProduct } from '../types.js';
import { stripAttributesPrefix } from '../utils/attribute-labels.js';
import { registerTool } from './register.js';
import { filterSchema } from '../utils/search-schema.js';

const ATTRIBUTE_FIELDS = ['name', 'label', 'type_class', 'groups', 'options', 'attributes'];
const json = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (action: string, error: unknown) => ({
  content: [{ type: 'text', text: `Error ${action}: ${error instanceof Error ? error.message : 'Request failed'}` }],
  isError: true,
});

/** Presence is an observational metric, not Plytix's completeness calculation. */
export function hasObservedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function getValue(product: PlytixProduct, label: string): unknown {
  if (Object.prototype.hasOwnProperty.call(product, `attributes.${label}`)) {
    return product[`attributes.${label}`];
  }
  return product.attributes?.[label];
}

function preview(value: unknown): unknown {
  // Bound potentially large text/media values while making truncation explicit.
  const encoded = JSON.stringify(value);
  return encoded.length <= 500 ? value : { preview: encoded.slice(0, 500), truncated: true };
}

export function registerSchemaTools(server: McpServer, client: PlytixClient) {
  registerTool<{
    query?: string; type_class?: string; group_id?: string;
    page: number; page_size: number; include_options: boolean;
  }>(server, 'attributes_search', {
    title: 'Search Attribute Schema',
    description: 'Search attribute names/labels, types, and groups. Returns completeness component definitions and allowed options; does not infer business purpose.',
    inputSchema: {
      query: z.string().min(1).optional().describe('Text contained in the attribute name or label'),
      type_class: z.string().min(1).optional().describe('Exact API type, e.g. CompletenessAttribute or DropdownAttribute'),
      group_id: z.string().min(1).optional().describe('Attribute group ID from attribute_groups_search'),
      page: z.number().int().positive().default(1),
      page_size: z.number().int().positive().max(100).default(25),
      include_options: z.boolean().default(true),
    },
  }, async ({ query, type_class, group_id, page, page_size, include_options }) => {
    try {
      const conditions: PlytixSearchFilter[] = [];
      if (type_class) conditions.push({ field: 'type_class', operator: 'eq', value: type_class });
      if (group_id) conditions.push({ field: 'groups', operator: 'in', value: [group_id] });
      // Plytix uses OR between groups and AND between conditions in each group.
      const filters = query
        ? ['name', 'label'].map(field => [...conditions, { field, operator: 'like' as const, value: query }])
        : conditions.length ? [conditions] : [];
      const result = await client.searchAttributes({
        filters, attributes: ATTRIBUTE_FIELDS.filter(field => include_options || field !== 'options'),
        pagination: { page, page_size },
      });
      return json({
        attributes: result.data,
        pagination: result.pagination,
        returned_count: result.data.length,
        source: 'Plytix product attribute schema',
        notes: [
          'CompletenessAttribute.attributes lists the component attributes; a null component id identifies a system attribute.',
          'Names, labels, groups, and returned descriptions are evidence for purpose. Formula/channel references are not discovered by this endpoint.',
        ],
      });
    } catch (error) { return failure('searching attribute schema', error); }
  });

  registerTool<{ query?: string; page: number; page_size: number }>(
    server, 'attribute_groups_search', {
      title: 'Search Attribute Groups',
      description: 'Search attribute groups with their order and member attribute labels.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Text contained in the group name'),
        page: z.number().int().positive().default(1),
        page_size: z.number().int().positive().max(100).default(25),
      },
    }, async ({ query, page, page_size }) => {
      try {
        const result = await client.searchAttributeGroups({
          filters: query ? [[{ field: 'name', operator: 'like', value: query }]] : [],
          attributes: ['name', 'order', 'attribute_labels'],
          pagination: { page, page_size, order: 'order' },
        });
        return json({ groups: result.data, pagination: result.pagination, returned_count: result.data.length });
      } catch (error) { return failure('searching attribute groups', error); }
    }
  );

  registerTool<{
    attribute_labels: string[]; filters?: PlytixSearchFilter[][]; max_products: number;
  }>(server, 'attributes_profile_usage', {
    title: 'Profile Attribute Values',
    description: 'Inspect a bounded sample of product attribute values, presence, types, and observed option usage. Does not establish channel/formula references, business purpose, or inheritance.',
    inputSchema: {
      attribute_labels: z.array(z.string().min(1)).min(1).max(10)
        .describe('Custom attribute labels, optionally prefixed with attributes.'),
      filters: z.array(z.array(filterSchema)).optional()
        .describe('Optional product filters using keys/operators from products_filters'),
      max_products: z.number().int().positive().max(500).default(100)
        .describe('Maximum products inspected; at most five pages'),
    },
  }, async ({ attribute_labels, filters, max_products }) => {
    try {
      const labels = [...new Set(attribute_labels.map(stripAttributesPrefix))];
      if (labels.some(label => !label)) throw new Error('Attribute labels cannot be empty');
      const metadata = await Promise.all(labels.map(label => client.getAttributeByLabel(label)));
      const missing = labels.filter((_label, index) => !metadata[index]);
      if (missing.length) throw new Error(`Attributes not found: ${missing.join(', ')}`);
      const products: PlytixProduct[] = [];
      const seenIds = new Set<string>();
      const pageSize = Math.min(100, max_products);
      let pages = 0;
      let complete = false;
      let stopReason = 'product_limit';
      let reportedTotal: number | null = null;
      let duplicateCount = 0;
      let discardedRows = 0;
      while (pages < Math.ceil(max_products / pageSize)) {
        const result = await client.searchProducts({
          filters: filters ?? [], attributes: labels.map(label => `attributes.${label}`),
          pagination: { page: pages + 1, page_size: pageSize },
        });
        pages++;
        const pagination = result.pagination as unknown as Record<string, unknown> | undefined;
        // Plytix count is the matching result total; total_count can include
        // every account record before filters are applied.
        const total = pagination?.count ?? pagination?.total_count ?? pagination?.total;
        if (typeof total === 'number' && Number.isFinite(total)) reportedTotal = total;
        const rows = result.data ?? [];
        let added = 0;
        for (const product of rows) {
          if (seenIds.has(product.id)) { duplicateCount++; continue; }
          if (products.length >= max_products) { discardedRows++; continue; }
          seenIds.add(product.id); products.push(product); added++;
        }
        if (!duplicateCount && !discardedRows &&
          (reportedTotal !== null ? products.length === reportedTotal : rows.length < pageSize)) {
          complete = true; stopReason = 'end_of_results'; break;
        }
        if (rows.length && !added) { stopReason = 'repeated_page'; break; }
        if (products.length >= max_products) break;
        if (rows.length < pageSize) { stopReason = 'short_page_inconsistent_total'; break; }
        stopReason = 'page_limit';
      }
      const profiles = labels.map((label, index) => {
        const attribute = metadata[index]!;
        const options = Array.isArray(attribute.options) ? attribute.options : null;
        const observedOptions = new Set<string>();
        const unexpectedOptions = new Set<string>();
        const types: Record<string, number> = {};
        const examples: Array<{ product_id: string; sku?: string; value: unknown }> = [];
        let populated = 0;
        for (const product of products) {
          const value = getValue(product, label);
          if (!hasObservedValue(value)) continue;
          populated++;
          const type = Array.isArray(value) ? 'array' : typeof value;
          types[type] = (types[type] ?? 0) + 1;
          if (examples.length < 5) examples.push({ product_id: product.id, sku: product.sku, value: preview(value) });
          if (options) {
            for (const option of Array.isArray(value) ? value : [value]) {
              if (typeof option === 'string') {
                if (options.includes(option)) observedOptions.add(option);
                else unexpectedOptions.add(option);
              }
            }
          }
        }
        return {
          label, search_key: `attributes.${label}`, name: attribute.name, type_class: attribute.type_class,
          groups: attribute.groups,
          inspected_products: products.length, populated_products: populated,
          empty_or_absent_products: products.length - populated,
          populated_percent: products.length ? Math.round(populated / products.length * 10000) / 100 : null,
          observed_value_types: types, examples,
          ...(options ? {
            allowed_options: options, observed_options: [...observedOptions],
            options_not_observed_in_sample: options.filter(option => !observedOptions.has(option)),
            unexpected_observed_options: [...unexpectedOptions],
          } : {}),
        };
      });
      return json({
        profiles,
        scope: {
          filters: filters ?? [], requested_max_products: max_products,
          inspected_products: products.length, pages_fetched: pages, api_reported_total: reportedTotal,
          complete_for_query: complete, stop_reason: stopReason, duplicate_rows_ignored: duplicateCount,
          rows_not_inspected_due_to_limit: discardedRows,
        },
        limitations: [
          'This is a sequential sample, not a random sample or a consistent snapshot. Products can change while pages are fetched.',
          'A value is present unless it is null, missing, blank text, an empty array, or an empty object. Zero and false are present.',
          'These presence counts are not Plytix completeness scores. Not observed does not mean unused across the catalog, channels, or formulas.',
          'Values alone do not establish business purpose or whether a value was inherited or overridden.',
        ],
      });
    } catch (error) { return failure('profiling attribute values', error); }
  });
}
