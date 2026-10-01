import { describe, expect, it } from 'vitest';
import { completeOrder } from '../../src/domain/order.js';
import type { OrderSnapshot, OrderStatus } from '../../src/domain/types.js';

const order = (status: OrderStatus): OrderSnapshot => ({
  id: 'order-1',
  status,
  totalMinor: 2500,
  currency: 'GBP',
});

describe('completeOrder', () => {
  it('completes a paid order', () => {
    expect(completeOrder(order('Paid'))).toEqual({ ok: true, status: 'Completed', changed: true });
  });

  it('is idempotent for an already completed order', () => {
    expect(completeOrder(order('Completed'))).toEqual({ ok: true, status: 'Completed', changed: false });
  });

  it.each<OrderStatus>(['AwaitingPayment', 'Cancelled'])('refuses to complete an order that is %s', (status) => {
    expect(completeOrder(order(status))).toEqual({ ok: false, error: 'ORDER_NOT_PAID', status });
  });
});
