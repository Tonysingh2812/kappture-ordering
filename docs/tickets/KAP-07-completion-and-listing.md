# KAP-07: Order completion and transaction/state listing

**Status:** Done

## Goal
Hand paid orders to fulfilment, and make every transaction and state visible.

## Scope
- `POST /orders/:id/complete`: only allowed from `Paid`. Appends `OrderCompleted`. Calling it again on a Completed order is idempotent (`200`, no new event).
- `GET /orders?status=`: list orders with their current status (paginated).
- `GET /payments?status=`: list payments with their status and order id.
- `GET /orders/:id/events`: full timeline, merging order events with received payment events and their outcomes (applied/duplicate/stale/rejected).

## Tests first
- Completing a Paid order → `Completed`, with an event recorded.
- Completing an `AwaitingPayment` order → `409`.
- Completing twice → the second call is a no-op `200`.
- The listing filters by status correctly.
- The timeline shows a duplicate and a stale event with their outcomes.

## Acceptance criteria
- Starting from an empty database, a reviewer can run the full flow with curl and see every transition.

## Implementation notes
- **`OrderService.completeOrder`** uses the domain's `completeOrder` decision in one transaction: Paid → Completed plus an `OrderCompleted` event. A repeat returns `hasChanged: false` and writes nothing.
- **`HistoryService` (new, read-only):** `listOrders`, `listPayments`, `listPaymentEvents` (filterable by outcome; `?outcome=rejected` is the dead-letter view) and `getTimeline`. Reads are kept apart from the write services.
- **Timeline:** merges order audit events with the provider events for **every** payment attempt on the order. On equal timestamps, a provider event (the cause) comes before the order events it produced.
- **Bug found and fixed in KAP-01 code:** `payment_events` broke timestamp ties by `provider_event_id` (alphabetical) rather than arrival order. I changed it to `rowid` and added a regression test, which fails against the old ordering.
- **Query validation (zod):** status/outcome enums, `limit` 1–200 (default 50), `offset` ≥ 0; anything else gets `400`.
- **Two `404` tests passed during the red phase for the wrong reason** (Fastify's default 404 for routes that didn't exist yet). I tightened them to assert our `ORDER_NOT_FOUND` code.
- **Real run:** complete before paid → 409; Authorised, then Captured ×2; complete → Completed; `GET /orders?status=Completed` lists it; the timeline shows the full causal history.
