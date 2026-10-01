import type { Sleeper } from './ports/system.ts';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

/** Kept small because retries currently happen inside the customer's HTTP request. See README limitations. */
export const defaultRetryPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 200 };

export interface RetryOptions<T> {
  policy: RetryPolicy;
  sleeper: Sleeper;
  /** Returns a value in [0, 1). Injected so jitter is deterministic in tests. */
  random: () => number;
  shouldRetry: (result: T) => boolean;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
}

/**
 * Back-off before retry number `retryNumber` (1-based): exponential with "equal jitter", in [exp/2, exp).
 * Jitter stops many clients that failed together from retrying in lockstep.
 */
export function backoffDelayMs(retryNumber: number, baseDelayMs: number, random: () => number): number {
  const exponentialMs = baseDelayMs * 2 ** (retryNumber - 1);
  return exponentialMs / 2 + random() * (exponentialMs / 2);
}

/** Calls `operation` until `shouldRetry` is false or attempts run out. Returns the last result. */
export async function callWithRetry<T>(operation: () => Promise<T>, options: RetryOptions<T>): Promise<RetryResult<T>> {
  const { policy, sleeper, random, shouldRetry } = options;

  for (let attempt = 1; ; attempt += 1) {
    const result = await operation();
    if (!shouldRetry(result) || attempt >= policy.maxAttempts) return { result, attempts: attempt };
    await sleeper.sleep(backoffDelayMs(attempt, policy.baseDelayMs, random));
  }
}
