# invoices

Backend module: **invoices**. HTTP routes + business logic for the Invoices domain. Registered into Fastify by `src/index.ts` under the `/invoices` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers

## Company scope and numbering (2026-10-12)

`TaxInvoice.tenantId` is the order's brand's company (a credit note carries
its original's). Numbers are unique per company and numbered per (company,
prefix, Karachi year, invoice / credit note). Each series has one counter
row in `tax_invoice_series` (company, head), bumped by one upsert inside the
issuing transaction — race-safe, gap-free and O(1) however many invoices the
company has (a MAX() over all its invoices did not scale). An invoice found
already holding the next number (issued outside the counter) makes the
counter catch up once. The issuing transaction has explicit `maxWait` /
`timeout`. `invoice_counters` is no longer read. Routes use `lib/tenantScope.ts`; foreign rows are 404.
