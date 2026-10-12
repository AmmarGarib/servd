# prebills

Pre-bills — the guest check printed for an OPEN order before payment (owner
amendment 2026-10-10, spec §17.1–§17.3).

**A pre-bill is never a tax invoice.** It never creates or touches a
`FiscalDocument`, is never sent to the POS connector, never posts to the
ledger and never feeds revenue or tax reports. Only the full & final (FnF)
bill files — and the FnF event is `completeOrder`, exactly once per order.

## Files

- `service.ts` — `createPreBill`, the lifecycle hooks, the printable HTML and
  the Finance list (flags, summary, CSV rows).
- `routes.ts` — two Fastify plugins plus `registerPreBillPlugins(app)`.
- `index.ts` — the public exports.
- Tests: `backend/tests/preBills.test.ts`.

## Routes (registered by `registerPreBillPlugins(app)` inside `/api/v1`)

| Route | Roles | What |
|---|---|---|
| `POST /pos/orders/:orderId/pre-bill` | `CASHIERS` (managers, cashier, foh) | Body `{ tender?: 'cash'\|'card' }` (default cash). 201 `{ preBill, receipt }`. 404 foreign order; 409 `ALREADY_FINAL` (completed or fully paid), `ORDER_NOT_OPEN` (cancelled / rejected / refunded), `ORDER_CHANGED` (the bill kept changing mid-print). |
| `GET /pos/pre-bills/:id/html` | `CASHIERS` | Printable pre-bill (receipt look, `PRE-BILL — NOT A TAX INVOICE`, `PB-<n>`, no fiscal block). A re-render is marked COPY. Foreign → 404. |
| `GET /pre-bills` | admin, owner, management, finance | Finance → Voided pre bills. Query `from`, `to` (PKT days, default last 30), `conceptId`, `printedById`, `status`, `flagged=1`, `format=csv`. |

There is **no** delete, hide, edit or exclude endpoint — do not add one.

## Numbers

`PB-<n>`, per company, gap-free: `pre_bill_counters` is upserted and bumped
under its row lock inside the print transaction, so a rollback gives the
number back and concurrent prints serialise.

## Totals

From `quoteOrderForTender` (pos/service.ts) — exactly what
`GET /pos/orders/:id/quote` returns and what the payment will demand. A cash
pre-bill stores the card total too (`cardTotalCents`), because GST splits by
tender (cash 15% / card 8%). Nothing here computes tax. The quote is taken
before the transaction and the order is fingerprinted before and under the
order row lock; if the bill moved in between, the print retries (then 409
`ORDER_CHANGED`).

## Lifecycle (`PreBill.status`)

- `open` — the latest pre-bill of an order that is not final.
- `superseded` — a later pre-bill was printed for the same order.
- `converted` — `markPreBillsConvertedTx(tx, orderId, finalTotalCents, at)`,
  called by completeOrder inside its claim transaction (W4). Superseded rows
  get `finalTotalCents` / `finalAt` too.
- `cancelled` — `markPreBillsCancelledTx(tx, orderId, approverId, reason, at)`,
  called in every cancel / void-whole-order path with the approving MANAGER
  (W4).

## Flags (computed at read)

- `ORPHANED` — order cancelled / rejected (or the pre-bill cancelled), or the
  order is still not final and its drawer is closed or the pre-bill is over
  12 h old.
- `FINAL_LOWER` — converted and the final total is below the pre-bill's total
  FOR THE TENDER THE ORDER WAS SETTLED WITH (`tenderOfPayments` over its paid /
  refunded payments — the rule processPayment prices by): all card-class → the
  card total printed under a cash headline; any cash, a mix, or no payments →
  the headline. Paid by card at the card total is not "lower"; paid in cash
  at the card total is. (A cash payment the cashier RECORDS as card is out of
  this flag's reach — that is a card-settlement reconciliation, not a
  pre-bill check.)
- `LINE_VOIDS_AFTER` — `OrderItem.voidedAt > printedAt`; the approver comes
  from the `order_item_void` audit row (`metadata.approverId`, else the
  voider).

## Summary

`count` / `orders` = prints / distinct orders. Money is counted ONCE PER
ORDER: `valueCents` and `orphaned.cents` take each order's latest (highest
numbered) print in the selection; `lineVoidsAfter.cents` counts each voided
line once; `finalLower` has one converted row per order. The per-flag
`count` is still prints, with `orders` alongside.

## Part-paid orders

A pre-bill may be printed on a part-paid order (a split bill). The receipt
carries `paidCents` / `dueCents` (the quote's) and prints "Paid so far" and
"BALANCE DUE". `PreBill` has no paid column: the figure is recorded on the
print's `prebill.print` audit row and read back on a re-render (fallback: the
order's payments created by `printedAt`).

## Locking

Both hooks take the order row lock (`lockOrderTx`) first — the lock
`createPreBill` holds while it supersedes and inserts — so a print racing a
cancel / FnF either lands wholly before it (and is cancelled / converted) or
sees the ended order and refuses. Re-locking inside the caller's transaction
is a no-op.

## Access

`GET /pre-bills` is gated by role here. The module id `voided_prebills`
(Finance workspace) and the `/pre-bills` prefix in `lib/moduleAccess.ts` are
added by W2.
