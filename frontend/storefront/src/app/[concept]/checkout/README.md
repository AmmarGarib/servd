# checkout

Storefront route: **/<concept>/checkout**. Customer-facing page rendered via Next.js App Router.

## Files

- `layout.tsx` — page title / noindex metadata.
- `page.tsx` — the checkout (client component). It prices nothing itself:
  every figure comes from `GET /storefront/quote`, and the order is placed
  with `POST /storefront/orders`.

## Delivery address and map pin

The server needs coordinates for every delivery: they set the zone fee and
tell the rider where to go. Without them, `deliveryFeeFor` (backend
`lib/pricing.ts`) refuses the order with `DELIVERY_LOCATION_REQUIRED`. The
page gets them from the map pin (`components/checkout/DeliveryPin.tsx`):

- **Typed (new) address** — the map shows under the address field. The
  customer taps the map, drags the pin, or uses "Use my current location".
- **Saved address with a pin** — that pin is used. "Move pin" opens the map
  to adjust it.
- **Saved address without a pin** — the map shows. The pin is saved back to
  the address (`PATCH /storefront/addresses/:id { lat, lng }`, debounced),
  so the customer only does this once.

The pin's `lat`/`lng` go out as `deliveryLat`/`deliveryLng` in the quote and
the order, and the quote runs again whenever the pin moves. With no pin,
"Place order" changes to "Set your delivery pin" and shows a message by the
map. The quote errors `DELIVERY_UNAVAILABLE`, `OUTSIDE_DELIVERY_AREA` and
`BELOW_ZONE_MINIMUM` also show by the map and block the order.

## The bill rows (delivery fee and GST)

The bill panel shows the server's figures from `GET /storefront/quote` and
works out nothing in the browser. Rows, top to bottom: **Subtotal**, **GST**,
**Delivery** (only when the fee is above zero), **Service charge** (only when
above zero), tip / points / wallet / promo / gift card, **Total**.

- The delivery fee is charged **before** its GST and the GST is added on top
  (owner H9), at the order's tender rate: 15% cash, 8% card or Raast.
- There is **one GST row**. Its amount is `taxCents` — the GST on the food
  (`itemTaxCents`) plus the GST on the delivery fee (`deliveryFeeTaxCents`).
  When `deliveryFeeTaxCents` is above zero the row carries the sub-label
  "incl. PKR x on delivery". Pickup, curbside and dine-in orders have no fee,
  so no Delivery row and no sub-label.
- The Total is `totalCents` from the quote, never a sum of the rows (promo,
  points, wallet, tip and gift card are applied by the server in checkout's
  own order).
- The percentage in the GST label is the quote's `taxRatePct` (the standard
  rate for the tender).
- The order tracker (`../order/[id]/page.tsx`) shows the same Delivery row
  and GST sub-label from the order's own `deliveryFeeCents` /
  `deliveryFeeTaxCents`.

## Other rules

- The rider tip starts at **No tip**. It is never pre-selected.
- The cash option is named for the fulfilment: "Cash on delivery" (delivery),
  "Pay cash at pickup" (pickup, curbside), "Pay at the counter" (dine-in).
  This only changes the text. The gateway is `cash` in every case.
