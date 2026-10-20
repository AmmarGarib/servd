# pos

Backend module: **pos**. HTTP routes + business logic for the Pos domain. Registered into Fastify by `src/index.ts` under the `/pos` URL prefix. `/pos` is not module-gated.

## Files

- `receipt.ts` — the receipt data (`GET /pos/orders/:id/receipt-data`, tablet thermal print) and printable HTML (`GET /pos/receipt/:orderId`). A delivery order prints its **delivery charge** (`Order.deliveryFeeCents`, before GST) as its own row, and the GST row is all the GST with the delivery share named: "GST (incl. PKR x on delivery)", so the printed rows add up to the total (H9).
- `routes.ts` — Fastify route registrations for this module. `GET /pos/payout-categories` and the till pay-out accept **expense categories only**; a `cogs` key (`kitchen_food` …) is a 400.
- `service.ts` — Business-logic functions invoked by route handlers (orders, payments, refunds, voids, shifts, Z-report, cancelled-ticket books).
- `boxGivenRoutes.ts` — **"Box given"** (`posBoxGivenRoutes`, registered at `/pos`, below).
- `tillFlow.ts`, `tillFlowRoutes.ts`, `keenuPush.ts` — the till flow (owner, 2026-10-20): waiters, guests, item search, delivery zones, order information, settlement channel, Push to Keenu, Order Summary. **Contract: `TILL_FLOW.md`.**
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

## On account at the till (`onAccountRoutes.ts`, `onAccountTender.ts`)

Charges a whole bill to a corporate client's account by scanning its QR card
(runbook `docs/on-account.md`). Registered as a second `/pos` plugin; roles
`CASHIERS`; not module-gated. **Off per company** until finance has created a
client and the CEO has approved it.

| Route | Body / query | What it does |
|---|---|---|
| `GET /pos/on-account/enabled` | `?orderId` | `{ enabled }`: true when the order's company has at least one active client **and** its till clearing has been cut over to 1115 (enabled requires the cut-over). The till hides the button otherwise. |
| `POST /pos/on-account/lookup` | `{ orderId, code }` (rate limit 20/min per user) | Resolves the card code inside the order's company only. Unknown: 404 `ON_ACCOUNT_CARD_UNKNOWN` (never says it exists elsewhere). Revoked: 409 `ON_ACCOUNT_CARD_REVOKED` and one `on_account_card_revoked_used` flag per card per Karachi day. Returns the client's name, available credit and whether a reference is required. |
| `GET /pos/orders/:orderId/on-account/quote` | | The bill re-priced at the cash rate, and whether it can be charged. |
| `POST /pos/orders/:orderId/on-account` | `{ shiftId, code, reference?, idempotencyKey }` | The charge. One transaction: order lock, replay check, whole-bill and eligibility checks, re-price (`['on_account']`, rate must equal `taxRateCash` else 409 `ON_ACCOUNT_RATE`), client lock, `assertChargeableTx`, a paid `on_account` Payment, the `CustomerAccountCharge`, then `applyCoverageTx` (must complete the order, else 409 `ON_ACCOUNT_NOT_HERE` and everything rolls back). After the transaction `afterTillSale` -> `completeOrder` files the one fiscal sale (buyer = the client). **No manager PIN.** |

Refusals: `TILL_CLEARING_NOT_SPLIT` (409, the company has not been cut over
to 1115 yet), `ON_ACCOUNT_NOT_ACTIVE`, `ON_ACCOUNT_BRAND_NOT_ALLOWED`,
`ON_ACCOUNT_OVERDUE` (a statement past due plus the client's grace),
`ON_ACCOUNT_OVER_LIMIT`, `ON_ACCOUNT_WHOLE_BILL` (anything already paid or
pending, or a tip, promo, wallet, gift card, loyalty credit or split portion),
`ON_ACCOUNT_NOT_HERE` (delivery, pickup, not a till bill, offline),
`ON_ACCOUNT_REFERENCE_REQUIRED` (422).

- **Scope:** the order is found with `scopeTenantWhere(req, 'write')`; the card
  is looked up with the order's company only; the charge, payment and fiscal
  document carry that company. A foreign order is 404.
- **The card code never reaches logs or the audit trail**: it is never logged
  (only sent in request bodies; the request serializer logs method + URL), and
  audit `order.on_account_charge` carries the card hint only.
- **Tax:** an on-account bill is the cash tax class; no loyalty is awarded.
- **Refunds** of an on-account bill go through the one refund engine, to the
  account only (`applyChargeRefundTx` inside `writeRefundTx`); `refundDueOf`
  and `refundDueCents` exclude `on_account`.
- **Ledger:** the client's debt is *Dr 1110* per client at the shift close (or
  `order.complete` on the web path); all other till clearing is on **1115**.

