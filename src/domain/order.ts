import type { OrderSnapshot, OrderStatus } from './types.ts';

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
