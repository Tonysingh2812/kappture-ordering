import type {
  OrderSnapshot,
  OrderStatus,
  PaymentEvent,
  PaymentEventDecision,
  PaymentEventType,
  PaymentSnapshot,
  PaymentStatus,
  ReviewFlag,
} from './types.ts';

const TARGET_STATUS: Record<PaymentEventType, PaymentStatus> = {
  PaymentAuthorised: 'Authorised',
  PaymentCaptured: 'Captured',
  PaymentFailed: 'Failed',
  PaymentCancelled: 'Cancelled',
};

/** Events that move money (or reserve it) must carry an amount we can match against. */
const REQUIRES_AMOUNT: ReadonlySet<PaymentEventType> = new Set(['PaymentAuthorised', 'PaymentCaptured']);

const isFailedOrCancelled = (s: PaymentStatus) => s === 'Failed' || s === 'Cancelled';

/**
 * Decides what a provider payment event means for a payment and its order.
 * Pure: no I/O, never throws for expected business cases.
 *
 * Policy (see README "Design decisions"):
 * - Payments only move forward: Initiated → Authorised → Captured. Backwards events are `stale`.
 * - Captured is the strongest fact (money moved). It is accepted from any payment state,
 *   provided the amount and currency match, and raises non-blocking review flags when unusual.
 * - Failed/Cancelled are terminal except that a later matching capture overrides them.
 */
export function applyPaymentEvent(
  order: OrderSnapshot,
  payment: PaymentSnapshot,
  event: PaymentEvent,
): PaymentEventDecision {
  const unchanged = (
    outcome: PaymentEventDecision['outcome'],
    reason: string,
    reviewFlags: ReviewFlag[] = [],
  ): PaymentEventDecision => ({
    outcome,
    paymentStatus: payment.status,
    orderStatus: order.status,
    reviewFlags,
    reason,
  });

  if (event.paymentId !== payment.id) {
    return unchanged('rejected', `Event is for payment ${event.paymentId}, not ${payment.id}`);
  }
  if (payment.orderId !== order.id) {
    return unchanged('rejected', `Payment ${payment.id} belongs to order ${payment.orderId}, not ${order.id}`);
  }

  const mismatch = describeAmountMismatch(payment, event);
  if (mismatch) {
    return unchanged('rejected', mismatch, [{ reason: 'AMOUNT_MISMATCH', details: mismatch }]);
  }

  const target = TARGET_STATUS[event.type];

  if (target === payment.status) {
    return unchanged('duplicate', `Payment already ${payment.status}`);
  }

  if (target === 'Captured') {
    return applyCapture(order, payment);
  }

  if (payment.status === 'Captured') {
    const reason = `${event.type} received after payment was Captured; capture stands`;
    const flags: ReviewFlag[] = isFailedOrCancelled(target)
      ? [{ reason: 'CONFLICTING_EVENT_AFTER_CAPTURE', details: reason }]
      : [];
    return unchanged('stale', reason, flags);
  }

  if (isFailedOrCancelled(payment.status)) {
    return unchanged('stale', `${event.type} received after payment was ${payment.status}`);
  }

  // Remaining: Initiated → Authorised, or Initiated/Authorised → Failed/Cancelled.
  // A failed attempt leaves the order AwaitingPayment so the customer can pay again.
  return {
    outcome: 'applied',
    paymentStatus: target,
    orderStatus: order.status,
    reviewFlags: [],
    reason: `Payment ${payment.status} → ${target}`,
  };
}

function applyCapture(order: OrderSnapshot, payment: PaymentSnapshot): PaymentEventDecision {
  const reviewFlags: ReviewFlag[] = [];

  if (payment.status === 'Initiated') {
    reviewFlags.push({
      reason: 'CAPTURE_WITHOUT_AUTHORISATION',
      details: 'Captured received before any Authorised; accepted because amount and currency match',
    });
  } else if (isFailedOrCancelled(payment.status)) {
    reviewFlags.push({
      reason: 'CAPTURE_AFTER_TERMINAL',
      details: `Captured received after payment was ${payment.status}; capture wins because money moved`,
    });
  }

  let orderStatus: OrderStatus = order.status;
  if (order.status === 'AwaitingPayment') {
    orderStatus = 'Paid';
  } else if (order.status === 'Cancelled') {
    reviewFlags.push({
      reason: 'CAPTURE_ON_CANCELLED_ORDER',
      details: 'Payment captured for a cancelled order; order not released, refund likely needed',
    });
  } else {
    reviewFlags.push({
      reason: 'DUPLICATE_PAYMENT_CAPTURED',
      details: `Payment captured for an order that is already ${order.status}; refund likely needed`,
    });
  }

  return {
    outcome: 'applied',
    paymentStatus: 'Captured',
    orderStatus,
    reviewFlags,
    reason: `Payment ${payment.status} → Captured; order ${order.status} → ${orderStatus}`,
  };
}

/** Returns a description of why the event does not confidently match the payment, or null if it does. */
function describeAmountMismatch(payment: PaymentSnapshot, event: PaymentEvent): string | null {
  if (REQUIRES_AMOUNT.has(event.type) && (event.amountMinor === undefined || event.currency === undefined)) {
    return `${event.type} has no amount/currency, so it cannot be matched to payment ${payment.id}`;
  }
  if (event.amountMinor !== undefined && event.amountMinor !== payment.amountMinor) {
    return `Event amount ${event.amountMinor} does not match payment amount ${payment.amountMinor}`;
  }
  if (event.currency !== undefined && event.currency !== payment.currency) {
    return `Event currency ${event.currency} does not match payment currency ${payment.currency}`;
  }
  return null;
}
