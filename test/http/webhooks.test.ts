import { afterEach, describe, expect, it } from 'vitest';
import { buildOrder, buildPayment } from '../support/builders.ts';
import { createTestApp, type TestApp } from '../support/test-app.ts';
import { providerEvent, signed } from '../support/webhooks.ts';

let testApp: TestApp;

afterEach(async () => {
  await testApp.app.close();
});

const start = async (options: Parameters<typeof createTestApp>[0] = {}) => {
  testApp = await createTestApp(options);
  for (const n of [1, 2]) {
    testApp.store.orders.insert(buildOrder({ id: `order-${n}` }));
    testApp.store.payments.insert(buildPayment({ id: `pay-${n}`, orderId: `order-${n}` }));
  }
};

const postWebhook = (body: unknown, signatureOverride?: string) => {
  const { rawBody, signature } = signed(body);
  return testApp.app.inject({
    method: 'POST',
    url: '/webhooks/payments',
    headers: { 'content-type': 'application/json', 'x-provider-signature': signatureOverride ?? signature },
    payload: rawBody,
  });
};

describe('POST /webhooks/payments', () => {
  it('returns 200 and applies a valid capture', async () => {
    await start();

    const res = await postWebhook(providerEvent({ eventId: 'evt_1' }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ providerEventId: 'evt_1', outcome: 'applied' });
    expect(testApp.store.orders.findById('order-1')).toMatchObject({ status: 'Paid' });
  });

  it('returns 200 for every repeat delivery, so the provider stops retrying', async () => {
    await start();
    const event = providerEvent();

    const responses = [await postWebhook(event), await postWebhook(event), await postWebhook(event)];

    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.json().outcome)).toEqual(['applied', 'duplicate', 'duplicate']);
  });

  it('returns 401 for a bad signature', async () => {
    await start();

    const res = await postWebhook(providerEvent(), 'not-a-signature');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(testApp.store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment' });
  });

  it('acknowledges malformed events with 200 (dead-lettered) and keeps processing other orders', async () => {
    await start();

    const garbage = await postWebhook('{not json');
    const invalid = await postWebhook(providerEvent({ type: 'Nonsense', paymentId: 'pay-1' }));
    const valid = await postWebhook(providerEvent({ paymentId: 'pay-2' }));

    expect(garbage.statusCode).toBe(200);
    expect(garbage.json()).toMatchObject({ outcome: 'rejected' });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ outcome: 'rejected' });
    expect(valid.json()).toMatchObject({ outcome: 'applied' });
    expect(testApp.store.orders.findById('order-1')).toMatchObject({ status: 'AwaitingPayment' });
    expect(testApp.store.orders.findById('order-2')).toMatchObject({ status: 'Paid' });
  });

  it('returns 500 on an internal failure, without partial writes, so the provider retries', async () => {
    let shouldFail = true;
    await start({
      wrapStore: (store) => ({
        ...store,
        orderEvents: {
          ...store.orderEvents,
          append: (event) => {
            if (shouldFail) throw new Error('disk I/O error');
            return store.orderEvents.append(event);
          },
        },
      }),
    });
    const event = providerEvent({ eventId: 'evt_retry' });

    const failed = await postWebhook(event);

    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(failed.json())).not.toContain('disk I/O');
    expect(testApp.store.paymentEvents.findByProviderEventId('evt_retry')).toBeNull();

    shouldFail = false;
    const retried = await postWebhook(event);

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ outcome: 'applied' });
  });
});
