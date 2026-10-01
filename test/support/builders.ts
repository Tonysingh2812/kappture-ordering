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
    status: 'Initiated',
    providerIdempotencyKey: `idem-${id}`,
    version: 1,
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}
