import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookSignatureVerifier } from '../application/ports/webhook-verifier.ts';

const hexSha256Pattern = /^[0-9a-f]{64}$/;

/** HMAC-SHA256 of the raw body, hex encoded. What the provider would send in the signature header. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function createHmacSignatureVerifier(secret: string): WebhookSignatureVerifier {
  return {
    isValid(rawBody, signature) {
      if (signature === undefined || !hexSha256Pattern.test(signature)) return false;
      const expected = Buffer.from(signWebhookBody(secret, rawBody), 'hex');
      // Constant-time comparison so the signature can't be guessed byte by byte from response timing.
      return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
    },
  };
}
