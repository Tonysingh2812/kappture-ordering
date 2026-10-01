import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrder } from '../support/builders.ts';
import { createTestApp, type TestApp } from '../support/test-app.ts';

let testApp: TestApp;

beforeEach(async () => {
  testApp = await createTestApp();
  testApp.store.orders.insert(buildOrder({ id: 'order-1' }));
});

afterEach(async () => {
  await testApp.app.close();
});

const postPayment = (orderId = 'order-1', idempotencyKey: string | null = 'pay-key-1') =>
  testApp.app.inject({
    method: 'POST',
    url: `/orders/${orderId}/payments`,
    headers: idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey },
  });

describe('POST /orders/:id/payments', () => {
  it('returns 202 when the provider accepts; the final status arrives asynchronously', async () => {
    testApp.provider.respondWith({ outcome: 'accepted', providerPaymentId: 'prov-1' });

    const res = await postPayment();

    expect(res.statusCode).toBe(202);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.json()).toMatchObject({
      providerOutcome: 'accepted',
      payment: { id: 'pay_1', orderId: 'order-1', status: 'Initiated', providerPaymentId: 'prov-1' },
    });
  });

  it('returns 202 pending when the outcome is unknown (provider timed out)', async () => {
    testApp.provider.respondWith({ outcome: 'timedOut' }, { outcome: 'timedOut' }, { outcome: 'timedOut' });

    const res = await postPayment();

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ providerOutcome: 'pending', payment: { status: 'Initiated' } });
  });

  it('returns 402 when the provider declines', async () => {
    testApp.provider.respondWith({ outcome: 'declined', reason: 'insufficient funds' });

    const res = await postPayment();

    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ providerOutcome: 'declined', payment: { status: 'Failed' } });
  });

  it('replays a retried request without charging again', async () => {
    const first = await postPayment();
    const retry = await postPayment();

    expect(retry.statusCode).toBe(first.statusCode);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(testApp.provider.calls).toHaveLength(1);
  });

  it('returns 409 when another payment is already in progress', async () => {
    await postPayment('order-1', 'attempt-1');

    const res = await postPayment('order-1', 'attempt-2');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'PAYMENT_ALREADY_IN_PROGRESS', details: { paymentId: 'pay_1' } } });
  });

  it('returns 409 for an order that cannot take payment', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-paid', status: 'Paid' }));

    const res = await postPayment('order-paid');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'ORDER_NOT_PAYABLE' } });
  });

  it('returns 422 when the key is reused for a different order', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-2' }));
    await postPayment('order-1');

    const res = await postPayment('order-2');

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('returns 404 for an unknown order', async () => {
    const res = await postPayment('missing');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });
  });

  it('returns 400 without an Idempotency-Key', async () => {
    const res = await postPayment('order-1', null);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('shows the payment on the order', async () => {
    await postPayment();

    const res = await testApp.app.inject({ method: 'GET', url: '/orders/order-1' });

    expect(res.json()).toMatchObject({
      payments: [{ id: 'pay_1', status: 'Initiated' }],
      events: [{ type: 'PaymentInitiated' }],
    });
  });
});
