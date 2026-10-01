import { beforeEach, describe, expect, it } from 'vitest';
import { createPaymentService } from '../../src/application/payment-service.ts';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { createWebhookService, type WebhookService } from '../../src/application/webhook-service.ts';
import { FakePaymentProvider } from '../../src/infrastructure/fake-payment-provider.ts';
import { createHmacSignatureVerifier } from '../../src/infrastructure/hmac-signature.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { buildOrder, buildPayment } from '../support/builders.ts';
import { FakeClock, InstantSleeper, SequentialIdGenerator } from '../support/fakes.ts';
import { providerEvent, signed, testWebhookSecret } from '../support/webhooks.ts';

let store: DataStore;
let clock: FakeClock;
let service: WebhookService;

const makeService = (dataStore: DataStore) =>
  createWebhookService({ dataStore, clock, signatureVerifier: createHmacSignatureVerifier(testWebhookSecret) });

beforeEach(() => {
  store = createSqliteDataStore(openDatabase(':memory:'));
  clock = new FakeClock();
  service = makeService(store);
});

const seedOrderWithPayment = (n = 1) => {
  store.orders.insert(buildOrder({ id: `order-${n}` }));
  store.payments.insert(buildPayment({ id: `pay-${n}`, orderId: `order-${n}` }));
};

const deliver = (body: unknown) => service.handlePaymentWebhook(signed(body));

describe('valid events', () => {
  beforeEach(() => seedOrderWithPayment());

  it('applies a capture: payment Captured, order Paid, event recorded as applied', () => {
    const result = deliver(providerEvent({ eventId: 'evt_cap' }));

    expect(result).toMatchObject({ isOk: true, providerEventId: 'evt_cap', outcome: 'applied' });
    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Captured' });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid' });
    expect(store.paymentEvents.findByProviderEventId('evt_cap')).toMatchObject({
      paymentId: 'pay-1',
      type: 'PaymentCaptured',
      outcome: 'applied',
      deliveryCount: 1,
    });
  });

  it('backfills the provider payment id if the initiation response never arrived', () => {
    deliver(providerEvent({ type: 'PaymentAuthorised', providerPaymentId: 'prov-late' }));

    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Authorised', providerPaymentId: 'prov-late' });
  });

  it('records the domain outcome for an event that does not match (amount mismatch)', () => {
    const result = deliver(providerEvent({ eventId: 'evt_bad_amount', amountMinor: 1 }));

    expect(result).toMatchObject({ isOk: true, outcome: 'rejected' });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment' });
    expect(store.paymentEvents.findByProviderEventId('evt_bad_amount')).toMatchObject({ outcome: 'rejected' });
  });
});

describe('duplicate callbacks', () => {
  beforeEach(() => seedOrderWithPayment());

  it('processes a repeated delivery once and counts the repeats', () => {
    const event = providerEvent({ eventId: 'evt_dup' });

    const firstOutcome = deliver(event);
    const versionAfterFirst = store.payments.findById('pay-1')!.version;
    const repeatOutcomes = [deliver(event), deliver(event)];

    expect([firstOutcome, ...repeatOutcomes].map((r) => r.isOk && r.outcome)).toEqual([
      'applied',
      'duplicate',
      'duplicate',
    ]);
    expect(store.paymentEvents.findByProviderEventId('evt_dup')).toMatchObject({ outcome: 'applied', deliveryCount: 3 });
    expect(store.orderEvents.listByOrderId('order-1').filter((e) => e.type === 'PaymentCaptured')).toHaveLength(1);
    // Repeats must not write anything to the payment.
    expect(store.payments.findById('pay-1')!.version).toBe(versionAfterFirst);
  });
});

describe('authenticity', () => {
  beforeEach(() => seedOrderWithPayment());

  it.each([
    ['missing', undefined],
    ['wrong', 'deadbeef'],
  ])('rejects a %s signature without recording or changing anything', (_label, signature) => {
    const result = service.handlePaymentWebhook({ rawBody: JSON.stringify(providerEvent()), signature });

    expect(result).toEqual({ isOk: false, error: 'INVALID_SIGNATURE' });
    expect(store.paymentEvents.list()).toHaveLength(0);
    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Initiated' });
  });

  it('rejects a body that was tampered with after signing', () => {
    const { signature } = signed(providerEvent({ amountMinor: 2500 }));
    const tampered = JSON.stringify(providerEvent({ amountMinor: 1 }));

    expect(service.handlePaymentWebhook({ rawBody: tampered, signature })).toEqual({
      isOk: false,
      error: 'INVALID_SIGNATURE',
    });
  });
});

describe('invalid events are dead-lettered and never block other orders', () => {
  beforeEach(() => {
    seedOrderWithPayment(1);
    seedOrderWithPayment(2);
  });

  it('stores unparseable JSON as rejected under a content-derived id, then processes the next event', () => {
    const garbage = deliver('{not json');
    const valid = deliver(providerEvent({ paymentId: 'pay-2' }));

    expect(garbage).toMatchObject({ isOk: true, outcome: 'rejected', providerEventId: expect.stringMatching(/^invalid:/) });
    expect(store.paymentEvents.list({ status: 'rejected' })).toHaveLength(1);
    expect(valid).toMatchObject({ isOk: true, outcome: 'applied' });
    expect(store.orders.findById('order-2')).toMatchObject({ status: 'Paid' });
  });

  it('treats a repeated unparseable body as a duplicate', () => {
    deliver('{not json');

    expect(deliver('{not json')).toMatchObject({ isOk: true, outcome: 'duplicate' });
  });

  it.each([
    ['unknown type', { type: 'PaymentExploded' }],
    ['missing paymentId', { paymentId: undefined }],
    ['amount as a string', { amountMinor: '2500' }],
    ['fractional amount', { amountMinor: 25.5 }],
  ])('rejects a schema-invalid event (%s) under its own eventId, with the reason', (_label, overrides) => {
    const result = deliver(providerEvent({ eventId: 'evt_invalid', ...overrides }));

    expect(result).toMatchObject({ isOk: true, providerEventId: 'evt_invalid', outcome: 'rejected' });
    expect(store.paymentEvents.findByProviderEventId('evt_invalid')).toMatchObject({
      outcome: 'rejected',
      reason: expect.any(String),
    });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment' });
  });

  it('rejects an event for an unknown payment and leaves other orders untouched', () => {
    const unknown = deliver(providerEvent({ eventId: 'evt_unknown', paymentId: 'pay-nope' }));
    const valid = deliver(providerEvent({ paymentId: 'pay-1' }));

    expect(unknown).toMatchObject({ isOk: true, outcome: 'rejected', reason: expect.stringContaining('pay-nope') });
    expect(store.paymentEvents.findByProviderEventId('evt_unknown')).toMatchObject({
      paymentId: 'pay-nope',
      outcome: 'rejected',
    });
    expect(valid).toMatchObject({ isOk: true, outcome: 'applied' });
    expect(store.orders.findById('order-2')).toMatchObject({ status: 'AwaitingPayment' });
  });
});

describe('internal failure', () => {
  beforeEach(() => seedOrderWithPayment());

  it('rolls back everything, including the delivery record, so the provider retry is processed fresh', () => {
    let shouldFail = true;
    const flakyStore: DataStore = {
      ...store,
      orderEvents: {
        ...store.orderEvents,
        append: (event) => {
          if (shouldFail) throw new Error('disk I/O error');
          return store.orderEvents.append(event);
        },
      },
    };
    const flakyService = makeService(flakyStore);
    const event = providerEvent({ eventId: 'evt_retry' });

    expect(() => flakyService.handlePaymentWebhook(signed(event))).toThrow('disk I/O error');
    expect(store.paymentEvents.findByProviderEventId('evt_retry')).toBeNull();
    expect(store.payments.findById('pay-1')).toMatchObject({ status: 'Initiated' });

    shouldFail = false;
    expect(flakyService.handlePaymentWebhook(signed(event))).toMatchObject({ isOk: true, outcome: 'applied' });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid' });
  });
});

describe('uncertain outcome: payment succeeds after the initiating request timed out', () => {
  it('settles the order from the webhook even though initiation reported pending', async () => {
    store.orders.insert(buildOrder({ id: 'order-1' }));
    const provider = new FakePaymentProvider().respondWith(
      { outcome: 'timedOut' },
      { outcome: 'timedOut' },
      { outcome: 'timedOut' },
    );
    const payments = createPaymentService({
      dataStore: store,
      clock,
      idGenerator: new SequentialIdGenerator(),
      paymentProvider: provider,
      sleeper: new InstantSleeper(),
      random: () => 0,
    });

    const initiation = await payments.initiatePayment({ orderId: 'order-1', idempotencyKey: 'k1' });
    expect(initiation).toMatchObject({ isOk: true, providerOutcome: 'pending', payment: { id: 'pay_1' } });

    clock.advanceMs(30_000);
    const webhook = deliver(providerEvent({ paymentId: 'pay_1', providerPaymentId: 'prov-xyz' }));

    expect(webhook).toMatchObject({ isOk: true, outcome: 'applied' });
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid' });
    expect(store.payments.findById('pay_1')).toMatchObject({ status: 'Captured', providerPaymentId: 'prov-xyz' });
  });
});
