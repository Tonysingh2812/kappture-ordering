# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository. **Follow these rules for every change.**

## Project

A timeboxed technical exercise for Kappture: a backend service for the online-ordering flow. A customer scans a QR code, creates an order and pays; payment status arrives asynchronously; the order becomes available for fulfilment once the required conditions are met.

The service must support creating an order, associating a payment with it, processing async payment events, and keeping a reliable order/payment state under these failure modes:
- duplicate order submission (client retries after a timeout)
- duplicate payment callbacks
- out-of-order events
- invalid events or orders (they must not block unrelated orders)
- uncertain outcomes (the payment succeeds after the initiating request timed out)

The assessors care most about decomposition, decisions and trade-offs, handling of ambiguity/retries/failures, testing of the behaviours that matter, and clear reasoning about limitations. It is **not** meant to be production-complete. When the timebox ends, stop and document what's next.

Deliverables: working code, automated tests, README (approach, assumptions, decisions, limitations, before production), and run instructions.

## Commands

```bash
npm test            # Vitest, all tests
npm run typecheck   # tsc --noEmit (strict)
npm run build       # compile src/ to dist/
npm start           # run dist/server.js
npm run dev         # run from source with reload
```

Node 22 (Homebrew `node@22`, keg-only) lives at `/opt/homebrew/opt/node@22/bin`. If `node` isn't on PATH in a non-login shell, prefix commands with `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. `gh` is at `/opt/homebrew/bin/gh`.

## Architecture rules

Business logic is **completely separate from endpoints**, so it's reusable and testable without HTTP.

| Layer | Folder | Responsibility | May import |
|---|---|---|---|
| Domain | `src/domain/` | Pure rules: state machines, decisions, validation of business invariants. No I/O, never throws for expected business cases (returns results). | Nothing outside `domain/` |
| Application | `src/application/` | Use-case services (create order, initiate payment, handle payment event, complete order, reconcile). They orchestrate the domain, repositories and ports inside transactions. Ports (interfaces) for repositories, the payment provider and the clock live here. | `domain/` |
| Infrastructure | `src/infrastructure/` | SQLite repositories, migrations, fake payment provider, clock. Implements the ports. | `application/`, `domain/` |
| HTTP | `src/http/` | Fastify routes **only**: parse/validate the request (zod), call one application service, map its result to a status code and body. No business decisions here. | `application/`, `domain/` types |
| Composition | `src/app.ts`, `src/server.ts` | Wire the dependencies together. `buildApp(deps)` never binds a port. | Everything |

If a route handler contains an `if` about order or payment state, it belongs in a service or the domain.

## Coding conventions

- **TypeScript only**, strict mode. Relative imports use the `.ts` extension (`import { x } from './x.ts'`); tsc rewrites them to `.js` on build.
- **lowerCamelCase** for all variables, constants, functions, parameters and properties. No `UPPER_SNAKE_CASE`, even for module-level constants. Types and interfaces are PascalCase.
- **Booleans** (variables, properties, parameters, result fields) start with `is`, `has`, `should` or `can`, e.g. `isOk`, `hasChanged`, `shouldLog`, `canRetry`.
- Database columns are snake_case (SQL convention). Repositories map them to camelCase properties, so nothing outside `src/infrastructure/` sees snake_case.
- Money is integer minor units (`amountMinor`, `totalMinor`) plus an ISO currency code. Never floats.
- Expected failures are returned as typed results (`{ isOk: false, error: ... }`), not thrown. Throw only for genuinely unexpected errors.
- Keep comments for the *why*. The code says the *what*.

## Workflow (TDD, tickets, commits)

- Work is tracked as tickets in `docs/tickets/` (index: `docs/tickets/README.md`).
- **Strict TDD:** write the tests first, run them and confirm they fail for the expected reason (prefer stubs that throw `Not implemented` over missing imports), then implement until green, then refactor.
- Test levels:
  - **Domain:** exhaustive, table-driven unit tests.
  - **Application services:** tested directly against an in-memory SQLite database (`:memory:`) and fakes, without HTTP.
  - **HTTP:** `app.inject()` tests for the request/response contract (validation, status codes, idempotency headers).
  - **E2E** (once the flow works end to end): a real server on a port, a real SQLite file and real HTTP calls, exercising the full flow and the failure modes (KAP-10).
- Retry/timeout logic takes an injectable clock/sleep, so tests are fast and deterministic.
- Optionally, do a mutation check on key rules: deliberately break the rule and confirm the tests fail.
- Before committing: `npm run typecheck` and `npm test` are green, the ticket status and notes are updated, and the README sections the ticket affects are updated.
- One commit per ticket (`KAP-NN: <title>`), pushed to `origin main` (public GitHub repo `Tonysingh2812/kappture-ordering`). End commit messages with the Co-Authored-By trailer.

## Agreed design decisions

These are recorded in full in the README "Design decisions" section and in the tickets.
- **Payments only move forward:** Initiated → Authorised → Captured. Backwards events are recorded as `stale` and ignored. Failed/Cancelled are terminal.
- **Captured while the order is still AwaitingPayment:** accepted if it confidently matches, meaning our payment reference, the amount and currency, and a verified signature all agree. The order becomes Paid, so the sale goes through, and a **non-blocking** review flag is raised. Rationale: Kappture's product must keep working through poor connectivity, and blocking a real paid sale hurts the customer. A capture that doesn't match is rejected and flagged; the order is not released.
- **Captured after Failed/Cancelled:** the capture wins (money moved) and is flagged. Failed/Cancelled after Captured is stale and flagged.
- **Capture on a Cancelled order, or a second capture on a Paid order:** recorded but the order is not changed; flagged for refund.
- **Idempotency:** client requests carry an `Idempotency-Key` header. Provider events are deduplicated on a unique `eventId`, recorded atomically with the state change.
- **Uncertain outcome:** the Payment row is persisted **before** calling the provider. A timeout leaves it `Initiated`, never `Failed`. The webhook (or reconciliation) is the source of truth.
- **Webhook status codes:** 2xx means "handled or durably rejected, don't retry". 5xx is only for transient internal failures. 401 is for a bad signature.
- **Device layer (KAP-11):** use a random device/session ID (`X-Device-Id`, generated client-side on first QR scan), **not** device fingerprinting, which causes false duplicates on shared venue Wi-Fi, is spoofable and has PECR consent issues. The ID scopes idempotency keys per device. Soft duplicate detection covers the same device + identical basket within 60s under a new key: return `409 POSSIBLE_DUPLICATE` with a `confirmDuplicate: true` override. Never block silently.
- **Persistence:** SQLite (better-sqlite3), so every transaction, event and state can be listed and audited.
