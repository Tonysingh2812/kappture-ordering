import { describe, expect, it } from 'vitest';
import { validateNewOrder, type NewOrderItem } from '../../src/domain/order.ts';

const item = (overrides: Partial<NewOrderItem> = {}): NewOrderItem => ({
  sku: 'burger',
  name: 'Burger',
  quantity: 1,
  unitPriceMinor: 1250,
  ...overrides,
});

describe('validateNewOrder', () => {
  it('computes the total from the items', () => {
    const result = validateNewOrder([item({ quantity: 2 }), item({ sku: 'chips', unitPriceMinor: 350 })], 'GBP');

    expect(result).toEqual({ isOk: true, totalMinor: 2850 });
  });

  it('allows free items', () => {
    expect(validateNewOrder([item({ unitPriceMinor: 0 })], 'GBP')).toEqual({ isOk: true, totalMinor: 0 });
  });

  it.each<[string, NewOrderItem[], string]>([
    ['no items', [], 'GBP'],
    ['zero quantity', [item({ quantity: 0 })], 'GBP'],
    ['negative quantity', [item({ quantity: -1 })], 'GBP'],
    ['fractional quantity', [item({ quantity: 1.5 })], 'GBP'],
    ['negative price', [item({ unitPriceMinor: -1 })], 'GBP'],
    ['fractional price', [item({ unitPriceMinor: 9.99 })], 'GBP'],
    ['blank sku', [item({ sku: '  ' })], 'GBP'],
    ['unsupported currency', [item()], 'XYZ'],
    ['total beyond safe integer range', [item({ quantity: 2, unitPriceMinor: Number.MAX_SAFE_INTEGER })], 'GBP'],
  ])('rejects %s', (_label, items, currency) => {
    const result = validateNewOrder(items, currency);

    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toBe('INVALID_ORDER');
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('reports every problem, not just the first', () => {
    const result = validateNewOrder([item({ quantity: 0 }), item({ unitPriceMinor: -5 })], 'XYZ');

    expect(result).toMatchObject({ isOk: false });
    if (!result.isOk) expect(result.problems).toHaveLength(3);
  });
});
