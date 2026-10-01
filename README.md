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

_More to come._

## Testing
_TBD_

## Known limitations
_TBD_

## Before production
_TBD_

## Use of AI tooling
_TBD_
