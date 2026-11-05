/** Guarded option maintenance: explicit additions, exact ordering, and unused-value removal. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlytixClient } from '../client.js';
import { PlytixError, type PlytixAttributeDetail } from '../types.js';
import { registerTool } from './register.js';

const optionList = z.array(z.string().min(1)).max(1000)
  .refine(values => new Set(values).size === values.length, 'Option values must be unique');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const preservedFields = ['id', 'label', 'name', 'description', 'type_class', 'restricted', 'sort_ascending', 'groups'] as const;
const json = (data: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], ...(isError ? { isError } : {}),
});

export function registerAttributeOptionTools(server: McpServer, client: PlytixClient) {
  registerTool<{
    attribute_id: string; expected_label: string; expected_modified: string;
    expected_options: string[]; options: string[]; add_options: string[];
  }>(server, 'attributes_update_options', {
    title: 'Maintain Attribute Options',
    description: 'Set manual order for dropdown/multiselect options, add explicitly listed values, and remove only values unused by every product. Requires the exact current option list (which may be empty), label and modified timestamp. Every new value must match add_options exactly. Rejects undeclared additions, stale definitions, incomplete usage evidence and in-use removals; never changes existing product values. Rechecks before one PATCH and verifies readback. No atomic concurrency guarantee; do not run alongside imports or other writers.',
    inputSchema: {
      attribute_id: z.string().min(1),
      expected_label: z.string().min(1).describe('Exact current custom attribute label'),
      expected_modified: z.string().min(1).describe('Current attribute modified timestamp from attributes_get'),
      expected_options: optionList.describe('Complete current option list in its current order'),
      options: optionList.refine(values => values.length > 0, 'At least one final option is required')
        .describe('Complete final list in desired manual order, preserving existing value text'),
      add_options: optionList.default([]).describe('Exact new values explicitly approved for addition; must equal the new values in options'),
    },
  }, async args => {
    let writeAttempted = false;
    try {
      const before = await client.getAttributeById(args.attribute_id, true);
      if (!before || before.id !== args.attribute_id || before.label !== args.expected_label) {
        throw new PlytixError('Attribute identity does not match the reviewed definition');
      }
      if (!['DropdownAttribute', 'MultiSelectAttribute'].includes(before.type_class)) {
        throw new PlytixError('Only dropdown and multiselect option definitions are supported');
      }
      if (before.modified !== args.expected_modified || !same(before.options, args.expected_options)) {
        throw new PlytixError('Attribute definition changed; read and review the current options again');
      }
      const existing = new Set(args.expected_options);
      const added = args.options.filter(value => !existing.has(value));
      const declaredAdditions = new Set(args.add_options);
      if (added.length !== declaredAdditions.size || added.some(value => !declaredAdditions.has(value))) {
        throw new PlytixError('New option values must exactly match the explicitly reviewed add_options list');
      }
      const kept = new Set(args.options);
      const removed = args.expected_options.filter(value => !kept.has(value));
      if (removed.length) {
        const usage = await client.searchProducts({
          filters: [[{ field: `attributes.${before.label}`, operator: 'in', value: removed }]],
          attributes: ['sku', `attributes.${before.label}`], pagination: { page: 1, page_size: 1 },
        });
        // count is the filtered total; total_count may be the whole catalog.
        if (usage.pagination?.count !== 0 || !Array.isArray(usage.data) || usage.data.length !== 0) {
          throw new PlytixError('Removal blocked: options are in use or a complete zero-usage result was not returned');
        }
      }
      const current = await client.getAttributeById(args.attribute_id, true);
      const unchanged = (attribute: PlytixAttributeDetail | null) => attribute !== null &&
        [...preservedFields, 'modified', 'options', 'manual_sorting'].every(field => same(attribute[field], before[field]));
      if (!unchanged(current)) throw new PlytixError('Attribute changed during preflight; no update was attempted');
      if (same(before.options, args.options) && before.manual_sorting === true) {
        return json({ success: true, changed: false, verified: true, attribute: current, removed_options: [], added_options: [] });
      }
      writeAttempted = true;
      await client.updateAttributeOptions(args.attribute_id, args.options);
      const after = await client.getAttributeById(args.attribute_id, true);
      if (!after || !same(after.options, args.options) || after.manual_sorting !== true ||
          preservedFields.some(field => !same(after[field], before[field]))) {
        throw new PlytixError('The write was attempted but saved options or preserved settings did not match; inspect the live attribute before any further write');
      }
      return json({ success: true, changed: true, verified: true, attribute: after,
        previous_options: before.options, removed_options: removed, added_options: added,
        removal_usage_check: removed.length ? 'zero_products' : 'not_needed',
        concurrency: 'Preflight checks are not an atomic lock against other catalog writers.' });
    } catch (error) {
      return json({ success: false, verified: false, write_attempted: writeAttempted,
        requires_inspection: writeAttempted,
        message: error instanceof PlytixError ? error.message : 'Attribute option cleanup failed',
      }, true);
    }
  });
}
