# KAP-08: Reconciliation of stuck payments (stretch)

**Status:** Deferred: documented in README "What I'd do next"

## Goal
Webhooks can be lost entirely. Payments stuck in `Initiated` or `Authorised` must still be resolved.

## Scope
- `PaymentProvider.getStatus(paymentId)`.
- `reconcile(olderThan)` service: for each stale non-terminal payment, query the provider, turn the result into a synthetic event (`eventId = reconcile:<paymentId>:<status>`), and apply it through the **same** domain path as webhooks.
- Triggered by `POST /admin/reconcile`. A scheduler is noted as a before-production item.

## Tests first
- A payment stuck in Initiated, with the provider reporting Captured → order `Paid`.
- Provider unreachable for one payment → that one is skipped and the others are still reconciled.
- Reconciliation and a real webhook for the same capture → a single state change.

## Acceptance criteria
- If this isn't reached within the timebox, it's documented in the README under "What I'd do next".
