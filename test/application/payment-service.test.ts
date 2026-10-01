import { beforeEach, describe, expect, it } from 'vitest';
import { persistPaymentEvent } from '../../src/application/payment-event-persistence.ts';
import {
  createPaymentService,
  type InitiatePaymentInput,
  type PaymentService,
} from '../../src/application/payment-service.ts';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { FakePaymentProvider } from '../../src/infrastructure/fake-payment-provider.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { buildOrder, deviceA, deviceB } from '../support/builders.ts';
import { FakeClock, InstantSleeper, SequentialIdGenerator } from '../support/fakes.ts';

let store: DataStore;
let provider: FakePaymentProvider;
let sleeper: InstantSleeper;
let service: PaymentService;

beforeEach(() => {
  store = createSqliteDataStore(openDatabase(':memory:'));
  provider = new FakePaymentProvider();
  sleeper = new InstantSleeper();
  service = createPaymentService({
    dataStore: store,
    clock: new FakeClock(),
    idGenerator: new SequentialIdGenerator(),
    paymentProvider: provider,
    sleeper,
    random: () => 0,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
  });
  store.orders.insert(buildOrder({ id: 'order-1', totalMinor: 2500, currency: 'GBP' }));
});

const initiate = (overrides: Partial<InitiatePaymentInput> = {}) =>
  service.initiatePayment({ orderId: 'order-1', idempotencyKey: 'pay-key-1', deviceId: deviceA, ...overrides });

describe('initiatePayment: happy path', () => {
  it('creates a payment for the order total and stores the provider reference', async () => {
    provider.respondWith({ outcome: 'accepted', providerPaymentId: 'prov-123' });

    const result = await initiate();

    expect(result).toMatchObject({
      isOk: true,
      isReplay: false,
      providerOutcome: 'accepted',
      payment: { id: 'pay_1', orderId: 'order-1', status: 'Initiated', providerPaymentId: 'prov-123', amountMinor: 2500 },
    });
    expect(store.payments.findById('pay_1')).toMatchObject({ providerPaymentId: 'prov-123', status: 'Initiated' });
    expect(store.orderEvents.listByOrderId('order-1')).toMatchObject([
      { type: 'PaymentInitiated', data: { paymentId: 'pay_1', amountMinor: 2500, currency: 'GBP' } },
    ]);
  });

  it('sends our payment id as the merchant reference with a stable idempotency key', async () => {
    await initiate();

    expect(provider.calls).toEqual([
      { paymentId: 'pay_1', amountMinor: 2500, currency: 'GBP', idempotencyKey: expect.any(String) },
    ]);
  });

  it('saves the payment before calling the provider, so an early webhook can always be matched', async () => {
    let paymentSeenByProvider: unknown = 'not checked';
    provider.respondWith((request) => {
      paymentSeenByProvider = store.payments.findById(request.paymentId);
      return { outcome: 'accepted', providerPaymentId: 'prov-1' };
    });

    await initiate();

    expect(paymentSeenByProvider).toMatchObject({ id: 'pay_1', status: 'Initiated' });
  });
});

describe('initiatePayment: uncertain outcomes', () => {
  it('leaves the payment Initiated (never Failed) when the provider times out on every attempt', async () => {
    provider.respondWith({ outcome: 'timedOut' }, { outcome: 'timedOut' }, { outcome: 'timedOut' });

    const result = await initiate();

    expect(result).toMatchObject({ isOk: true, providerOutcome: 'pending', payment: { status: 'Initiated' } });
    expect(store.payments.findById('pay_1')).toMatchObject({ status: 'Initiated', providerPaymentId: null });
    expect(provider.calls).toHaveLength(3);
  });

  it('retries transient errors with back-off, reusing the same provider idempotency key', async () => {
    provider.respondWith(
      { outcome: 'transientError', reason: '503' },
      { outcome: 'timedOut' },
      { outcome: 'accepted', providerPaymentId: 'prov-1' },
    );

    const result = await initiate();

    expect(result).toMatchObject({ isOk: true, providerOutcome: 'accepted' });
    expect(provider.calls).toHaveLength(3);
    expect(new Set(provider.calls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(sleeper.delays).toEqual([50, 100]);
  });

  it('treats an unexpected provider exception as an unknown outcome, not a failure', async () => {
    const hangUp = () => {
      throw new Error('socket hang up');
    };
    provider.respondWith(hangUp, hangUp, hangUp);

    const result = await initiate();

    expect(result).toMatchObject({ isOk: true, providerOutcome: 'pending', payment: { status: 'Initiated' } });
  });
});

describe('initiatePayment: decline', () => {
  it('marks the payment Failed without retrying and keeps the order payable', async () => {
    provider.respondWith({ outcome: 'declined', reason: 'insufficient funds' });

    const result = await initiate();

    expect(result).toMatchObject({ isOk: true, providerOutcome: 'declined', payment: { status: 'Failed' } });
    expect(provider.calls).toHaveLength(1);
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment' });
    expect(store.orderEvents.listByOrderId('order-1').map((e) => e.type)).toEqual(['PaymentInitiated', 'PaymentFailed']);
  });

  it('allows a new payment attempt after a decline', async () => {
    provider.respondWith({ outcome: 'declined', reason: 'insufficient funds' });
    await initiate({ idempotencyKey: 'attempt-1' });

    const second = await initiate({ idempotencyKey: 'attempt-2' });

    expect(second).toMatchObject({ isOk: true, providerOutcome: 'accepted', payment: { id: 'pay_2' } });
    expect(store.payments.findByOrderId('order-1').map((p) => p.status)).toEqual(['Failed', 'Initiated']);
  });
});

describe('initiatePayment: duplicate requests', () => {
  it('replays the original result for a retried request, without a second payment or provider call', async () => {
    const first = await initiate();
    const retry = await initiate();

    expect(retry).toEqual({ ...first, isReplay: true });
    expect(store.payments.findByOrderId('order-1')).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('rejects the same key used for a different order', async () => {
    store.orders.insert(buildOrder({ id: 'order-2' }));
    await initiate();

    expect(await initiate({ orderId: 'order-2' })).toEqual({ isOk: false, error: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses a second payment while one is still in progress', async () => {
    await initiate({ idempotencyKey: 'attempt-1' });

    expect(await initiate({ idempotencyKey: 'attempt-2' })).toEqual({
      isOk: false,
      error: 'PAYMENT_ALREADY_IN_PROGRESS',
      paymentId: 'pay_1',
    });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('initiatePayment: invalid orders', () => {
  it('reports an unknown order without consuming the key', async () => {
    expect(await initiate({ orderId: 'missing' })).toEqual({ isOk: false, error: 'ORDER_NOT_FOUND' });
    expect(await initiate()).toMatchObject({ isOk: true });
  });

  it.each(['Paid', 'Completed', 'Cancelled'] as const)('refuses to take payment for an order that is %s', async (status) => {
    store.orders.insert(buildOrder({ id: 'order-x', status }));

    expect(await initiate({ orderId: 'order-x' })).toEqual({ isOk: false, error: 'ORDER_NOT_PAYABLE', orderStatus: status });
    expect(provider.calls).toHaveLength(0);
  });
});

describe('initiatePayment: webhook races the provider response', () => {
  const captureViaWebhook = (paymentId: string) =>
    store.runInTransaction(() =>
      persistPaymentEvent(store, {
        order: store.orders.findById('order-1')!,
        payment: store.payments.findById(paymentId)!,
        event: { type: 'PaymentCaptured', paymentId, amountMinor: 2500, currency: 'GBP' },
        now: '2026-10-01T12:00:00.500Z',
      }),
    );

  it('keeps a capture that arrived during the call when the provider then reports accepted', async () => {
    provider.respondWith((request) => {
      captureViaWebhook(request.paymentId);
      return { outcome: 'accepted', providerPaymentId: 'prov-1' };
    });

    const result = await initiate();

    expect(result).toMatchObject({ isOk: true, payment: { status: 'Captured', providerPaymentId: 'prov-1' } });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid' });
  });

  it('does not let a late decline undo a capture; it is flagged instead', async () => {
    provider.respondWith((request) => {
      captureViaWebhook(request.paymentId);
      return { outcome: 'declined', reason: 'confused provider' };
    });

    await initiate();

    expect(store.payments.findById('pay_1')).toMatchObject({ status: 'Captured' });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid' });
    expect(store.reviewFlags.listByOrderId('order-1').map((f) => f.reason)).toContain('CONFLICTING_EVENT_AFTER_CAPTURE');
  });
});

describe('initiatePayment: device scoping (KAP-11)', () => {
  it('records the device on the payment and in PaymentInitiated', async () => {
    await initiate();

    expect(store.payments.findById('pay_1')).toMatchObject({ deviceId: deviceA });
    expect(store.orderEvents.listByOrderId('order-1')[0]).toMatchObject({ data: { deviceId: deviceA } });
  });

  it("does not replay another device's result for the same key", async () => {
    await initiate({ deviceId: deviceA });

    const fromB = await initiate({ deviceId: deviceB });

    expect(fromB).toEqual({ isOk: false, error: 'PAYMENT_ALREADY_IN_PROGRESS', paymentId: 'pay_1' });
  });

  it('allows a different device to pay for the order (e.g. paying for a friend)', async () => {
    store.orders.insert(buildOrder({ id: 'order-2', deviceId: deviceA }));

    expect(await initiate({ orderId: 'order-2', deviceId: deviceB })).toMatchObject({ isOk: true });
  });
});
