# KAP-04: Payment initiation, provider port and uncertain outcomes

**Status:** Done

## Goal
Associate a payment with an order and keep a coherent source of truth even when the call to the provider times out or fails.

## Scope
- `PaymentProvider` port: `initiate({ paymentId, amountMinor, currency, idempotencyKey })`.
- `FakePaymentProvider`, scriptable per test: success, permanent decline, transient error, timeout (the outcome is unknown, but the provider may still capture and send a webhook later).
- `POST /orders/:id/payments` (requires an `Idempotency-Key` header):
  1. In one transaction: check the order is `AwaitingPayment` and has no active payment, then insert the Payment as `Initiated` and append `PaymentInitiated`. **This is committed before the provider is called.**
  2. Call the provider with our `paymentId` as the merchant reference, and an outbound timeout.
  3. On success: store `provider_payment_id`, return `202`.
  4. On timeout: leave the payment `Initiated` and return `202` with `status: "pending"`. The webhook or reconciliation will resolve it.
  5. On a transient error: bounded retries with exponential backoff and jitter, using the same provider idempotency key each time. Once retries are exhausted, treat it like a timeout.
  6. On a permanent decline: mark the payment `Failed`. The order stays `AwaitingPayment`, so the customer can retry with a new payment.
- Retry/backoff takes an injectable `sleep`/clock so tests are fast.

## Tests first
- Happy path → `202`, the payment is persisted and linked to the order.
- Provider timeout → `202 pending`, payment `Initiated`, never `Failed`.
- **Uncertain outcome:** provider times out, then a `PaymentCaptured` webhook arrives → the order becomes `Paid` (completed in KAP-05).
- A transient error twice then success → 3 provider calls, all with the same idempotency key.
- Permanent decline → payment `Failed`, and a new payment attempt is then allowed.
- The same `Idempotency-Key` repeated → no second payment row and no second provider call.
- Initiating on an order that is `Paid` or `Cancelled`, or that already has an active payment → `409`.

## Acceptance criteria
- No code path marks a payment `Failed` just because the outcome is unknown.

## Implementation notes
- **Three phases**, because an external call can't sit inside a database transaction:
  1. **Claim (transaction):** claim the idempotency key, check the order, and save the payment as `Initiated` plus a `PaymentInitiated` event. Business refusals (not found, not payable, payment already in progress) release the key.
  2. **Call (no transaction):** bounded retries with exponential back-off and jitter, the same provider idempotency key on every attempt, and unexpected exceptions treated as transient.
  3. **Record (transaction):** **re-read** the payment, because a webhook may have changed it during the call. An `accepted` response stores `providerPaymentId` without touching the status. A `declined` response becomes a synthetic `PaymentFailed` event run through the **domain rules**, so a late decline can't undo a capture (it gets flagged instead). A timeout or exhausted retries leaves the payment unchanged, giving `pending`.
- **`persistPaymentEvent`** is a new shared application helper: domain decision → save statuses, audit events and flags. KAP-05 (webhooks) and KAP-08 (reconciliation) reuse it, so every source of payment truth goes through one set of rules.
- **Provider adapters own their request timeout** and report it as `timedOut`. The service doesn't add its own race-based timeout, which would make tests non-deterministic with an instant sleeper. Documented as a limitation.
- **HTTP:** `202` for accepted or pending (the final result arrives asynchronously), `402` when the payment ended up `Failed` (declined), and `409` for not payable or already in progress.
- **Mutation check:** I made unknown outcomes mark the payment Failed, and 3 tests failed (service and HTTP).
- The "uncertain outcome resolved by a later webhook" test belongs to KAP-05, which adds the webhook.
