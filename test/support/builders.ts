import type { OrderRecord, PaymentRecord } from '../../src/application/ports/records.ts';

export const t0 = '2026-10-01T12:00:00.000Z';
export const t1 = '2026-10-01T12:00:01.000Z';
export const t2 = '2026-10-01T12:00:02.000Z';

export function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'order-1',
    venueId: 'venue-1',
    tableRef: 'T12',
    items: [{ sku: 'burger', name: 'Burger', quantity: 2, unitPriceMinor: 1250 }],
    totalMinor: 2500,
    currency: 'GBP',
    deviceId: 'device-builder',
    status: 'AwaitingPayment',
    version: 1,
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

export function buildPayment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  const id = overrides.id ?? 'pay-1';
  return {
    id,
    orderId: 'order-1',
    providerPaymentId: null,
    amountMinor: 2500,
    currency: 'GBP',
    deviceId: 'device-builder',
    status: 'Initiated',
    providerIdempotencyKey: `idem-${id}`,
    version: 1,
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

/** Random-looking UUIDs, as a phone would generate on first QR scan. */
export const deviceA = '6f1c2b7e-3d4a-4e8b-9c1d-2a3b4c5d6e7f';
export const deviceB = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
