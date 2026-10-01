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

const addFlag = () =>
  testApp.store.reviewFlags.insert({
    orderId: 'order-1',
    paymentId: null,
    reason: 'AMOUNT_MISMATCH',
    details: 'amount 1 does not match 2500',
    createdAt: testApp.clock.now(),
  });

describe('GET /review', () => {
  it('lists open flags', async () => {
    addFlag();

    const res = await testApp.app.inject({ method: 'GET', url: '/review' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [{ reason: 'AMOUNT_MISMATCH', order: { id: 'order-1' } }] });
  });

  it('returns an empty list when nothing needs review', async () => {
    const res = await testApp.app.inject({ method: 'GET', url: '/review' });

    expect(res.json()).toEqual({ items: [] });
  });
});

describe('POST /review/:id/resolve', () => {
  it('resolves an open flag, removing it from the queue', async () => {
    const flag = addFlag();

    const res = await testApp.app.inject({ method: 'POST', url: `/review/${flag.id}/resolve` });

    expect(res.statusCode).toBe(200);
    expect((await testApp.app.inject({ method: 'GET', url: '/review' })).json()).toEqual({ items: [] });
  });

  it('returns 404 for a flag that is unknown or already resolved', async () => {
    const flag = addFlag();
    await testApp.app.inject({ method: 'POST', url: `/review/${flag.id}/resolve` });

    const again = await testApp.app.inject({ method: 'POST', url: `/review/${flag.id}/resolve` });

    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: { code: 'FLAG_NOT_OPEN' } });
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await testApp.app.inject({ method: 'POST', url: '/review/abc/resolve' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});
