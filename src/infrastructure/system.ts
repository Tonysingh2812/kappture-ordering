import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../application/ports/system.ts';

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export const uuidIdGenerator: IdGenerator = {
  newId: (prefix) => `${prefix}_${randomUUID()}`,
};
