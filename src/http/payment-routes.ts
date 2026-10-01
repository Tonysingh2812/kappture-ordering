import type { FastifyInstance } from 'fastify';
import type { PaymentService } from '../application/payment-service.ts';
import { sendError } from './errors.ts';
import { readIdempotencyKey } from './idempotency-header.ts';

export function registerPaymentRoutes(app: FastifyInstance, paymentService: PaymentService): void {
  app.post<{ Params: { id: string } }>('/orders/:id/payments', async (request, reply) => {
    const idempotencyKey = readIdempotencyKey(request, reply);
    if (idempotencyKey === null) return reply;

    const result = await paymentService.initiatePayment({ orderId: request.params.id, idempotencyKey });

    if (result.isOk) {
      // 202: accepted for processing; the final payment status arrives asynchronously via the webhook.
      // 402: the provider declined, so the payment is Failed and the customer can try again.
      const statusCode = result.payment.status === 'Failed' ? 402 : 202;
      return reply
        .status(statusCode)
        .header('idempotent-replayed', String(result.isReplay))
        .send({ payment: result.payment, providerOutcome: result.providerOutcome });
    }
    switch (result.error) {
      case 'ORDER_NOT_FOUND':
        return sendError(reply, 404, result.error, `Order ${request.params.id} not found`);
      case 'ORDER_NOT_PAYABLE':
        return sendError(reply, 409, result.error, `Order is ${result.orderStatus} and cannot take payment`, {
          orderStatus: result.orderStatus,
        });
      case 'PAYMENT_ALREADY_IN_PROGRESS':
        return sendError(reply, 409, result.error, 'A payment for this order is already in progress', {
          paymentId: result.paymentId,
        });
      case 'IDEMPOTENCY_KEY_REUSED':
        return sendError(reply, 422, result.error, 'This Idempotency-Key was already used with a different request');
      case 'REQUEST_IN_PROGRESS':
        reply.header('retry-after', '1');
        return sendError(reply, 409, result.error, 'A request with this Idempotency-Key is still in progress');
    }
  });
}
