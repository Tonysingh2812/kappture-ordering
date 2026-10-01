import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Clock, IdGenerator, Sleeper } from '../application/ports/system.ts';

export const realSleeper: Sleeper = {
  sleep: async (ms) => {
    await delay(ms);
  },
};

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const uuidIdGenerator: IdGenerator = {
  newId: (prefix) => `${prefix}_${randomUUID()}`,
};
