# backend/tests

Vitest test suite. Run with `npm run test` (single shot) or `npm run test:watch`.

Coverage focuses on:
- Adapter normalisation (Foodpanda / Careem / WhatsApp payloads → canonical `OrderDTO`).
- Service-level business rules (order status transitions, price overrides, refund authorisation).
- HMAC verification of webhooks.

For end-to-end pipeline coverage, prefer the smoke test (`npm run smoke`) which exercises real DB writes.
