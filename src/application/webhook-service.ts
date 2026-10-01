import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PaymentEvent } from '../domain/types.ts';
import { persistPaymentEvent } from './payment-event-persistence.ts';
import type { IsoTimestamp, PaymentEventOutcome } from './ports/records.ts';
import type { DataStore } from './ports/repositories.ts';
import type { Clock } from './ports/system.ts';
import type { WebhookSignatureVerifier } from './ports/webhook-verifier.ts';

export interface PaymentWebhookInput {
  rawBody: string;
  signature: string | undefined;
}

type HandledOutcome = Exclude<PaymentEventOutcome, 'pending'>;

/**
 * Every authentic delivery is "handled" (and should be acknowledged so the provider stops retrying), whatever
 * its outcome: applied, duplicate, stale or rejected. Only unexpected internal errors throw.
 */
export type PaymentWebhookResult =
  | { isOk: true; providerEventId: string; outcome: HandledOutcome; reason: string }
  | { isOk: false; error: 'INVALID_SIGNATURE' };

export interface WebhookServiceDeps {
  dataStore: DataStore;
  clock: Clock;
  signatureVerifier: WebhookSignatureVerifier;
}

/** The provider's event contract (our assumption of it). Amounts are integer minor units. */
const providerEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(['PaymentAuthorised', 'PaymentCaptured', 'PaymentFailed', 'PaymentCancelled']),
  paymentId: z.string().min(1),
  providerPaymentId: z.string().min(1).optional(),
  amountMinor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  occurredAt: z.string().optional(),
});

type ProviderEvent = z.infer<typeof providerEventSchema>;

type ParsedDelivery =
  | { isValid: true; event: ProviderEvent }
  | { isValid: false; providerEventId: string; paymentId: string | null; type: string; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Turns a raw body into a provider event, or describes why it isn't one. An invalid delivery still gets an id
 * (its own eventId if it has one, otherwise a hash of the body) so it can be dead-lettered and deduplicated.
 */
function parseDelivery(rawBody: string): ParsedDelivery {
  const contentId = `invalid:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { isValid: false, providerEventId: contentId, paymentId: null, type: 'unparseable', reason: 'Body is not valid JSON' };
  }

  const parsed = providerEventSchema.safeParse(json);
  if (parsed.success) return { isValid: true, event: parsed.data };

  const fields = isRecord(json) ? json : {};
  const hasEventId = typeof fields.eventId === 'string' && fields.eventId.length > 0;
  return {
    isValid: false,
    providerEventId: hasEventId ? (fields.eventId as string) : contentId,
    paymentId: typeof fields.paymentId === 'string' ? fields.paymentId : null,
    type: typeof fields.type === 'string' ? fields.type : 'unknown',
    reason: `Invalid event: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
  };
}

function toDomainEvent(event: ProviderEvent): PaymentEvent {
  return {
    type: event.type,
    paymentId: event.paymentId,
    ...(event.amountMinor === undefined ? {} : { amountMinor: event.amountMinor }),
    ...(event.currency === undefined ? {} : { currency: event.currency }),
  };
}

export function createWebhookService({ dataStore, clock, signatureVerifier }: WebhookServiceDeps) {
  /** Records the delivery. Returns a duplicate result if this provider event id was seen before, else null. */
  function recordDelivery(
    providerEventId: string,
    paymentId: string | null,
    type: string,
    rawBody: string,
    now: IsoTimestamp,
  ): PaymentWebhookResult | null {
    const delivery = dataStore.paymentEvents.recordDelivery({ providerEventId, paymentId, type, payload: rawBody, receivedAt: now });
    if (delivery.isFirstDelivery) return null;
    return {
      isOk: true,
      providerEventId,
      outcome: 'duplicate',
      reason: `Delivery ${delivery.record.deliveryCount} of an event already processed (outcome: ${delivery.record.outcome})`,
    };
  }

  function finish(providerEventId: string, outcome: HandledOutcome, reason: string): PaymentWebhookResult {
    dataStore.paymentEvents.setOutcome(providerEventId, outcome, reason);
    return { isOk: true, providerEventId, outcome, reason };
  }

  return {
    /**
     * Verifies, records and applies one provider event in a single transaction, so the dedupe record and the
     * state change are committed together (or not at all, in which case the provider's retry starts fresh).
     */
    handlePaymentWebhook({ rawBody, signature }: PaymentWebhookInput): PaymentWebhookResult {
      // Unauthenticated bodies are not recorded: anyone could otherwise fill the dead-letter store.
      if (!signatureVerifier.isValid(rawBody, signature)) return { isOk: false, error: 'INVALID_SIGNATURE' };

      return dataStore.runInTransaction((): PaymentWebhookResult => {
        const now = clock.now();
        const parsed = parseDelivery(rawBody);

        if (!parsed.isValid) {
          const duplicate = recordDelivery(parsed.providerEventId, parsed.paymentId, parsed.type, rawBody, now);
          return duplicate ?? finish(parsed.providerEventId, 'rejected', parsed.reason);
        }

        const { event } = parsed;
        const duplicate = recordDelivery(event.eventId, event.paymentId, event.type, rawBody, now);
        if (duplicate) return duplicate;

        const payment = dataStore.payments.findById(event.paymentId);
        if (!payment) return finish(event.eventId, 'rejected', `Unknown payment ${event.paymentId}`);
        const order = dataStore.orders.findById(payment.orderId)!;

        const decision = persistPaymentEvent(dataStore, { order, payment, event: toDomainEvent(event), now });

        // If the initiation response was lost, the webhook is how we learn the provider's reference.
        if (decision.outcome !== 'rejected' && event.providerPaymentId !== undefined) {
          const current = dataStore.payments.findById(payment.id)!;
          if (current.providerPaymentId === null) {
            dataStore.payments.update(payment.id, { providerPaymentId: event.providerPaymentId }, current.version, now);
          }
        }

        return finish(event.eventId, decision.outcome, decision.reason);
      });
    },
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;
