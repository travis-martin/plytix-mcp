import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PlytixSearchBody } from '../types.js';
import type { PlytixClient } from '../client.js';
import { PlytixLookup } from '../lookup/lookup.js';

describe('PlytixLookup MPN/MNO label fallbacks', () => {
  const originalMpnLabels = process.env.PLYTIX_MPN_LABELS;
  const originalMnoLabels = process.env.PLYTIX_MNO_LABELS;

  afterEach(() => {
    if (originalMpnLabels === undefined) {
      delete process.env.PLYTIX_MPN_LABELS;
    } else {
      process.env.PLYTIX_MPN_LABELS = originalMpnLabels;
    }

    if (originalMnoLabels === undefined) {
      delete process.env.PLYTIX_MNO_LABELS;
    } else {
      process.env.PLYTIX_MNO_LABELS = originalMnoLabels;
    }
  });

  it('uses default MPN labels when searchFields exclude attributes', async () => {
    delete process.env.PLYTIX_MPN_LABELS;
    delete process.env.PLYTIX_MNO_LABELS;

    const searchCalls: PlytixSearchBody[] = [];
    const client = {
      searchProducts: vi.fn(async (body: PlytixSearchBody) => {
        searchCalls.push(body);
        return { data: [] };
      }),
    } as unknown as PlytixClient;

    const lookup = new PlytixLookup(client, {
      searchFields: ['sku', 'label', 'gtin'],
      cacheEnabled: false,
    });

    await lookup.findByIdentifier('ABC-123', 'mpn', 5);

    const hasMpnFilter = searchCalls.some((body) =>
      body.filters?.some((group) => group.some((filter) => filter.field === 'attributes.mpn'))
    );

    expect(hasMpnFilter).toBe(true);
  });
});

describe('lookup fallback and ambiguity handling', () => {
  it('matches any configured field in the broad fallback', async () => {
    const searchProducts = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: 'p', sku: 'SHEET-1', label: 'Unrelated', gtin: '12345678' }] });
    const lookup = new PlytixLookup({ searchProducts } as unknown as PlytixClient, {
      searchFields: ['sku', 'label', 'gtin'], cacheEnabled: false,
    });

    const result = await lookup.findByIdentifier('SHEET-1', 'sku');
    expect(searchProducts.mock.calls[2][0].filters).toEqual([
      [{ field: 'sku', operator: 'like', value: 'SHEET' }],
      [{ field: 'label', operator: 'like', value: 'SHEET' }],
      [{ field: 'gtin', operator: 'like', value: 'SHEET' }],
    ]);
    expect(result.selected?.id).toBe('p');
  });

  it('keeps the strongest match for a repeated product instead of creating ambiguity', async () => {
    const searchProducts = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'p', sku: 'ABC-SUFFIX' }] })
      .mockResolvedValueOnce({ data: [{ id: 'p', sku: 'ABC', attributes: { alternate_mpn: 'ABC' } }] });
    const lookup = new PlytixLookup({ searchProducts } as unknown as PlytixClient, {
      searchFields: ['sku'], mpnLabels: ['mpn', 'alternate_mpn'], cacheEnabled: false,
    });

    const result = await lookup.findByIdentifier('ABC', 'mpn');
    expect(searchProducts).toHaveBeenCalledTimes(2);
    expect(result.matches).toHaveLength(1);
    expect(result.selected).toMatchObject({
      id: 'p', confidence: 1, matchedField: 'attributes.alternate_mpn_eq',
    });
  });

  it('preserves ambiguity between different products after deduplicating repeated matches', async () => {
    const rows = [{ id: 'p', sku: 'ABC-1' }, { id: 'q', sku: 'ABC-2' }];
    const searchProducts = vi.fn().mockResolvedValue({ data: rows });
    const lookup = new PlytixLookup({ searchProducts } as unknown as PlytixClient, {
      searchFields: ['sku'], mpnLabels: ['mpn', 'alternate_mpn'], cacheEnabled: false,
    });

    const result = await lookup.findByIdentifier('ABC', 'mpn');
    expect(result.matches.map(match => match.id)).toEqual(['p', 'q']);
    expect(result.selected).toBeUndefined();
  });
});
