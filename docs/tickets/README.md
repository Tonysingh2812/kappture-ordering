# Tickets

Work is split into tickets so progress is easy to track and each one lands as its own commit.

**Workflow per ticket (TDD):**
1. Write the tests listed under *Tests first*.
2. Run them and confirm they fail for the expected reason (red).
3. Implement the minimum needed to pass (green), then refactor.
4. Update the ticket status and any README sections it affects.
5. Commit with the ticket ID in the message, e.g. `KAP-03: Create order API with idempotency`.

| ID | Title | Status |
|---|---|---|
| [KAP-00](KAP-00-scaffold.md) | Project scaffold and tooling | Done |
| [KAP-01](KAP-01-database.md) | SQLite schema, migrations and repositories | Done |
| [KAP-02](KAP-02-domain-state-machines.md) | Order and payment state machines (pure domain) | Done |
| [KAP-03](KAP-03-create-order.md) | Create/get order API with idempotent submission | To do |
| [KAP-04](KAP-04-initiate-payment.md) | Payment initiation, provider port and uncertain outcomes | To do |
| [KAP-05](KAP-05-webhook-processing.md) | Payment webhook: verification, dedupe and isolation | To do |
| [KAP-06](KAP-06-out-of-order-and-review.md) | Out-of-order events, early capture and review flags | To do |
| [KAP-07](KAP-07-completion-and-listing.md) | Order completion and transaction/state listing | To do |
| [KAP-08](KAP-08-reconciliation.md) | Reconciliation of stuck payments (stretch) | To do |
| [KAP-10](KAP-10-e2e-tests.md) | End-to-end integration tests (real server, SQLite file, HTTP) | To do |
| [KAP-09](KAP-09-docs.md) | Final README: decisions, limitations, before production | To do |

KAP-01 and KAP-02 are independent of each other. Everything from KAP-03 onwards depends on both. KAP-10 runs once the flow works end to end (after KAP-07). KAP-09 is last.

Project rules (architecture layers, naming, TDD) are in the root [CLAUDE.md](../../CLAUDE.md).
