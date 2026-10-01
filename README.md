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

_TBD: curl walkthrough of the full flow._

## Approach
_TBD_

## Assumptions
_TBD_

## Design decisions
| Decision | Alternatives | Why | Cost |
|---|---|---|---|
| TypeScript + Fastify | Express, NestJS | Light, first-class schema support, `inject()` for HTTP tests without a real port | Smaller ecosystem than Express |
| SQLite via better-sqlite3 | In-memory maps, Postgres | Durable and queryable history of every transaction and state; synchronous transactions keep "dedupe + state change" atomic; zero setup for reviewers | Single writer, single process; Postgres would be needed to scale out |
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
_TBD_

## Before production
_TBD_

## Use of AI tooling
_TBD_
