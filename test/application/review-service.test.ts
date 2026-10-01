import { beforeEach, describe, expect, it } from 'vitest';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { createReviewService, type ReviewService } from '../../src/application/review-service.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { buildOrder, buildPayment, t0, t1 } from '../support/builders.ts';
import { FakeClock } from '../support/fakes.ts';

let store: DataStore;
let clock: FakeClock;
let service: ReviewService;

beforeEach(() => {
  store = createSqliteDataStore(openDatabase(':memory:'));
  clock = new FakeClock('2026-10-01T13:00:00.000Z');
  service = createReviewService({ dataStore: store, clock });
  store.orders.insert(buildOrder({ id: 'order-1', status: 'Paid', tableRef: 'T7' }));
  store.payments.insert(buildPayment({ id: 'pay-1', orderId: 'order-1', status: 'Captured', providerPaymentId: 'prov-1' }));
});

const flag = (overrides = {}) =>
  store.reviewFlags.insert({
    orderId: 'order-1',
    paymentId: 'pay-1',
    reason: 'CAPTURE_WITHOUT_AUTHORISATION',
    details: 'early capture',
    createdAt: t0,
    ...overrides,
  });

describe('listOpen', () => {
  it('returns open flags with order and payment context, oldest first', () => {
    flag({ createdAt: t0 });
    flag({ reason: 'CONFLICTING_EVENT_AFTER_CAPTURE', createdAt: t1 });

    expect(service.listOpen()).toEqual([
      {
        id: expect.any(Number),
        reason: 'CAPTURE_WITHOUT_AUTHORISATION',
        details: 'early capture',
        createdAt: t0,
        order: { id: 'order-1', status: 'Paid', tableRef: 'T7', totalMinor: 2500, currency: 'GBP' },
        payment: { id: 'pay-1', status: 'Captured', amountMinor: 2500, providerPaymentId: 'prov-1' },
      },
      expect.objectContaining({ reason: 'CONFLICTING_EVENT_AFTER_CAPTURE' }),
    ]);
  });

  it('handles a flag with no payment', () => {
    flag({ paymentId: null });

    expect(service.listOpen()[0]).toMatchObject({ payment: null });
  });

  it('excludes resolved flags', () => {
    const resolved = flag();
    flag({ reason: 'AMOUNT_MISMATCH' });
    store.reviewFlags.resolve(resolved.id, t1);

    expect(service.listOpen().map((f) => f.reason)).toEqual(['AMOUNT_MISMATCH']);
  });
});

describe('resolve', () => {
  it('resolves an open flag at the current time', () => {
    const open = flag();

    expect(service.resolve(open.id)).toEqual({ isOk: true });
    expect(store.reviewFlags.listByOrderId('order-1')[0]).toMatchObject({ resolvedAt: clock.now() });
    expect(service.listOpen()).toHaveLength(0);
  });

  it('reports a flag that is unknown or already resolved', () => {
    const open = flag();
    service.resolve(open.id);

    expect(service.resolve(open.id)).toEqual({ isOk: false, error: 'FLAG_NOT_OPEN' });
    expect(service.resolve(9999)).toEqual({ isOk: false, error: 'FLAG_NOT_OPEN' });
  });
});
