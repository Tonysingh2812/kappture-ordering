# KAP-05: Payment webhook: verification, dedupe and isolation

**Status:** Done

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

## Implementation notes
- **`WebhookService` (application)** owns verification (through a `WebhookSignatureVerifier` port), parsing, dedupe and applying events. The route only extracts the raw body and signature header and maps the result: `200` handled, `401` bad signature, `500` unexpected.
- **One transaction per event:** record the delivery (the dedupe point), load the payment and order, run `persistPaymentEvent` (the domain rules), backfill `providerPaymentId`, and set the outcome. An internal error rolls everything back, **including the delivery record**, so the provider's retry is processed fresh. Tested at both the service and HTTP levels.
- **Bad signatures are not recorded.** Otherwise anyone could fill the dead-letter store. Signatures are HMAC-SHA256 over the **raw** body (the route uses an encapsulated raw-string parser), compared in constant time.
- **Invalid events are dead-lettered** (`payment_events.outcome = rejected`, with the reason) and acknowledged with `200`, because a retry wouldn't fix them. Unparseable bodies get a synthetic id `invalid:<sha256 of body>`, so identical garbage is also deduplicated.
- **Two layers of dedupe:** the unique `eventId` first, then the domain's forward-only rules. The mutation check showed this: with eventId dedupe switched off, the HTTP repeat test still passed because the domain returned `duplicate`; the service-level test is what catches it.
- **Mutation checks:** turning off eventId dedupe made 2 tests fail; accepting bad signatures made 4 fail.
- **Real run:** order → payment → the same signed webhook ×6 → one applied event, order Paid; a bad signature got 401.
- **Known edge:** if a provider ever sent a schema-invalid event and later a corrected one **with the same eventId**, the second would be treated as a duplicate. Real providers resend identical payloads per event id. Noted in the README limitations.
