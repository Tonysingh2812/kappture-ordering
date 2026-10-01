import type { Clock, IdGenerator, Sleeper } from '../../src/application/ports/system.ts';

/** Resolves immediately and records the requested delays, so back-off can be asserted without waiting. */
export class InstantSleeper implements Sleeper {
  readonly delays: number[] = [];

  async sleep(ms: number): Promise<void> {
    this.delays.push(ms);
  }
}

export class FakeClock implements Clock {
  private currentMs: number;

  constructor(startIso = '2026-10-01T12:00:00.000Z') {
    this.currentMs = Date.parse(startIso);
  }

  now(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceMs(ms: number): void {
    this.currentMs += ms;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  newId(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${next}`;
  }
}
