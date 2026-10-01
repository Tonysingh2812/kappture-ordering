import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrder, buildPayment, t0, t1 } from '../support/builders.ts';
import { createTestApp, type TestApp } from '../support/test-app.ts';
import { providerEvent, signed } from '../support/webhooks.ts';

let testApp: TestApp;

beforeEach(async () => {
  testApp = await createTestApp();
});

afterEach(async () => {
  await testApp.app.close();
});

const get = (url: string) => testApp.app.inject({ method: 'GET', url });
const complete = (orderId: string) => testApp.app.inject({ method: 'POST', url: `/orders/${orderId}/complete` });

describe('POST /orders/:id/complete', () => {
  it('completes a paid order', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-1', status: 'Paid' }));

    const res = await complete('order-1');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasChanged: true, order: { id: 'order-1', status: 'Completed' } });
  });

  it('is idempotent: a repeat returns 200 with hasChanged false', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-1', status: 'Paid' }));
    await complete('order-1');

    const again = await complete('order-1');

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ hasChanged: false, order: { status: 'Completed' } });
  });

  it('returns 409 for an order that is not paid', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-1' }));

    const res = await complete('order-1');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'ORDER_NOT_PAID', details: { orderStatus: 'AwaitingPayment' } } });
  });

  it('returns 404 for an unknown order', async () => {
    const res = await complete('missing');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });
  });
});

describe('listing endpoints', () => {
  beforeEach(() => {
    testApp.store.orders.insert(buildOrder({ id: 'a', createdAt: t0 }));
    testApp.store.orders.insert(buildOrder({ id: 'b', createdAt: t1, status: 'Paid' }));
    testApp.store.payments.insert(buildPayment({ id: 'p1', orderId: 'b', status: 'Captured' }));
  });

  it('GET /orders lists orders with paging info, filtered by status', async () => {
    const res = await get('/orders?status=Paid');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [{ id: 'b', status: 'Paid' }], limit: 50, offset: 0 });
  });

  it('GET /orders paginates', async () => {
    expect((await get('/orders?limit=1&offset=1')).json()).toMatchObject({ items: [{ id: 'b' }], limit: 1, offset: 1 });
  });

  it.each([
    ['an unknown status', '/orders?status=Shipped'],
    ['a limit above 200', '/orders?limit=500'],
    ['a negative offset', '/orders?offset=-1'],
    ['an unknown payment status', '/payments?status=Pending'],
    ['an unknown event outcome', '/payment-events?outcome=lost'],
  ])('returns 400 for %s', async (_label, url) => {
    const res = await get(url);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('GET /payments lists payments filtered by status', async () => {
    expect((await get('/payments?status=Captured')).json()).toMatchObject({ items: [{ id: 'p1', orderId: 'b' }] });
  });

  it('GET /payment-events?outcome=rejected shows dead-lettered webhooks', async () => {
    const { rawBody, signature } = signed('{not json');
    await testApp.app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
      payload: rawBody,
    });

    const res = await get('/payment-events?outcome=rejected');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [{ outcome: 'rejected', reason: 'Body is not valid JSON' }] });
  });
});

describe('GET /orders/:id/timeline', () => {
  it('shows the full history, including duplicate and stale provider events with their outcomes', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-1' }));
    testApp.store.payments.insert(buildPayment({ id: 'pay-1', orderId: 'order-1' }));
    const send = (body: unknown) => {
      const { rawBody, signature } = signed(body);
      return testApp.app.inject({
        method: 'POST',
        url: '/webhooks/payments',
        headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
        payload: rawBody,
      });
    };
    const capture = providerEvent({ eventId: 'evt-cap', paymentId: 'pay-1' });
    await send(capture);
    await send(capture);
    await send(providerEvent({ eventId: 'evt-auth', type: 'PaymentAuthorised', paymentId: 'pay-1' }));

    const res = await get('/orders/order-1/timeline');

    expect(res.statusCode).toBe(200);
    const providerEntries = (res.json().entries as { source: string }[]).filter((e) => e.source === 'provider');
    expect(providerEntries).toMatchObject([
      { providerEventId: 'evt-cap', outcome: 'applied', deliveryCount: 2 },
      { providerEventId: 'evt-auth', outcome: 'stale' },
    ]);
  });

  it('returns 404 for an unknown order', async () => {
    const res = await get('/orders/missing/timeline');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });
  });
});
