# KAP-01: SQLite schema, migrations and repositories

**Status:** To do

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
