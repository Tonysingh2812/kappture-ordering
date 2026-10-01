import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sendError } from './errors.ts';

const idempotencyKeySchema = z.string().min(1).max(255);

/** Returns the Idempotency-Key header, or sends a 400 and returns null. */
export function readIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | null {
  const parsed = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
  if (parsed.success) return parsed.data;
  void sendError(reply, 400, 'VALIDATION_FAILED', 'An Idempotency-Key header (1-255 characters) is required', [
    { path: 'headers.Idempotency-Key', message: 'Required' },
  ]);
  return null;
}
