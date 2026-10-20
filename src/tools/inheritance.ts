import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import type { PlytixFamilyAttribute, PlytixProduct } from '../types.js';
import { stripAttributesPrefix } from '../utils/attribute-labels.js';
import { registerTool } from './register.js';

function reportedValue(product: PlytixProduct, label: string) {
  const prefixed = `attributes.${label}`;
  if (Object.prototype.hasOwnProperty.call(product, prefixed)) {
    return { status: 'reported', value: product[prefixed] };
  }
  if (product.attributes && Object.prototype.hasOwnProperty.call(product.attributes, label)) {
    return { status: 'reported', value: product.attributes[label] };
  }
  return { status: 'not_returned' };
}

function overrideMarker(product: PlytixProduct, label: string) {
  if (!Array.isArray(product.overwritten_attributes)) return 'unavailable';
  return product.overwritten_attributes.some(item => typeof item === 'string' && stripAttributesPrefix(item) === label)
    ? 'overwritten' : 'not_marked_overwritten';
}

export function registerInheritanceTools(server: McpServer, client: PlytixClient) {
  registerTool<{ product_id: string; attribute_labels: string[]; max_depth: number }>(
    server, 'products_inspect_inheritance', {
      title: 'Inspect Product Attribute Inheritance',
      description: 'Inspect requested attribute values along a bounded parent-product chain, family inheritance levels, and explicit override markers. Reports incomplete ancestry/configuration and never infers value origin from equality.',
      inputSchema: {
        product_id: z.string().min(1).describe('Product ID to inspect'),
        attribute_labels: z.array(z.string().min(1)).min(1).max(20)
          .describe('Custom attribute labels to inspect, optionally prefixed with attributes.'),
        max_depth: z.number().int().positive().max(8).default(5)
          .describe('Maximum number of products in the ancestry chain, including the requested product'),
      },
    }, async ({ product_id, attribute_labels, max_depth }) => {
      try {
        const labels = [...new Set(attribute_labels.map(stripAttributesPrefix))];
        if (labels.some(label => !label)) throw new Error('Attribute labels cannot be empty');
        const products: PlytixProduct[] = [];
        const seen = new Set<string>();
        const errors: Array<{ section: string; id: string; message: string }> = [];
        let nextId: string | null = product_id;
        let stopReason = 'depth_limit';
        let ancestryComplete = false;
        while (nextId && products.length < max_depth) {
          if (seen.has(nextId)) { stopReason = 'cycle_detected'; break; }
          seen.add(nextId);
          let product: PlytixProduct | undefined;
          try {
            const result = await client.getProduct(nextId);
            product = result.data?.[0];
          } catch (error) {
            if (!products.length) throw error;
            errors.push({ section: 'ancestor_product', id: nextId, message: error instanceof Error ? error.message : 'Request failed' });
            stopReason = 'ancestor_unavailable';
            break;
          }
          if (!product) {
            if (!products.length) throw new Error(`Product not found: ${product_id}`);
            errors.push({ section: 'ancestor_product', id: nextId, message: 'No product returned by API' });
            stopReason = 'ancestor_not_found';
            break;
          }
          products.push(product);
          const parentId = product._parent_id;
          if (typeof parentId === 'string' && parentId.length > 0) {
            nextId = parentId;
            continue;
          }
          nextId = null;
          const rootLevel = product.product_type === 'PARENT' || product.product_type === 'STANDALONE'
            || product.product_type === 'SINGLE';
          ancestryComplete = rootLevel;
          stopReason = rootLevel ? 'root_product' : 'parent_not_reported';
        }
        if (nextId && seen.has(nextId) && products.length >= max_depth) stopReason = 'cycle_detected';
        const familyIds = [...new Set(products.flatMap(product =>
          typeof product.product_family_id === 'string' && product.product_family_id ? [product.product_family_id] : []
        ))];
        const familyAttributes = new Map<string, PlytixFamilyAttribute[]>();
        // Sequential requests keep this bounded even if every ancestor has a different family.
        for (const familyId of familyIds) {
          try {
            const result = await client.getFamilyAllAttributes(familyId);
            familyAttributes.set(familyId, result.data ?? []);
          } catch (error) {
            errors.push({ section: 'family_attributes', id: familyId, message: error instanceof Error ? error.message : 'Request failed' });
          }
        }
        const chain = products.map(product => ({
          product_id: product.id, sku: product.sku, product_type: product.product_type ?? null,
          product_level: product.product_level ?? null, parent_id: product._parent_id ?? null,
          family_id: product.product_family_id ?? null, family_model_id: product.product_family_model_id ?? null,
          overwritten_attributes: product.overwritten_attributes ?? null,
          family_configuration_available: Boolean(product.product_family_id && familyAttributes.has(product.product_family_id)),
        }));
        const attributes = labels.map(label => ({
          label,
          reported_product_value: reportedValue(products[0], label),
          levels: products.map(product => {
            const config = product.product_family_id ? familyAttributes.get(product.product_family_id) : undefined;
            // This tool accepts custom labels. System family rows have no ID;
            // never confuse a system row with a custom attribute of the same label.
            const matching = config?.filter(item => typeof item.label === 'string' && stripAttributesPrefix(item.label) === label) ?? [];
            const candidates = matching.filter(item => typeof item.id === 'string' && item.id.length > 0);
            const systemMatches = matching.filter(item => !item.id);
            const attribute = candidates.length === 1 ? candidates[0] : undefined;
            return {
              product_id: product.id,
              reported_value: reportedValue(product, label),
              override_marker: overrideMarker(product, label),
              family_attribute_status: config === undefined ? 'unavailable' : candidates.length > 1 ? 'ambiguous' : attribute ? 'reported' : 'not_returned',
              family_attribute: attribute ?? null,
              ...(candidates.length > 1 ? { family_attribute_candidates: candidates } : {}),
              ...(systemMatches.length > 0 ? { same_label_system_attributes: systemMatches } : {}),
            };
          }),
          value_origin: 'not_inferred',
        }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              product_id, attributes, ancestry: chain,
              ancestry_status: { complete: ancestryComplete, stop_reason: stopReason, max_depth, next_parent_id: nextId },
              partial: !ancestryComplete || errors.length > 0 || chain.some(level => !level.family_configuration_available)
                || attributes.some(attribute => attribute.levels.some(level => level.family_attribute_status === 'ambiguous')),
              errors,
              interpretation: [
                'Ancestry is ordered from the requested product to its parent products; these are product relationships, not parent families.',
                'Family attribute_level reports parent_level (Level 1), variant_level (Level 2), or no_level (off). Missing configuration is unknown.',
                'overwritten is an explicit API override marker. not_marked_overwritten does not by itself prove a value was inherited.',
                'Product values are exactly what the API returned. Empty attributes can be omitted. Matching values do not establish their origin.',
                'This inspection does not recalculate values or change inheritance. An ancestry/configuration error leaves the affected evidence unavailable.',
              ],
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `Error inspecting inheritance: ${error instanceof Error ? error.message : 'Request failed'}` }], isError: true };
      }
    }
  );
}
