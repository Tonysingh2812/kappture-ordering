import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/test-app.ts';

let testApp: TestApp;

beforeEach(async () => {
  testApp = await createTestApp();
});

afterEach(async () => {
  await testApp.app.close();
});

const validBody = {
  venueId: 'venue-1',
  tableRef: 'T12',
  items: [{ sku: 'burger', name: 'Burger', quantity: 2, unitPriceMinor: 1250 }],
  currency: 'GBP',
};

const postOrder = (body: unknown, idempotencyKey: string | null = 'key-1') =>
  testApp.app.inject({
    method: 'POST',
    url: '/orders',
    headers: idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey },
    payload: body as object,
  });

describe('POST /orders', () => {
  it('creates an order and returns 201', async () => {
    const res = await postOrder(validBody);

    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.json()).toMatchObject({ id: 'ord_1', status: 'AwaitingPayment', totalMinor: 2500, currency: 'GBP' });
  });

  it('replays the same response for a retried request, creating only one order', async () => {
    const first = await postOrder(validBody);
    const retry = await postOrder(validBody);

    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(testApp.store.orders.list()).toHaveLength(1);
  });

  it('returns 422 when the key is reused with a different body', async () => {
    await postOrder(validBody);
    const res = await postOrder({ ...validBody, tableRef: 'T99' });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('returns 409 with Retry-After while the original request is in progress', async () => {
    testApp.store.idempotency.tryBegin({
      scope: 'createOrder',
      key: 'key-1',
      requestHash: 'x',
      createdAt: testApp.clock.now(),
    });

    const res = await postOrder(validBody);

    expect(res.statusCode).toBe(409);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.json()).toMatchObject({ error: { code: 'REQUEST_IN_PROGRESS' } });
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const res = await postOrder(validBody, null);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(JSON.stringify(res.json())).toContain('Idempotency-Key');
  });

  it.each([
    ['missing items', { ...validBody, items: undefined }],
    ['quantity as a string', { ...validBody, items: [{ ...validBody.items[0], quantity: '2' }] }],
    ['missing venueId', { ...validBody, venueId: undefined }],
  ])('returns 400 for a malformed body (%s)', async (_label, body) => {
    const res = await postOrder(body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: expect.any(Array) } });
    expect(testApp.store.orders.list()).toHaveLength(0);
  });

  it('returns 400 with the business problems for an invalid order', async () => {
    const res = await postOrder({ ...validBody, currency: 'XYZ' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_ORDER', details: [expect.stringContaining('XYZ')] } });
  });

  it('returns 400 for a body that is not valid JSON', async () => {
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': 'key-1', 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /orders/:id', () => {
  it('returns the order with its history', async () => {
    await postOrder(validBody);

    const res = await testApp.app.inject({ method: 'GET', url: '/orders/ord_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      order: { id: 'ord_1', status: 'AwaitingPayment' },
      payments: [],
      events: [{ type: 'OrderCreated' }],
      reviewFlags: [],
    });
  });

  it('returns 404 for an unknown order', async () => {
    const res = await testApp.app.inject({ method: 'GET', url: '/orders/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });
  });
});
