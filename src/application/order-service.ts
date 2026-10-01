import { completeOrder as decideCompletion, validateNewOrder, type NewOrderItem } from '../domain/order.ts';
import type { OrderEventRecord, OrderRecord, PaymentRecord, ReviewFlagRecord } from './ports/records.ts';
import type { DataStore } from './ports/repositories.ts';
import type { Clock, IdGenerator } from './ports/system.ts';
import { hashRequest } from './request-hash.ts';

export interface CreateOrderInput {
  idempotencyKey: string;
  deviceId: string;
  /** Set when the customer confirms they really want an order that looks like a duplicate. */
  confirmDuplicate?: boolean;
  venueId: string;
  tableRef: string;
  items: NewOrderItem[];
  currency: string;
}

export type OrderView = Omit<OrderRecord, 'version'>;
export type PaymentView = Omit<PaymentRecord, 'version'>;

export type CreateOrderResult =
  | { isOk: true; order: OrderView; isReplay: boolean }
  | { isOk: false; error: 'INVALID_ORDER'; problems: string[] }
  /** The key was already used with a different request body. */
  | { isOk: false; error: 'IDEMPOTENCY_KEY_REUSED' }
  /** The key's original request has not finished yet. */
  | { isOk: false; error: 'REQUEST_IN_PROGRESS' }
  /** Same device, identical basket, recently, under a different key. Resend with confirmDuplicate to proceed. */
  | { isOk: false; error: 'POSSIBLE_DUPLICATE'; existingOrderId: string };

export interface OrderDetails {
  order: OrderView;
  payments: PaymentView[];
  events: OrderEventRecord[];
  reviewFlags: ReviewFlagRecord[];
}

export type GetOrderResult = { isOk: true; details: OrderDetails } | { isOk: false; error: 'ORDER_NOT_FOUND' };

export type CompleteOrderServiceResult =
  | { isOk: true; order: OrderView; hasChanged: boolean }
  | { isOk: false; error: 'ORDER_NOT_FOUND' }
  | { isOk: false; error: 'ORDER_NOT_PAID'; orderStatus: string };

export interface OrderServiceDeps {
  dataStore: DataStore;
  clock: Clock;
  idGenerator: IdGenerator;
}

const createOrderScope = 'createOrder';

export const toOrderView = ({ version: _version, ...view }: OrderRecord): OrderView => view;
export const toPaymentView = ({ version: _version, ...view }: PaymentRecord): PaymentView => view;

export function createOrderService({ dataStore, clock, idGenerator }: OrderServiceDeps) {
  return {
    /**
     * Creates an order exactly once per idempotency key. Claiming the key, inserting the order, recording
     * the event and storing the result all happen in one transaction, so a crash can't leave them half-done.
     */
    createOrder(input: CreateOrderInput): CreateOrderResult {
      // Validate before claiming the key, so a rejected body doesn't burn the key.
      const validation = validateNewOrder(input.items, input.currency);
      if (!validation.isOk) return validation;

      const { idempotencyKey, ...request } = input;
      const requestHash = hashRequest(request);

      return dataStore.runInTransaction((): CreateOrderResult => {
        const now = clock.now();
        const existing = dataStore.idempotency.tryBegin({
          scope: createOrderScope,
          key: idempotencyKey,
          requestHash,
          createdAt: now,
        });

        if (existing) {
          if (existing.status === 'in_progress' || existing.result === null) {
            return { isOk: false, error: 'REQUEST_IN_PROGRESS' };
          }
          if (existing.requestHash !== requestHash) return { isOk: false, error: 'IDEMPOTENCY_KEY_REUSED' };
          return { isOk: true, order: JSON.parse(existing.result) as OrderView, isReplay: true };
        }

        const order: OrderRecord = {
          id: idGenerator.newId('ord'),
          venueId: input.venueId,
          tableRef: input.tableRef,
          items: input.items,
          totalMinor: validation.totalMinor,
          currency: input.currency,
          status: 'AwaitingPayment',
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        dataStore.orders.insert(order);
        dataStore.orderEvents.append({
          orderId: order.id,
          type: 'OrderCreated',
          data: {
            venueId: order.venueId,
            tableRef: order.tableRef,
            totalMinor: order.totalMinor,
            currency: order.currency,
            itemCount: order.items.length,
          },
          occurredAt: now,
        });

        const view = toOrderView(order);
        dataStore.idempotency.complete(createOrderScope, idempotencyKey, JSON.stringify(view));
        return { isOk: true, order: view, isReplay: false };
      });
    },

    /** Hands a paid order to fulfilment. Idempotent: completing a Completed order changes nothing. */
    completeOrder(orderId: string): CompleteOrderServiceResult {
      return dataStore.runInTransaction((): CompleteOrderServiceResult => {
        const order = dataStore.orders.findById(orderId);
        if (!order) return { isOk: false, error: 'ORDER_NOT_FOUND' };

        const decision = decideCompletion(order);
        if (!decision.isOk) return { isOk: false, error: decision.error, orderStatus: decision.status };
        if (!decision.hasChanged) return { isOk: true, order: toOrderView(order), hasChanged: false };

        const now = clock.now();
        const version = dataStore.orders.updateStatus(order.id, decision.status, order.version, now);
        dataStore.orderEvents.append({ orderId: order.id, type: 'OrderCompleted', data: {}, occurredAt: now });
        return {
          isOk: true,
          order: toOrderView({ ...order, status: decision.status, version, updatedAt: now }),
          hasChanged: true,
        };
      });
    },

    getOrder(orderId: string): GetOrderResult {
      const order = dataStore.orders.findById(orderId);
      if (!order) return { isOk: false, error: 'ORDER_NOT_FOUND' };

      return {
        isOk: true,
        details: {
          order: toOrderView(order),
          payments: dataStore.payments.findByOrderId(orderId).map(toPaymentView),
          events: dataStore.orderEvents.listByOrderId(orderId),
          reviewFlags: dataStore.reviewFlags.listByOrderId(orderId),
        },
      };
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
