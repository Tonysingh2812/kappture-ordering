import type { FastifyInstance } from 'fastify';
import type { DataStore } from '../../src/application/ports/repositories.ts';
import { buildApp } from '../../src/app.ts';
import { FakePaymentProvider } from '../../src/infrastructure/fake-payment-provider.ts';
import { createSqliteDataStore, openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { FakeClock, InstantSleeper, SequentialIdGenerator } from './fakes.ts';
import { testWebhookSecret } from './webhooks.ts';

export interface TestApp {
  app: FastifyInstance;
  store: DataStore;
  clock: FakeClock;
  provider: FakePaymentProvider;
}

export interface TestAppOptions {
  /** Wrap the real store, e.g. to inject a failure into one repository method. */
  wrapStore?: (store: DataStore) => DataStore;
}

/** A fully wired app on a fresh in-memory database, driven via `app.inject` (no real port). */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const store = createSqliteDataStore(openDatabase(':memory:'));
  const clock = new FakeClock();
  const provider = new FakePaymentProvider();
  const app = buildApp({
    dataStore: options.wrapStore ? options.wrapStore(store) : store,
    clock,
    idGenerator: new SequentialIdGenerator(),
    paymentProvider: provider,
    sleeper: new InstantSleeper(),
    random: () => 0,
    webhookSecret: testWebhookSecret,
  });
  await app.ready();
  return { app, store, clock, provider };
}
