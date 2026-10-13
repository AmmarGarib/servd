All the in-scope till findings are fixed and tested. The new tests are `tests/auditTillMoney.test.ts` (36) and `tests/auditTillShift.test.ts` (11), and all 47 pass. Run together with the existing POS, till, shift, refund and split suites, 250 of 253 tests pass. The 3 failures are in other agents' areas (below). `tsc --noEmit` shows no errors. Nothing is committed.

Every locked path takes a row lock on the order (`SELECT … FOR UPDATE`, `lockOrderTx`) and re-reads its payments under that lock. That covers payment, settle, comp, refund, void and split.

**Files changed:** `backend/src/modules/pos/service.ts`, `pos/routes.ts`, `pos/receipt.ts`, `backend/src/modules/checkSplit/routes.ts`, and the message at `backend/src/lib/tenantScope.ts:251` (nothing else in that file).

**The 3 failures are not from my files:**
- 2 in `customersReconcile` (promo evaluation): the promo code is now unique per company, and the test still looks it up by code alone.
- 1 in `ordersReconcile` (storefront quote): the `jazzcash` gateway is now rejected.
- Earlier runs also failed loyalty tests after the loyalty-account schema change. Those passed on the final run.

## Per finding (all fixed, all with tests)

**Blockers**
- **FOH-03 / BOH-02 (void doesn't lower the bill):** a void now re-prices the order inside the same transaction, through `priceOrder` at the order's own tender rate and discount. The difference comes off GST, service charge, discount and total, so a gift card or delivery fee already on the bill is kept. Check-split portions that no longer add up are cleared; a placeholder or uncollected cash row is lowered. Cash and card now agree.
- **FOH-04 (double payments):** the order is locked before what's paid is read. There's an optional `idempotencyKey` per payment submission, scoped to the order: a retry gets the first result back (`replayed: true`); the same key with different amounts is a 409. Concurrent split settles also lock, so the last portion completes the bill. That race was a second bug: a fully paid split bill could stay open.
- **FOH-05 (double refunds):** the refund is locked and what's refundable is recomputed inside the transaction.
- **FOH-06 (millisecond order ids):** an order with no key now gets `pos-<uuid>`.

**High**
- **FOH-07:** a key reused by another brand or another cashier is a 409, never the other order. This is checked both before and after `ingestOrder`, matching the orders agent's rule.
- **FOH-08:** add-on prices come from the menu, and the add-on must belong to that dish. A free-text add-on can't be negative.
  - Related bug I also fixed: pricing a dish below the menu never asked for a PIN, and the waiter role skipped the price-override check entirely. Any change from the menu price now needs a PIN for anyone who isn't a manager.
- **FOH-09:** cancelled, rejected or refunded orders can't take a payment, settle, comp or split (409 `ORDER_NOT_OPEN`).
- **FOH-10:** check-split re-prices for the portions' tenders before splitting. Portions worked out from the old total are scaled onto the new one.
- **FOH-11:** cash-variance, over-threshold void/comp/refund, repeated-void and price-override alerts all carry the company. Repeated voids are now counted by who voided, per company.
- **FOH-13:** opening a shift is serialised per cashier with an advisory lock, so a double tap opens one drawer. There's no database constraint behind it; a partial unique index would need a migration later.
- **BOOKS-05:** cash that hasn't been paid into a drawer isn't refundable (422 `CASH_NOT_PAID_IN`, pay it in first).
- **ONL-16:** a refund must use a tender the order was paid with, capped per tender.
- **BOOKS-02:** finance can now read Z-reports for its own company.

**Medium / low**
- **FOH-14:** tips are recorded at the till on `Order.tipCents` and its total.
- **FOH-15:** pay, settle, comp and a refund naming a drawer only work on your own drawer, unless you're a manager.
- **FOH-16:** a paid order can't be voided (`ORDER_PAID`); a bill with a payment or comp on it gives `ORDER_PARTLY_PAID`.
- **FOH-21:** closing a drawer with unpaid tickets returns 409 `OPEN_TICKETS` with the list, unless `confirmOpenTickets: true` is sent. The Z-report lists them too.
- **BOH-11:** voiding a line that hasn't been fired restores its stock once; a cooked line stays consumed.
- **BOOKS-07:** a refused till posting raises a high `posting_failed` exception for the company.
- **FOH-22:** unknown customer gives 422. **FOH-23:** receipts show REFUNDED / PARTLY REFUNDED / CANCELLED plus the refund lines, and `?duplicate=1` prints DUPLICATE. **FOH-24:** cash tendered below the amount is refused. **FOH-26:** paying onto a closed drawer says `SHIFT_CLOSED`.

## API changes for the till UI
The agreed shapes are kept exactly. These now exist:
- **`POST /pos/orders`:** takes `paymentMethod`. New errors: `INVALID_MODIFIER` / `NEGATIVE_MODIFIER` / `CUSTOMER_NOT_FOUND` (422), `IDEMPOTENCY_KEY_REUSED` (409).
- **`GET /pos/orders/:id/quote?method=`:** returns `{orderId, status, tender, repriced, taxRatePct, taxCents, serviceChargeCents, discountCents, tipCents, totalCents, paidCents, dueCents}`. It uses the same pricing function as the payment and writes nothing.
- **`POST /pos/quote`:** returns `{conceptId, …priceOrder result, items}`.
- **`POST /pos/payments`:** takes `idempotencyKey` and `payments[].tipCents`, where `amountCents` includes the tip. The response adds `replayed`. New errors: `ORDER_NOT_OPEN`, `NOTHING_DUE`, `TENDERED_LESS_THAN_DUE`, `INVALID_TIP`, `NOT_YOUR_SHIFT`, `SHIFT_CLOSED`.

Changes the UI still needs to handle:
- **Void:** the response now adds `order{totalCents,taxCents,serviceChargeCents,discountCents}`, `removedCents`, `splitCleared`, `stockRestored`. The UI should refresh the bill after a void, and re-split when `splitCleared` is true.
- **Close:** handle 409 `OPEN_TICKETS` (`error.details.openTickets`) and resend with `confirmOpenTickets`. **The reconciliation page (`frontend/admin/src/app/reconciliation/page.tsx`) closes drawers through the same route and also needs this.**
- **Z-report:** adds `openTickets` and `unassignedOpenTickets`.
- **Open shift:** a `SHIFT_OPEN` error now includes `details.shiftId`.
- **Split:** the created rows may carry different amounts than were sent (scaled). `SPLIT_TOTAL_MISMATCH` includes `details.totalCents`.
- **Refund:** only offer tenders the order was paid with.
- **Receipt data:** adds `status`, `banner`, `refunds`, `refundedCents`. The tablet printer (`tablet/src/lib/printer.ts`) should print the banner and refund lines.
- **Waiter screen** (`pos/waiter/page.tsx:49`) should send a per-submit `idempotencyKey` so double taps dedupe.

## For the orders and posting agents
- **Orders:** `restoreInventoryForOrder` needs no change. On a void I lower the order's stock-depletion record by what was given back (original figures kept under `takenAtSale`, plus a `stock.void_restore` audit row per line), so a later cancel only restores what's still out. Please don't also subtract void restores, or the stock will be counted twice.
  - Existing behaviour, not changed: cancelling an order also restores the stock of lines that were already cooked.
- **Posting:** the tip is on both the order and the payment's `gatewayMeta.tipCents`, so `withTenderTips` adds nothing extra and nothing is counted twice.
- **`lib/exceptions.ts` owner:** please add `'posting_failed'` to `ExceptionKind`. I cast it for now; the column is plain text, so the write can't fail.

## Other gaps
- Refunding a cash-on-delivery order from admin still needs the cash paid in and then an open drawer. A wallet-credit refund path doesn't exist yet.
- The payment idempotency key is stored in `Payment.gatewayMeta`; a proper column would be better later.
- The POS add-on pricing repeats the storefront's `resolveCheckoutItems` logic, because that function lives in a file I don't own.
