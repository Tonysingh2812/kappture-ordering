import { createHash } from 'node:crypto';

/** Recursively sorts object keys so semantically equal requests serialise identically. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalise(v)]),
    );
  }
  return value;
}

/** Fingerprint of a request, used to detect an idempotency key reused with a different body. */
export function hashRequest(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalise(request))).digest('hex');
}
