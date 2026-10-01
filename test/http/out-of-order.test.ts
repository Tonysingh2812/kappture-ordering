/**
 * Acceptance tests for the out-of-order policy and the agreed "PaymentCaptured while AwaitingPayment" decision,
 * driven entirely through HTTP (create order → initiate payment → webhooks → read order and review queue).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OrderStatus } from '../../src/domain/types.ts';
import { createTestApp, type TestApp } from '../support/test-app.ts';
import { providerEvent, signed } from '../support/webhooks.ts';

let testApp: TestApp;

afterEach(async () => {
  await testApp?.app.close();
});

type EventType = 'PaymentAuthorised' | 'PaymentCaptured' | 'PaymentFailed' | 'PaymentCancelled';

/** Creates an order (total 2500 GBP) and initiates a payment over HTTP. Returns the payment id. */
async function startPaidFlow(): Promise<{ orderId: string; paymentId: string }> {
  testApp = await createTestApp();
  const order = await testApp.app.inject({
    method: 'POST',
    url: '/orders',
    headers: { 'idempotency-key': 'order-key' },
    payload: {
      venueId: 'venue-1',
      tableRef: 'T12',
      items: [{ sku: 'burger', name: 'Burger', quantity: 2, unitPriceMinor: 1250 }],
      currency: 'GBP',
    },
  });
  const orderId = order.json().id as string;
  const payment = await testApp.app.inject({
    method: 'POST',
    url: `/orders/${orderId}/payments`,
    headers: { 'idempotency-key': 'payment-key' },
  });
  return { orderId, paymentId: payment.json().payment.id as string };
}

async function sendEvent(paymentId: string, type: EventType, overrides: Record<string, unknown> = {}) {
  const { rawBody, signature } = signed(providerEvent({ type, paymentId, ...overrides }));
  const res = await testApp.app.inject({
    method: 'POST',
    url: '/webhooks/payments',
    headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
    payload: rawBody,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { outcome: string };
}

async function readState(orderId: string) {
  const details = (await testApp.app.inject({ method: 'GET', url: `/orders/${orderId}` })).json();
  const review = (await testApp.app.inject({ method: 'GET', url: '/review' })).json();
  return {
    orderStatus: details.order.status as OrderStatus,
    paymentStatus: details.payments[0].status as string,
    flags: (details.reviewFlags as { reason: string }[]).map((f) => f.reason),
    reviewQueue: (review.items as { reason: string; order: { id: string } }[]).map((i) => [i.order.id, i.reason]),
  };
}

describe('PaymentCaptured while the order is still AwaitingPayment (agreed decision)', () => {
  it('accepts a confidently matched capture: order Paid, non-blocking flag in the review queue', async () => {
    const { orderId, paymentId } = await startPaidFlow();

    expect(await sendEvent(paymentId, 'PaymentCaptured')).toMatchObject({ outcome: 'applied' });

    const state = await readState(orderId);
    expect(state).toMatchObject({ orderStatus: 'Paid', paymentStatus: 'Captured' });
    expect(state.flags).toEqual(['CAPTURE_WITHOUT_AUTHORISATION']);
    expect(state.reviewQueue).toEqual([[orderId, 'CAPTURE_WITHOUT_AUTHORISATION']]);
  });

  it('ignores the late Authorised that arrives afterwards (stale, no error, no change)', async () => {
    const { orderId, paymentId } = await startPaidFlow();
    await sendEvent(paymentId, 'PaymentCaptured');

    expect(await sendEvent(paymentId, 'PaymentAuthorised')).toMatchObject({ outcome: 'stale' });
    expect(await readState(orderId)).toMatchObject({ orderStatus: 'Paid', paymentStatus: 'Captured' });
  });

  it.each([
    ['amount', { amountMinor: 2499 }],
    ['currency', { currency: 'EUR' }],
  ])('does not release the order when the %s does not match; flags it instead', async (_label, overrides) => {
    const { orderId, paymentId } = await startPaidFlow();

    expect(await sendEvent(paymentId, 'PaymentCaptured', overrides)).toMatchObject({ outcome: 'rejected' });

    const state = await readState(orderId);
    expect(state).toMatchObject({ orderStatus: 'AwaitingPayment', paymentStatus: 'Initiated' });
    expect(state.flags).toEqual(['AMOUNT_MISMATCH']);
  });
});

describe('conflicting terminal events', () => {
  it('Failed then Captured: the capture wins (money moved) and is flagged', async () => {
    const { orderId, paymentId } = await startPaidFlow();

    await sendEvent(paymentId, 'PaymentFailed');
    expect(await sendEvent(paymentId, 'PaymentCaptured')).toMatchObject({ outcome: 'applied' });

    const state = await readState(orderId);
    expect(state).toMatchObject({ orderStatus: 'Paid', paymentStatus: 'Captured' });
    expect(state.flags).toEqual(['CAPTURE_AFTER_TERMINAL']);
  });

  it('Captured then Failed: the capture stands and the conflict is flagged', async () => {
    const { orderId, paymentId } = await startPaidFlow();

    await sendEvent(paymentId, 'PaymentAuthorised');
    await sendEvent(paymentId, 'PaymentCaptured');
    expect(await sendEvent(paymentId, 'PaymentFailed')).toMatchObject({ outcome: 'stale' });

    const state = await readState(orderId);
    expect(state).toMatchObject({ orderStatus: 'Paid', paymentStatus: 'Captured' });
    expect(state.flags).toEqual(['CONFLICTING_EVENT_AFTER_CAPTURE']);
  });

  it('a capture for an order cancelled meanwhile is recorded but the order is not released', async () => {
    const { orderId, paymentId } = await startPaidFlow();
    // No cancel endpoint in scope; simulate cancellation (e.g. by staff) directly in the store.
    const order = testApp.store.orders.findById(orderId)!;
    testApp.store.orders.updateStatus(orderId, 'Cancelled', order.version, testApp.clock.now());

    await sendEvent(paymentId, 'PaymentAuthorised');
    await sendEvent(paymentId, 'PaymentCaptured');

    const state = await readState(orderId);
    expect(state).toMatchObject({ orderStatus: 'Cancelled', paymentStatus: 'Captured' });
    expect(state.flags).toEqual(['CAPTURE_ON_CANCELLED_ORDER']);
  });
});

describe('arrival order does not change the final state', () => {
  const permutations = <T>(items: T[]): T[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
        );

  it.each(permutations<EventType>(['PaymentAuthorised', 'PaymentCaptured', 'PaymentFailed']).map((p) => [p.join(' → '), p]))(
    '%s ends Paid / Captured',
    async (_label, sequence) => {
      const { orderId, paymentId } = await startPaidFlow();

      for (const type of sequence as EventType[]) await sendEvent(paymentId, type);

      expect(await readState(orderId)).toMatchObject({ orderStatus: 'Paid', paymentStatus: 'Captured' });
    },
  );
});
