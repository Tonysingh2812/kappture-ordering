import type { IsoTimestamp } from './records.ts';

/** Injected so tests control time (timestamps, retry back-off, reconciliation age). */
export interface Clock {
  now(): IsoTimestamp;
}

/** Injected so tests get predictable ids. */
export interface IdGenerator {
  newId(prefix: string): string;
}
