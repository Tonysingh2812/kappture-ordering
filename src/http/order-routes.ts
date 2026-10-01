import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrderService } from '../application/order-service.ts';
import { sendError, toValidationDetails } from './errors.ts';
import { readIdempotencyKey } from './idempotency-header.ts';

/** Shape and types only. Business rules (quantities, prices, currencies) are enforced in the domain. */
const createOrderBodySchema = z.object({
  venueId: z.string().min(1),
  tableRef: z.string().min(1),
  items: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      quantity: z.number(),
      unitPriceMinor: z.number(),
    }),
  ),
  currency: z.string(),
});

export function registerOrderRoutes(app: FastifyInstance, orderService: OrderService): void {
  app.post('/orders', async (request, reply) => {
    const idempotencyKey = readIdempotencyKey(request, reply);
    if (idempotencyKey === null) return reply;

    const body = createOrderBodySchema.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Request body is invalid', toValidationDetails(body.error));
    }

    const result = orderService.createOrder({ ...body.data, idempotencyKey });

    if (result.isOk) {
      return reply.status(201).header('idempotent-replayed', String(result.isReplay)).send(result.order);
    }
    switch (result.error) {
      case 'INVALID_ORDER':
        return sendError(reply, 400, result.error, 'Order is invalid', result.problems);
      case 'IDEMPOTENCY_KEY_REUSED':
        return sendError(reply, 422, result.error, 'This Idempotency-Key was already used with a different request');
      case 'REQUEST_IN_PROGRESS':
        reply.header('retry-after', '1');
        return sendError(reply, 409, result.error, 'A request with this Idempotency-Key is still in progress');
    }
  });

  app.get<{ Params: { id: string } }>('/orders/:id', async (request, reply) => {
    const result = orderService.getOrder(request.params.id);
    if (!result.isOk) return sendError(reply, 404, result.error, `Order ${request.params.id} not found`);
    return reply.send(result.details);
  });
}
