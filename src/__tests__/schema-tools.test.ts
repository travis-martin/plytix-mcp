import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import { hasObservedValue } from '../tools/schema.js';

afterEach(() => vi.restoreAllMocks());

async function withTools(
  run: (api: PlytixClient, call: (name: string, args?: Record<string, unknown>) => Promise<any>) => Promise<void>,
  writeNames: string[] = [],
) {
  const writeTools = new Set(writeNames);
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture', allowWrites: Boolean(writeNames.length), writeTools });
  const server = createServer(api, writeTools, { requestWriteApproval: async () => true });
  const client = new Client({ name: 'schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(api, async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(result.isError, text).not.toBe(true);
      return JSON.parse(text);
    });
  } finally {
    await client.close();
    await server.close();
  }
}

const attribute = { id: 'field', label: 'field', name: 'Field', type_class: 'TextAttribute' };

describe('schema discovery', () => {
  it('retains completeness members and normalizes the custom-attribute prefix', async () => {
    await withTools(async (api, call) => {
      const lookup = vi.spyOn(api, 'getAttributeByLabel').mockResolvedValue({
        ...attribute, type_class: 'CompletenessAttribute',
        attributes: [{ id: null, label: 'sku' }, { id: 'title-id', label: 'title' }],
        description: 'Required export content',
      });
      const result = await call('attributes_get', { label: 'attributes.field' });
      expect(lookup).toHaveBeenCalledWith('field');
      expect(result.attributes).toEqual([{ id: null, label: 'sku' }, { id: 'title-id', label: 'title' }]);
      expect(result.description).toBe('Required export content');
      expect(result.search_key).toBe('attributes.field');
    });
  });

  it('searches schema with explicit supported fields and retains completeness definitions', async () => {
    await withTools(async (api, call) => {
      const search = vi.spyOn(api, 'searchAttributes').mockResolvedValue({
        data: [{ ...attribute, type_class: 'CompletenessAttribute', attributes: [{ id: null, label: 'sku' }] }],
      });
      const result = await call('attributes_search', {
        query: 'complete', type_class: 'CompletenessAttribute', group_id: 'group', include_options: false,
      });
      expect(search).toHaveBeenCalledWith({
        filters: ['name', 'label'].map(field => [
          { field: 'type_class', operator: 'eq', value: 'CompletenessAttribute' },
          { field: 'groups', operator: 'in', value: ['group'] },
          { field, operator: 'like', value: 'complete' },
        ]),
        attributes: ['name', 'label', 'type_class', 'groups', 'attributes'],
        pagination: { page: 1, page_size: 25 },
      });
      expect(result.attributes[0].attributes).toEqual([{ id: null, label: 'sku' }]);
    });
  });

  it('requests member labels and order when searching groups', async () => {
    await withTools(async (api, call) => {
      const search = vi.spyOn(api, 'searchAttributeGroups').mockResolvedValue({
        data: [{ id: 'group', name: 'Dimensions', order: 0, attribute_labels: ['length', 'width'] }],
      });
      const result = await call('attribute_groups_search', { query: 'Dimensions' });
      expect(search).toHaveBeenCalledWith({
        filters: [[{ field: 'name', operator: 'like', value: 'Dimensions' }]],
        attributes: ['name', 'order', 'attribute_labels'],
        pagination: { page: 1, page_size: 25, order: 'order' },
      });
      expect(result.groups[0].attribute_labels).toEqual(['length', 'width']);
    });
  });

  it('keeps family inheritance evidence available when family metadata is forbidden', async () => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'getFamily').mockRejectedValue(new Error('Plytix API request failed (HTTP 403)'));
      vi.spyOn(api, 'getFamilyAttributes').mockResolvedValue({
        data: [{ label: 'field', name: 'Field', attribute_level: 'variant_level' }],
      });
      vi.spyOn(api, 'getFamilyAllAttributes').mockResolvedValue({
        data: [{ label: 'field', name: 'Field', attribute_level: 'variant_level' }, { label: 'sku', name: 'SKU', attribute_level: 'no_level' }],
      });
      const result = await call('families_inspect', { family_id: 'family' });
      expect(result.partial).toBe(true);
      expect(result.family).toBeNull();
      expect(result.custom_attributes[0].attribute_level).toBe('variant_level');
      expect(result.all_attributes[1].label).toBe('sku');
      expect(result.section_status.family).toBe('unavailable');
      expect(result.errors).toEqual([{ section: 'family', message: 'Plytix API request failed (HTTP 403)' }]);
    });
  });

  it('requests useful family metadata rather than just IDs', async () => {
    await withTools(async (api, call) => {
      const search = vi.spyOn(api, 'searchFamilies').mockResolvedValue({ data: [] });
      await call('families_list');
      expect(search.mock.calls[0][0]).toMatchObject({
        filters: [],
        attributes: ['name', 'total_products', 'total_attributes', 'total_models', '_created_at', 'modified'],
      });
    });
  });
});

describe('bounded attribute value profiling', () => {
  it('treats zero and false as present and distinguishes blank values', () => {
    expect([0, false, 'value', ['value'], { value: false }].every(hasObservedValue)).toBe(true);
    expect([null, undefined, '', '  ', [], {}].some(hasObservedValue)).toBe(false);
  });

  it('reports allowed and observed options separately and marks a complete small query', async () => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'getAttributeByLabel').mockResolvedValue({
        ...attribute, type_class: 'DropdownAttribute', options: ['red', 'green', 'blue'],
      });
      const search = vi.spyOn(api, 'searchProducts').mockResolvedValue({
        data: [
          { id: 'one', attributes: { field: 'red' } },
          { id: 'two', 'attributes.field': 'yellow' },
          { id: 'three', attributes: { field: '' } },
        ],
        pagination: { page: 1, page_size: 100, count: 3, total_count: 3 },
      });
      const result = await call('attributes_profile_usage', { attribute_labels: ['attributes.field'] });
      expect(search).toHaveBeenCalledWith({
        filters: [], attributes: ['attributes.field'], pagination: { page: 1, page_size: 100 },
      });
      expect(result.profiles[0]).toMatchObject({
        populated_products: 2, empty_or_absent_products: 1, populated_percent: 66.67,
        observed_options: ['red'], options_not_observed_in_sample: ['green', 'blue'],
        unexpected_observed_options: ['yellow'],
      });
      expect(result.scope.complete_for_query).toBe(true);
    });
  });

  it('does not claim a complete scan when a partial final page exceeds the requested limit', async () => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'getAttributeByLabel').mockResolvedValue(attribute);
      const rows = Array.from({ length: 175 }, (_, i) => ({ id: String(i), attributes: { field: 0 } }));
      const search = vi.spyOn(api, 'searchProducts')
        .mockResolvedValueOnce({ data: rows.slice(0, 100) })
        .mockResolvedValueOnce({ data: rows.slice(100) });
      const result = await call('attributes_profile_usage', { attribute_labels: ['field'], max_products: 150 });
      expect(search).toHaveBeenCalledTimes(2);
      expect(result.scope).toMatchObject({
        complete_for_query: false, inspected_products: 150, rows_not_inspected_due_to_limit: 25,
      });
      expect(result.profiles[0].populated_products).toBe(150);
    });
  });

  it('uses the matching count instead of the account total for filtered query coverage', async () => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'getAttributeByLabel').mockResolvedValue(attribute);
      vi.spyOn(api, 'searchProducts').mockResolvedValue({
        data: [{ id: 'one', attributes: { field: 0 } }, { id: 'two', attributes: { field: false } }],
        pagination: { page: 1, page_size: 2, count: 2, total_count: 82 },
      });
      const result = await call('attributes_profile_usage', {
        attribute_labels: ['field'], filters: [[{ field: 'status', operator: 'eq', value: 'Completed' }]], max_products: 2,
      });
      expect(result.scope).toMatchObject({ api_reported_total: 2, inspected_products: 2, complete_for_query: true });
    });
  });

  it('stops repeated pages without presenting duplicate rows as coverage', async () => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'getAttributeByLabel').mockResolvedValue(attribute);
      const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), attributes: { field: false } }));
      const search = vi.spyOn(api, 'searchProducts').mockResolvedValue({ data: rows });
      const result = await call('attributes_profile_usage', { attribute_labels: ['field'], max_products: 300 });
      expect(search).toHaveBeenCalledTimes(2);
      expect(result.scope).toMatchObject({
        complete_for_query: false, inspected_products: 100, stop_reason: 'repeated_page', duplicate_rows_ignored: 100,
      });
    });
  });
});

describe('family write payload corrections', () => {
  it.each([
    ['families_link_attribute', 'linkFamilyAttributes', 'link_requested'],
    ['families_unlink_attribute', 'unlinkFamilyAttributes', 'unlink_requested'],
  ] as const)('resolves labels to IDs and distinguishes acceptance for %s', async (tool, method, action) => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'getAttributeByLabel').mockImplementation(async label => ({ ...attribute, id: `${label}-id`, label }));
      const write = vi.spyOn(api, method).mockResolvedValue({ data: [] });
      const result = await call(tool, { family_id: 'family', attribute_labels: ['attributes.color', 'size'] });
      expect(write).toHaveBeenCalledWith('family', ['color-id', 'size-id']);
      expect(result).toMatchObject({
        accepted: true, verified: false, action, attribute_labels: ['color', 'size'], attribute_ids: ['color-id', 'size-id'],
      });
    }, [tool]);
  });

  it('does not claim a created family without an ID in the API response', async () => {
    await withTools(async (api, call) => {
      vi.spyOn(api, 'createFamily').mockResolvedValue({ data: [] });
      const result = await call('families_create', { name: 'Fixture' });
      expect(result).toMatchObject({ accepted: true, verified: false, action: 'create_requested' });
      expect(result.family).toBeUndefined();
    }, ['families_create']);
  });
});
