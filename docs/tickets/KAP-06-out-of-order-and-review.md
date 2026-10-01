# KAP-06: Out-of-order events, early capture and review flags

**Status:** Done

## Goal
Implement and prove the deliberate out-of-order policy and the agreed answer to the key scenario.

## Decision (agreed 2026-10-01)
**PaymentCaptured received while the order is still AwaitingPayment:** accept it **if it confidently matches**, meaning all of the following:
- the payment reference we generated
- the amount and currency
- a verified signature

The order moves to `Paid` so the sale goes through, and a **non-blocking** review flag is raised for later internal checking.

Rationale: Kappture's product has to keep working through poor connectivity. Losing or blocking a real, paid sale hurts the customer more than reviewing it afterwards. If anything doesn't match, the order is **not** released and is flagged instead.

**Conflicting terminal events:** Captured wins over an earlier Failed/Cancelled, because money has moved, and the payment is flagged. Failed/Cancelled arriving after Captured is ignored as stale and flagged.

Considered and rejected:
- Strict ordering, i.e. reject and rely on provider retries: the customer is charged but the order is stuck.
- Parking the event until Authorised arrives: needs a timeout fallback, which ends up as acceptance anyway.

Listed for before production: confirm with the provider's API, or reconcile asynchronously.

## Scope
- Wire the KAP-02 decisions end to end through the webhook.
- `GET /review`: open review flags with order/payment context.
- `POST /review/:id/resolve`: optional, if time allows.

## Tests first (HTTP level)
- Captured with no prior Authorised → order `Paid`, flag `CAPTURE_WITHOUT_AUTHORISATION`, and it appears in `GET /review`.
- Then a late Authorised arrives → `stale`, no change, no error.
- Captured with the wrong amount → order stays `AwaitingPayment`, flag `AMOUNT_MISMATCH`.
- Failed then Captured → payment `Captured`, order `Paid`, flag `CAPTURE_AFTER_TERMINAL`.
- Captured then Failed → stays `Captured`, flag `CONFLICTING_EVENT_AFTER_CAPTURE`.
- Captured for a Cancelled order → order not released, flag `CAPTURE_ON_CANCELLED_ORDER`.
- Property-style test: any permutation of {Authorised, Captured} for a matching payment ends at `Paid`/`Captured`.

## Acceptance criteria
- The README "Design decisions" section contains this reasoning.

## Implementation notes
- **About TDD here:** the out-of-order rules were already built test-first (KAP-02) and wired through the webhook (KAP-05). I expected the new HTTP acceptance tests to pass immediately. They actually failed first, because their state reader also queries `GET /review`, which didn't exist yet. That's a genuine dependency on the new code, and they went green once the review queue was built.
- **`ReviewService` (application):** `listOpen()` returns each open flag with its order and payment context (oldest first); `resolve(id)` timestamps the flag from the clock. Routes: `GET /review` and `POST /review/:id/resolve` (`404 FLAG_NOT_OPEN` if the flag is unknown or already resolved, `400` for a non-numeric id).
- **Acceptance tests** (`test/http/out-of-order.test.ts`) drive the whole flow over HTTP: create order → initiate payment → signed webhooks → read the order and the review queue. They cover:
  - early capture (agreed decision), followed by a stale late Authorised
  - amount or currency mismatch (not released)
  - Failed → Captured
  - Captured → Failed
  - capture on a cancelled order
  - all 6 permutations of Authorised/Captured/Failed
- **Mutation check:** I made early captures be ignored, and 4 HTTP acceptance tests failed (plus 8 domain tests, from KAP-02).
- No cancel endpoint is in scope. The cancelled-order test sets the status directly in the store; noted in the README limitations.
