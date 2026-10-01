# KAP-07: Order completion and transaction/state listing

**Status:** To do

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
