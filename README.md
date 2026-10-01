# Kappture Online Ordering: Order and Payment Service

A small backend service for the core online-ordering flow: create an order, associate a payment with it, process asynchronous payment events, and keep a reliable order/payment state, including under duplicate, out-of-order, invalid and uncertain-outcome conditions.

> Built within a timebox. Work was tracked as tickets in [docs/tickets](docs/tickets/README.md), with one commit per ticket. Project rules for humans and AI are in [CLAUDE.md](CLAUDE.md).

## Run instructions

These steps work on **Windows and macOS**. The npm scripts are plain Node commands, with no shell-specific syntax.

### Recommended editor: Visual Studio Code
Use [Visual Studio Code](https://code.visualstudio.com/). The repo includes `.vscode/extensions.json`, so VS Code offers two extensions when you open the folder:
- **Vitest** (`vitest.explorer`): run or debug any single test from the Testing sidebar.
- **SQLite Viewer** (`qwtel.sqlite-viewer`): click `kappture.db` to browse the `orders`, `payments`, `payment_events` and `review_flags` tables while you try the scenarios.

VS Code's built-in terminal (`` Ctrl+` `` on Windows, `` ⌃` `` on macOS) gives you the same shell commands on both platforms.

### 1. Prerequisites
- **Node.js 22 LTS or newer** (`.nvmrc` pins 22). Install it from [nodejs.org](https://nodejs.org/), or use a version manager: `nvm install 22` with [nvm](https://github.com/nvm-sh/nvm) on macOS, or [nvm-windows](https://github.com/coreybutler/nvm-windows) on Windows.
- **Git.**
- Check with `node --version` (v22 or newer) and `npm --version`.

The SQLite driver (`better-sqlite3`) downloads a prebuilt binary for Windows and macOS (Intel and Apple Silicon), so normally no compiler is needed. If `npm install` fails while building `better-sqlite3`:
- **macOS:** run `xcode-select --install`, then `npm install` again.
- **Windows:** install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload, then `npm install` again.

### 2. Get the code and install
```bash
git clone https://github.com/Tonysingh2812/kappture-ordering.git
cd kappture-ordering
npm install
```
(The repository is private; you need access to clone it.) Then open the folder in VS Code (**File → Open Folder…**, or `code .`).

### 3. Run the tests
```bash
npm test            # all tests: domain, repository, service, HTTP and e2e
npm run typecheck   # strict TypeScript check
npm run test:watch  # re-run tests on save
```
The e2e suite (`test/e2e/`) starts a real server on a random port with a real SQLite file in a temp folder and calls it with real `fetch`. Nothing to set up.

### 4. Run the service
```bash
npm run dev         # run from source, restarts on save (recommended while exploring)
# or
npm run build       # compile to dist/
npm start           # run the compiled server
```
The server listens on **http://127.0.0.1:3000**. Open http://127.0.0.1:3000/health in a browser; it should show `{"status":"ok"}`. Stop it with `Ctrl+C`.

### 5. Try the scenarios (easiest: the scenario tester page)
With the server running, open **http://127.0.0.1:3000/** in a browser. This page is the recommended way to explore on any OS, with no curl quoting differences to worry about. Work through it top to bottom:
1. **Create order:** click it twice with the same key, and the second response says `idempotent-replayed: true`.
2. **Initiate payment.**
3. **Send webhooks:**
   - **Captured** then **Authorised** shows out of order: the order becomes Paid with a review flag, and the late Authorised is `stale`.
   - The **same event id twice** is a duplicate.
   - **Bad signature** gets `401`.
   - **Unparseable body** is dead-lettered.
4. **Get order**, **Timeline**, **Review queue** and **Complete** show the results.

Every raw response is logged on the page. Webhooks are signed in the browser with the secret in the page's "Webhook secret" box, which must match the server's `WEBHOOK_SECRET` (the default matches).

To start again from an empty database, stop the server and delete `kappture.db` (plus `kappture.db-wal` and `kappture.db-shm` if present). It's recreated on the next start.

### Configuration (environment variables, all optional)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATABASE_PATH` | `kappture.db` (in the folder you start from) | SQLite file; migrations run on startup |
| `WEBHOOK_SECRET` | `dev-webhook-secret` (logs a warning) | Shared secret for provider webhook signatures |

How to set one depends on the shell:
```bash
# macOS / Linux (bash, zsh)
PORT=3001 npm run dev
```
```powershell
# Windows PowerShell (VS Code's default terminal on Windows)
$env:PORT = "3001"; npm run dev
```
```bat
:: Windows Command Prompt
set "PORT=3001" && npm run dev
```

### Optional: calling the API from the command line
The page above covers every scenario. If you prefer curl, these commands are for **macOS Terminal or Git Bash on Windows**. In PowerShell, `curl` is an alias for a different command; use `curl.exe` and escape the JSON quotes, or just use the page.
```bash
# Create an order (repeat it: same order, header idempotent-replayed: true)
curl -i -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"venueId":"venue-1","tableRef":"T12","items":[{"sku":"burger","name":"Burger","quantity":2,"unitPriceMinor":1250}],"currency":"GBP"}'

curl http://127.0.0.1:3000/orders/<order id>
```

## API

| Method and path | Purpose | Main responses |
|---|---|---|
| `POST /orders` | Create an order (requires an `Idempotency-Key` header) | `201`; replay `201` + `Idempotent-Replayed: true`; `400`; `409` in progress; `422` key reused |
| `GET /orders/:id` | Order with payments, audit events and review flags | `200`, `404` |
| `POST /orders/:id/payments` | Start a payment (requires an `Idempotency-Key` header) | `202` accepted/pending, `402` declined, `404`, `409`, `422` |
| `POST /webhooks/payments` | Provider events (signed with `X-Provider-Signature`) | `200` handled (incl. duplicate/stale/rejected), `401`, `500` |
| `POST /orders/:id/complete` | Hand a paid order to fulfilment (idempotent) | `200`, `404`, `409` not paid |
| `GET /orders?status=&limit=&offset=` | List orders | `200`, `400` |
| `GET /payments?status=&limit=&offset=` | List payments | `200`, `400` |
| `GET /payment-events?outcome=&limit=&offset=` | Every provider event received; `?outcome=rejected` is the dead-letter view | `200`, `400` |
| `GET /orders/:id/timeline` | Audit events and provider events merged in time order | `200`, `404` |
| `GET /review` / `POST /review/:id/resolve` | Non-blocking review queue | `200`, `400`, `404` |

Errors always look like `{ "error": { "code", "message", "details"? } }`.

## Approach
1. **Domain first.** The order and payment state machines are a single pure function. It decides what each payment event means (`applied` / `duplicate` / `stale` / `rejected`, plus review flags) and never touches I/O. It's tested exhaustively: every state × event, plus the arrival-order permutations.
2. **Application services own the use cases:** create order, initiate payment, handle webhook, complete, review, history. Idempotency, transactions and failure handling live here, so business logic is completely separate from HTTP and testable without it.
3. **Ports and adapters.** Repositories, payment provider, signature verifier, clock, sleeper and id generator are interfaces. SQLite, the fake provider and HMAC are the adapters.
4. **Thin HTTP layer.** Fastify routes validate the request's shape (zod), call one service and map typed results to status codes.
5. **Every source of payment truth goes through the same rules.** The provider's response to initiation, the webhooks and (later) reconciliation all use `persistPaymentEvent`, so a late or contradictory signal can never undo a capture.

```
HTTP (Fastify routes) → application services → domain (pure rules)
                               ↓ ports
             SQLite repositories · fake provider · HMAC · clock
```

## Assumptions
- **QR code:** scanning one gives the client a `venueId` and `tableRef`. QR handling itself is out of scope.
- **Prices:** the server computes the order total from the items. A client-supplied total is never trusted. A real system would look up prices from the venue's menu; here the client sends unit prices.
- **Currencies:** GBP, EUR and USD are accepted. A real venue would configure its own.
- **Duplicate submission:** the client generates one `Idempotency-Key` per logical order, e.g. when the customer taps "Place order", and reuses it on every retry. Two requests with identical bodies but different keys are two orders (e.g. two people at the same table ordering the same thing).

## Design decisions
The key decisions are below. Smaller ones are recorded in each ticket's notes in [docs/tickets](docs/tickets/README.md).

1. **PaymentCaptured while the order is still AwaitingPayment: accept it if it confidently matches.** A confident match means our payment reference, the amount and currency, and a verified signature all agree. The order becomes Paid, and a **non-blocking** review flag is raised. *Why:* Kappture's product has to keep working through poor connectivity, and the money has moved, so blocking a real sale hurts the customer. *Rejected:* strict ordering (the customer is charged but the order is stuck), and parking the event until Authorised arrives (that needs a timeout fallback that ends up accepting anyway). *Cost:* relies on signature checks and someone working the review queue. A capture that doesn't match is rejected and flagged, and the order isn't released.
2. **Payments only move forward** (Initiated → Authorised → Captured). Backwards events are recorded as `stale` and ignored. Captured wins over an earlier Failed/Cancelled (money moved), with a flag. *Why:* deterministic, and it doesn't rely on the provider's ordering or on missing events ever arriving. All of this lives in one pure function, tested against every state × event.
3. **Idempotency belongs to the application service, in one transaction.** Claiming the key, writing the order and audit event, and storing the result happen atomically, and retries replay the original result. *Why:* "don't create or charge twice" is a business rule, so it's testable without HTTP, and a crash can't leave an order without its key. *Cost:* the HTTP layer re-maps replayed results to status codes.
4. **The payment is saved (Initiated) before calling the provider, and a timeout is never a failure.** Our payment id is the merchant reference, and retries are bounded with back-off, jitter and the same provider idempotency key. *Why:* a webhook that beats the response can always be matched, and a timeout means "unknown", so the provider may still capture. *Cost:* the client waits for the webhook, and retries add latency to the request (moving them to a background job is listed under next steps).
5. **Every source of payment truth goes through the same rules** (`persistPaymentEvent`): the provider's response, webhooks, and later reconciliation. *Why:* a late decline can't undo a capture that a webhook already recorded.
6. **Webhooks:** HMAC over the raw body, deduplicated on a unique `eventId`, and each event processed in its own transaction. Status codes tell the provider what to do: `200` for anything handled (including rejected events, which are dead-lettered because retrying can't fix them), `401` for a bad signature, and `500` only for our own transient faults (rolled back, so the retry starts fresh). *Why:* one bad event never blocks another order, and repeats are harmless.
7. **SQLite (better-sqlite3) with synchronous transactions.** `STRICT` tables, `CHECK` constraints and version columns add defence in depth. *Why:* a durable, queryable history of every transaction and state with zero setup, and atomic "dedupe + state change + audit". *Cost:* single process; Postgres would need async ports and row locking.
8. **A device/session ID instead of device fingerprinting** (agreed and designed, not implemented; see "What I'd do next"). *Why:* fingerprints collide on shared venue Wi-Fi (false duplicates would block real sales), are spoofable, and fall under PECR consent rules.

## Testing
Built test-first: each ticket's tests were written and run red before the implementation. **245 tests:**
| Level | What | Why |
|---|---|---|
| Domain | Full transition table (5 payment states × 4 events), confident matching, arrival-order permutations | The rules that matter most, tested exhaustively and fast |
| Repository | Round trips, dedupe statement, optimistic concurrency, rollback, constraints, file persistence | The guarantees the services rely on |
| Service | Idempotency, retries and back-off, timeouts, webhook races, dead-lettering, rollback-and-retry | Business behaviour without HTTP |
| HTTP | Status codes, validation, headers, error bodies | The contract clients and the provider rely on |
| E2E | One test per failure mode in the brief, the happy path, restart durability | The pieces work together over real HTTP and a real file |

**Mutation checks:** for the key rules (early capture, eventId dedupe, signature check, "timeout is not failure", key reuse), I deliberately broke the code and confirmed the tests failed.

**Not tested:** load or concurrency across multiple processes (single-process SQLite), the scenario tester page beyond "it is served", and a real provider.

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
- **The fake provider is configured in code.** The scenario tester can't simulate a provider timeout; that scenario is covered by the e2e and service tests.
- **Single process.** SQLite with synchronous transactions serialises writes, which is why the race conditions are handled by design rather than by locks.

## What I'd do next (not done within the timebox)
1. **KAP-11: device/session ID.** Scope idempotency keys per device, and soft duplicate detection for a lost key (same device + same basket within 60s → `409 POSSIBLE_DUPLICATE` with a confirm override). This was agreed **instead of device fingerprinting** (false duplicates on shared venue Wi-Fi, spoofable, PECR consent). The tests are written and the implementation is half done on branch `kap-11-device-id-wip`.
2. **KAP-08: reconciliation.** Periodically ask the provider about payments stuck in `Initiated`/`Authorised` (lost webhooks), and apply the answer through the same `persistPaymentEvent` path.
3. **Move the provider call out of the customer's request:** return `202` immediately and call the provider from an outbox or background worker.

## Before production
- A real provider adapter (its own timeouts, mapping of its event format), timestamped webhook signatures, and secrets from a secret manager.
- Postgres (async ports, row locking or `SELECT … FOR UPDATE`), an outbox for fulfilment notifications, and TTL clean-up of idempotency keys.
- Authentication: customers for their own orders, staff for listings, completion and the review queue (with a "resolved by" audit).
- **Logging throughout, so every error and decision can be traced.** Today only Fastify's request logs and the 500 handler log anything. Before production I'd add:
  - **Structured (JSON) logs at every decision point in the services:**
    - order created, or an idempotent replay
    - payment initiated
    - each provider attempt, with its outcome and back-off delay
    - each webhook, with its outcome (applied, duplicate, stale or rejected) and the reason
    - every state transition
    - every review flag raised
  - **Correlation:** a request id on every log line, plus `orderId`, `paymentId` and `providerEventId`. One order's journey can then be followed from the first request, through provider calls and webhooks, to completion, and matched against the provider's own logs.
  - **Errors** logged with stack traces and that context (internally only; clients still get the generic `INTERNAL_ERROR` body).
  - **No card data, secrets or signatures in logs.** Device and customer identifiers would be reviewed for PII.
  - **Implementation:** a `Logger` port injected into the services like the clock, so log output can also be asserted in tests.
- **Metrics and alerts** on review flags, rejected or dead-lettered events, duplicates, payments stuck in `Initiated`, and provider latency and error rates.
- Load testing, plus a cancellation flow with automatic refunds for `CAPTURE_ON_CANCELLED_ORDER` and `DUPLICATE_PAYMENT_CAPTURED`.

## Use of AI tooling
Built with Claude Code as a pair programmer.

### Where it materially accelerated the work
- **Writing tests, in volume and fast.** About 245 tests across the domain, repositories, services, HTTP and e2e. That includes the exhaustive transition table (every payment state × event), the arrival-order permutation tests, and a test for each failure mode. Writing that many tests first, by hand, wouldn't have fitted in the timebox. AI made strict TDD practical rather than aspirational.
- **Building the models.** The domain types, the order and payment state machines, and the typed result shapes for each use case.
- **The database structure and test doubles.** The SQLite schema and migrations, the repositories and their mapping to and from records, and the test support around them: a fresh in-memory database per test, record builders, a fake clock, an instant sleeper, and a scriptable fake payment provider that can decline, error, time out or throw.

### Where I kept control
I kept control of the decisions and the process:
- **Decisions were mine.** I chose the answer to the "PaymentCaptured while AwaitingPayment" question (accept a confident match so the sale goes through, plus a non-blocking review flag), "Captured wins + flag" for conflicting events, SQLite for an auditable history, and a device/session ID rather than fingerprinting. The AI laid out the options and trade-offs; I chose.
- **Process rules I set:** strict TDD (tests seen failing first), one ticket and one commit at a time, business logic separate from endpoints, naming conventions. They're written into `CLAUDE.md` so the agent follows them.
- **What was verified rather than trusted:**
  - every red → green step was run
  - mutation checks on the key rules
  - the built server was smoke-tested over real HTTP after each ticket
  - the e2e suite runs against a real port and a real file
- **Where verification caught problems:** wrong test assumptions (a duplicate payment idempotency key in a builder, a back-off value, a version count); two tests passing for the wrong reason (Fastify's default 404), which were tightened; and a real ordering bug in the event log (alphabetical rather than arrival order), fixed with a regression test.
- **Scope control:** I deferred reconciliation and parked KAP-11 on a branch when time ran short, rather than leaving `main` broken.
