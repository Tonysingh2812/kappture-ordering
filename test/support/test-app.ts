import type { FastifyInstance } from 'fastify';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { buildApp } from '../../src/app.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { FakeClock, SequentialIdGenerator } from './fakes.ts';

export interface TestApp {
  app: FastifyInstance;
  store: DataStore;
  clock: FakeClock;
}

/** A fully wired app on a fresh in-memory database, driven via `app.inject` (no real port). */
export async function createTestApp(): Promise<TestApp> {
  const store = createSqliteDataStore(openDatabase(':memory:'));
  const clock = new FakeClock();
  const app = buildApp({ dataStore: store, clock, idGenerator: new SequentialIdGenerator() });
  await app.ready();
  return { app, store, clock };
}
