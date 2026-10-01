# KAP-03: Create/get order API with idempotent submission

**Status:** Done

## Goal
A client retrying after a timeout must never create the same logical order twice.

## Scope
- `POST /orders`: body `{ venueId, tableRef, items[{ sku, name, quantity, unitPriceMinor }], currency }`. The server computes the total. Requires an `Idempotency-Key` header. Creates the order in `AwaitingPayment` and appends `OrderCreated`.
- `GET /orders/:id`: the order, its payments and its event history.
- Idempotency middleware/service, reused by KAP-04:
  - Key and request hash both match a completed request → replay the stored response.
  - Same key, different request hash → `422`.
  - Same key, original still `in_progress` → `409`, with a `Retry-After` header.
  - Missing key → `400`.

## Tests first
- Create returns `201` with an id, status `AwaitingPayment`, and the computed total.
- The same request repeated with the same key → identical response, and exactly one row in `orders`.
- Same key with a different body → `422`, and no new order.
- Missing key / invalid payload (empty items, negative quantity, unknown currency) → `400` with a useful error.
- `GET` for an unknown id → `404`.

## Acceptance criteria
- Duplicate submission is covered by tests at the HTTP level, not just in the service.

## Implementation notes
- **Idempotency lives in the application layer** (`OrderService.createOrder`), not in HTTP middleware. "Don't create the same order twice" is a business rule, so it's testable without HTTP. The service stores the *use-case result* against the key, and the route maps it to a status code. Migration 2 replaced `response_code`/`response_body` with `result`; migration 1 was left untouched because migrations are append-only.
- **One transaction** covers claiming the key, inserting the order, appending `OrderCreated` and storing the result. A crash can't leave an order without its key, and an error mid-way rolls back and frees the key (tested by injecting a failing repository).
- **Validation runs before the key is claimed,** so a rejected body doesn't burn the key and the client can retry with a corrected body.
- The request fingerprint is a SHA-256 of canonical JSON (keys sorted), so key order doesn't matter.
- A replay returns the **original** result (a snapshot from creation time) with header `Idempotent-Replayed: true` and status 201, following Stripe's convention.
- **Precedence:** in progress (409) is checked before body mismatch (422). While the first request hasn't finished, the client should just wait.
- **Split of validation:** zod checks only shape and types (400 `VALIDATION_FAILED`); business rules live in `validateNewOrder` in the domain (400 `INVALID_ORDER`, listing every problem).
- **Mutation check:** I removed the body-mismatch check, and both the service test and the HTTP test failed.
- I smoke-tested against the real server and a SQLite file: a retried POST gave the same order id with `idempotent-replayed: true`.
