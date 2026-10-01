import type { IsoTimestamp } from './records.ts';

/** Injected so tests control time (timestamps, retry back-off, reconciliation age). */
export interface Clock {
  now(): IsoTimestamp;
}

/** Injected so retry back-off doesn't slow tests down. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** Injected so tests get predictable ids. */
export interface IdGenerator {
  newId(prefix: string): string;
}
