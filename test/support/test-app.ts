import type { FastifyInstance } from 'fastify';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { buildApp } from '../../src/app.ts';
import { FakePaymentProvider } from '../../src/infrastructure/fake-payment-provider.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { FakeClock, InstantSleeper, SequentialIdGenerator } from './fakes.ts';

export interface TestApp {
  app: FastifyInstance;
  store: DataStore;
  clock: FakeClock;
  provider: FakePaymentProvider;
}

/** A fully wired app on a fresh in-memory database, driven via `app.inject` (no real port). */
export async function createTestApp(): Promise<TestApp> {
  const store = createSqliteDataStore(openDatabase(':memory:'));
  const clock = new FakeClock();
  const provider = new FakePaymentProvider();
  const app = buildApp({
    dataStore: store,
    clock,
    idGenerator: new SequentialIdGenerator(),
    paymentProvider: provider,
    sleeper: new InstantSleeper(),
    random: () => 0,
  });
  await app.ready();
  return { app, store, clock, provider };
}
