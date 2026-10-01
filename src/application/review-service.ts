import type { OrderStatus, PaymentStatus, ReviewReason } from '../domain/types.ts';
import type { IsoTimestamp } from './ports/records.ts';
import type { DataStore } from './ports/repositories.ts';
import type { Clock } from './ports/system.ts';

/** A review flag with enough order/payment context for staff to act without further lookups. */
export interface ReviewItem {
  id: number;
  reason: ReviewReason;
  details: string;
  createdAt: IsoTimestamp;
  order: { id: string; status: OrderStatus; tableRef: string; totalMinor: number; currency: string };
  payment: { id: string; status: PaymentStatus; amountMinor: number; providerPaymentId: string | null } | null;
}

export type ResolveFlagResult = { isOk: true } | { isOk: false; error: 'FLAG_NOT_OPEN' };

export interface ReviewServiceDeps {
  dataStore: DataStore;
  clock: Clock;
}

export function createReviewService({ dataStore, clock }: ReviewServiceDeps) {
  return {
    /** Open flags, oldest first. Flags never block fulfilment; this is the queue staff work through. */
    listOpen(): ReviewItem[] {
      return dataStore.reviewFlags.listOpen().map((flag) => {
        const order = dataStore.orders.findById(flag.orderId)!;
        const payment = flag.paymentId === null ? null : dataStore.payments.findById(flag.paymentId);
        return {
          id: flag.id,
          reason: flag.reason,
          details: flag.details,
          createdAt: flag.createdAt,
          order: {
            id: order.id,
            status: order.status,
            tableRef: order.tableRef,
            totalMinor: order.totalMinor,
            currency: order.currency,
          },
          payment: payment && {
            id: payment.id,
            status: payment.status,
            amountMinor: payment.amountMinor,
            providerPaymentId: payment.providerPaymentId,
          },
        };
      });
    },

    resolve(flagId: number): ResolveFlagResult {
      const isResolved = dataStore.reviewFlags.resolve(flagId, clock.now());
      return isResolved ? { isOk: true } : { isOk: false, error: 'FLAG_NOT_OPEN' };
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
