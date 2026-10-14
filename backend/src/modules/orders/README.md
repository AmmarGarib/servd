# orders

Backend module: **orders**. HTTP routes + business logic for the Orders domain. Registered into Fastify by `src/index.ts` under the `/orders` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module. `GET /orders` and `GET /orders/:id` return, per line, `serviceVessel`, `boxGiven`, `boxGivenAt`, and per order `deliveryFeeCents` / `deliveryFeeTaxCents`.
- `service.ts` — Business-logic functions invoked by route handlers. `ingestOrder` is the one place that creates `OrderItem` rows: it stores the delivery fee (`Order.deliveryFeeCents`, before GST) and its GST (`Order.deliveryFeeTaxCents`, **inside** `Order.taxCents`) from `lib/pricing.ts priceOrder`, and **snapshots the brand's service vessel on every line** (`OrderItem.serviceVessel`) so a later change of the brand's vessel never restates past cost. `cancelOrder` takes `cookedFood?: { wasteReason: 'cancelled_after_fire', photoUrl? }`. Re-exports the stock functions below.
- `stock.ts` — **what a sale takes out of stock, on FIFO lots** (finance wave B). Described below.

## Delivery fee (H9)

The fee is a taxed supply, GST added on top at the order's tender rate (15 % cash, 8 % card / Raast / online / wallet; the brand's `taxRateCash` / `taxRateCard`, never `concept.taxRate`). `taxCents = itemTaxCents + deliveryFeeTaxCents`, `totalCents = food + food GST − discount + fee + fee GST + service charge`; the service charge and a % tip never apply to the fee or its GST. A refund / cancel takes back its share (see `accounting/orderPosting.ts`). A legacy delivery order (fee column 0, fee untaxed inside the total) is unchanged.

## Stock: depletion, give-back, waste

What a sale consumes is THE recipe explosion in `lib/recipeCost.ts consumptionPerLine`: the dish's ingredients and sub-recipes, each picked add-on's modifier recipe, and the **Packaging section only when `packagingApplies(order, line)`** — takeaway / delivery, or the line's snapshotted vessel is `packaging` (e.g. Stackd), or (dine-in at a plate brand) staff tapped "Box given". Only the **order's company's** items are consumed; another company's (or a company-less) item is excluded and flagged `recipe_foreign_stock` once per dish and company.

- **When**: at order creation (`ingestOrder`, fire-and-forget; a held pre-order at its release) and ensured again before completion books its cost (`ensureOrderDepleted`, never throws). Claimed once per order by a write-once audit row (`stock.sale_deplete`, mode `fifo`); the cancel's restore by `stock.sale_restore`, both under the order's row lock.
- **Sale**: `consumeFifoTx` kind `sale` (`order_item.sale` + line id), oldest lot first; a shortfall is recorded and the sale never fails.
- **Box given**: `markBoxGiven(itemId, actor, { undo })` — see `modules/pos/README.md`. Source `order_item.box_given` + `<line>@<tap ms>` (a tap after an undo is a new tap); 409 `BOX_NOT_NEEDED`, `LINE_VOIDED`, `ORDER_ENDED`, `BOX_GIVEN_FINAL` (undo after completion; the route answers it as `ORDER_COMPLETED`).
- **Unfired void / cancel**: `returnToLotsTx` (`order_item.return`) — back into the very lots it came from.
- **Fired void / cancel**: `inventory/voidWaste.ts wasteSoldLineTx` relabels to waste (`sale_void` + `waste` rows), booked Dr 5040 / Cr 12x0 `pos.void_waste:<line>`.
- **KDS remake**: `bookRemakeWaste` — ingredients and add-ons again as waste `remake` (own WasteLog per recall); packaging is not remade.
- **Before the company's FIFO cut-over** an order was depleted the old way (its claim row holds the `taken` JSON): it still restores / voids through that JSON, and after the cut-over what it gives back comes in as a `legacy_return` lot at head cost keyed `<orderId>:cancel` / `<orderItemId>:void`.
- **Failures never block a sale or a cancel**: flagged `stock_restore_failed` in the order's company (`flagOrderStockFailure`, phase `deplete` / `restore` / `remake` / `box_given`), re-driven by the Backfill re-poster. All-or-nothing depletion: one bad item (`STOCK_NOT_ON_LOTS`) fails the whole order's depletion, nothing is claimed, and completion retries it.

## An order's cost of sales is booked ONCE

By its `order.complete` entry, or — for a till order — its home drawer's `shift.close` (`accounting/cogs.ts orderCostBookedAt`). A stock event **after** that is not in that entry, so it books its own small entry, in the order's company, with both lines tagged to the order's brand, inside the event's transaction behind a savepoint (a refusal is flagged `posting_failed` after commit; `orderCogsFixDoc` re-posts the same entry). These are the **`ORDER_COGS_FIX`** keys (`orders/stock.ts`):

| Key (`<sourceType>:<sourceId>`) | Event | Entry |
|---|---|---|
| `order_item.return:<line>` | an unfired line given back | Dr 12x0 / Cr 50x0 |
| `order_item.box_given:<line@ms>` | "Box given" packaging drawn | Dr 50x0 / Cr 12x0 |
| `order_item.box_given_undo:<tap>` | that packaging given back | Dr 12x0 / Cr 50x0 |
| `order.legacy_return:<key>` | a pre-cut-over give-back lot | Dr 12x0 / Cr 50x0 |
| `order.cogs_late:<order>` | a depletion that ran late | Dr 50x0 / Cr 12x0 |
| `order.cancel_settle:<order>` | a cancelled order **never booked**: the late-receipt settles of its shortfalls (already Dr 50x0 / Cr 12x0) come back out | Dr 12x0 / Cr 50x0 |

Each only when the order's cost was booked before the event; otherwise the order's own booking nets `sale_return` / `sale_void` when it comes, or the order never sells and its rows stay out of the GL. `ORDER_COGS_FIX_ENTITY` names the flag entity of each fix (the re-poster's key), `ORDER_COGS_FIX_NOTHING` the reasons that mean there is nothing to post.

## Rules

- Never `id.slice(0, 8)` for an order reference — `lib/orderRef.ts orderRefOf`.
- A new path that completes an order goes through `completeOrder`, calls `bumpCustomerRollups`, and does not touch stock outside `orders/stock.ts` / `lib/stockLedger.ts`.
- Cancelling an already-picked-up delivery order keeps today's behaviour (no 409); the normal rule applies: unfired lines back to the lots, fired lines wasted.
