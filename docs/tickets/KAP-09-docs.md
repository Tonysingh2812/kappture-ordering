# KAP-09: Final README: decisions, limitations, before production

**Status:** To do

## Goal
The deliverable README covers everything the brief asks for.

## Scope
- **Run instructions:** prerequisites, install, test, start, plus a curl walkthrough of the full flow, including a duplicate and an out-of-order webhook.
- **Approach and decomposition:** layers and state machines, with a diagram.
- **Assumptions.**
- **Design decisions and trade-offs**, including idempotency, dedupe, out-of-order policy, the early-capture decision, webhook status codes, and SQLite.
- **Testing:** what's covered, what isn't, and why.
- **Known limitations:**
  - single process
  - SQLite write concurrency
  - no auth
  - fake provider
  - no partial or split payments
- **Before production:**
  - provider verification and scheduled reconciliation
  - outbox for fulfilment events
  - Postgres with row locking
  - observability (metrics on flags, duplicates, stale events)
  - auth
  - secrets management
  - retention of idempotency keys
  - load testing
- **Use of AI tooling:** what was delegated, what was verified by hand, and what was changed or rejected.

## Acceptance criteria
- A reviewer can clone, run the tests and walk through the flow using only the README.
