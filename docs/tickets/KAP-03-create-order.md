# KAP-03: Create/get order API with idempotent submission

**Status:** To do

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
