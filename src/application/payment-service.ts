import { toPaymentView, type PaymentView } from './order-service.ts';
import { persistPaymentEvent } from './payment-event-persistence.ts';
import type { InitiatePaymentRequest, InitiatePaymentResponse, PaymentProvider } from './ports/payment-provider.ts';
import type { PaymentRecord } from './ports/records.ts';
import type { DataStore } from './ports/repositories.ts';
import type { Clock, IdGenerator, Sleeper } from './ports/system.ts';
import { hashRequest } from './request-hash.ts';
import { callWithRetry, defaultRetryPolicy, type RetryPolicy } from './retry.ts';

export interface InitiatePaymentInput {
  orderId: string;
  idempotencyKey: string;
}

/**
 * - `accepted`: the provider took the payment; its final status arrives asynchronously.
 * - `pending`: we don't know what happened (timeout or retries exhausted). The webhook or reconciliation decides.
 * - `declined`: the provider definitively refused; the payment is Failed and the customer may try again.
 */
export type ProviderOutcome = 'accepted' | 'pending' | 'declined';

type InitiatePaymentSuccess = { isOk: true; payment: PaymentView; providerOutcome: ProviderOutcome; isReplay: boolean };

export type InitiatePaymentResult =
  | InitiatePaymentSuccess
  | { isOk: false; error: 'ORDER_NOT_FOUND' }
  | { isOk: false; error: 'ORDER_NOT_PAYABLE'; orderStatus: string }
  | { isOk: false; error: 'PAYMENT_ALREADY_IN_PROGRESS'; paymentId: string }
  | { isOk: false; error: 'IDEMPOTENCY_KEY_REUSED' }
  | { isOk: false; error: 'REQUEST_IN_PROGRESS' };

export interface PaymentServiceDeps {
  dataStore: DataStore;
  clock: Clock;
  idGenerator: IdGenerator;
  paymentProvider: PaymentProvider;
  sleeper: Sleeper;
  random?: () => number;
  retryPolicy?: RetryPolicy;
}

const initiatePaymentScope = 'initiatePayment';

const isRetryable = (response: InitiatePaymentResponse) =>
  response.outcome === 'transientError' || response.outcome === 'timedOut';

export function createPaymentService(deps: PaymentServiceDeps) {
  const { dataStore, clock, idGenerator, paymentProvider, sleeper } = deps;
  const random = deps.random ?? Math.random;
  const retryPolicy = deps.retryPolicy ?? defaultRetryPolicy;

  type ClaimOutcome = { shouldProceed: false; result: InitiatePaymentResult } | { shouldProceed: true; payment: PaymentRecord };

  /**
   * Phase 1 (one transaction): claim the idempotency key, check the order can be paid, and save the
   * payment as Initiated *before* any provider call, so a webhook that beats the response can be matched.
   */
  function claimAndCreatePayment(input: InitiatePaymentInput): ClaimOutcome {
    const requestHash = hashRequest({ orderId: input.orderId });

    return dataStore.runInTransaction((): ClaimOutcome => {
      const now = clock.now();
      const existing = dataStore.idempotency.tryBegin({
        scope: initiatePaymentScope,
        key: input.idempotencyKey,
        requestHash,
        createdAt: now,
      });

      if (existing) {
        if (existing.status === 'in_progress' || existing.result === null) {
          return { shouldProceed: false, result: { isOk: false, error: 'REQUEST_IN_PROGRESS' } };
        }
        if (existing.requestHash !== requestHash) {
          return { shouldProceed: false, result: { isOk: false, error: 'IDEMPOTENCY_KEY_REUSED' } };
        }
        const stored = JSON.parse(existing.result) as Omit<InitiatePaymentSuccess, 'isReplay'>;
        return { shouldProceed: false, result: { ...stored, isReplay: true } };
      }

      // Business refusals don't consume the key, so the client can retry once the problem is resolved.
      const refuse = (result: InitiatePaymentResult): ClaimOutcome => {
        dataStore.idempotency.release(initiatePaymentScope, input.idempotencyKey);
        return { shouldProceed: false, result };
      };

      const order = dataStore.orders.findById(input.orderId);
      if (!order) return refuse({ isOk: false, error: 'ORDER_NOT_FOUND' });
      if (order.status !== 'AwaitingPayment') {
        return refuse({ isOk: false, error: 'ORDER_NOT_PAYABLE', orderStatus: order.status });
      }
      const activePayment = dataStore.payments
        .findByOrderId(order.id)
        .find((p) => p.status === 'Initiated' || p.status === 'Authorised');
      if (activePayment) {
        return refuse({ isOk: false, error: 'PAYMENT_ALREADY_IN_PROGRESS', paymentId: activePayment.id });
      }

      const paymentId = idGenerator.newId('pay');
      const payment: PaymentRecord = {
        id: paymentId,
        orderId: order.id,
        providerPaymentId: null,
        amountMinor: order.totalMinor,
        currency: order.currency,
        status: 'Initiated',
        // One key per payment attempt, reused on every retry of this attempt.
        providerIdempotencyKey: paymentId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      dataStore.payments.insert(payment);
      dataStore.orderEvents.append({
        orderId: order.id,
        type: 'PaymentInitiated',
        data: { paymentId, amountMinor: payment.amountMinor, currency: payment.currency },
        occurredAt: now,
      });
      return { shouldProceed: true, payment };
    });
  }

  /** Phase 2 (no transaction): call the provider with bounded retries. Unexpected exceptions mean "unknown". */
  async function callProvider(payment: PaymentRecord): Promise<InitiatePaymentResponse> {
    const request: InitiatePaymentRequest = {
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      idempotencyKey: payment.providerIdempotencyKey,
    };
    const { result } = await callWithRetry(
      async (): Promise<InitiatePaymentResponse> => {
        try {
          return await paymentProvider.initiatePayment(request);
        } catch (error) {
          return { outcome: 'transientError', reason: error instanceof Error ? error.message : String(error) };
        }
      },
      { policy: retryPolicy, sleeper, random, shouldRetry: isRetryable },
    );
    return result;
  }

  /**
   * Phase 3 (one transaction): record what the provider said. The payment is re-read because a webhook may
   * have moved it on during the call; a decline goes through the domain rules so it can't undo a capture.
   */
  function recordProviderResponse(paymentId: string, idempotencyKey: string, response: InitiatePaymentResponse) {
    return dataStore.runInTransaction((): InitiatePaymentSuccess => {
      const now = clock.now();
      const current = dataStore.payments.findById(paymentId)!;
      let providerOutcome: ProviderOutcome = 'pending';

      if (response.outcome === 'accepted') {
        providerOutcome = 'accepted';
        if (current.providerPaymentId === null) {
          dataStore.payments.update(paymentId, { providerPaymentId: response.providerPaymentId }, current.version, now);
        }
      } else if (response.outcome === 'declined') {
        providerOutcome = 'declined';
        persistPaymentEvent(dataStore, {
          order: dataStore.orders.findById(current.orderId)!,
          payment: current,
          event: { type: 'PaymentFailed', paymentId },
          now,
        });
      }

      const result = { isOk: true as const, payment: toPaymentView(dataStore.payments.findById(paymentId)!), providerOutcome };
      dataStore.idempotency.complete(initiatePaymentScope, idempotencyKey, JSON.stringify(result));
      return { ...result, isReplay: false };
    });
  }

  return {
    /**
     * Associates a new payment with an order and asks the provider to take it. Safe to retry with the same
     * idempotency key; never marks a payment Failed just because the outcome is unknown.
     */
    async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
      const claim = claimAndCreatePayment(input);
      if (!claim.shouldProceed) return claim.result;

      try {
        const response = await callProvider(claim.payment);
        return recordProviderResponse(claim.payment.id, input.idempotencyKey, response);
      } catch (error) {
        // Free the key so the client isn't stuck on 409. The payment stays Initiated, so a retry gets
        // PAYMENT_ALREADY_IN_PROGRESS and the webhook or reconciliation settles it.
        dataStore.idempotency.release(initiatePaymentScope, input.idempotencyKey);
        throw error;
      }
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
