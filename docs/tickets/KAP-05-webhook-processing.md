# KAP-05: Payment webhook: verification, dedupe and isolation

**Status:** To do

## Goal
Process asynchronous payment events exactly once in effect. A bad event must never block other orders.

## Scope
- `POST /webhooks/payments`, with the event shape `{ eventId, type, paymentId, providerPaymentId?, amountMinor, currency, occurredAt }`.
- Handled types: PaymentAuthorised, PaymentCaptured, PaymentFailed, PaymentCancelled.
- Pipeline:
  1. Verify the HMAC signature header (shared secret). If invalid → `401`, and nothing is recorded as applied.
  2. Validate the schema (zod). If invalid → record in `payment_events` as `rejected` (when an eventId is present) and return `200`.
  3. In a single transaction:
     - insert into `payment_events` (the unique `eventId` is the dedupe point)
     - load the payment and order
     - get a decision from the domain (KAP-02)
     - persist the new states, the `order_events` entry and any review flags
  4. If the eventId was already seen → `200`, outcome `duplicate`, no other changes.
  5. Unknown paymentId → `rejected` (dead-letter), `200`.
  6. Only unexpected internal errors → `500`, and the transaction rolls back, so the provider's retry is safe.
- Response codes are documented as part of the contract: 2xx means "don't retry".

## Tests first
- Valid capture → order `Paid`, `PaymentCaptured` appears in the history.
- The same event delivered 3 times → a single state change, one `applied` row, and the repeats counted as duplicates. *(An event row per delivery, or a counter: decide during implementation and document it.)*
- Bad signature → `401`, and no state change.
- Malformed payload → `200` and stored as rejected, and a valid event for a **different order** sent straight afterwards is processed normally.
- Unknown paymentId → `200` rejected; other orders are unaffected.
- A simulated repository failure part-way through → `500`, with no partial writes, and a retried delivery then succeeds.

## Acceptance criteria
- Duplicate and isolation behaviour is proven through the HTTP endpoint.
