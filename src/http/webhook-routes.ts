import type { FastifyInstance } from 'fastify';
import type { WebhookService } from '../application/webhook-service.ts';
import { sendError } from './errors.ts';

export const signatureHeader = 'x-provider-signature';

/**
 * 200 = handled (applied, duplicate, stale or durably rejected): the provider should stop retrying.
 * 401 = signature invalid. 500 = unexpected internal error, rolled back: the provider should retry.
 */
export function registerWebhookRoutes(app: FastifyInstance, webhookService: WebhookService): void {
  // Encapsulated so only this route keeps the body as a raw string; the HMAC is over the exact bytes sent.
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

    scope.post('/webhooks/payments', async (request, reply) => {
      const signature = request.headers[signatureHeader];
      const result = webhookService.handlePaymentWebhook({
        rawBody: typeof request.body === 'string' ? request.body : '',
        signature: typeof signature === 'string' ? signature : undefined,
      });

      if (!result.isOk) return sendError(reply, 401, result.error, 'Webhook signature is missing or invalid');
      return reply.send({ providerEventId: result.providerEventId, outcome: result.outcome, reason: result.reason });
    });
  });
}
