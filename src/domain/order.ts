import type { OrderSnapshot, OrderStatus } from './types.js';

export type CompleteOrderResult =
  | { ok: true; status: OrderStatus; changed: boolean }
  | { ok: false; error: 'ORDER_NOT_PAID'; status: OrderStatus };

/** Hands a paid order to fulfilment. Idempotent: completing a Completed order is a no-op. */
export function completeOrder(order: OrderSnapshot): CompleteOrderResult {
  switch (order.status) {
    case 'Paid':
      return { ok: true, status: 'Completed', changed: true };
    case 'Completed':
      return { ok: true, status: 'Completed', changed: false };
    case 'AwaitingPayment':
    case 'Cancelled':
      return { ok: false, error: 'ORDER_NOT_PAID', status: order.status };
  }
}
