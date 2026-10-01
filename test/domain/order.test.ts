import { describe, expect, it } from 'vitest';
import { completeOrder } from '../../src/domain/order.ts';
import type { OrderSnapshot, OrderStatus } from '../../src/domain/types.ts';

const order = (status: OrderStatus): OrderSnapshot => ({
  id: 'order-1',
  status,
  totalMinor: 2500,
  currency: 'GBP',
});

describe('completeOrder', () => {
  it('completes a paid order', () => {
    expect(completeOrder(order('Paid'))).toEqual({ isOk: true, status: 'Completed', hasChanged: true });
  });

  it('is idempotent for an already completed order', () => {
    expect(completeOrder(order('Completed'))).toEqual({ isOk: true, status: 'Completed', hasChanged: false });
  });

  it.each<OrderStatus>(['AwaitingPayment', 'Cancelled'])('refuses to complete an order that is %s', (status) => {
    expect(completeOrder(order(status))).toEqual({ isOk: false, error: 'ORDER_NOT_PAID', status });
  });
});
