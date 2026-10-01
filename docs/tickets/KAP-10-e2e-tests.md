# KAP-10: End-to-end integration tests

**Status:** Done (timeboxed; see notes)

## Goal
Prove that the real pieces work together: the HTTP server, the application services, the SQLite file and the fake provider, not just each piece in isolation.

## Scope
- Start the real server on an ephemeral port with a temporary SQLite **file**. Talk to it over real HTTP (`fetch`), not `app.inject`.
- The fake provider sends signed webhooks to the server over HTTP, so callbacks really are asynchronous.
- A separate `npm run test:e2e` script, also run by `npm test` (or documented if it's kept separate for speed).

## Tests first
- **Happy path:** create order → initiate payment → provider sends Authorised then Captured → order `Paid` → complete → `Completed`, and the listing endpoints show every transition.
- **Duplicate submission:** POST /orders retried with the same `Idempotency-Key` → one order in the database.
- **Duplicate callback:** the same Captured webhook delivered 3× → one state change.
- **Out of order:** Captured before Authorised → `Paid` with a review flag, and the late Authorised is stale.
- **Isolation:** a malformed webhook between two valid ones for different orders → both valid orders are processed.
- **Uncertain outcome:** the provider times out on initiation but later sends Captured → order `Paid`.
- **Durability:** restart the server on the same SQLite file → state and history are intact, and a replayed event is still recognised as a duplicate.

## Acceptance criteria
- E2E tests are documented in the README's run instructions.
- Depends on KAP-03 to KAP-07.

## Implementation notes (timeboxed)
- `test/e2e/scenarios.e2e.test.ts` covers:
  - happy path, including the timeline
  - duplicate order submission
  - duplicate payment request
  - duplicate callback
  - out-of-order events (early capture + stale Authorised)
  - invalid events / bad signature / unknown payment, without blocking another order
  - uncertain outcome (timeout, then webhook)
  - restart durability
- It runs a real server on port 0, a SQLite file in a temp directory, and `fetch`. The tests passed on the first run: they're acceptance tests of behaviour each ticket had already proven red → green.
- **Not done:** the fake provider sending webhooks to the server by itself (the tests send signed webhooks as the provider would), a separate `test:e2e` script (they run as part of `npm test`), and KAP-11 coverage (that ticket is parked).
