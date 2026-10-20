import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlytixClient } from '../client.js';
import { createServer } from '../server.js';
import type { PlytixFamilyAttribute, PlytixProduct } from '../types.js';

afterEach(() => vi.restoreAllMocks());

async function inspect(
  products: Record<string, PlytixProduct | Error>, args: Record<string, unknown> = {},
  forbiddenFamily = false, familyRows?: PlytixFamilyAttribute[],
) {
  const api = new PlytixClient({ apiKey: 'fixture', apiPassword: 'fixture' });
  const get = vi.spyOn(api, 'getProduct').mockImplementation(async id => {
    if (products[id] instanceof Error) throw products[id];
    return { data: products[id] ? [products[id] as PlytixProduct] : [] };
  });
  const family = vi.spyOn(api, 'getFamilyAllAttributes').mockImplementation(async () => {
    if (forbiddenFamily) throw new Error('Plytix API request failed (HTTP 403)');
    return { data: familyRows ?? [{ id: 'color-id', label: 'color', name: 'Color', attribute_level: 'parent_level' }] };
  });
  const server = createServer(api);
  const client = new Client({ name: 'inheritance-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({
      name: 'products_inspect_inheritance',
      arguments: { product_id: 'child', attribute_labels: ['attributes.color'], ...args },
    });
    const text = (response.content as Array<{ text: string }>)[0].text;
    expect(response.isError, text).not.toBe(true);
    return { result: JSON.parse(text), get, family };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('product inheritance evidence', () => {
  it('retains parent, variant and sub-variant values without inferring origin from equality', async () => {
    const { result, family } = await inspect({
      child: {
        id: 'child', _parent_id: 'variant', product_type: 'SUB_VARIANT', product_level: 3,
        product_family_id: 'family', overwritten_attributes: ['attributes.color'], attributes: { color: 'red' },
      },
      variant: {
        id: 'variant', _parent_id: 'parent', product_type: 'VARIANT', product_level: 2,
        product_family_id: 'family', overwritten_attributes: [], attributes: { color: 'red' },
      },
      parent: {
        id: 'parent', product_type: 'PARENT', product_level: 1,
        product_family_id: 'family', attributes: { color: 'red' },
      },
    });
    expect(family).toHaveBeenCalledTimes(1);
    expect(result.ancestry.map((level: any) => level.product_type)).toEqual(['SUB_VARIANT', 'VARIANT', 'PARENT']);
    expect(result.ancestry_status).toMatchObject({ complete: true, stop_reason: 'root_product' });
    expect(result.attributes[0]).toMatchObject({ value_origin: 'not_inferred', reported_product_value: { status: 'reported', value: 'red' } });
    expect(result.attributes[0].levels.map((level: any) => level.override_marker)).toEqual([
      'overwritten', 'not_marked_overwritten', 'unavailable',
    ]);
    expect(result.attributes[0].levels[0].family_attribute.attribute_level).toBe('parent_level');
  });

  it('bounds ancestry and reports a pending parent instead of claiming a complete tree', async () => {
    const { result, get } = await inspect({
      child: { id: 'child', _parent_id: 'variant', product_type: 'SUB_VARIANT' },
      variant: { id: 'variant', _parent_id: 'parent', product_type: 'VARIANT' },
      parent: { id: 'parent', product_type: 'PARENT' },
    }, { max_depth: 2 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.ancestry_status).toMatchObject({ complete: false, stop_reason: 'depth_limit', next_parent_id: 'parent' });
    expect(result.partial).toBe(true);
  });

  it('terminates cycles without refetching products', async () => {
    const { result, get } = await inspect({
      child: { id: 'child', _parent_id: 'variant', product_type: 'VARIANT' },
      variant: { id: 'variant', _parent_id: 'child', product_type: 'VARIANT' },
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.ancestry_status).toMatchObject({ complete: false, stop_reason: 'cycle_detected' });
  });

  it('retains the requested product if an ancestor or family configuration is forbidden', async () => {
    const { result } = await inspect({
      child: {
        id: 'child', _parent_id: 'parent', product_type: 'VARIANT',
        product_family_id: 'family', attributes: { color: false },
      },
      parent: new Error('Plytix API request failed (HTTP 403)'),
    }, {}, true);
    expect(result.partial).toBe(true);
    expect(result.ancestry_status).toMatchObject({ complete: false, stop_reason: 'ancestor_unavailable' });
    expect(result.attributes[0].reported_product_value).toEqual({ status: 'reported', value: false });
    expect(result.attributes[0].levels[0].family_attribute_status).toBe('unavailable');
    expect(result.errors.map((error: any) => error.section)).toEqual(['ancestor_product', 'family_attributes']);
  });

  it('keeps a missing parent pointer unknown on variants and distinguishes omitted values from false', async () => {
    const { result } = await inspect({
      child: { id: 'child', product_type: 'VARIANT', attributes: { color: false } },
    }, { attribute_labels: ['color', 'missing'] });
    expect(result.ancestry_status).toMatchObject({ complete: false, stop_reason: 'parent_not_reported' });
    expect(result.attributes[0].reported_product_value).toEqual({ status: 'reported', value: false });
    expect(result.attributes[1].reported_product_value).toEqual({ status: 'not_returned' });
  });

  it('does not confuse custom and system attributes that share a label', async () => {
    const { result } = await inspect({
      child: { id: 'child', product_type: 'PARENT', product_family_id: 'family', attributes: { label: 'Custom label' } },
    }, { attribute_labels: ['label'] }, false, [
      { label: 'label', name: 'System label', attribute_level: 'no_level' },
      { id: 'custom-label-id', label: 'label', name: 'Custom label', attribute_level: 'parent_level' },
    ]);
    expect(result.attributes[0].levels[0].family_attribute.id).toBe('custom-label-id');
    expect(result.attributes[0].levels[0].same_label_system_attributes[0].attribute_level).toBe('no_level');
  });

  it('does not treat numeric product level as proof of a root when the product is a variant', async () => {
    const { result } = await inspect({
      child: { id: 'child', product_type: 'VARIANT', product_level: 1, product_family_id: 'family' },
    });
    expect(result.ancestry_status).toMatchObject({ complete: false, stop_reason: 'parent_not_reported' });
    expect(result.partial).toBe(true);
  });
});
