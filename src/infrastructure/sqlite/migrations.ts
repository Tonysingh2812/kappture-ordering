/**
 * Ordered, append-only migrations. Never edit one that has shipped; add a new one instead.
 * STRICT tables make SQLite enforce column types (e.g. no fractional money in INTEGER columns).
 */
export const migrations: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE orders (
        id          TEXT PRIMARY KEY,
        venue_id    TEXT NOT NULL,
        table_ref   TEXT NOT NULL,
        items       TEXT NOT NULL,
        total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
        currency    TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('AwaitingPayment', 'Paid', 'Completed', 'Cancelled')),
        version     INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      ) STRICT;
      CREATE INDEX orders_by_status ON orders (status, created_at);

      CREATE TABLE payments (
        id                       TEXT PRIMARY KEY,
        order_id                 TEXT NOT NULL REFERENCES orders (id),
        provider_payment_id      TEXT,
        amount_minor             INTEGER NOT NULL CHECK (amount_minor >= 0),
        currency                 TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('Initiated', 'Authorised', 'Captured', 'Failed', 'Cancelled')),
        provider_idempotency_key TEXT NOT NULL UNIQUE,
        version                  INTEGER NOT NULL,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      ) STRICT;
      CREATE INDEX payments_by_order ON payments (order_id, created_at);
      CREATE INDEX payments_by_status ON payments (status, created_at);

      -- Every provider event received. provider_event_id is the dedupe key.
      -- payment_id has no foreign key: rejected events may reference payments we don't know (dead letters).
      CREATE TABLE payment_events (
        provider_event_id TEXT PRIMARY KEY,
        payment_id        TEXT,
        type              TEXT NOT NULL,
        payload           TEXT NOT NULL,
        outcome           TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'duplicate', 'stale', 'rejected')),
        reason            TEXT,
        delivery_count    INTEGER NOT NULL,
        first_received_at TEXT NOT NULL,
        last_received_at  TEXT NOT NULL
      ) STRICT;
      CREATE INDEX payment_events_by_payment ON payment_events (payment_id, first_received_at);
      CREATE INDEX payment_events_by_outcome ON payment_events (outcome, first_received_at);

      CREATE TABLE order_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL REFERENCES orders (id),
        type        TEXT NOT NULL,
        data        TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX order_events_by_order ON order_events (order_id, id);

      CREATE TABLE idempotency_keys (
        scope         TEXT NOT NULL,
        key           TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
        response_code INTEGER,
        response_body TEXT,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT;

      CREATE TABLE review_flags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL REFERENCES orders (id),
        payment_id  TEXT,
        reason      TEXT NOT NULL,
        details     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX review_flags_open ON review_flags (resolved_at, id);
      CREATE INDEX review_flags_by_order ON review_flags (order_id, id);
    `,
  },
  {
    // Idempotency stores the use-case result (application layer), not an HTTP response, so business
    // logic stays independent of HTTP. The HTTP layer maps the replayed result to a status code.
    version: 2,
    sql: `
      ALTER TABLE idempotency_keys DROP COLUMN response_code;
      ALTER TABLE idempotency_keys RENAME COLUMN response_body TO result;
    `,
  },
];
