/**
 * End-to-end: a real server on a real port, a real SQLite file, real HTTP. One test per failure mode in the brief,
 * plus the agreed "PaymentCaptured while AwaitingPayment" decision and durability across a restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { FakePaymentProvider } from '../../src/infrastructure/fake-payment-provider.ts';
import { signWebhookBody } from '../../src/infrastructure/hmac-signature.ts';
import { createSqliteDataStore, openDatabase, type SqliteDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { systemClock, uuidIdGenerator } from '../../src/infrastructure/system.ts';
import { InstantSleeper } from '../support/fakes.ts';

const secret = 'e2e-secret';
let dir: string;
let db: SqliteDatabase;
let app: FastifyInstance;
let baseUrl: string;
let provider: FakePaymentProvider;

async function startServer() {
  db = openDatabase(join(dir, 'e2e.db'));
  provider = new FakePaymentProvider();
  app = buildApp({
    dataStore: createSqliteDataStore(db),
    clock: systemClock,
    idGenerator: uuidIdGenerator,
    paymentProvider: provider,
    sleeper: new InstantSleeper(),
    webhookSecret: secret,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

async function stopServer() {
  await app.close();
  db.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kappture-e2e-'));
  await startServer();
});

afterEach(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, options: { headers?: Record<string, string>; body?: string } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: options.headers ?? {}, ...(options.body ? { body: options.body } : {}) });
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
};

const basket = {
  venueId: 'venue-1',
  tableRef: 'T12',
  items: [{ sku: 'burger', name: 'Burger', quantity: 2, unitPriceMinor: 1250 }],
  currency: 'GBP',
};

const createOrder = (key: string) =>
  call('POST', '/orders', {
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(basket),
  });

const initiatePayment = (orderId: string, key: string) =>
  call('POST', `/orders/${orderId}/payments`, { headers: { 'idempotency-key': key } });

const webhook = (event: object | string, signature?: string) => {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  return call('POST', '/webhooks/payments', {
    headers: { 'content-type': 'application/json', 'x-provider-signature': signature ?? signWebhookBody(secret, body) },
    body,
  });
};

const event = (eventId: string, type: string, paymentId: string, extra: object = {}) => ({
  eventId,
  type,
  paymentId,
  amountMinor: 2500,
  currency: 'GBP',
  ...extra,
});

const getOrder = async (orderId: string) => (await call('GET', `/orders/${orderId}`)).json;

describe('E2E: happy path', () => {
  it('create → pay → Authorised → Captured → Paid → complete → Completed, with a full timeline', async () => {
    const order = await createOrder('o1');
    expect(order.status).toBe(201);
    const payment = await initiatePayment(order.json.id, 'p1');
    expect(payment.status).toBe(202);
    const paymentId = payment.json.payment.id;

    expect((await webhook(event('e1', 'PaymentAuthorised', paymentId))).json.outcome).toBe('applied');
    expect((await webhook(event('e2', 'PaymentCaptured', paymentId))).json.outcome).toBe('applied');
    expect((await getOrder(order.json.id)).order.status).toBe('Paid');

    const completed = await call('POST', `/orders/${order.json.id}/complete`);
    expect(completed.json.order.status).toBe('Completed');

    const timeline = await call('GET', `/orders/${order.json.id}/timeline`);
    expect(timeline.json.entries.filter((e: any) => e.source === 'order').map((e: any) => e.type)).toEqual([
      'OrderCreated',
      'PaymentInitiated',
      'PaymentAuthorised',
      'PaymentCaptured',
      'OrderPaid',
      'OrderCompleted',
    ]);
  });
});

describe('E2E: failure modes from the brief', () => {
  it('duplicate order submission: a retried POST creates one order and replays the response', async () => {
    const first = await createOrder('same-key');
    const retry = await createOrder('same-key');

    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.json.id).toBe(first.json.id);
    expect((await call('GET', '/orders')).json.items).toHaveLength(1);
  });

  it('duplicate payment request: a retried payment POST does not charge twice', async () => {
    const order = await createOrder('o1');
    await initiatePayment(order.json.id, 'p1');
    const retry = await initiatePayment(order.json.id, 'p1');

    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(provider.calls).toHaveLength(1);
  });

  it('duplicate callback: the same webhook three times is applied once', async () => {
    const order = await createOrder('o1');
    const paymentId = (await initiatePayment(order.json.id, 'p1')).json.payment.id;
    const captured = event('dup-1', 'PaymentCaptured', paymentId);

    const outcomes = [];
    for (let i = 0; i < 3; i += 1) outcomes.push((await webhook(captured)).json.outcome);

    expect(outcomes).toEqual(['applied', 'duplicate', 'duplicate']);
    const events = (await call('GET', '/payment-events')).json.items;
    expect(events).toMatchObject([{ providerEventId: 'dup-1', deliveryCount: 3, outcome: 'applied' }]);
  });

  it('out-of-order events: Captured before Authorised → Paid (flagged), late Authorised is stale', async () => {
    const order = await createOrder('o1');
    const paymentId = (await initiatePayment(order.json.id, 'p1')).json.payment.id;

    expect((await webhook(event('c', 'PaymentCaptured', paymentId))).json.outcome).toBe('applied');
    expect((await webhook(event('a', 'PaymentAuthorised', paymentId))).json.outcome).toBe('stale');

    expect((await getOrder(order.json.id)).order.status).toBe('Paid');
    const review = await call('GET', '/review');
    expect(review.json.items.map((i: any) => i.reason)).toEqual(['CAPTURE_WITHOUT_AUTHORISATION']);
  });

  it('invalid event or order: bad events are dead-lettered and do not block other orders', async () => {
    const orderA = await createOrder('oA');
    const orderB = await createOrder('oB');
    const paymentB = (await initiatePayment(orderB.json.id, 'pB')).json.payment.id;

    const garbage = await webhook('{not json');
    const unknownPayment = await webhook(event('x1', 'PaymentCaptured', 'pay_does_not_exist'));
    const badSignature = await webhook(event('x2', 'PaymentCaptured', paymentB), 'forged');
    const valid = await webhook(event('ok', 'PaymentCaptured', paymentB));

    expect([garbage.status, unknownPayment.status, badSignature.status, valid.status]).toEqual([200, 200, 401, 200]);
    expect(valid.json.outcome).toBe('applied');
    expect((await getOrder(orderB.json.id)).order.status).toBe('Paid');
    expect((await getOrder(orderA.json.id)).order.status).toBe('AwaitingPayment');
    expect((await call('GET', '/payment-events?outcome=rejected')).json.items).toHaveLength(2);
  });

  it('uncertain outcome: initiation times out, the payment later succeeds via webhook', async () => {
    provider.respondWith({ outcome: 'timedOut' }, { outcome: 'timedOut' }, { outcome: 'timedOut' });
    const order = await createOrder('o1');

    const payment = await initiatePayment(order.json.id, 'p1');
    expect(payment.status).toBe(202);
    expect(payment.json).toMatchObject({ providerOutcome: 'pending', payment: { status: 'Initiated' } });

    await webhook(event('late', 'PaymentCaptured', payment.json.payment.id));

    expect(await getOrder(order.json.id)).toMatchObject({ order: { status: 'Paid' }, payments: [{ status: 'Captured' }] });
  });
});

describe('E2E: durability', () => {
  it('state and dedupe survive a server restart on the same database file', async () => {
    const order = await createOrder('o1');
    const paymentId = (await initiatePayment(order.json.id, 'p1')).json.payment.id;
    const captured = event('persist-1', 'PaymentCaptured', paymentId);
    await webhook(captured);

    await stopServer();
    await startServer();

    expect((await getOrder(order.json.id)).order.status).toBe('Paid');
    expect((await webhook(captured)).json.outcome).toBe('duplicate');
    expect((await createOrder('o1')).headers.get('idempotent-replayed')).toBe('true');
  });
});
