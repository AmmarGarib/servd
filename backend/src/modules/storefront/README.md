# storefront

Backend module: **storefront**. HTTP routes + business logic for the Storefront domain. Registered into Fastify by `src/index.ts` under the `/storefront` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module

## Delivery fee in the quote and the order (H9, 2026-10-14)

The delivery fee carries sales tax, **added on top** at the order's tender rate
(15 % cash and cash on delivery, 8 % card / Raast / online / wallet). The zone
fee is stored **before GST**; the page computes nothing itself.

- **`GET /storefront/quote`** returns, besides the existing fields:
  - `itemTotalCents` — the food;
  - `itemTaxCents` — GST on the food;
  - `deliveryFeeCents` — the zone fee before GST (0 unless `type=delivery`);
  - `deliveryFeeTaxCents` — GST on the fee, at the order's standard rate (never an item tax class, so a zero-rated basket still pays it);
  - `taxCents` = `itemTaxCents` + `deliveryFeeTaxCents` (what `Order.taxCents` will hold);
  - `pricedTotalCents` — includes both. The service charge and a %-tip are never taken on the fee or its GST.
- **`POST /storefront/orders` (checkout)** prices with the same `priceOrder(…, { deliveryFeeCents })` and the order stores the two parts in `Order.deliveryFeeCents` and `Order.deliveryFeeTaxCents` through `ingestOrder`. The 201 response is the placed order and carries both fields.
- **The order tracker** (`GET /storefront/orders/:id`) returns the order's own `deliveryFeeCents` / `deliveryFeeTaxCents` in the spread, so the page shows a Delivery row and one GST row naming the delivery share.
- A legacy delivery order (priced before this date) has both columns 0; its fee, untaxed, is inside the total.
- Never read `concept.taxRate` (the legacy 17 %).
