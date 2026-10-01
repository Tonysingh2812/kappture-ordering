export type OrderStatus = 'AwaitingPayment' | 'Paid' | 'Completed' | 'Cancelled';

export type PaymentStatus = 'Initiated' | 'Authorised' | 'Captured' | 'Failed' | 'Cancelled';

export type PaymentEventType =
  | 'PaymentAuthorised'
  | 'PaymentCaptured'
  | 'PaymentFailed'
  | 'PaymentCancelled';

/** Money is always integer minor units (e.g. pence) to avoid floating point errors. */
export interface OrderSnapshot {
  id: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
}

export interface PaymentSnapshot {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
}

export interface PaymentEvent {
  type: PaymentEventType;
  paymentId: string;
  /** Required to confidently match Authorised/Captured events; optional for Failed/Cancelled. */
  amountMinor?: number;
  currency?: string;
}

export type ReviewReason =
  /** Captured arrived without a prior Authorised (out-of-order or skipped). Sale still goes through. */
  | 'CAPTURE_WITHOUT_AUTHORISATION'
  /** Captured arrived after the payment was already Failed/Cancelled. Money moved, so capture wins. */
  | 'CAPTURE_AFTER_TERMINAL'
  /** Failed/Cancelled arrived after Captured. Ignored, but worth a human look. */
  | 'CONFLICTING_EVENT_AFTER_CAPTURE'
  /** Event amount/currency does not match the payment. Not applied. */
  | 'AMOUNT_MISMATCH'
  /** Money captured for an order that was cancelled. Not released; likely needs a refund. */
  | 'CAPTURE_ON_CANCELLED_ORDER'
  /** A second payment was captured for an order that was already paid. Likely needs a refund. */
  | 'DUPLICATE_PAYMENT_CAPTURED';

export interface ReviewFlag {
  reason: ReviewReason;
  details: string;
}

export type DecisionOutcome =
  /** The event changed state. */
  | 'applied'
  /** The payment is already in the event's target state. No change. */
  | 'duplicate'
  /** The event would move the payment backwards (e.g. Authorised after Captured). No change. */
  | 'stale'
  /** The event cannot be trusted or matched (e.g. amount mismatch). No change. */
  | 'rejected';

export interface PaymentEventDecision {
  outcome: DecisionOutcome;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  reviewFlags: ReviewFlag[];
  /** Human-readable explanation, stored alongside the event for auditing. */
  reason: string;
}
