# reconciliation

Backend module: **reconciliation**. HTTP routes + business logic for the Reconciliation domain. Registered into Fastify by `src/index.ts` under the `/reconciliation` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers
- `backfillOrders.ts` — re-posts order completions, loyalty postings and refund restores the ledger refused (behind `POST /reconciliation/backfill-unposted`)

## CEO-only catch-up actions (role `admin`, dry run by default)

- `POST /reconciliation/backfill-unposted` — closed shifts, sales, points and refunds that never reached the ledger.
- `POST /reconciliation/apply-missed-bill-variances` `{ dryRun = true, tenantId? }` — supplier bills booked before their goods whose carried price difference was never applied by a receipt (receipts before receiving did it itself). Runs `applyMissedCarriedBillVariances` per company in scope (a picked `tenantId` outside the scope is 404). Idempotent; a company whose books are closed through today lists its lines as `locked` and applies nothing. Shares the backfill's single-flight slot (409 `BACKFILL_RUNNING`).
