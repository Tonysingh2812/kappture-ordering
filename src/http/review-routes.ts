import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReviewService } from '../application/review-service.ts';
import { sendError } from './errors.ts';

const flagIdSchema = z.coerce.number().int().positive();

export function registerReviewRoutes(app: FastifyInstance, reviewService: ReviewService): void {
  app.get('/review', async () => ({ items: reviewService.listOpen() }));

  app.post<{ Params: { id: string } }>('/review/:id/resolve', async (request, reply) => {
    const flagId = flagIdSchema.safeParse(request.params.id);
    if (!flagId.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'Review flag id must be a positive integer');
    }

    const result = reviewService.resolve(flagId.data);
    if (!result.isOk) return sendError(reply, 404, result.error, `Review flag ${flagId.data} is not open`);
    return reply.send({ id: flagId.data, isResolved: true });
  });
}
