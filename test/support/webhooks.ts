import { signWebhookBody } from '../../src/infrastructure/hmac-signature.ts';

export const testWebhookSecret = 'test-webhook-secret';

export interface ProviderEventBody {
  eventId?: unknown;
  type?: unknown;
  paymentId?: unknown;
  providerPaymentId?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  occurredAt?: unknown;
}

let eventCounter = 0;

export function providerEvent(overrides: ProviderEventBody = {}): ProviderEventBody {
  eventCounter += 1;
  return {
    eventId: `evt_${eventCounter}`,
    type: 'PaymentCaptured',
    paymentId: 'pay-1',
    providerPaymentId: 'prov-1',
    amountMinor: 2500,
    currency: 'GBP',
    occurredAt: '2026-10-01T12:00:05.000Z',
    ...overrides,
  };
}

/** A body exactly as the provider would send it, with a valid signature. */
export function signed(body: unknown, secret = testWebhookSecret): { rawBody: string; signature: string } {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return { rawBody, signature: signWebhookBody(secret, rawBody) };
}
