import { buildApp } from './app.ts';
import { FakePaymentProvider } from './infrastructure/fake-payment-provider.ts';
import { createSqliteDataStore, openDatabase } from './infrastructure/sqlite/database.ts';
import { realSleeper, systemClock, uuidIdGenerator } from './infrastructure/system.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const databasePath = process.env.DATABASE_PATH ?? 'kappture.db';
const webhookSecret = process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret';

const db = openDatabase(databasePath);
const app = buildApp({
  dataStore: createSqliteDataStore(db),
  clock: systemClock,
  idGenerator: uuidIdGenerator,
  // No real provider in this exercise: the fake accepts every payment. Status arrives via the webhook.
  paymentProvider: new FakePaymentProvider(),
  sleeper: realSleeper,
  webhookSecret,
  shouldLog: true,
});

if (process.env.WEBHOOK_SECRET === undefined) {
  app.log.warn('WEBHOOK_SECRET not set; using an insecure development default');
}

app.addHook('onClose', async () => {
  db.close();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
