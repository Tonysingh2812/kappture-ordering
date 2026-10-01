import { beforeEach, describe, expect, it } from 'vitest';
import { createOrderService, type CreateOrderInput, type OrderService } from '../../src/application/order-service.ts';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { deviceA, deviceB } from '../support/builders.ts';
import { FakeClock, SequentialIdGenerator } from '../support/fakes.ts';

let store: DataStore;
let clock: FakeClock;
let service: OrderService;

beforeEach(() => {
  store = createSqliteDataStore(openDatabase(':memory:'));
  clock = new FakeClock();
  service = createOrderService({ dataStore: store, clock, idGenerator: new SequentialIdGenerator() });
});

const input = (overrides: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  idempotencyKey: 'key-1',
  deviceId: deviceA,
  venueId: 'venue-1',
  tableRef: 'T12',
  items: [
    { sku: 'burger', name: 'Burger', quantity: 2, unitPriceMinor: 1250 },
    { sku: 'chips', name: 'Chips', quantity: 1, unitPriceMinor: 350 },
  ],
  currency: 'GBP',
  ...overrides,
});

describe('createOrder', () => {
  it('creates an order awaiting payment with a server-computed total', () => {
    const result = service.createOrder(input());

    expect(result).toMatchObject({
      isOk: true,
      isReplay: false,
      order: { id: 'ord_1', status: 'AwaitingPayment', totalMinor: 2850, currency: 'GBP', tableRef: 'T12' },
    });
    expect(store.orders.findById('ord_1')).toMatchObject({ status: 'AwaitingPayment', totalMinor: 2850 });
  });

  it('records an OrderCreated event', () => {
    service.createOrder(input());

    expect(store.orderEvents.listByOrderId('ord_1')).toMatchObject([
      { type: 'OrderCreated', data: { totalMinor: 2850, currency: 'GBP' }, occurredAt: clock.now() },
    ]);
  });

  describe('duplicate submission (client retry after timeout)', () => {
    it('replays the original result for the same key and body, without creating a second order', () => {
      const first = service.createOrder(input());
      clock.advanceMs(5_000);
      const retry = service.createOrder(input());

      expect(retry).toEqual({ ...first, isReplay: true });
      expect(store.orders.list()).toHaveLength(1);
      expect(store.orderEvents.listByOrderId('ord_1')).toHaveLength(1);
    });

    it('treats the body as the same regardless of JSON key order', () => {
      service.createOrder(input());
      const reordered = service.createOrder({
        currency: 'GBP',
        tableRef: 'T12',
        venueId: 'venue-1',
        idempotencyKey: 'key-1',
        deviceId: deviceA,
        items: input().items.map(({ unitPriceMinor, quantity, name, sku }) => ({ unitPriceMinor, quantity, name, sku })),
      });

      expect(reordered).toMatchObject({ isOk: true, isReplay: true });
      expect(store.orders.list()).toHaveLength(1);
    });

    it('rejects reuse of a key with a different body', () => {
      service.createOrder(input());
      const result = service.createOrder(input({ tableRef: 'T99' }));

      expect(result).toEqual({ isOk: false, error: 'IDEMPOTENCY_KEY_REUSED' });
      expect(store.orders.list()).toHaveLength(1);
    });

    it('reports a request still in progress for the same key', () => {
      store.idempotency.tryBegin({ scope: `createOrder:${deviceA}`, key: 'key-1', requestHash: 'whatever', createdAt: clock.now() });

      expect(service.createOrder(input())).toEqual({ isOk: false, error: 'REQUEST_IN_PROGRESS' });
      expect(store.orders.list()).toHaveLength(0);
    });

    it('creates separate orders for different keys, even with an identical body', () => {
      service.createOrder(input({ idempotencyKey: 'key-1' }));
      service.createOrder(input({ idempotencyKey: 'key-2' }));

      expect(store.orders.list()).toHaveLength(2);
    });
  });

  describe('invalid orders', () => {
    it('rejects an invalid order without persisting anything', () => {
      const result = service.createOrder(input({ items: [] }));

      expect(result).toMatchObject({ isOk: false, error: 'INVALID_ORDER', problems: [expect.any(String)] });
      expect(store.orders.list()).toHaveLength(0);
    });

    it('does not consume the idempotency key, so the client can retry with a corrected body', () => {
      service.createOrder(input({ currency: 'XYZ' }));
      const corrected = service.createOrder(input());

      expect(corrected).toMatchObject({ isOk: true, isReplay: false });
    });
  });

  describe('failure part-way through', () => {
    it('rolls back the order and releases the key, so a retry succeeds', () => {
      const failingStore: DataStore = {
        ...store,
        orderEvents: {
          ...store.orderEvents,
          append: () => {
            throw new Error('disk full');
          },
        },
      };
      const failingService = createOrderService({
        dataStore: failingStore,
        clock,
        idGenerator: new SequentialIdGenerator(),
      });

      expect(() => failingService.createOrder(input())).toThrow('disk full');
      expect(store.orders.list()).toHaveLength(0);

      expect(service.createOrder(input())).toMatchObject({ isOk: true, isReplay: false });
      expect(store.orders.list()).toHaveLength(1);
    });
  });
});

describe('getOrder', () => {
  it('returns the order with its payments, events and review flags', () => {
    service.createOrder(input());

    const result = service.getOrder('ord_1');

    expect(result).toMatchObject({
      isOk: true,
      details: {
        order: { id: 'ord_1', status: 'AwaitingPayment' },
        payments: [],
        events: [{ type: 'OrderCreated' }],
        reviewFlags: [],
      },
    });
  });

  it('does not expose the internal version field', () => {
    service.createOrder(input());
    const result = service.getOrder('ord_1');

    expect(result.isOk && 'version' in result.details.order).toBe(false);
  });

  it('reports an unknown order', () => {
    expect(service.getOrder('missing')).toEqual({ isOk: false, error: 'ORDER_NOT_FOUND' });
  });
});

describe('completeOrder', () => {
  const createPaidOrder = () => {
    service.createOrder(input());
    const order = store.orders.findById('ord_1')!;
    store.orders.updateStatus('ord_1', 'Paid', order.version, clock.now());
  };

  it('completes a paid order and records OrderCompleted', () => {
    createPaidOrder();
    clock.advanceMs(60_000);

    const result = service.completeOrder('ord_1');

    expect(result).toMatchObject({ isOk: true, hasChanged: true, order: { id: 'ord_1', status: 'Completed' } });
    expect(store.orders.findById('ord_1')).toMatchObject({ status: 'Completed', updatedAt: clock.now() });
    expect(store.orderEvents.listByOrderId('ord_1').at(-1)).toMatchObject({ type: 'OrderCompleted', occurredAt: clock.now() });
  });

  it('is idempotent: completing again changes nothing and records no second event', () => {
    createPaidOrder();
    service.completeOrder('ord_1');

    const again = service.completeOrder('ord_1');

    expect(again).toMatchObject({ isOk: true, hasChanged: false, order: { status: 'Completed' } });
    expect(store.orderEvents.listByOrderId('ord_1').filter((e) => e.type === 'OrderCompleted')).toHaveLength(1);
  });

  it('refuses to complete an order that has not been paid', () => {
    service.createOrder(input());

    expect(service.completeOrder('ord_1')).toEqual({ isOk: false, error: 'ORDER_NOT_PAID', orderStatus: 'AwaitingPayment' });
    expect(store.orders.findById('ord_1')).toMatchObject({ status: 'AwaitingPayment' });
  });

  it('reports an unknown order', () => {
    expect(service.completeOrder('missing')).toEqual({ isOk: false, error: 'ORDER_NOT_FOUND' });
  });
});

describe('device scoping and soft duplicate detection (KAP-11)', () => {
  it('records the device on the order and in OrderCreated', () => {
    service.createOrder(input());

    expect(store.orders.findById('ord_1')).toMatchObject({ deviceId: deviceA });
    expect(store.orderEvents.listByOrderId('ord_1')[0]).toMatchObject({ data: { deviceId: deviceA } });
  });

  it('scopes idempotency keys per device: the same key from two devices creates two orders', () => {
    const fromA = service.createOrder(input({ deviceId: deviceA, tableRef: 'T1' }));
    const fromB = service.createOrder(input({ deviceId: deviceB, tableRef: 'T2' }));

    expect(fromA).toMatchObject({ isOk: true, isReplay: false, order: { id: 'ord_1' } });
    expect(fromB).toMatchObject({ isOk: true, isReplay: false, order: { id: 'ord_2' } });
  });

  it("never replays another device's stored result for the same key", () => {
    service.createOrder(input({ deviceId: deviceA }));

    const fromB = service.createOrder(input({ deviceId: deviceB }));

    expect(fromB).toMatchObject({ isOk: true, isReplay: false, order: { id: 'ord_2', deviceId: deviceB } });
  });

  it('still replays a genuine retry from the same device and key', () => {
    service.createOrder(input());

    expect(service.createOrder(input())).toMatchObject({ isOk: true, isReplay: true, order: { id: 'ord_1' } });
  });

  describe('same device, identical basket, new key (e.g. page reload lost the key)', () => {
    it('within 60s: refuses as a possible duplicate, pointing at the existing order', () => {
      service.createOrder(input({ idempotencyKey: 'key-1' }));
      clock.advanceMs(60_000);

      const result = service.createOrder(input({ idempotencyKey: 'key-2' }));

      expect(result).toEqual({ isOk: false, error: 'POSSIBLE_DUPLICATE', existingOrderId: 'ord_1' });
      expect(store.orders.list()).toHaveLength(1);
    });

    it('creates it when the customer confirms, reusing the same key', () => {
      service.createOrder(input({ idempotencyKey: 'key-1' }));
      service.createOrder(input({ idempotencyKey: 'key-2' }));

      const confirmed = service.createOrder(input({ idempotencyKey: 'key-2', confirmDuplicate: true }));

      expect(confirmed).toMatchObject({ isOk: true, isReplay: false, order: { id: 'ord_2' } });
      expect(store.orders.list()).toHaveLength(2);
    });

    it('after 60s: creates a new order (a genuine "same again")', () => {
      service.createOrder(input({ idempotencyKey: 'key-1' }));
      clock.advanceMs(60_001);

      expect(service.createOrder(input({ idempotencyKey: 'key-2' }))).toMatchObject({ isOk: true, isReplay: false });
    });
  });

  it('does not treat the same basket from a different device as a duplicate (two people, same table)', () => {
    service.createOrder(input({ idempotencyKey: 'key-1', deviceId: deviceA }));

    expect(service.createOrder(input({ idempotencyKey: 'key-2', deviceId: deviceB }))).toMatchObject({ isOk: true });
  });

  it('does not treat a different basket from the same device as a duplicate', () => {
    service.createOrder(input({ idempotencyKey: 'key-1' }));

    const different = service.createOrder(
      input({ idempotencyKey: 'key-2', items: [{ sku: 'cola', name: 'Cola', quantity: 1, unitPriceMinor: 300 }] }),
    );

    expect(different).toMatchObject({ isOk: true });
  });

  it('treats the basket as identical regardless of item field order', () => {
    service.createOrder(input({ idempotencyKey: 'key-1' }));
    const reordered = input({
      idempotencyKey: 'key-2',
      items: input().items.map(({ unitPriceMinor, quantity, name, sku }) => ({ unitPriceMinor, quantity, name, sku })),
    });

    expect(service.createOrder(reordered)).toMatchObject({ isOk: false, error: 'POSSIBLE_DUPLICATE' });
  });
});
