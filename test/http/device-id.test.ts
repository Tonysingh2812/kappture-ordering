import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrder, deviceA, deviceB } from '../support/builders.ts';
import { createTestApp, type TestApp } from '../support/test-app.ts';

let testApp: TestApp;

beforeEach(async () => {
  testApp = await createTestApp();
});

afterEach(async () => {
  await testApp.app.close();
});

const basket = {
  venueId: 'venue-1',
  tableRef: 'T12',
  items: [{ sku: 'burger', name: 'Burger', quantity: 2, unitPriceMinor: 1250 }],
  currency: 'GBP',
};

const postOrder = (headers: Record<string, string>, body: object = basket) =>
  testApp.app.inject({ method: 'POST', url: '/orders', headers, payload: body });

describe('X-Device-Id header', () => {
  it.each([
    ['missing', {}],
    ['not a UUID', { 'x-device-id': 'my-phone' }],
  ])('POST /orders returns 400 when the device id is %s', async (_label, deviceHeader) => {
    const res = await postOrder({ 'idempotency-key': 'k1', ...deviceHeader });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(JSON.stringify(res.json())).toContain('X-Device-Id');
  });

  it('POST /orders/:id/payments returns 400 without a device id', async () => {
    testApp.store.orders.insert(buildOrder({ id: 'order-1' }));

    const res = await testApp.app.inject({
      method: 'POST',
      url: '/orders/order-1/payments',
      headers: { 'idempotency-key': 'k1' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('soft duplicate detection over HTTP', () => {
  it('returns 409 POSSIBLE_DUPLICATE with the existing order, then creates on confirmation', async () => {
    const first = await postOrder({ 'idempotency-key': 'k1', 'x-device-id': deviceA });

    const suspect = await postOrder({ 'idempotency-key': 'k2', 'x-device-id': deviceA });

    expect(suspect.statusCode).toBe(409);
    expect(suspect.json()).toMatchObject({
      error: { code: 'POSSIBLE_DUPLICATE', details: { existingOrderId: first.json().id } },
    });

    const confirmed = await postOrder({ 'idempotency-key': 'k2', 'x-device-id': deviceA }, { ...basket, confirmDuplicate: true });

    expect(confirmed.statusCode).toBe(201);
    expect(testApp.store.orders.list()).toHaveLength(2);
  });

  it('creates the same basket from a different device without question', async () => {
    await postOrder({ 'idempotency-key': 'k1', 'x-device-id': deviceA });

    const other = await postOrder({ 'idempotency-key': 'k1', 'x-device-id': deviceB });

    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBe('false');
  });

  it('rejects a non-boolean confirmDuplicate', async () => {
    const res = await postOrder({ 'idempotency-key': 'k1', 'x-device-id': deviceA }, { ...basket, confirmDuplicate: 'yes' });

    expect(res.statusCode).toBe(400);
  });
});
