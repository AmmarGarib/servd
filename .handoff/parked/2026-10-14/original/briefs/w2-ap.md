# Wave B builder brief — w2-ap: ONE receiving path with lots + GRNI, bills on FIFO, cash-settled receipts, supplier tax fields, FIFO cut-over

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **foodcost (receiving, GRNI, bills, cut-over) + tax (bill authority/WHT) + assets (bill equipment guard)** · Test DB **`servd_test_wb_w2_ap`** · Redis **`redis://127.0.0.1:6390/10`** (index 10) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

supplierPosting.ts rewrite, procurement service/routes/receiving/creditNotes/grniRoutes, inventory/cashPurchase.ts + fifoCutover.ts, reconciliation/routes.ts (delete one route).

W1 is merged: code against the W1 contracts as they are ON DISK (read the files). Files you own may change hands in W3/W4 (shared-files.md).


## Binding decisions (read before anything else)

Owner decisions 2026-10-13 (/home/user/servd/.handoff/fixes/owner-decisions-20261013.md), as merged by the integration architect:
- Upgrade the EXISTING fixed-asset register and food cost (no duplicates; food cost = one variance report under Reports; the old
  /accounting/food-cost link forwards).
- Cash requests replace the voucher flow: anyone raises → HOD signs → director (CEO) approves → Jamil sb (box custodian) pays and marks
  paid (no photo) → the holder uploads receipts → that books the expense (advance on 1355 until then, H3/H4).
- Petty cash is funded by the Garibsons cashier (GS Foods holds no cash): Dr 1011 / Cr 2210 Due to Garibsons (H1). servd records only the cash-in.
- Delivery completes ONLY with the customer's code; no staff "Delivered" override. Refused/unpaid → the rider brings the food back → booked as
  food WASTE by the RGM / chef / F&B manager through the new "Emergency overrides" section (send the code to the rider's number; log
  returned food). Strikes: refused-at-door = strike; 3 strikes block the customer (account, email, number) PER COMPANY; a blocked customer can
  appeal to the help desk.
- Fixed assets: depreciation AUTOMATIC monthly; no threshold; smallwares grouped in pools; big items individual; disposals/scraps/write-downs:
  finance requests, CEO approves (F&B manager NOT); no opening/pre-servd assets; equipment only via CapEx.
- Food cost: split food / drinks / packaging; real-time at the PO price of the lots actually cooked (FIFO); per-outlet stock is the NEXT build
  (tag the outlet now).
- Delivery fee carries sales tax, ADDED ON TOP. On-account corporate clients with a credit limit and a QR card the cashier scans; no manager
  approval per bill; finance invoices monthly (statements). Bad-debt write-off: the CEO approves every one. Raast "void, never booked": CEO only.
  Wrong-brand Raast QR: no change. G15 (dead "Purchase order coming soon" button) → fix.

**PACKAGING RULE — FINAL (owner, 2026-10-13, the LAST answer; it overrides every earlier packaging message, including the
"no exceptions / no brand setting" message the owner withdrew: "Ok nvm do what we originally planned and [do] the brand primary setting
thing. With the button it makes sense"):**
- every finished (plate) recipe ALWAYS has an optional Packaging section (all brands, plated ones like Simmer included);
- whether a sale uses its packaging depends on the ORDER TYPE and the BRAND: `packagingApplies(order, concept, line)` in lib/recipeCost.ts =
  order is takeaway or delivery (incl. storefront pickup/delivery, rider, WhatsApp pickup) → TRUE; else the brand's primary service vessel is
  'packaging' (e.g. Stackd — packaging IS the service vessel) → TRUE; else (dine-in at a plate brand) → TRUE only when staff tapped
  "Box given" on that line (leftovers boxed);
- Concept.serviceVessel 'plate' | 'packaging' (NOT NULL, default 'plate'): a REQUIRED choice when a brand is created (create-brand form + API)
  and editable in Marketing → Brands; backfill stackd = 'packaging', every other brand 'plate'; a change applies from then on (the vessel is
  snapshotted on the order line, never restating past cost);
- OrderItem.boxGiven (Boolean default false) + boxGivenAt / boxGivenById: the "Box given" button on the till / admin order / KDS-expo for
  dine-in lines (any staff of the order's company; audited; undo allowed until the order completes); it depletes the line's packaging lots
  (FIFO, Dr 5030 / Cr 1230) and adds the packaging to the line's actual MC;
- stock depletion and the books follow the same rule: a line whose packaging does not apply depletes no packaging;
- TARGET MC (material cost) = food + drinks + packaging-if-it-applies-to-that-order-type; ACTUAL MC = food + drinks + packaging actually used;
  the variance report shows MC by order type (dine-in / takeaway / delivery) and by brand;
- a recipe needs no packaging lines to be approved (a plate brand with dine-in only is valid); a packaging-vessel brand's recipe WITHOUT
  packaging lines raises a warning on the recipe and in the report (not a block);
- the existing `Recipe.qFactorPct` stays the ONLY pricing allowance (the "Q factor" that pays off the plate, H18): pricing/theoretical only,
  never posted; plate cost reaches the books through smallwares depreciation.

Accountant defaults in force (Hasnain H1–H30, 'In servd now'; Hasnain may change later — keep each one a single switch point):
H1 Garibsons cash → 2210 Due to Garibsons · H2 own petty-cash account 1011; boxes' history treated as from the safe (1010) · H3 cash request =
advance on 1355; receipt books Dr expense / Cr 1355; change back to the box; unsettled after 30 days becomes a staff advance (HR loan, 1350)
or the director's current account (1356) · H4 director's current account · H5 delivered COD not handed in = receivable from the rider (1351) ·
H6 gratuity at exit (30 days' last gross per completed year, > 6 months counts, permanent staff with 1+ year, booked when the F&F is approved) ·
H7 2042 salary tax / 2043 EOBI / 2044 SESSI-PESSI · H8 input tax by charging authority (1320–1324), set off only against that authority;
OpEx/CapEx withhold income tax at the vendor's filer rate (s.153/s.155) · H9 delivery-fee GST at the order's tender rate (15% cash / 8% card,
Raast, online) · H10 kept no-show deposit taxable, tax inside, brand revenue · H11 breakage of sold gift cards → 4200 at expiry, no sales tax
(promotional → 6060) · H12 card MDR booked at payout; tax on the fee is a cost (6080) · H13 customer-withheld sales tax → 1335, netted in that
authority's return · H14 on-account tax invoice at supply (the fiscal POS files at the till; the statement is not a tax invoice) · H15 direct
write-off with reason + evidence, no provision · H16 FIFO lots · H17 goods booked on arrival against 2015 GRNI, cleared by the bill · H18 plate
wear via smallwares depreciation; Q factor pricing only · H19 opening stock found by the first count → 3020 (items never counted/received) ·
H20 brand-less waste/count differences split by each brand's recipe use (30 days); untraceable stays head office · H21 smallwares pools per
outlet/type, 24 months · H22 lives: kitchen 5y, furniture 7, IT 3, vehicles 5, fit-out 10 (or lease end), generators 7, office 5, buildings 20,
smallwares 2, land none · H23 ITO Third Schedule rates + 25% initial allowance on eligible plant · H24 deferred tax report only at 29% ·
H25 rent advance spread monthly to 6010; refundable deposits 1360; no IFRS 16 · H26 architect/design/project fees capitalised on build-outs;
legal/broker expensed · H27 accumulated depreciation per class 1591+ (one-off move out of 1590) · H28 WHT on CapEx at the vendor's filer
rate, 0 with an exemption certificate · H29 30 June year end, virtual roll-forward · H30 due-to/due-from per company pair, settled monthly;
old pre-launch cross-company balances written off inside each company.


## Already done by the orchestrator in wave 0 (use it, never redo or edit it)

- `backend/prisma/schema.prisma` + migrations `20261014085900_finance_wave_b_enums` and `20261014090000_finance_wave_b`, client generated —
  exactly `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`. If you truly need another column/table/index, STOP and say so in your report.
- `backend/src/lib/chartOfAccounts.ts` (new codes, REQUIRED list, `assertTemplateAccounts`, `REGISTER_CONTROLLED_CODES`) and
  `backend/src/modules/accounting/journal.ts` (ACCT constants, `TILL_CLEARING_CODES`, `ON_ACCOUNT_MEMO`, `CONTROLLED_PREFIX`, the
  controlled-account rule with `controlledOverride`, `lateDatingFor`) — exactly `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`.
- `accounting/sourcePosting.ts`: `syncSourcePosting(…, { keepLiveDate })`, `liveRevision(…, tx)` / `liveRevisionsFor(…, tx)`.
- `lib/bankAccounts.ts` `ledgerBalancesByCode(tenantId, codes, { asOf })`; `lib/exceptions.ts` every new ExceptionKind; `lib/inventoryClass.ts`
  (INVENTORY_CATEGORIES, costClassOf, CLASS_ACCOUNTS, CLASS_LABEL); `lib/savepoint.ts` (withSavepoint); `lib/evidenceFile.ts`
  (decodeEvidenceFile, sendEvidence); `lib/onAccountCard.ts`; `lib/tenders.ts` (ON_ACCOUNT_TENDER, REFUND_TENDERS); `accounting/closeCheckTypes.ts`
  (CloseCheck, CloseProblem, CloseCheckContext); `accounting/fiscalYear.ts` (pure fiscalYearOf, taxYearOf, isFiscalYearEndInRange);
  `approvals/types.ts` APPROVAL_TYPES; `lib/moduleAccess.ts` + `lib/workspaces.ts` (module ids food_cost + emergency_overrides, GATED rules);
  `reconciliation/routes.ts` registering stub child plugins (cardPayoutRoutes, codRoutes, pettyCashBackfillRoutes);
  `reconciliation/backfillOrders.ts` exporting placeAndPost / Reposter / RefusedDoc / withBackfillSlot; `tests/setup.ts` (seeds every template
  code, applies the SQL-only CHECKs + partial uniques); `tests/moneyBigint.test.ts` canary; admin `lib/appRoles.ts`, `lib/moduleCatalog.ts`,
  `next.config.js` redirect, `app/exceptions/page.tsx` labels; `packages/types` order modifierId + delivery fee fields.
- `backend/src/index.ts` is NOT touched until wave Z: tests register the plugin they test on their own Fastify instance (see
  tests/connectorsFixtures.ts buildApp). Give the orchestrator the exact registration / worker-start / boot / /health snippet in your report.

## You own (edit only these)

- `backend/src/modules/accounting/supplierPosting.ts`
- `backend/src/modules/procurement/service.ts`
- `backend/src/modules/procurement/routes.ts`
- `backend/src/modules/procurement/receiving.ts`
- `backend/src/modules/procurement/creditNotes.ts`
- `backend/src/modules/procurement/grniRoutes.ts (new)`
- `backend/src/modules/inventory/cashPurchase.ts (new)`
- `backend/src/modules/inventory/fifoCutover.ts (new)`
- `backend/src/modules/reconciliation/routes.ts (W2: delete POST /apply-missed-bill-variances only)`
- `backend/tests/grni.test.ts (new)`
- `backend/tests/supplierFifo.test.ts (new)`
- `backend/tests/fifoCutover.test.ts (new)`
- `backend/tests/receivingFifo.test.ts (new)`
- `backend/tests/grniRoutes.test.ts (new)`
- `backend/tests/cashPurchaseStock.test.ts (new)`
- `backend/tests/supplierBillInputAuthority.test.ts (new)`
- `backend/tests/billEquipmentGuard.test.ts (new)`
- `backend/tests/booksRound5.test.ts`
- `backend/tests/integrationPass2Books.test.ts`
- `backend/tests/resimBooks.test.ts`
- `backend/tests/apAging.test.ts`
- `backend/tests/auditProcurement.test.ts`
- `backend/tests/supplierPaymentsBank.test.ts`
- `backend/tests/supplierCreditNotes.test.ts (W2: moving-average re-pricing → lots + 5060 — verifier: unowned otherwise)`
- `backend/tests/receiving.test.ts (W2: moving-average unit cost → FIFO head; w3-stockdocs owns it in W3)`

## Read first

- plan_foodcost.json: PURCHASES, postings 1-5, 13-18, routes (procurement, GRNI), build_split B+C (receiving/service/grni/creditNotes/cashPurchase), data_migration PART 2
- plan_tax.json: shared_file_changes supplierPosting.ts + procurement/service.ts + routes.ts; plan_assets.json shared_file_changes procurement/service.ts createBill
- critic_assets_foodcost_1.json: violations 2 (one receiving path), 4 (company-less), 5 (GRNI write-off approval); missing (several lots per receipt line, ItemPriceHistory)
- critic_cash_delivery_onaccount_1.json violation 2 (one stock-in contract; only the cash document books it)
- critic_tax_people_0.json violation 8 (supplier picker), critic_assets_foodcost_0.json (one WHT resolver, bill override limits, credit notes excluded)

## What to build

**receiving.ts — THE one path that brings stock in.** Extract `receiveGoodsTx(tx, input)` from receiveGoods (receiveGoods = ensureFifoReady + tx +
receiveGoodsTx + after-commit flags). Sets GoodsReceipt.tenantId / locationId (a Location of the receiving company, else 422
LOCATION_NOT_IN_COMPANY). Each line → `addLotTx`; lot cost = pending bill price for the pending quantity (oldest bill first), else the PO price,
else the dock price — a receipt line may open SEVERAL lots (lot sourceId '<receiptLineId>:<grniMatchId|po|dock>'); store lotUnitCostCents;
settle pending GrniMatch rows; `postGoodsReceiptTx` inside the tx. Delete applyReceiptLine / applyCarriedBillVarianceTx usage; rewrite the header
(owner decision 30 moving average → FIFO lots). **Company-less refusals on every path (critic):** item with tenantId NULL → 422
ITEM_HAS_NO_COMPANY; supplier with tenantId NULL → 422 SUPPLIER_HAS_NO_COMPANY — on the PO path too (today only the no-PO path checks).
**Cash-settled receipts (decision P6):** `input.settledBy?: { kind: 'petty_cash_movement'|'cash_voucher_settlement', id, creditAccountCode }` —
a no-PO receipt whose supplier is the company's system supplier `ensureCashPurchaseSupplier(tx, tenantId)` (Supplier.systemKind
'cash_purchases', name 'Cash purchases', created lazily, never listed or billed), lines born billed (billedQty = receivedQty), GoodsReceipt
settledByType/Id/AccountCode set (unique per cash document → the same food can't come in twice), and `postGoodsReceiptTx` posts nothing. The
MANAGERS-only receive check and the self-receipt rule do not apply to settled receipts (the cash area restricts stock lines to keepers /
inventory-module roles instead).
**inventory/cashPurchase.ts** `recordCashPurchaseStockTx(tx, { tenantId, settledBy, lines: [{ spendLineId, inventoryItemId, qty, unit,
totalCents }], locationId, occurredAt, actorId })` — a THIN caller of receiveGoodsTx (units through toPurchaseUnits → 422 UNIT_MISMATCH; items
must be the company's → 404) returning `{ goodsReceiptId, lines: [{ spendLineId, receiptLineId, accountCode (CLASS_ACCOUNTS[class].inv),
valueCents (= totalCents exactly) }], byClass }`. It posts NOTHING (the cash document's entry carries Dr 12x0). Used by w3-cash-requests.
**supplierPosting.ts (FC + TX):** rewrite postSupplierBill (posting 2: Dr 2015 for stock lines matched FIFO to unbilled receipt lines of the PO
line (or to receiptLineId) × the receipt lot cost → GrniMatch 'live' + billedQty; price difference → repriceLotTx (on-hand share to 12x0, used
share to 5060 brand-split); Dr 2015 at the billed price for quantity billed before it arrived (GrniMatch 'pending', ≤ ordered − received else 422
OVER_BILLED); Dr <expenseAccountCode> for non-stock lines; **Dr inputTaxCodeFor(bill.taxAuthority)** for taxCents with memo naming the authority;
Cr 2040 WHT; Cr 2010); postSupplierBillVoid (posting 4 incl. the legacy path: 'supplier.bill.void.legacy:<billId>' Dr 12x0 R / Cr 2015 R + true-up
via 5060); postSupplierCreditNote + void (posting 5: returns from the bill's own lots first then FIFO, kind supplier_return; price credit
re-prices the matched lots; Cr the bill's own input code (inputTaxCodeOfBill — comment 'G7 done')); costAdjustmentCode always 5060; delete the
moving-average machinery (revalueItem, revalueForBillVariance, billVarianceLines, varianceRecordsOf, matchedByOtherBills, receivedSince,
applyCarriedBillVarianceTx) — existing audit rows stay readable for the legacy void path; postWasteLog's body moved to inventoryPosting.ts (keep
`export { postWasteLog } from './inventoryPosting.js'`); rewrite the K2 comment (~645-653). **ONE WHT resolver:**
`withholdingForBill(db, { tenantId, supplier, subtotalCents, section, at })` delegates to lib/withholding.ts computeWithholding and returns
{ whtCents, rateBps, section }. ItemPriceHistory written only at lot creation (receipts) and on bill re-price (critic).
**procurement/service.ts createBill:** stock lines need poLineId or receiptLineId (422 STOCK_LINE_NEEDS_RECEIPT 'receive it at the dock first');
receiptLineId must be this supplier's receipt of the same item (422 RECEIPT_LINE_MISMATCH); non-stock lines need expenseAccountCode (422
EXPENSE_ACCOUNT_REQUIRED; assertExpenseCode 6xxx); keep the INT4 cap on non-stock lines (~403-431); a STOCK line's unit cost must also fit INT4 — it becomes GrniMatch.billedUnitCostCents /
StockLot.unitCostCents (per-unit stock cost, INT4 by BOOKS-06) — `assertInt4Fits` → 422 AMOUNT_TOO_LARGE, never a 500 on insert (verifier); refuse bills to a system supplier (422
SYSTEM_SUPPLIER). TX: taxAuthority (default supplier.defaultTaxAuthority ?? 'fbr'), whtSection (default supplier.defaultWhtSection ?? '153_1_a'),
whtRateBps stored; whtCents from withholdingForBill. FA: each non-stock line → `assertNotEquipmentLine(…, actor)` (equipment AND smallwares →
422 USE_CAPEX; override only admin/finance with a reason ≥ 10; audited 'supplier_bill.not_equipment_override' + flagException
'bill_equipment_override' HIGH in the supplier's company); credit notes (kind credit_note) are excluded from the guard; stock lines never checked.
**procurement/routes.ts:** billLineSchema + receiptLineId?, expenseAccountCode?, notEquipment?, notEquipmentReason?; billCreateSchema + taxAuthority,
whtSection; supplier create/patch + filerStatus, whtExemptCertNo, whtExemptUntil, defaultTaxAuthority, defaultWhtSection; **GET
/procurement/suppliers?view=picker&categoryId=… (or &tenantId=…)** → projection {id, name, filerStatus, whtExemptUntil, defaultWhtSection,
defaultTaxAuthority} of the OpEx category's company (resolved in WRITE scope → 404 foreign) — the OpEx/CapEx vendor picker (w0 widened the
'/procurement/suppliers' read gate to 'capital'); system suppliers never listed anywhere.
**creditNotes.ts:** return caps read the remaining quantity of the bill's lots.
**grniRoutes.ts** (wave Z registers at /procurement/grni; gate anyOf ['procurement','accounting'] from w0): GET / ?tenantId&supplierId&olderThanDays
&writeOffRequested=1 (open receipt lines received − billed, value, age, stale > 30 days, pending bill matches, write-off request); GET
/unbilled-lines?supplierId (bill form picker; foreign supplier → 404); **GRNI write-off (critic: finance/procurement request, the CEO approves):**
POST /:receiptLineId/write-off-request {reason 3-500} (admin, owner, management, finance, procurement roles; claim writeOffRequestedAt IS NULL;
409 NOTHING_OPEN / WRITE_OFF_PENDING); POST /:receiptLineId/write-off/approve (ADMIN_ONLY; posts postGrniWriteOffTx; a request the CEO raised
applies at once); POST /:receiptLineId/write-off/reject {note} (ADMIN_ONLY). Audit rows in the receipt's company.
**inventory/fifoCutover.ts** `ensureFifoCutover(tenantId)` / `readCutover(tenantId)`: per the FC plan PART 2 (step 0 = the former
applyMissedCarriedBillVariances logic, moved here and run once; steps 1-5 in ONE tx under pg_advisory_xact_lock(hashtext('fifo_cutover:'||tenantId))
with the company's items locked in id order; opening lots 'fifo_cutover' (negative/NaN stock → 0 + audit; null cost → 0 flagged noCost; company-
less items with stock are LISTED (for /health and the Unassigned worklist), never given lots); billedQty per PO line; class reclass + GRNI opening
(postClassReclassTx / postGrniOpeningTx, pending GrniMatch rows for billed-ahead keyed by billLineId); pre-FIFO difference stored in Setting
'foodcost.preFifoDiff:<tenantId>' (never posted — alignment is the CEO's postFifoAlign); marker 'foodcost.fifoCutoverAt:<tenantId>').
**reconciliation/routes.ts:** delete POST /apply-missed-bill-variances (~365-400) — the logic now lives in fifoCutover step 0.

## Contracts you consume (already on disk when you start)

- w1-stock: addLotTx, consumeFifoTx (supplier returns), repriceLotTx, ensureFifoReady, postGoodsReceiptTx, postClassReclassTx, postGrniOpeningTx,
  postGrniWriteOffTx, brandUsageShares/splitCents.
- w1-taxcore: computeWithholding, inputTaxCodeFor, TAX_AUTHORITY_KEYS, WHT_SECTIONS.  w1-fa-engine: assertNotEquipmentLine.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// procurement/receiving.ts
export interface ReceiveGoodsInput { tenantId: string; supplierId?: string; poId?: string; locationId?: string | null; receivedById: string;
  receivedAt?: Date; lines: Array<{ inventoryItemId: string; receivedQty: number; unit: string; unitCostCents?: number; poLineId?: string; description?: string }>;
  settledBy?: { kind: 'petty_cash_movement'|'cash_voucher_settlement'; id: string; creditAccountCode: string } }
export function receiveGoodsTx(tx: Tx, input: ReceiveGoodsInput): Promise<{ receiptId: string; lines: Array<{ receiptLineId: string; lotIds: string[]; valueCents: number; costClass: CostClass }> }>
export function ensureCashPurchaseSupplier(tx: Tx, tenantId: string): Promise<{ id: string }>
// inventory/cashPurchase.ts
export function recordCashPurchaseStockTx(tx: Tx, a: { tenantId: string; settledBy: { kind: 'petty_cash_movement'|'cash_voucher_settlement'; id: string; creditAccountCode: string };
  lines: Array<{ spendLineId: string; inventoryItemId: string; qty: number; unit: string; totalCents: number }>; locationId?: string | null; occurredAt: Date; actorId: string })
  : Promise<{ goodsReceiptId: string; lines: Array<{ spendLineId: string; receiptLineId: string; accountCode: string; valueCents: number }>; byClass: Record<CostClass, number> }>
// inventory/fifoCutover.ts
export function ensureFifoCutover(tenantId: string): Promise<{ ran: boolean; at: Date }>
export function readCutover(tenantId: string): Promise<{ at: Date | null; preFifoDiff: Record<CostClass, number> | null }>
// accounting/supplierPosting.ts
export function withholdingForBill(db: Db, a: { tenantId: string; supplier: SupplierTaxFields; subtotalCents: number; section: WhtSection | null; at: Date }): Promise<{ whtCents: number; rateBps: number; section: WhtSection | null }>
```


## Tests

Your database: `servd_test_wb_w2_ap`. Your Redis: `redis://127.0.0.1:6390/10`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_ap REDIS_URL=redis://127.0.0.1:6390/10 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`receivingFifo` (PO receipt → lots + Dr 12x0 / Cr 2015; two lots for one receipt line when a pending bill priced part of it; company-less item or
supplier refused on PO and no-PO paths; location of another company → 422). `grni` (bill at a higher price after half the lot was sold: 2015 cleared
at the PO cost, on-hand half to 1210, sold half to 5060, lot re-priced, lots == 1210; bill before receipt: pending → receipt creates the lot at the
billed price, 2015 nets 0; bill void restores lots and 2015; legacy bill void re-opens GRNI + 5060 true-up; credit-note return takes the bill's
lots first). `supplierFifo` (STOCK_LINE_NEEDS_RECEIPT; non-stock line to its 6xxx; beverage/packaging classes). `grniRoutes` (two companies: B →
404 on A's receipt line/supplier; finance requests a write-off, non-admin approve → 403, CEO approves → Dr 2015 / Cr 5060, CEO-raised applies at
once; 409 NOTHING_OPEN). `cashPurchaseStock` (settled receipt: lines born billed, posts nothing, second call for the same cash document → unique
violation mapped to 409; B's item → 404; UNIT_MISMATCH). `supplierBillInputAuthority` (SRB-tagged bill → Dr 1322 in the supplier's company; its
credit note credits 1322; WHT by section/filer via the one resolver; B creating a bill against A's supplier → 404; supplier picker view=picker
scoped to the category's company). `billEquipmentGuard` ('Deep fryer' → 422 USE_CAPEX; 'Fryer repair', 'Kraft bowl 500ml', stock lines pass;
'Dinner plates x24' (smallwares) → 422; override by finance audited + high flag in the supplier's company; override by procurement → 403; credit
note not checked). `fifoCutover` (lots == currentStock; class reclass once; re-run posts nothing; GRNI opening matches received − billed; company-
less item with stock listed not lotted; each company's cut-over touches only its rows). Update booksRound5, integrationPass2Books (keep the
pos-connector doc identity strings), resimBooks, and re-run apAging / auditProcurement / supplierPaymentsBank (adjust only what your change moves).



## Rules (CLAUDE.md applies in full — these are the ones builders trip on)

1. **Ownership.** Edit ONLY the files listed under "You own". Shared/orchestrator files (schema.prisma, migrations, chartOfAccounts.ts,
   journal.ts, sourcePosting.ts, index.ts, moduleAccess.ts, workspaces.ts, approvals/types.ts, admin moduleCatalog.ts/appRoles.ts,
   tests/setup.ts) and every file another agent owns this wave: put the exact snippet in your report ("patch notes"). Read any file you like.
2. **Company separation from the first line.** Routes use `lib/tenantScope.ts` (`scopeTenantWhere(req,'read'|'write'|'create')`,
   `assertConceptOwned`, `conceptIdsInScope`, `activeTenantId`, `resolveTenantScope`). Resolve every client id (conceptId, locationId, shiftId,
   supplierId, bankAccountId, itemId, …) to its company first: foreign row → 404; cross-company attach on create → 422; an empty scope DENIES
   (`{ tenantId: { in: [] } }`), never `tenantFilter ?? undefined`. Orders have no tenantId: scope them through `concept`. Workers loop per
   company on `serviceClient`; route reads use the RLS client. Audit rows carry the DOCUMENT's tenantId.
3. **Money.** `postJournalEntry` with the SOURCE document's tenantId, inside the document's own transaction, idempotent `sourceType:sourceId`,
   debits == credits asserted before posting. User-entered money in a closed month → 422 PERIOD_LOCKED and nothing saved; system / approval
   / late postings use `lateDatingFor` (owner decision 6: post into the open month with a note naming the original date). A posting that can be
   refused outside a user request → `flagPostingFailed(sourceType, entity, sourceId)` and an exported re-post function (w4-integration wires
   REPOSTERS). BIGINT company money through lib/money.ts (`toCents`, `sumCents`, `assertMoneyFits`, `zMoneyCents`); INT4 per-ticket/per-unit/
   per-person/per-box money through `zInt4Cents` / `assertInt4Fits`. No bigint literals, `BigInt()` or bigint arithmetic in src; raw SQL sums
   cast `::bigint` then `toCents`; never select a widened table with `SELECT *` in raw SQL. Never `as never` / `as unknown` on a DB write.
   Want a clear 422 instead of `resolveAccountIds`' 500? Call `assertTemplateAccounts(db, tenantId, codes)` first.
4. **One source of truth.** Extend existing code; never a second resolver, rate table, engine, list or approval path. If you discover a duplicate
   the brief did not anticipate, STOP that part and report it (owner's standing rule).
5. **Locks.** Documented order: order → client account → invoice; `lockRaastTx` before the order lock; FIFO item locks in id order
   (`lockItemsTx`). Never hold a transaction across a network call, photo decode or `processPayment`.
6. **Tests.** Every route you add or change ships with a two-company test (company B gets 404 on A's rows; creates bind to the active company;
   cross-company ids → 422). Run from `backend/`:
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_ap REDIS_URL=redis://127.0.0.1:6390/10 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
   (your own database and Redis index — never another agent's). Run ONLY your new test files and the existing suites listed in your brief (plus
   any other suite that covers code you changed — grep tests/ for the module). Never the whole suite, never `next build`, never a dev server,
   never production, never `git commit`. `npx tsc --noEmit -p .` in backend/ (and frontend/admin if you touched it): YOUR files must be clean;
   list errors in other agents' files without fixing them (they are being edited in parallel).
7. **Admin pages you own** (if any): tokens only (`var(--erp-*)`, `rgb(var(--x-rgb) / a)`, `color-mix(...)`, `s-badge-*`, `text-success`);
   purple = actions, green = state/good news, red = bad; no hard-coded colours, no emoji icons; money typed in rupees (convert to paisa);
   plain English; phone width; show the server's 403/404/409/422 messages; no local role lists (lib/roles.ts or server capability flags).


## Report format (your final message is the return value — no separate report file)

1. Files created / changed / deleted (paths).
2. Routes added/changed: method, path, guard (roles), module gate, scope mode, body, responses, error codes.
3. Postings: Dr/Cr, `sourceType:sourceId`, company source, date rule, where it runs (which transaction).
4. Contracts you EXPOSE (exact TypeScript signatures, file paths) — later waves code against these.
5. Tests: files written/updated, the exact command run, pass/fail counts; failures you believe belong to another agent's in-flight work.
6. `tsc` result for your files.
7. Patch notes: exact snippets for files you do not own (orchestrator or the next owner applies them).
8. Deviations from this brief and why; owner/accountant questions still open (with the default you built); anything still wrong.
