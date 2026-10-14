# procurement

Backend module: **procurement**. HTTP routes + business logic for the Procurement domain. Registered into Fastify by `src/index.ts` under the `/procurement` URL prefix. Every row belongs to its **supplier's company** (`scope.ts`); a supplier with no company is refused on every write (422 `SUPPLIER_HAS_NO_COMPANY`).

## Files

- `routes.ts` — suppliers, purchase orders, bills, payments, vendor picker (below).
- `service.ts` — business logic for POs, bills (`createBill`), payments (incl. unapply / void), AP aging, reorder.
- `receiving.ts` — **goods receiving, the one path that brings stock in** (`receiveGoodsTx` in the caller's transaction; `receiveGoods` wraps it for the dock and PO routes). Opens FIFO lots through `lib/stockLedger.ts addLotTx`, raises `PurchaseOrderLine.quantityReceived`, posts `procurement.receipt:<id>` Dr 12x0 / Cr **2015 GRNI** (H17). Quantity a bill already charged for (a pending `GrniMatch`, oldest bill first) opens a lot at the **billed** price; the rest at the PO price or the price typed at the dock. A receipt with a `settledBy` (a petty-cash movement or a cash-request settlement) is cash-settled: system supplier "Cash purchases" (`ensureCashPurchaseSupplier`, never listed or billed), lines born billed, posts nothing. Owner decision 27 still applies to `receiveGoods`: no-PO receiving needs the unit cost typed, only manager tiers receive, and whoever raised the PO cannot receive it (except the CEO).
- `grniRoutes.ts` — **Received, not billed** at `/procurement/grni` (module gate: procurement OR accounting). `GET /` (`tenantId`, `supplierId`, `olderThanDays`, `writeOffRequested=1`) → `{ tenantIds, staleDays (30), lines[], totals, pendingBillMatches[] }`; `GET /unbilled-lines?supplierId` (the bill form's "Fill from receipt" picker); `POST /:receiptLineId/write-off-request { reason 3-500 }` (admin, owner, management, finance, procurement; the CEO's own request applies at once; 409 `NOTHING_OPEN` / `WRITE_OFF_PENDING`); `POST …/write-off/approve` and `…/reject { note }` (**CEO only**). Approving posts `procurement.grni_writeoff:<lineId>` Dr 2015 / Cr 5060. Every route 404s on another company's line or supplier; audit rows are filed under the receipt's company. `grniLineOpenValues` is the one open-value rule (the food-cost report imports it).
- `creditNotes.ts` — supplier credit notes / returns (`SupplierBill` kind `credit_note`): create, apply, unapply, void. Returns leave the bill's own lots first; price credits re-price the bill's lots; a short delivery or price credit on billed-ahead quantity shrinks the pending match and credits 2015; tax is credited to the bill's own input code.
- `openingBalance.ts` — supplier opening balances posted once (Dr 3020 / Cr 2010).
- `scope.ts` — `supplierScopeWhere`, `findSupplierInScope`. `chat.ts` — supplier chat and portal.

## Routes added or changed in wave B

- **`POST /bills`** — every line is either `{ inventoryItemId, receiptLineId | poLineId }` (a **stock line**; 422 `STOCK_LINE_NEEDS_RECEIPT` without a receipt link, `RECEIPT_LINE_MISMATCH`, `OVER_BILLED`) or `{ expenseAccountCode }` (a non-stock line; 422 `EXPENSE_ACCOUNT_REQUIRED`, `NOT_AN_EXPENSE_CODE`). A non-stock line that **looks like equipment** is 422 `USE_CAPEX`; `notEquipment` + `notEquipmentReason` overrides it, and only finance or the CEO may (403 `OVERRIDE_NOT_ALLOWED`; today `POST /bills` is managers-only, so only the CEO reaches it — open question below). The body also takes `taxAuthority` (which input account the tax goes to) and `whtSection` (`'none'` allowed). Other 422s: `SYSTEM_SUPPLIER`, `SUPPLIER_HAS_NO_COMPANY`, `AMOUNT_TOO_LARGE`.
- **Suppliers** — `POST` / `PATCH /suppliers` take `filerStatus` (`filer`, `non_filer`, `exempt`, `unknown`), `whtExemptCertNo`, `whtExemptUntil` (stored as the end of the PKT day), `defaultTaxAuthority`, `defaultWhtSection`. A system supplier cannot be edited (422). `GET /suppliers?view=picker&categoryId=` (or `&tenantId=`, else the active company) is the OpEx / CapEx vendor picker: `{ id, name, filerStatus, whtExemptUntil, defaultWhtSection, defaultTaxAuthority }`; a foreign category or company is 404; system suppliers are never listed.
- **`POST /purchase-orders/:id/receive`** — takes `locationId` (the receiving outlet; an outlet of another company is 422 `LOCATION_NOT_IN_COMPANY`). The dock page `POST /crosschecks/receiving` forwards it too and excludes system suppliers.
- **Deleted** — `POST /reconciliation/apply-missed-bill-variances`: that catch-up is now step 0 of the FIFO cut-over (`inventory/fifoCutover.ts`).

## Postings (supplier's company, in the document's own transaction, balance-asserted — `accounting/supplierPosting.ts`)

- **Bill** `supplier.bill:<id>`, dated `billDate`: Dr 2015 for each matched receipt quantity × the receipt cost; the price difference through `repriceLotTx` (on-hand share to 12x0, used share to **5060**, split by brand usage); Dr 2015 at the billed price for quantity billed **before** it arrived (a pending match); Dr 6xxx for non-stock lines; Dr the **charging authority's** input-tax account; Cr 2040 for withholding (`computeWithholding`, the supplier's filer rate and certificate, stores `whtSection` / `whtRateBps`); Cr 2010 for the rest. A bill recorded before the company's FIFO cut-over posts the old way (Dr 1210).
- **Void** `supplier.bill.void` (reversal) + `supplier.bill.void.price` (trues up 12x0 against 5060 for the undone re-pricing); a legacy bill: `supplier.bill.void.legacy:<id>`. A void is **409 `RECEIPT_WRITTEN_OFF`** when it would re-open a delivery line the CEO wrote off (correct it with a credit note). **Credit note** `supplier.credit_note:<id>` and its void `…void` / `…void.price`.
- Price history is written at receipt and on a bill re-price (`bill_match`); voids and credits no longer write rows.

## Rules

- Equipment never goes on a bill — CapEx or Quick buy (`docs/fixed-assets.md`).
- The AP aging is one figure, tied to ledger 2010.
- A foreign supplier / line / receipt is 404; attaching another company's outlet or item is 422.

## Open questions

- Should **finance** be allowed to record bills (and so use the equipment override)? `POST /bills` is managers-only today.
- Dock deliveries received before the cut-over but never billed are counted as settled by the cut-over; a bill for one that arrives later cannot be matched (`OVER_BILLED`). How to book such a bill is the accountant's call.
