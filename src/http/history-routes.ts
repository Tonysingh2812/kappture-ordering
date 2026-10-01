import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HistoryService } from '../application/history-service.ts';
import type { OrderService } from '../application/order-service.ts';
import { sendError, toValidationDetails } from './errors.ts';

const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const ordersQuery = z.object({
  status: z.enum(['AwaitingPayment', 'Paid', 'Completed', 'Cancelled']).optional(),
  ...paging,
});
const paymentsQuery = z.object({
  status: z.enum(['Initiated', 'Authorised', 'Captured', 'Failed', 'Cancelled']).optional(),
  ...paging,
});
const paymentEventsQuery = z.object({
  outcome: z.enum(['pending', 'applied', 'duplicate', 'stale', 'rejected']).optional(),
  ...paging,
});

/** Drops an undefined filter so it isn't passed as an explicit `undefined` (exactOptionalPropertyTypes). */
const withStatus = <T>(status: T | undefined) => (status === undefined ? {} : { status });

export function registerHistoryRoutes(
  app: FastifyInstance,
  historyService: HistoryService,
  orderService: OrderService,
): void {
  app.get('/orders', async (request, reply) => {
    const query = ordersQuery.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Query is invalid', toValidationDetails(query.error));
    }
    const { status, limit, offset } = query.data;
    return { items: historyService.listOrders({ ...withStatus(status), limit, offset }), limit, offset };
  });

  app.get('/payments', async (request, reply) => {
    const query = paymentsQuery.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Query is invalid', toValidationDetails(query.error));
    }
    const { status, limit, offset } = query.data;
    return { items: historyService.listPayments({ ...withStatus(status), limit, offset }), limit, offset };
  });

  app.get('/payment-events', async (request, reply) => {
    const query = paymentEventsQuery.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Query is invalid', toValidationDetails(query.error));
    }
    const { outcome, limit, offset } = query.data;
    return { items: historyService.listPaymentEvents({ ...withStatus(outcome), limit, offset }), limit, offset };
  });

  app.get<{ Params: { id: string } }>('/orders/:id/timeline', async (request, reply) => {
    const result = historyService.getTimeline(request.params.id);
    if (!result.isOk) return sendError(reply, 404, result.error, `Order ${request.params.id} not found`);
    return { orderId: result.orderId, entries: result.entries };
  });

  app.post<{ Params: { id: string } }>('/orders/:id/complete', async (request, reply) => {
    const result = orderService.completeOrder(request.params.id);
    if (result.isOk) return { order: result.order, hasChanged: result.hasChanged };
    switch (result.error) {
      case 'ORDER_NOT_FOUND':
        return sendError(reply, 404, result.error, `Order ${request.params.id} not found`);
      case 'ORDER_NOT_PAID':
        return sendError(reply, 409, result.error, `Order is ${result.orderStatus}; only Paid orders can be completed`, {
          orderStatus: result.orderStatus,
        });
    }
  });
}
