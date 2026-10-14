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

## Delivery charge on a tax invoice (H9, 2026-10-14)

A delivery order's fee is a **taxable supply** (GST added on top at the order's
tender rate, stored in `Order.deliveryFeeCents` / `deliveryFeeTaxCents`, the GST
inside `Order.taxCents`). So an invoice issued for it:

- carries the fee as its own line, `Delivery charge` (`DELIVERY_CHARGE_LINE`),
  quantity 1, priced at the fee before GST, and stores `deliveryFeeCents`;
- includes the fee in `taxableValueCents`, with its GST in the stored tax;
- has a total equal to **the bill**:
  `totalCents = max(0, subtotal + deliveryFee + tax + serviceCharge + tip − discount)`
  — a discount or loyalty redemption that covered more than the food comes off
  the fee and the tax too, exactly as the bill and the fiscal payload's totals
  have it;
- prints a "Delivery charge" row in the HTML;
- is mirrored line for line by a **credit note** (the fee is returned as
  `-deliveryFeeCents`).

A legacy delivery order (fee column 0, the fee untaxed inside the total) issues
exactly as before. The invoice total must equal the fiscal document's
`totals.totalCents` for the same sale (`docs/pos-connector-api.md`).
