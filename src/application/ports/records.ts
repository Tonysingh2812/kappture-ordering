import type {
  DecisionOutcome,
  OrderStatus,
  PaymentStatus,
  ReviewReason,
} from '../../domain/types.ts';

/** Timestamps are ISO-8601 strings supplied by the caller (from the injected clock), never generated in SQL. */
export type IsoTimestamp = string;

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface OrderRecord {
  id: string;
  venueId: string;
  tableRef: string;
  items: OrderItem[];
  totalMinor: number;
  currency: string;
  status: OrderStatus;
  /** Optimistic concurrency token, incremented on every update. */
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PaymentRecord {
  /** Our reference. Sent to the provider as the merchant reference so every callback can be matched. */
  id: string;
  orderId: string;
  providerPaymentId: string | null;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  /** Sent to the provider on every (re)try of initiation so it can't charge twice. */
  providerIdempotencyKey: string;
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type PaymentEventOutcome = DecisionOutcome | 'pending';

/** Every provider event we receive, including duplicates (counted) and rejected ones (dead-lettered). */
export interface PaymentEventRecord {
  providerEventId: string;
  paymentId: string | null;
  type: string;
  payload: string;
  outcome: PaymentEventOutcome;
  reason: string | null;
  deliveryCount: number;
  firstReceivedAt: IsoTimestamp;
  lastReceivedAt: IsoTimestamp;
}

export type OrderEventType =
  | 'OrderCreated'
  | 'PaymentInitiated'
  | 'PaymentAuthorised'
  | 'PaymentCaptured'
  | 'PaymentFailed'
  | 'PaymentCancelled'
  | 'OrderPaid'
  | 'OrderCompleted';

/** Append-only audit log of what happened to an order. */
export interface OrderEventRecord {
  id: number;
  orderId: string;
  type: OrderEventType;
  data: Record<string, unknown>;
  occurredAt: IsoTimestamp;
}

export type IdempotencyStatus = 'in_progress' | 'completed';

export interface IdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseCode: number | null;
  responseBody: string | null;
  createdAt: IsoTimestamp;
}

export interface ReviewFlagRecord {
  id: number;
  orderId: string;
  paymentId: string | null;
  reason: ReviewReason;
  details: string;
  createdAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
}
