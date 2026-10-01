import { beforeEach, describe, expect, it } from 'vitest';
import { persistPaymentEvent } from '../../src/application/payment-event-persistence.ts';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import type { PaymentEvent } from '../../src/domain/types.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { buildOrder, buildPayment, t1 } from '../support/builders.ts';

let store: DataStore;

beforeEach(() => {
  store = createSqliteDataStore(openDatabase(':memory:'));
});

const seed = (orderOverrides = {}, paymentOverrides = {}) => {
  store.orders.insert(buildOrder({ id: 'order-1', ...orderOverrides }));
  store.payments.insert(buildPayment({ id: 'pay-1', orderId: 'order-1', ...paymentOverrides }));
};

const persist = (event: Omit<PaymentEvent, 'paymentId'>) =>
  store.runInTransaction(() =>
    persistPaymentEvent(store, {
      order: store.orders.findById('order-1')!,
      payment: store.payments.findById('pay-1')!,
      event: { paymentId: 'pay-1', ...event },
      now: t1,
    }),
  );

describe('persistPaymentEvent', () => {
  it('saves an applied capture: payment, order, audit events and flags', () => {
    seed();

    const decision = persist({ type: 'PaymentCaptured', amountMinor: 2500, currency: 'GBP' });

    expect(decision.outcome).toBe('applied');
    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Captured', version: 2, updatedAt: t1 });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid', version: 2, updatedAt: t1 });
    expect(store.orderEvents.listByOrderId('order-1')).toMatchObject([
      { type: 'PaymentCaptured', data: { paymentId: 'pay-1', from: 'Initiated', to: 'Captured' }, occurredAt: t1 },
      { type: 'OrderPaid', data: { paymentId: 'pay-1' }, occurredAt: t1 },
    ]);
    expect(store.reviewFlags.listByOrderId('order-1')).toMatchObject([
      { paymentId: 'pay-1', reason: 'CAPTURE_WITHOUT_AUTHORISATION', createdAt: t1 },
    ]);
  });

  it('saves a payment-only change without touching the order', () => {
    seed();

    persist({ type: 'PaymentAuthorised', amountMinor: 2500, currency: 'GBP' });

    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Authorised' });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment', version: 1 });
    expect(store.orderEvents.listByOrderId('order-1').map((e) => e.type)).toEqual(['PaymentAuthorised']);
  });

  it('writes nothing for a duplicate', () => {
    seed({}, { status: 'Authorised' });

    const decision = persist({ type: 'PaymentAuthorised', amountMinor: 2500, currency: 'GBP' });

    expect(decision.outcome).toBe('duplicate');
    expect(store.payments.findById('pay-1')).toMatchObject({ version: 1 });
    expect(store.orderEvents.listByOrderId('order-1')).toHaveLength(0);
    expect(store.reviewFlags.listByOrderId('order-1')).toHaveLength(0);
  });

  it('saves only the review flag for a stale but suspicious event', () => {
    seed({ status: 'Paid' }, { status: 'Captured' });

    const decision = persist({ type: 'PaymentFailed' });

    expect(decision.outcome).toBe('stale');
    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Captured', version: 1 });
    expect(store.orderEvents.listByOrderId('order-1')).toHaveLength(0);
    expect(store.reviewFlags.listByOrderId('order-1')).toMatchObject([{ reason: 'CONFLICTING_EVENT_AFTER_CAPTURE' }]);
  });

  it('saves only the review flag for a rejected event', () => {
    seed();

    const decision = persist({ type: 'PaymentCaptured', amountMinor: 1, currency: 'GBP' });

    expect(decision.outcome).toBe('rejected');
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment' });
    expect(store.reviewFlags.listByOrderId('order-1')).toMatchObject([{ reason: 'AMOUNT_MISMATCH' }]);
  });
});
