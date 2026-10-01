import type {
  InitiatePaymentRequest,
  InitiatePaymentResponse,
  PaymentProvider,
} from '../application/ports/payment-provider.ts';

/** A scripted step: a fixed response, or a function (e.g. to simulate a webhook landing mid-call). */
export type ScriptedResponse =
  | InitiatePaymentResponse
  | ((request: InitiatePaymentRequest) => InitiatePaymentResponse | Promise<InitiatePaymentResponse>);

/**
 * Stand-in for a real payment provider. Responses are scripted per call; once the script is used up,
 * every call is accepted. There is no real provider in this exercise.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly calls: InitiatePaymentRequest[] = [];
  private script: ScriptedResponse[] = [];

  /** Queues responses for the next calls, in order. */
  respondWith(...responses: ScriptedResponse[]): this {
    this.script.push(...responses);
    return this;
  }

  async initiatePayment(request: InitiatePaymentRequest): Promise<InitiatePaymentResponse> {
    this.calls.push({ ...request });
    const next = this.script.shift();
    if (next === undefined) return { outcome: 'accepted', providerPaymentId: `prov_${request.paymentId}` };
    return typeof next === 'function' ? next(request) : next;
  }
}
