# KAP-11: Device/session ID for idempotency scoping and soft duplicate detection

**Status:** To do

## Goal
Add a device-level layer on top of idempotency keys:
- keys can't collide across devices
- one device can't replay another's key to read its response
- an order resubmitted under a *new* key (e.g. the page reloaded mid-submit and lost the key) is caught, without blocking genuine repeat orders

## Decision (agreed 2026-10-01)
Use a **device/session ID**, not device fingerprinting.
- The client generates a random UUID when the QR code is first scanned, stores it locally, and sends it as `X-Device-Id` on every request.
- **Fingerprinting was rejected** for three reasons:
  - **False duplicates:** identical phones on the venue's Wi-Fi produce the same fingerprint, which would block real sales.
  - **Spoofable:** the server only sees what the client sends.
  - **Privacy:** fingerprinting falls under PECR consent rules in the UK. A random functional ID is a far easier position.

## Scope
- **`X-Device-Id` header,** required on `POST /orders` and `POST /orders/:id/payments`. A missing or invalid value gets `400 VALIDATION_FAILED`.
- **Idempotency scope includes the device:** `(useCase, deviceId, key)`. The same key from another device is a different request, and it can't read or replay the first device's stored result.
- **Audit:** `device_id` is stored on orders and payments (migration) and included in `OrderCreated`/`PaymentInitiated` event data.
- **Soft duplicate detection on order creation:**
  - **Trigger:** the same device and an **identical basket** (venue, table, items, currency) within **60 seconds**, under a **different** idempotency key.
  - **Result:** `409 POSSIBLE_DUPLICATE`, with the existing order id in the response.
  - **Override:** the client resends with `confirmDuplicate: true` in the body to create it anyway (the customer really does want "same again").
  - **Where the logic lives:** the application service (business logic), not HTTP. The time window comes from the injected clock.
- **Documentation:** README sections (assumptions, decisions, limitations). Note that the device ID is a convenience layer: a client that clears storage gets a new ID, and the idempotency key is still the primary guarantee.

## Tests first
- The same idempotency key from two devices → two separate orders; neither sees the other's stored result.
- A replay from the same device and key → the original result, as before.
- The same device and basket under a new key within 60s → `POSSIBLE_DUPLICATE` with the existing order id; no new order.
- The same as above with `confirmDuplicate: true` → order created.
- The same basket from a **different** device → created (no false duplicates across a table).
- The same device and basket after 61s → created.
- A different basket from the same device within 60s → created.
- Missing or invalid `X-Device-Id` → `400`.
- E2E (KAP-10): a lost-key reload scenario over real HTTP.

## Acceptance criteria
- Duplicate detection never blocks silently: there's always a confirm path.
- Depends on KAP-07. Runs before KAP-10 so the e2e tests cover it.
