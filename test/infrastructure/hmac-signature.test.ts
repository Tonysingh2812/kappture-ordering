import { describe, expect, it } from 'vitest';
import { createHmacSignatureVerifier, signWebhookBody } from '../../src/infrastructure/hmac-signature.ts';

describe('HMAC webhook signatures', () => {
  const verifier = createHmacSignatureVerifier('secret');
  const body = '{"eventId":"evt_1"}';

  it('produces a hex HMAC-SHA256', () => {
    expect(signWebhookBody('secret', body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a body signed with the shared secret', () => {
    expect(verifier.isValid(body, signWebhookBody('secret', body))).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['signed with another secret', signWebhookBody('other', body)],
    ['for a different body', signWebhookBody('secret', '{"eventId":"evt_2"}')],
    ['not hex', 'zz'],
    ['truncated', signWebhookBody('secret', body).slice(0, 10)],
  ])('rejects a signature that is %s', (_label, signature) => {
    expect(verifier.isValid(body, signature)).toBe(false);
  });

  it('rejects a body changed by a single byte', () => {
    const signature = signWebhookBody('secret', body);

    expect(verifier.isValid(body.replace('1', '2'), signature)).toBe(false);
  });
});
