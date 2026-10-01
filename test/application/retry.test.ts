import { describe, expect, it } from 'vitest';
import { backoffDelayMs, callWithRetry } from '../../src/application/retry.ts';
import { InstantSleeper } from '../support/fakes.ts';

describe('backoffDelayMs', () => {
  it.each([
    [1, 0, 50],
    [1, 0.999, 99.95],
    [2, 0, 100],
    [3, 0, 200],
    [3, 0.5, 300],
  ])('retry %i with random %d → %d ms (base 100)', (retryNumber, randomValue, expected) => {
    expect(backoffDelayMs(retryNumber, 100, () => randomValue)).toBeCloseTo(expected);
  });
});

describe('callWithRetry', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 100 };

  const scripted = (results: string[]) => {
    const remaining = [...results];
    let calls = 0;
    return {
      operation: async () => {
        calls += 1;
        return remaining.shift() ?? 'exhausted';
      },
      callCount: () => calls,
    };
  };

  it('returns immediately when the first result should not be retried', async () => {
    const sleeper = new InstantSleeper();
    const { operation, callCount } = scripted(['ok']);

    const outcome = await callWithRetry(operation, {
      policy,
      sleeper,
      random: () => 0,
      shouldRetry: (r) => r === 'retry',
    });

    expect(outcome).toEqual({ result: 'ok', attempts: 1 });
    expect(callCount()).toBe(1);
    expect(sleeper.delays).toEqual([]);
  });

  it('retries with exponential back-off until a non-retryable result', async () => {
    const sleeper = new InstantSleeper();
    const { operation } = scripted(['retry', 'retry', 'ok']);

    const outcome = await callWithRetry(operation, {
      policy,
      sleeper,
      random: () => 0,
      shouldRetry: (r) => r === 'retry',
    });

    expect(outcome).toEqual({ result: 'ok', attempts: 3 });
    expect(sleeper.delays).toEqual([50, 100]);
  });

  it('gives up after maxAttempts and returns the last result', async () => {
    const sleeper = new InstantSleeper();
    const { operation, callCount } = scripted(['retry', 'retry', 'retry', 'ok']);

    const outcome = await callWithRetry(operation, {
      policy,
      sleeper,
      random: () => 0,
      shouldRetry: (r) => r === 'retry',
    });

    expect(outcome).toEqual({ result: 'retry', attempts: 3 });
    expect(callCount()).toBe(3);
    expect(sleeper.delays).toHaveLength(2);
  });
});
