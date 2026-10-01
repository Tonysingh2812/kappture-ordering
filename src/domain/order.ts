import type { OrderSnapshot, OrderStatus } from './types.ts';

export interface NewOrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

/** Currencies we accept. An assumption for this exercise; a real venue would configure its own. */
export const supportedCurrencies: readonly string[] = ['GBP', 'EUR', 'USD'];

export type ValidateNewOrderResult =
  | { isOk: true; totalMinor: number }
  | { isOk: false; error: 'INVALID_ORDER'; problems: string[] };

/** Checks the business invariants of a new order and computes its total on the server (never trust a client total). */
export function validateNewOrder(items: NewOrderItem[], currency: string): ValidateNewOrderResult {
  const problems: string[] = [];

  if (!supportedCurrencies.includes(currency)) {
    problems.push(`Currency ${currency} is not supported (expected one of ${supportedCurrencies.join(', ')})`);
  }
  if (items.length === 0) {
    problems.push('An order must contain at least one item');
  }

  items.forEach((item, index) => {
    const label = `items[${index}]`;
    if (item.sku.trim() === '') problems.push(`${label}.sku must not be blank`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      problems.push(`${label}.quantity must be a whole number of at least 1`);
    }
    if (!Number.isInteger(item.unitPriceMinor) || item.unitPriceMinor < 0) {
      problems.push(`${label}.unitPriceMinor must be a whole number of minor units, at least 0`);
    }
  });

  if (problems.length > 0) return { isOk: false, error: 'INVALID_ORDER', problems };

  const totalMinor = items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) {
    return { isOk: false, error: 'INVALID_ORDER', problems: ['Order total is too large'] };
  }

  return { isOk: true, totalMinor };
}

export type CompleteOrderResult =
  | { isOk: true; status: OrderStatus; hasChanged: boolean }
  | { isOk: false; error: 'ORDER_NOT_PAID'; status: OrderStatus };

/** Hands a paid order to fulfilment. Idempotent: completing a Completed order is a no-op. */
export function completeOrder(order: OrderSnapshot): CompleteOrderResult {
  switch (order.status) {
    case 'Paid':
      return { isOk: true, status: 'Completed', hasChanged: true };
    case 'Completed':
      return { isOk: true, status: 'Completed', hasChanged: false };
    case 'AwaitingPayment':
    case 'Cancelled':
      return { isOk: false, error: 'ORDER_NOT_PAID', status: order.status };
  }
}
