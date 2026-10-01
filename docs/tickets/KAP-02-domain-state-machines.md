# KAP-02: Order and payment state machines (pure domain)

**Status:** Done

## Goal
All transition rules live in one pure, heavily tested place. Services only ask the domain "what happens if this event is applied?"

## Scope
- **Payment:** `Initiated → Authorised → Captured`; `Failed` and `Cancelled` are terminal. Rank: Initiated(0) < Authorised(1) < Captured(2).
- **Order:** `AwaitingPayment → Paid → Completed`; `AwaitingPayment → Cancelled`.
- `applyPaymentEvent(payment, order, event)` returns a decision: `{ outcome: applied | duplicate | stale | rejected, newPaymentStatus, newOrderStatus, reviewFlags[], reason }`. It never throws for expected business cases.
- Validation inside the decision: amount/currency match, the payment belongs to the order.

## Tests first
- Each valid forward transition.
- Same-status event → `duplicate` (no change).
- Backwards event (e.g. Authorised after Captured) → `stale` (no change).
- Captured from Initiated (skipping Authorised) → applied, order becomes Paid, review flag `CAPTURE_WITHOUT_AUTHORISATION`.
- Captured after Failed/Cancelled → applied, flag `CAPTURE_AFTER_TERMINAL`.
- Failed/Cancelled after Captured → `stale`, flag `CONFLICTING_EVENT_AFTER_CAPTURE`.
- Amount or currency mismatch on capture → `rejected`, order not Paid, flag `AMOUNT_MISMATCH`.
- Capture on a Cancelled order → payment recorded as Captured, order **not** Paid, flag `CAPTURE_ON_CANCELLED_ORDER` (refund needed).
- `complete(order)` is only allowed from Paid.

## Acceptance criteria
- The domain has no imports from infrastructure or HTTP.
- Every row of the transition table is covered by a test.

## Implementation notes
- Two additions beyond the original list, found while writing the table:
  - `DUPLICATE_PAYMENT_CAPTURED`: a second payment is captured on an order that is already Paid or Completed (the customer was double charged). The capture is recorded, the order is unchanged, and the flag is raised.
  - The amount check applies to Failed/Cancelled events too **if** they carry an amount. A mismatching amount on any event is suspicious.
- Mutation check: I made early captures (Initiated → Captured) be ignored, and 8 tests failed. The tests guard the key decision.
