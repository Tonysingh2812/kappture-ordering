# Kappture Online Ordering: Order and Payment Service

A small backend service for the core online-ordering flow: create an order, associate a payment with it, process asynchronous payment events, and keep a reliable order/payment state, including under duplicate, out-of-order, invalid and uncertain-outcome conditions.

> Work in progress. Sections marked _TBD_ are filled in as tickets land (see [docs/tickets](docs/tickets/README.md)).

## Run instructions

**Prerequisites:** Node.js 22+ (see `.nvmrc`). The SQLite driver (better-sqlite3) ships prebuilt binaries for common platforms.

```bash
npm install
npm test            # run the test suite
npm run typecheck   # strict TypeScript check
npm run build       # compile to dist/
npm start           # run the compiled server on http://127.0.0.1:3000
npm run dev         # run from source with reload
```

Check it's running: `curl http://127.0.0.1:3000/health` returns `{"status":"ok"}`.

Configuration (environment variables): `PORT` (default `3000`), `HOST` (default `127.0.0.1`), `DATABASE_PATH` (default `kappture.db` in the working directory; migrations run on startup), `WEBHOOK_SECRET` (shared secret for provider webhook signatures; an insecure development default is used, with a warning, if it isn't set).

```bash
# Create an order (repeat the same command: same order, header idempotent-replayed: true)
curl -i -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"venueId":"venue-1","tableRef":"T12","items":[{"sku":"burger","name":"Burger","quantity":2,"unitPriceMinor":1250}],"currency":"GBP"}'

curl http://127.0.0.1:3000/orders/<order id>
```

_TBD: curl walkthrough of the full flow._

## Approach
_TBD_

## Assumptions
- **QR code:** scanning one gives the client a `venueId` and `tableRef`. QR handling itself is out of scope.
- **Prices:** the server computes the order total from the items. A client-supplied total is never trusted. A real system would look up prices from the venue's menu; here the client sends unit prices.
- **Currencies:** GBP, EUR and USD are accepted. A real venue would configure its own.
- **Duplicate submission:** the client generates one `Idempotency-Key` per logical order, e.g. when the customer taps "Place order", and reuses it on every retry. Two requests with identical bodies but different keys are two orders (e.g. two people at the same table ordering the same thing).

_More to come._

## Design decisions
| Decision | Alternatives | Why | Cost |
|---|---|---|---|
| TypeScript + Fastify | Express, NestJS | Light, first-class schema support, `inject()` for HTTP tests without a real port | Smaller ecosystem than Express |
| SQLite via better-sqlite3 | In-memory maps, Postgres | Durable and queryable history of every transaction and state; synchronous transactions keep "dedupe + state change" atomic; zero setup for reviewers | Single writer, single process; Postgres would be needed to scale out |
| Synchronous repository ports | Async (Promise-based) ports | better-sqlite3 transactions are synchronous; keeps "dedupe + state change + audit" in one guaranteed transaction | Moving to Postgres needs async ports and row-level locking |
| Provider events deduplicated by a unique `provider_event_id`, using one `INSERT … ON CONFLICT DO UPDATE` that counts deliveries | Check then insert; a separate row per delivery | Atomic and race-free; one row per logical event, with a delivery count for observability | Only the first delivery's payload is kept |
| `STRICT` tables + `CHECK` constraints + foreign keys | Rely on application validation only | Defence in depth: bad money or status values can't be persisted even if the code has a bug | Schema changes need migrations |
| Optimistic concurrency (`version` column) on orders and payments | Pessimistic locks | Cheap, and catches lost updates if the service ever runs concurrently | A conflict surfaces as an error and needs a retry |
| Idempotency enforced in the application service, storing the use-case result per key | Fastify middleware caching HTTP responses | "Don't create the same order twice" is a business rule, so it should be testable without HTTP and reusable from other entry points (queue, CLI) | The HTTP layer re-maps the replayed result to a status code |
| Claiming the key, writing the order, appending the event and storing the result happen in one transaction | Separate steps | A crash can't leave an order without its key (which would mean a duplicate on retry) | Only possible because the whole use case is synchronous; payment initiation (an external call) needs a different approach |
| Validate before claiming the idempotency key | Claim, then validate | A rejected body doesn't burn the key, so the client can fix the body and retry | An invalid request reusing a completed key gets `400` rather than `422` |
| zod checks shape and types at the edge; business rules live in the domain | Do everything in zod | Business rules are in one tested place and reusable outside HTTP | Two kinds of 400 (`VALIDATION_FAILED`, `INVALID_ORDER`) |
| **Payment row saved (Initiated) before calling the provider**, with our payment id as the merchant reference | Call the provider first, then save | If the response is lost or a webhook beats it, we can still match the callback to a payment. There's always a record of the attempt | A payment row exists even if the provider never heard of it (left Initiated; reconciliation settles it) |
| **Timeout or exhausted retries leave the payment `Initiated` ("pending"), never `Failed`** | Treat a timeout as failure | A timeout means "unknown". The provider may still capture the money, and marking it Failed would invite a second charge | The client must wait for the webhook or poll the order |
| Bounded retries (3 attempts, exponential back-off with jitter) on transient errors and timeouts, with the same provider idempotency key on every attempt | No retries; unbounded retries | Rides out blips without double-charging (the provider dedupes on the key) | Adds latency to the customer's request (see limitations) |
| The provider response is recorded by re-reading the payment and running a decline through the domain rules | Overwrite the status with the response | A webhook may have already captured the payment during the call; a late decline must not undo that | Slightly more complex phase 3 |
| One active payment (Initiated/Authorised) per order; a new attempt is allowed after Failed/Cancelled | Allow parallel payments | Prevents double charging from two devices at the same table | Split bills aren't supported |
| **Webhook status codes:** `200` for anything handled (applied, duplicate, stale **or rejected**), `401` for a bad signature, `500` only for unexpected internal errors | `4xx` for invalid events | The status code is an instruction to the provider: retrying a malformed event can't fix it, so it's dead-lettered and acknowledged. Only a transient fault on our side is worth a retry | Rejected events need monitoring (they're queryable in `payment_events`) |
| Each webhook is processed in **its own transaction**, including the delivery record | Shared batch or queue | One bad or failing event can never block or corrupt another order's processing; a rollback means the retry starts fresh | No batching |
| Unauthenticated webhooks are **not stored** | Store everything | Stops anyone filling the dead-letter store | A misconfigured secret loses evidence (the 401s are visible in logs) |
| HMAC-SHA256 over the raw body, compared in constant time | Verify the re-serialised JSON | Re-serialising can change bytes and break valid signatures | The webhook route needs its own body parser |
| Review flags are a **non-blocking queue** (`GET /review`, `POST /review/:id/resolve`), showing order and payment context | Block the order until a human approves it | Matches the agreed priority: the sale goes through, and unusual cases still get human eyes | Someone has to work the queue; an unworked queue means refunds are missed (needs alerting in production) |
| Vitest | Jest | Native TS/ESM, fast | None significant |
| Transition rules live in one pure function (`src/domain/payment-events.ts`) returning a decision (`applied` / `duplicate` / `stale` / `rejected` + review flags) | Rules spread across services/handlers; throwing on invalid transitions | One place to reason about and test exhaustively (every state × event); expected business cases are data, not exceptions | Services must persist the decision faithfully |
| Payments only move forward (Initiated → Authorised → Captured); backwards events are recorded as `stale` and ignored | Re-sequencing/buffering events by provider sequence number | No reliance on the provider ordering or on missing events ever arriving; simple and deterministic | We discard information from stale events (they are still stored for audit) |
| **Captured is accepted from any payment state if amount and currency match**, including straight from Initiated (no Authorised seen) and after Failed/Cancelled | Strictly require Authorised first; park the capture until Authorised arrives | Kappture's product must keep working through poor connectivity. Money has moved, so blocking the sale hurts the customer. Unusual paths raise **non-blocking review flags** rather than stopping fulfilment | Relies on signature verification and confident matching; a human must work the review queue |
| A capture that cannot be confidently matched (amount/currency differ or missing) is `rejected` and flagged; the order is not released | Accept and flag | "Confident match" is the condition for releasing a sale without human input | A genuine but malformed capture needs manual review |
| A capture on a Cancelled order, or a second capture on a Paid order, is recorded but does not change the order; it's flagged for refund | Reopen the order | Never silently release or double-fulfil | Refunds are manual for now |

_More to come._

## Testing
_TBD_

## Known limitations
- **No real payment provider.** `FakePaymentProvider` accepts every payment when the server runs. In tests it is scripted to decline, error, time out or throw.
- **Provider retries happen inside the customer's HTTP request,** so the worst case adds back-off delay plus the adapter's timeout per attempt. In production I'd return `202` immediately and run the provider call from a background job (an outbox).
- **Request timeouts are the provider adapter's responsibility.** The service trusts it to return `timedOut` and doesn't race its own timer.
- **Single payment per order at a time.** No split bills or partial payments.
- **Webhook signatures have no timestamp,** so a captured request could be replayed. Replays are harmless here (deduplicated on `eventId`), but production should use timestamped signatures with a tolerance window.
- **A schema-invalid event followed by a corrected event with the *same* `eventId`** would treat the second as a duplicate. Real providers resend identical payloads per event.
- **No order cancellation endpoint.** The `Cancelled` state and its rules exist in the domain (e.g. a capture on a cancelled order is flagged for refund), but cancelling is out of scope.
- **The review queue has no authentication or "resolved by" audit.** Resolving is just a timestamp.
- **Event payload contract is assumed:** `{ eventId, type, paymentId (our reference), providerPaymentId?, amountMinor?, currency?, occurredAt? }`. A real provider's format would be mapped to this in an adapter.

_More to come._

## Before production
_TBD_

## Use of AI tooling
_TBD_
