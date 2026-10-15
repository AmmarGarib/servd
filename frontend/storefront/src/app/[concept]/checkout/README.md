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

## Blocked accounts (strikes and bans, owner 2026-10-15)

- A block is **servd-wide**: it is on the customer's servd account and applies
  at every brand of every company. The notice never names a company or brand.
- When the API answers `BANNED` (403, from the quote or from placing the
  order), checkout keeps the cart and its own message exactly as before, and
  also mounts `components/account/BlockedNotice.tsx`. The notice reads
  `GET /storefront/account/blocks` and offers the appeal form
  (`POST /storefront/account/ban-appeals`: reason + 10 to 1000 characters;
  409 `APPEAL_OPEN` and 429 `APPEAL_TOO_SOON` are shown in plain words).
- While the CEO's appeals switch is OFF both routes answer 404: the notice
  renders nothing, and the BANNED message is all the customer sees.
- Same notice: after sign-in / sign-up (sign-in is never refused), on
  /account, on /reserve, /reserve/<brand>, /group-order and in a group order
  on a BANNED answer.
- The order tracker replaces the hand-over code block with "Your rider has the
  code for this order." when the order's `handoverRerouted` is true.
