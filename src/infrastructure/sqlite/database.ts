import Database from 'better-sqlite3';
import type { DataStore } from '../../application/ports/repositories.ts';
import { migrations } from './migrations.ts';
import {
  createIdempotencyRepository,
  createOrderEventRepository,
  createOrderRepository,
  createPaymentEventRepository,
  createPaymentRepository,
  createReviewFlagRepository,
} from './repositories.ts';

export type SqliteDatabase = Database.Database;

const inMemoryPath = ':memory:';

/** Opens a database (a file path, or ':memory:') and applies migrations. */
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (path !== inMemoryPath) {
    // WAL lets readers (e.g. listing endpoints) proceed while a write is in progress.
    db.pragma('journal_mode = WAL');
  }
  runMigrations(db);
  return db;
}

/** Applies any migrations not yet recorded in `schema_migrations`. Safe to run repeatedly. */
export function runMigrations(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT`);
  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((row) => row.version),
  );

  const applyMigration = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      version,
      new Date().toISOString(),
    );
  });

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) applyMigration(migration.version, migration.sql);
  }
}

export function createSqliteDataStore(db: SqliteDatabase): DataStore {
  return {
    orders: createOrderRepository(db),
    payments: createPaymentRepository(db),
    paymentEvents: createPaymentEventRepository(db),
    orderEvents: createOrderEventRepository(db),
    idempotency: createIdempotencyRepository(db),
    reviewFlags: createReviewFlagRepository(db),
    runInTransaction: (work) => db.transaction(work)(),
  };
}
