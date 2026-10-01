import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ErrorBody = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return reply.status(statusCode).send(body);
}

export function toValidationDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Consistent error bodies for framework-level errors (e.g. malformed JSON) and a safe 500 for anything unexpected. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      return sendError(reply, statusCode, 'BAD_REQUEST', error.message);
    }
    request.log.error(error);
    return sendError(reply, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  });
}
