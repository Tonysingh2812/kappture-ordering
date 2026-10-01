import { beforeEach, describe, expect, it } from 'vitest';
import { createHistoryService, type HistoryService } from '../../src/application/history-service.ts';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { buildOrder, buildPayment, t0, t1, t2 } from '../support/builders.ts';

let store: DataStore;
let service: HistoryService;

beforeEach(() => {
  store = createSqliteDataStore(openDatabase(':memory:'));
  service = createHistoryService({ dataStore: store });
});

const page = { limit: 50, offset: 0 };

describe('listOrders', () => {
  beforeEach(() => {
    store.orders.insert(buildOrder({ id: 'a', createdAt: t0 }));
    store.orders.insert(buildOrder({ id: 'b', createdAt: t1, status: 'Paid' }));
    store.orders.insert(buildOrder({ id: 'c', createdAt: t2, status: 'Paid' }));
  });

  it('lists all orders oldest first, without internal fields', () => {
    const orders = service.listOrders(page);

    expect(orders.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(orders[0]).not.toHaveProperty('version');
  });

  it('filters by status and paginates', () => {
    expect(service.listOrders({ ...page, status: 'Paid' }).map((o) => o.id)).toEqual(['b', 'c']);
    expect(service.listOrders({ status: 'Paid', limit: 1, offset: 1 }).map((o) => o.id)).toEqual(['c']);
  });
});

describe('listPayments', () => {
  it('filters by status', () => {
    store.orders.insert(buildOrder());
    store.payments.insert(buildPayment({ id: 'p1', status: 'Failed' }));
    store.payments.insert(buildPayment({ id: 'p2', status: 'Captured' }));

    const payments = service.listPayments({ ...page, status: 'Captured' });

    expect(payments.map((p) => p.id)).toEqual(['p2']);
    expect(payments[0]).not.toHaveProperty('version');
  });
});

describe('listPaymentEvents', () => {
  it('lists provider events, filterable by outcome (e.g. the dead-letter view)', () => {
    store.paymentEvents.recordDelivery({ providerEventId: 'e1', paymentId: 'p1', type: 'PaymentCaptured', payload: '{}', receivedAt: t0 });
    store.paymentEvents.recordDelivery({ providerEventId: 'e2', paymentId: null, type: 'unparseable', payload: '{', receivedAt: t1 });
    store.paymentEvents.setOutcome('e1', 'applied', 'ok');
    store.paymentEvents.setOutcome('e2', 'rejected', 'Body is not valid JSON');

    expect(service.listPaymentEvents(page).map((e) => e.providerEventId)).toEqual(['e1', 'e2']);
    expect(service.listPaymentEvents({ ...page, status: 'rejected' })).toMatchObject([
      { providerEventId: 'e2', reason: 'Body is not valid JSON' },
    ]);
  });
});

describe('getTimeline', () => {
  it('merges order events and provider events in time order, cause before effect on ties', () => {
    store.orders.insert(buildOrder({ id: 'order-1' }));
    store.payments.insert(buildPayment({ id: 'pay-1', orderId: 'order-1' }));
    store.orderEvents.append({ orderId: 'order-1', type: 'OrderCreated', data: {}, occurredAt: t0 });
    store.orderEvents.append({ orderId: 'order-1', type: 'PaymentInitiated', data: { paymentId: 'pay-1' }, occurredAt: t0 });
    // The webhook at t1 and the state changes it caused share a timestamp.
    store.orderEvents.append({ orderId: 'order-1', type: 'PaymentCaptured', data: {}, occurredAt: t1 });
    store.orderEvents.append({ orderId: 'order-1', type: 'OrderPaid', data: {}, occurredAt: t1 });
    store.paymentEvents.recordDelivery({ providerEventId: 'evt-cap', paymentId: 'pay-1', type: 'PaymentCaptured', payload: '{}', receivedAt: t1 });
    store.paymentEvents.setOutcome('evt-cap', 'applied', 'Payment Initiated → Captured');
    store.paymentEvents.recordDelivery({ providerEventId: 'evt-cap', paymentId: 'pay-1', type: 'PaymentCaptured', payload: '{}', receivedAt: t2 });
    store.paymentEvents.recordDelivery({ providerEventId: 'evt-auth', paymentId: 'pay-1', type: 'PaymentAuthorised', payload: '{}', receivedAt: t2 });
    store.paymentEvents.setOutcome('evt-auth', 'stale', 'Authorised after Captured');

    const result = service.getTimeline('order-1');

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.entries.map((e) => `${e.source}:${e.type}`)).toEqual([
      'order:OrderCreated',
      'order:PaymentInitiated',
      'provider:PaymentCaptured',
      'order:PaymentCaptured',
      'order:OrderPaid',
      'provider:PaymentAuthorised',
    ]);
    expect(result.entries[2]).toMatchObject({ providerEventId: 'evt-cap', outcome: 'applied', deliveryCount: 2, lastReceivedAt: t2 });
    expect(result.entries[5]).toMatchObject({ outcome: 'stale', reason: 'Authorised after Captured' });
  });

  it('includes provider events for every payment attempt on the order', () => {
    store.orders.insert(buildOrder({ id: 'order-1' }));
    store.payments.insert(buildPayment({ id: 'pay-1', orderId: 'order-1', status: 'Failed' }));
    store.payments.insert(buildPayment({ id: 'pay-2', orderId: 'order-1' }));
    store.paymentEvents.recordDelivery({ providerEventId: 'e1', paymentId: 'pay-1', type: 'PaymentFailed', payload: '{}', receivedAt: t0 });
    store.paymentEvents.recordDelivery({ providerEventId: 'e2', paymentId: 'pay-2', type: 'PaymentCaptured', payload: '{}', receivedAt: t1 });

    const result = service.getTimeline('order-1');

    expect(result.isOk && result.entries.map((e) => e.source === 'provider' && e.paymentId)).toEqual(['pay-1', 'pay-2']);
  });

  it('reports an unknown order', () => {
    expect(service.getTimeline('missing')).toEqual({ isOk: false, error: 'ORDER_NOT_FOUND' });
  });
});
