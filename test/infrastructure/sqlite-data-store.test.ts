import { beforeEach, describe, expect, it } from 'vitest';
import { ConcurrencyError } from '../../src/application/errors.ts';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import {
  createSqliteDataStore,
  openDatabase,
  runMigrations,
  type SqliteDatabase,
} from '../../src/infrastructure/sqlite/database.ts';
import { buildOrder, buildPayment, t0, t1, t2 } from '../support/builders.ts';

let db: SqliteDatabase;
let store: DataStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = createSqliteDataStore(db);
});

describe('migrations', () => {
  const tableNames = () =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map(
      (row) => row.name,
    );

  it('creates every table', () => {
    expect(tableNames()).toEqual(
      expect.arrayContaining([
        'orders',
        'payments',
        'payment_events',
        'order_events',
        'idempotency_keys',
        'review_flags',
        'schema_migrations',
      ]),
    );
  });

  it('is a no-op when run again', () => {
    const migrationCount = () => (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
    const before = migrationCount();

    runMigrations(db);

    expect(migrationCount()).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  it('enforces foreign keys', () => {
    expect(() => store.payments.insert(buildPayment({ orderId: 'no-such-order' }))).toThrow();
  });

  it('rejects negative or fractional money at the database level', () => {
    expect(() => store.orders.insert(buildOrder({ totalMinor: -1 }))).toThrow();
    expect(() => store.orders.insert(buildOrder({ totalMinor: 10.5 }))).toThrow();
  });
});

describe('orders', () => {
  it('round-trips an order, including its items', () => {
    const order = buildOrder();
    store.orders.insert(order);

    expect(store.orders.findById(order.id)).toEqual(order);
  });

  it('returns null for an unknown id', () => {
    expect(store.orders.findById('missing')).toBeNull();
  });

  it('updates status when the version matches, and bumps the version', () => {
    store.orders.insert(buildOrder());

    const newVersion = store.orders.updateStatus('order-1', 'Paid', 1, t1);

    expect(newVersion).toBe(2);
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid', version: 2, updatedAt: t1 });
  });

  it('throws ConcurrencyError on a stale version and leaves the row unchanged', () => {
    store.orders.insert(buildOrder());
    store.orders.updateStatus('order-1', 'Paid', 1, t1);

    expect(() => store.orders.updateStatus('order-1', 'Cancelled', 1, t2)).toThrow(ConcurrencyError);
    expect(store.orders.findById('order-1')).toMatchObject({ status: 'Paid', version: 2 });
  });

  it('lists orders, optionally filtered by status, oldest first', () => {
    store.orders.insert(buildOrder({ id: 'a', createdAt: t0 }));
    store.orders.insert(buildOrder({ id: 'b', createdAt: t1, status: 'Paid' }));
    store.orders.insert(buildOrder({ id: 'c', createdAt: t2 }));

    expect(store.orders.list().map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(store.orders.list({ status: 'AwaitingPayment' }).map((o) => o.id)).toEqual(['a', 'c']);
    expect(store.orders.list({ limit: 1, offset: 1 }).map((o) => o.id)).toEqual(['b']);
  });
});

describe('payments', () => {
  beforeEach(() => store.orders.insert(buildOrder()));

  it('round-trips a payment', () => {
    const payment = buildPayment();
    store.payments.insert(payment);

    expect(store.payments.findById(payment.id)).toEqual(payment);
  });

  it('finds all payments for an order', () => {
    store.payments.insert(buildPayment({ id: 'p1', createdAt: t0 }));
    store.payments.insert(buildPayment({ id: 'p2', createdAt: t1 }));

    expect(store.payments.findByOrderId('order-1').map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('applies partial updates with optimistic concurrency', () => {
    store.payments.insert(buildPayment());

    const version = store.payments.update('pay-1', { providerPaymentId: 'prov-9' }, 1, t1);
    store.payments.update('pay-1', { status: 'Captured' }, version, t2);

    expect(store.payments.findById('pay-1')).toMatchObject({
      providerPaymentId: 'prov-9',
      status: 'Captured',
      version: 3,
      updatedAt: t2,
    });
    expect(() => store.payments.update('pay-1', { status: 'Failed' }, 1, t2)).toThrow(ConcurrencyError);
  });

  it('lists payments filtered by status', () => {
    store.payments.insert(buildPayment({ id: 'p1' }));
    store.payments.insert(buildPayment({ id: 'p2', status: 'Captured' }));

    expect(store.payments.list({ status: 'Captured' }).map((p) => p.id)).toEqual(['p2']);
  });
});

describe('payment events (dedupe point)', () => {
  const delivery = (overrides = {}) => ({
    providerEventId: 'evt-1',
    paymentId: 'pay-1',
    type: 'PaymentCaptured',
    payload: '{"eventId":"evt-1"}',
    receivedAt: t0,
    ...overrides,
  });

  it('records the first delivery as new and pending', () => {
    const result = store.paymentEvents.recordDelivery(delivery());

    expect(result.isFirstDelivery).toBe(true);
    expect(result.record).toMatchObject({
      providerEventId: 'evt-1',
      outcome: 'pending',
      deliveryCount: 1,
      firstReceivedAt: t0,
      lastReceivedAt: t0,
    });
  });

  it('counts redeliveries of the same provider event id instead of inserting again', () => {
    store.paymentEvents.recordDelivery(delivery());
    store.paymentEvents.recordDelivery(delivery({ receivedAt: t1 }));
    const third = store.paymentEvents.recordDelivery(delivery({ receivedAt: t2 }));

    expect(third.isFirstDelivery).toBe(false);
    expect(third.record).toMatchObject({ deliveryCount: 3, firstReceivedAt: t0, lastReceivedAt: t2 });
    expect(store.paymentEvents.list()).toHaveLength(1);
  });

  it('stores events with no matching payment (dead letters)', () => {
    store.paymentEvents.recordDelivery(delivery({ paymentId: null, type: 'Garbage' }));

    expect(store.paymentEvents.findByProviderEventId('evt-1')).toMatchObject({ paymentId: null, type: 'Garbage' });
  });

  it('records the outcome and reason', () => {
    store.paymentEvents.recordDelivery(delivery());
    store.paymentEvents.setOutcome('evt-1', 'stale', 'Authorised after Captured');

    expect(store.paymentEvents.findByProviderEventId('evt-1')).toMatchObject({
      outcome: 'stale',
      reason: 'Authorised after Captured',
    });
  });

  it('keeps arrival order for events received at the same timestamp', () => {
    store.paymentEvents.recordDelivery(delivery({ providerEventId: 'zz-first', receivedAt: t0 }));
    store.paymentEvents.recordDelivery(delivery({ providerEventId: 'aa-second', receivedAt: t0 }));

    expect(store.paymentEvents.listByPaymentId('pay-1').map((e) => e.providerEventId)).toEqual(['zz-first', 'aa-second']);
    expect(store.paymentEvents.list().map((e) => e.providerEventId)).toEqual(['zz-first', 'aa-second']);
  });

  it('lists events by payment and by outcome', () => {
    store.paymentEvents.recordDelivery(delivery({ providerEventId: 'e1', receivedAt: t0 }));
    store.paymentEvents.recordDelivery(delivery({ providerEventId: 'e2', receivedAt: t1 }));
    store.paymentEvents.recordDelivery(delivery({ providerEventId: 'e3', paymentId: 'pay-2' }));
    store.paymentEvents.setOutcome('e2', 'rejected', 'bad');

    expect(store.paymentEvents.listByPaymentId('pay-1').map((e) => e.providerEventId)).toEqual(['e1', 'e2']);
    expect(store.paymentEvents.list({ status: 'rejected' }).map((e) => e.providerEventId)).toEqual(['e2']);
  });
});

describe('order events (audit log)', () => {
  beforeEach(() => store.orders.insert(buildOrder()));

  it('appends events with ids and lists them in order', () => {
    const first = store.orderEvents.append({ orderId: 'order-1', type: 'OrderCreated', data: { totalMinor: 2500 }, occurredAt: t0 });
    store.orderEvents.append({ orderId: 'order-1', type: 'PaymentInitiated', data: { paymentId: 'pay-1' }, occurredAt: t1 });

    expect(first.id).toEqual(expect.any(Number));
    expect(store.orderEvents.listByOrderId('order-1')).toMatchObject([
      { type: 'OrderCreated', data: { totalMinor: 2500 }, occurredAt: t0 },
      { type: 'PaymentInitiated', data: { paymentId: 'pay-1' }, occurredAt: t1 },
    ]);
  });
});

describe('idempotency keys', () => {
  const begin = (overrides = {}) =>
    store.idempotency.tryBegin({ scope: 'POST /orders', key: 'k1', requestHash: 'h1', createdAt: t0, ...overrides });

  it('claims a new key by returning null', () => {
    expect(begin()).toBeNull();
  });

  it('returns the in-progress record when the key is reused before completion', () => {
    begin();

    expect(begin()).toMatchObject({ status: 'in_progress', requestHash: 'h1', result: null });
  });

  it('returns the stored response once completed', () => {
    begin();
    store.idempotency.complete('POST /orders', 'k1', '{"id":"order-1"}');

    expect(begin({ requestHash: 'h2' })).toMatchObject({
      status: 'completed',
      requestHash: 'h1',
      result: '{"id":"order-1"}',
    });
  });

  it('scopes keys, so the same key on a different endpoint is independent', () => {
    begin();

    expect(begin({ scope: 'POST /orders/order-1/payments' })).toBeNull();
  });

  it('can release a claim so the client may retry', () => {
    begin();
    store.idempotency.release('POST /orders', 'k1');

    expect(begin()).toBeNull();
  });
});

describe('review flags', () => {
  beforeEach(() => store.orders.insert(buildOrder()));

  it('inserts, lists open flags and resolves them', () => {
    const flag = store.reviewFlags.insert({
      orderId: 'order-1',
      paymentId: 'pay-1',
      reason: 'CAPTURE_WITHOUT_AUTHORISATION',
      details: 'early capture',
      createdAt: t0,
    });

    expect(flag).toMatchObject({ id: expect.any(Number), resolvedAt: null });
    expect(store.reviewFlags.listOpen()).toHaveLength(1);
    expect(store.reviewFlags.listByOrderId('order-1')).toHaveLength(1);

    expect(store.reviewFlags.resolve(flag.id, t1)).toBe(true);
    expect(store.reviewFlags.listOpen()).toHaveLength(0);
    expect(store.reviewFlags.listByOrderId('order-1')[0]).toMatchObject({ resolvedAt: t1 });
  });

  it('reports false when resolving an unknown or already resolved flag', () => {
    expect(store.reviewFlags.resolve(999, t1)).toBe(false);
  });
});

describe('runInTransaction', () => {
  it('commits all writes when the work succeeds', () => {
    store.runInTransaction(() => {
      store.orders.insert(buildOrder());
      store.orderEvents.append({ orderId: 'order-1', type: 'OrderCreated', data: {}, occurredAt: t0 });
    });

    expect(store.orders.findById('order-1')).not.toBeNull();
    expect(store.orderEvents.listByOrderId('order-1')).toHaveLength(1);
  });

  it('rolls back every write when the work throws', () => {
    expect(() =>
      store.runInTransaction(() => {
        store.orders.insert(buildOrder());
        store.orderEvents.append({ orderId: 'order-1', type: 'OrderCreated', data: {}, occurredAt: t0 });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(store.orders.findById('order-1')).toBeNull();
    expect(store.orderEvents.listByOrderId('order-1')).toHaveLength(0);
  });

  it('returns the value produced by the work', () => {
    expect(store.runInTransaction(() => 42)).toBe(42);
  });
});

describe('file-backed database', () => {
  it('persists across connections', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'kappture-'));
    const path = join(dir, 'test.db');

    try {
      const first = openDatabase(path);
      createSqliteDataStore(first).orders.insert(buildOrder());
      first.close();

      const second = openDatabase(path);
      expect(createSqliteDataStore(second).orders.findById('order-1')).not.toBeNull();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
