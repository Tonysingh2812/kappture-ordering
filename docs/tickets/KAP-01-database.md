# KAP-01: SQLite schema, migrations and repositories

**Status:** Done

## Goal
Durable storage for orders, payments and every event received, so the full history of transactions and states can be listed and audited.

## Scope
Tables (first draft):
- `orders`: id, venue_id, table_ref, items (JSON), total_minor, currency, status, version, created_at, updated_at
- `payments`: id (our reference, sent to provider), order_id, provider_payment_id (nullable), amount_minor, currency, status, idempotency_key, created_at, updated_at
- `payment_events`: provider_event_id (**UNIQUE**, the dedupe key), payment_id, type, payload, received_at, outcome (`applied` | `duplicate` | `stale` | `rejected`), reason
- `order_events`: append-only audit log (OrderCreated, PaymentInitiated, …, OrderCompleted)
- `idempotency_keys`: key, scope, request_hash, status (`in_progress` | `completed`), response_code, response_body
- `review_flags`: id, order_id, payment_id, reason_code, details, created_at, resolved_at

Also:
- Simple ordered migrations, run on startup.
- Repository interfaces in `application/ports`, SQLite implementations in `infrastructure/`.
- A `unitOfWork(fn)` wrapper around a SQLite transaction.
- Money is stored as integer minor units (pence). No floats.

## Tests first
- Migrations create all tables, and running them twice is a no-op.
- Round trip for each repository (save, then load).
- Inserting a duplicate `provider_event_id` fails on the unique constraint.
- If an error is thrown inside `unitOfWork`, nothing is persisted (rollback).
- Tests use `:memory:` databases, a fresh one per test.

## Acceptance criteria
- All repository tests pass. No domain logic lives in repositories.

## Implementation notes
- **Synchronous repository ports.** better-sqlite3 transactions must be synchronous, so the ports are too. This guarantees "dedupe + state change + audit" happens in one transaction. Moving to Postgres would mean async ports (recorded as a trade-off).
- **Dedupe in a single statement.** `recordDelivery` is `INSERT … ON CONFLICT DO UPDATE SET delivery_count = delivery_count + 1 … RETURNING *`. Repeat deliveries are counted on the same row rather than stored again. This settles the KAP-05 question: one row per event, plus a counter.
- **Defence in depth.** `STRICT` tables and `CHECK` constraints reject fractional or negative money and unknown statuses, even if the code above has a bug. Foreign keys are on.
- **`payment_events.payment_id` has no foreign key,** so dead-lettered events that reference unknown payments can still be stored.
- **Optimistic concurrency.** Orders and payments have a `version` column. A stale update throws `ConcurrencyError`, which rolls the transaction back.
- **`idempotency.release()`** was added so a request that fails unexpectedly frees its key and the client can retry.
- **Mutation check:** I made every delivery report as the first one, and the redelivery test failed.
- Timestamps are passed in by callers (from an injectable clock), never `CURRENT_TIMESTAMP`, so tests stay deterministic.
