# pos

Backend module: **pos**. HTTP routes + business logic for the Pos domain. Registered into Fastify by `src/index.ts` under the `/pos` URL prefix. `/pos` is not module-gated.

## Files

- `receipt.ts` — the receipt data (`GET /pos/orders/:id/receipt-data`, tablet thermal print) and printable HTML (`GET /pos/receipt/:orderId`). A delivery order prints its **delivery charge** (`Order.deliveryFeeCents`, before GST) as its own row, and the GST row is all the GST with the delivery share named: "GST (incl. PKR x on delivery)", so the printed rows add up to the total (H9).
- `routes.ts` — Fastify route registrations for this module. `GET /pos/payout-categories` and the till pay-out accept **expense categories only**; a `cogs` key (`kitchen_food` …) is a 400.
- `service.ts` — Business-logic functions invoked by route handlers (orders, payments, refunds, voids, shifts, Z-report, cancelled-ticket books).
- `boxGivenRoutes.ts` — **"Box given"** (`posBoxGivenRoutes`, registered at `/pos`, below).
- `drawerToBox.ts` — `recordDrawerToBoxTx`: the till drawer's cash moving into a petty-cash box. A drawer `payout` CashMovement with no PIN and no `pos.payout` entry; the box's `pettycash.till_topup:<cashMovementId>` Dr 1011 / Cr 1015 is the only posting and the shift close skips it. Keepers only.

## Box given

`POST /pos/orders/:orderId/items/:itemId/box-given` body `{ undo?: boolean }` → `200 { boxGiven, depleted }`.

- **Who**: `requireAuth(...CASHIERS ∪ KITCHEN_STAFF)` — the till, the floor and the pass/expo. Finance gets 403. No module gate.
- **Scope**: the order is found with `scopeTenantWhere(req, 'write')` through its brand, and the line must belong to that order; a foreign order, a line from another order, or a non-UUID id is 404 and nothing moves.
- **What it does**: `markBoxGiven` (`orders/stock.ts`) — draws the line's Packaging section from its lots, oldest first, and adds it to the line's actual MC; an **undo** puts it back in the same lots. Booked by its own entry when the order's cost was already booked (`order_item.box_given:<line>@<ms>` Dr 5030 / Cr 1230; undo `order_item.box_given_undo`).
- **409s**: `BOX_NOT_NEEDED` (takeaway, delivery, or a line whose snapshotted vessel is `packaging`), `ORDER_COMPLETED` (an undo after completion — the route maps the service's `BOX_GIVEN_FINAL` to this code), `LINE_VOIDED`, `ORDER_ENDED`.
- A non-AppError failure on a tap (stock or books) is flagged `flagOrderStockFailure(orderId, 'box_given', …)`.
- A tap **after completion** is allowed (a till dine-in sale completes at payment and boxes often come after).

## Delivery fee (H9) at the till

- `GET /pos/orders/:orderId/quote` also returns `deliveryFeeCents` and `deliveryFeeTaxCents`. Changing the tender (card to cash) re-prices the order (`repriceForTenderTx`), so the fee's GST changes with the rate. A dish void never removes the fee's GST (`voidBillDeltaTx` prices both sides with the fee).
- **Cancelled ticket** (`order.cancel_unwind:<orderId>`, the order's brand's company): the close had credited 4110 for the fee; the unwind now **debits 4110** for it (brand-tagged; the fee's GST is inside the tax line), then books exactly as before with the balancing line on **1110**. Runs in the cancel's order-locked transaction or the first hand-back's.

## Raast "void, never booked" (CEO only) at the till

A Raast receipt the CEO voided is **not money taken**. `refundDueOf` (refund due on a cancelled ticket, the hand-back tenders, the default hand-back method) and the Z-report's `cancelledPaid` leave it out, and `getZReport` returns `raastVoidedCents` so the Raast breakdown still adds up. A hand-back by Raast of a voided payment is 422 `REFUND_METHOD_NOT_TENDERED`; over the amount due 422 `REFUND_EXCEEDS_DUE`. In the non-till branch of the cancelled-ticket books a voided receipt is no longer parked. The rule is `isVoidedRaast` in `accounting/orderPosting.ts`; the void itself is `modules/reconciliation/raast.ts` (see `docs/raast.md`).

## Rules that are unchanged and still binding

- Pre-bill vs final bill: a pre-bill never creates a fiscal document; only completion files, once (`completeOrder`).
- Every item void and every whole-order cancel/void of a rung-up order needs a manager (their own login or a same-company manager PIN); `approverId` always recorded.
- Tills take exactly Cash, Card – Keenu and Raast QR (`lib/tenders.ts`); card and Raast are the one digital tax group.
- A new path that completes an order calls `bumpCustomerRollups` and goes through `completeOrder`.
