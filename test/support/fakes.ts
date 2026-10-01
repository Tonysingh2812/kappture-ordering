import type { Clock, IdGenerator } from '../../src/application/ports/system.ts';

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
