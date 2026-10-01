export interface InitiatePaymentRequest {
  /** Our payment id, sent as the merchant reference so every callback can be matched to the payment. */
  paymentId: string;
  amountMinor: number;
  currency: string;
  /** The same on every retry, so the provider never creates a second charge. */
  idempotencyKey: string;
}

/**
 * Expected provider outcomes are returned, not thrown. Adapters are responsible for enforcing their own
 * request timeout and reporting it as `timedOut` (the outcome is then unknown, not failed).
 */
export type InitiatePaymentResponse =
  | { outcome: 'accepted'; providerPaymentId: string }
  | { outcome: 'declined'; reason: string }
  | { outcome: 'transientError'; reason: string }
  | { outcome: 'timedOut' };

export interface PaymentProvider {
  initiatePayment(request: InitiatePaymentRequest): Promise<InitiatePaymentResponse>;
}
