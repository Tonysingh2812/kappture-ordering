import { buildApp } from './app.ts';
import { createSqliteDataStore, openDatabase } from './infrastructure/sqlite/database.ts';
import { systemClock, uuidIdGenerator } from './infrastructure/system.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const databasePath = process.env.DATABASE_PATH ?? 'kappture.db';

const db = openDatabase(databasePath);
const app = buildApp({
  dataStore: createSqliteDataStore(db),
  clock: systemClock,
  idGenerator: uuidIdGenerator,
  shouldLog: true,
});

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
