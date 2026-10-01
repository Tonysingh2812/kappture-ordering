# KAP-06: Out-of-order events, early capture and review flags

**Status:** To do

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
