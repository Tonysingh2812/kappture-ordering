import type { OrderStatus, PaymentStatus } from '../domain/types.ts';
import { toOrderView, toPaymentView, type OrderView, type PaymentView } from './order-service.ts';
import type { IsoTimestamp, PaymentEventOutcome, PaymentEventRecord } from './ports/records.ts';
import type { DataStore } from './ports/repositories.ts';

export interface PageOptions<TStatus> {
  status?: TStatus;
  limit: number;
  offset: number;
}

export type TimelineEntry =
  | { source: 'order'; at: IsoTimestamp; type: string; data: Record<string, unknown> }
  | {
      source: 'provider';
      at: IsoTimestamp;
      type: string;
      providerEventId: string;
      paymentId: string | null;
      outcome: PaymentEventOutcome;
      reason: string | null;
      deliveryCount: number;
      lastReceivedAt: IsoTimestamp;
    };

export type GetTimelineResult =
  | { isOk: true; orderId: string; entries: TimelineEntry[] }
  | { isOk: false; error: 'ORDER_NOT_FOUND' };

export interface HistoryServiceDeps {
  dataStore: DataStore;
}

/** On equal timestamps, a provider event (the cause) is listed before the order events it produced. */
const sourceRank: Record<TimelineEntry['source'], number> = { provider: 0, order: 1 };

/** Read-only views over every order, payment and provider event, for staff and auditing. */
export function createHistoryService({ dataStore }: HistoryServiceDeps) {
  return {
    listOrders(options: PageOptions<OrderStatus>): OrderView[] {
      return dataStore.orders.list(options).map(toOrderView);
    },

    listPayments(options: PageOptions<PaymentStatus>): PaymentView[] {
      return dataStore.payments.list(options).map(toPaymentView);
    },

    /** Every provider event received, including duplicates (counted), stale and rejected (dead-lettered) ones. */
    listPaymentEvents(options: PageOptions<PaymentEventOutcome>): PaymentEventRecord[] {
      return dataStore.paymentEvents.list(options);
    },

    /** Our audit events and the provider events that caused them, merged in time order. */
    getTimeline(orderId: string): GetTimelineResult {
      const order = dataStore.orders.findById(orderId);
      if (!order) return { isOk: false, error: 'ORDER_NOT_FOUND' };

      const orderEntries: TimelineEntry[] = dataStore.orderEvents.listByOrderId(orderId).map((e) => ({
        source: 'order',
        at: e.occurredAt,
        type: e.type,
        data: e.data,
      }));
      const providerEntries: TimelineEntry[] = dataStore.payments
        .findByOrderId(orderId)
        .flatMap((p) => dataStore.paymentEvents.listByPaymentId(p.id))
        .map((e) => ({
          source: 'provider',
          at: e.firstReceivedAt,
          type: e.type,
          providerEventId: e.providerEventId,
          paymentId: e.paymentId,
          outcome: e.outcome,
          reason: e.reason,
          deliveryCount: e.deliveryCount,
          lastReceivedAt: e.lastReceivedAt,
        }));

      // Array.prototype.sort is stable, so entries keep their stored order within the same time and source.
      const entries = [...providerEntries, ...orderEntries].sort((a, b) =>
        a.at === b.at ? sourceRank[a.source] - sourceRank[b.source] : a.at < b.at ? -1 : 1,
      );
      return { isOk: true, orderId, entries };
    },
  };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
