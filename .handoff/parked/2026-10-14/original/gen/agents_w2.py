W2 = []

W2.append(dict(
id="w2-sale", wave="W2", area="foodcost (sale side) + delivery/tax hooks in orders", idx=9,
title="Recipe explosion with packaging by order type + brand vessel + Box given, per-line FIFO depletion, cancel/void/return semantics, orders/service.ts",
summary="lib/recipeCost.ts, orders/stock.ts, inventory/voidWaste.ts, orders/service.ts (all merged), pos/service.ts (FC part).",
owns=["backend/src/lib/recipeCost.ts", "backend/src/modules/orders/stock.ts (new)", "backend/src/modules/orders/service.ts",
      "backend/src/modules/inventory/voidWaste.ts", "backend/src/modules/pos/service.ts (FC part only — W2)",
      "backend/tests/orderStock.test.ts (new)", "backend/tests/packagingDepletion.test.ts (new)", "backend/tests/modifierStock.test.ts (new)",
      "backend/tests/cancelReturnedHook.test.ts (new)", "backend/tests/recipeCost.test.ts", "backend/tests/integrationPass2Orders.test.ts",
      "backend/tests/auditTillShift.test.ts", "backend/tests/auditOrdersFollowup.test.ts", "backend/tests/managerVoids.test.ts (FC void parts, W2)",
      "backend/tests/resimTill.test.ts (W2: the void_after_fire / stock.sale_deplete / Cr 1210 cases — verifier: unowned otherwise)",
      "backend/tests/auditOrdersRefund.test.ts (W2: the deductInventoryForOrder / cancel restore cases only)"],
read=["plan_foodcost.json: summary SALES, extends_existing (recipeCost, orders/service, voidWaste, pos/service), shared_file_changes orders/service + pos/service, build_split A",
      "plan_delivery.json: shared_file_changes orders/service.ts (inCancelTx hook); plan_tax.json: shared_file_changes orders/service.ts",
      "critic_assets_foodcost_1.json: returned food (no auto-waste after pick-up), KDS recall remake, restore failure flag, RecipeKind 'modifier', company-less stock",
      "critic_cash_delivery_onaccount_0.json: cancelOrder audits in the order's company"],
tasks=r"""
**THE packaging rule (decision P1 — FINAL owner rule, see the common brief):** a sold line consumes its dish's Packaging section ONLY when
`packagingApplies(order, line)` is true: takeaway / delivery (every off-premise fulfilment) → true; else the line's snapshotted brand service
vessel (OrderItem.serviceVessel, copied from Concept.serviceVessel at ring-up) is 'packaging' → true; else (dine-in at a plate brand) → true only
when OrderItem.boxGiven. This is THE one seam. `markBoxGiven(orderItemId, actor, { undo? })` (undo only until the order completes): the
line from write scope (foreign → 404), dine-in only (takeaway/delivery or a packaging-vessel line → 409 BOX_NOT_NEEDED, it already counts);
sets boxGiven/boxGivenAt/boxGivenById and, when the line's stock was already depleted, depletes the dish's packaging lots (FIFO, kind 'sale',
sourceType 'order_item.box_given', sourceId line.id — idempotent on the line, never twice); undo returns them to the same lots; audited
'order.box_given' / 'order.box_given_undo' in the ORDER's company. **Snapshot:** every OrderItem create in orders/service.ts (ingestOrder ~576
and the add-items paths ~1188 / ~1223) writes `serviceVessel` = the line's brand Concept.serviceVessel at that moment; a legacy line with null
reads the brand's current vessel.
**lib/recipeCost.ts (THE explosion/costing):** CostItem gains tenantId + category; recipe lines gain `section`; roots carry Recipe.modifierId/kind.
`consumptionForSoldLines(lines, db, { tenantId, fulfilmentType })` and per-line `consumptionPerLine` → `{ need, excluded }`: dish ingredients +
sub-recipes + the dish's modifier recipes (RecipeKind 'modifier', loaded per line from OrderItemModifier.modifierId) + the dish's Packaging
section (when packagingApplies). Negative 'removes' lines only on modifier recipes, clamped ≥ 0 per ingredient per line. Foreign or company-less
items are EXCLUDED (never consumed) and reported. `RecipeCost` gains `stockByClass` {food, beverage, packaging} (all depths, ex-Q),
`packagingCents`, `standardCents` (= food + drinks, the plate MC) and `targetMcCents` { dine_in, takeout, delivery } (= standardCents +
packagingCents where packaging applies to that order type for the recipe's brand vessel — the TARGET MC; dine_in at a plate brand = standardCents), `qCents` (Recipe.qFactorPct — pricing only,
never stock, never posted). `menuItemPlateCosts` and `cogsForSoldLines` keep their signatures (menu engineering + the legacy COGS fallback).
**orders/stock.ts (bodies moved from orders/service.ts; service.ts re-exports deductInventoryForOrder / restoreInventoryForOrder):**
- `deductInventoryForOrder(orderId)`: `ensureFifoReady(tenantId)` first (outside any tx); claim through the write-once 'stock.sale_deplete' audit
  row; per line `consumeFifoTx` (clamp, kind 'sale', sourceType 'order_item.sale', sourceId line.id, conceptId, order.locationId,
  theoreticalQty); after commit one open `recipe_foreign_stock` flag per (menuItem, company); the auto-86 moved unchanged.
- `restoreInventoryForOrder(orderId, { cookedFood?, actorId, approverId })`: unfired lines → `returnToLotsTx` (exact lots); fired lines →
  `wasteSoldLineTx` reason 'cancelled_after_fire' (food that never left the kitchen). Pre-cut-over orders use the old JSON path and return
  through 'legacy_return' lots at the head cost keyed by event (`'<orderItemId>:void'` / `':cancel'` — critic: no collision).
- `returnVoidedLineStockTx(tx, { orderId, tenantId, line })`, `ensureOrderDepleted(orderId)` (outside any tx), `wasteReturnedOrder(orderId,
  actor)` (fired lines still out on an ALREADY-cancelled order, once, same keys), `packagingApplies`.
**inventory/voidWaste.ts (FC + DL merged):** `wasteSoldLineTx(tx, { orderId, tenantId, line, wasteReason, actorId, conceptId })` — relabels the
line's net-out sale rows to sale_void + waste (stock unchanged), one WasteLog per item (tenantId, conceptId, orderItemId, FIFO value in
estimatedCostCents), `postVoidWaste` by class (Cr 1210/1220/1230 — packaging included) inside the tx, key 'pos.void_waste:<orderItemId>'.
Exports `VOID_WASTE_REASONS = ['void_after_fire','cancelled_after_fire','returned_food']`, `RETURN_WASTE_REASON = 'returned_food'`; keep
`wasteVoidedFiredLineTx` as an alias. A refusal leaves the waste logs standing and is flagged after commit (existing pattern).
**orders/service.ts — every merged change (you are the only W2 owner):**
- FC: the moves above; completeOrder `await ensureOrderDepleted(orderId)` before the claim tx; ingestOrder persists `modifierId` only when that
  Modifier belongs to a non-deleted ModifierGroup of the line's menuItem (else null); depletion today is fire-and-forget → on failure flag
  'stock_restore_failed' (and cancel restore/waste after commit: flag instead of console.error — critic; w4-integration adds the sweep).
- **KDS recall (~1805-1857, ItemStatus 'recalled'):** the remake re-cooks the line → book the line's recipe as waste reason 'remake' (consumeFifoTx
  kind 'waste', a WasteLog with orderItemId, `postWasteLog` key 'inventory.waste:<wasteLogId>' — each recall its own log), never silently.
- **Cancel semantics (FC + DL):** `CancelOrderInput.cookedFood?` and `CancelOrderInput.returned?: { cause, actorId, run(tx) }`;
  `transitionOrder(…, { inCancelTx })` runs `run(tx)` right after markPreBillsCancelledTx when the claim changed, inside the cancel tx, and
  returns its result. Default cancel: unfired lines return to lots, fired lines wasted 'cancelled_after_fire' — EXCEPT a delivery order with
  `pickedUpAt` set and not delivered: the generic cancel refuses **409 USE_EMERGENCY_OVERRIDE** ('the food is with the rider; log it in Emergency
  overrides when it comes back'); only the override (w3-dlv-return, via `returned`) books 'returned_food' with the manager as actor and skips
  the default waste for those lines. cancelOrder audits with the ORDER's company (concept.tenantId), not input.actor.tenantId (critic).
- TX: ingestOrder writes `deliveryFeeCents` / `deliveryFeeTaxCents` from `opts.price` (w1-taxsales already returns them).
**pos/service.ts — FC part only in W2 (w3-till owns the file in W3):** delete restoreVoidedLineStockTx + STOCK_DEPLETE / STOCK_RESTORE /
STOCK_VOID_RESTORE (~1926-1999); the void handler (~2171-2183) calls `returnVoidedLineStockTx` (unfired) / `wasteSoldLineTx(…, 'void_after_fire')`
(fired) with the same result shape for the existing flagging; compOrder / staff meal (~2424): `await ensureOrderDepleted(order.id)` then
`estimatedCostCents = await orderStockCostCents(order.id)`. Touch nothing else in pos/service.ts.
""",
consumes=r"""
- w1-stock: consumeFifoTx, returnToLotsTx, relabelToWasteTx, ensureFifoReady, lockItemsTx; cogs.orderStockCostCents; inventoryPosting.postWasteLog.
- w0: RecipeKind 'modifier', Recipe.modifierId, RecipeIngredient.section, WasteLog columns, Order fee columns, lib/savepoint.
""",
exposes=r"""
```ts
// lib/recipeCost.ts
export function packagingApplies(order: { fulfilmentType: string }, line: { serviceVessel: 'plate' | 'packaging'; boxGiven: boolean }): boolean
export async function markBoxGiven(orderItemId: string, actor: { id: string }, opts?: { undo?: boolean }): Promise<{ boxGiven: boolean; depleted: boolean }>
export function consumptionForSoldLines(lines: SoldLine[], db: Db, o: { tenantId: string; fulfilmentType: string })
  : Promise<{ need: Map<string, { qty: number; costClass: CostClass }>; excluded: Array<{ itemId: string; reason: 'foreign'|'company_less' }> }>
export interface RecipeCost { /* existing */ stockByClass: Record<CostClass, number>; packagingCents: number; standardCents: number; qCents: number;
  targetMcCents: { dine_in: number; takeout: number; delivery: number } }   // per the brand's vessel; dine_in excludes packaging at a plate brand
// orders/stock.ts
export function deductInventoryForOrder(orderId: string): Promise<void>
export function restoreInventoryForOrder(orderId: string, o: { cookedFood?: { wasteReason: 'cancelled_after_fire'; photoUrl?: string }; actorId?: string; approverId?: string }): Promise<void>
export function returnVoidedLineStockTx(tx: Tx, a: { orderId: string; tenantId: string; line: { id: string; quantity: number } }): Promise<{ valueCents: number }>
export function ensureOrderDepleted(orderId: string): Promise<void>
export function wasteReturnedOrder(orderId: string, actor: { id: string }): Promise<{ wasteCostCents: number }>
// inventory/voidWaste.ts
export const VOID_WASTE_REASONS: readonly ['void_after_fire','cancelled_after_fire','returned_food']
export const RETURN_WASTE_REASON: 'returned_food'
export function wasteSoldLineTx(tx: Tx, a: { orderId: string; tenantId: string; line: { id: string }; wasteReason: typeof VOID_WASTE_REASONS[number];
  actorId: string | null; conceptId: string | null }): Promise<{ wasteLogIds: string[]; wasteCostCents: number; postingError?: AppError }>
// orders/service.ts
export interface CancelOrderInput { /* existing */ cookedFood?: { wasteReason: 'cancelled_after_fire'; photoUrl?: string };
  returned?: { cause: 'refused'|'unreachable'|'other'; actorId: string; run: (tx: Tx) => Promise<ReturnedTxResult> } }
export function cancelOrder(id: string, input: CancelOrderInput): Promise<{ order: Order; returned?: ReturnedTxResult }>
```
""",
tests=r"""
Single company: every path writes exactly its movements and a replay writes nothing (sale, unfired void, fired void = sale_void + waste with stock
unchanged, cancel (fired wasted, unfired returned), returned_food via the hook); FIFO draws oldest first and returns go to the same lots;
shortfall clamps + auto-86 kept; **packaging (`packagingDepletion`): a Simmer (plate) DINE-IN sale depletes NO packaging and its target MC excludes
it; the same dish takeaway or delivery depletes the packaging; a Stackd (packaging vessel) dine-in sale depletes it; "Box given" on a Simmer dine-in
line depletes it once (a second tap and a replay write nothing; undo before completion returns it to the same lots; after completion → 409); Box
given on a takeaway line → 409 BOX_NOT_NEEDED; B → 404 on A's line; changing the brand's vessel later does not change an already rung-up line
(snapshot);** modifier recipe with a negative line clamps; legacy pre-cut-over order cancels through the JSON path with
event-keyed legacy_return lots; KDS recall books 'remake' waste once per recall; generic cancel of a picked-up delivery → 409 USE_EMERGENCY_OVERRIDE;
the returned hook runs inside the cancel tx and its waste replaces the default; cancel audit row carries the order's company; staff meal cost =
lot value. Two companies: a B order whose shared sub-recipe uses A's (or a company-less) item consumes nothing of A, writes no movement under A, one
recipe_foreign_stock flag in B; consumeFifoTx with a mismatched tenant throws; a modifierId of another menu item is stored null (through ingestOrder).
Update recipeCost, integrationPass2Orders, auditTillShift, auditOrdersFollowup (stock JSON → movements) and managerVoids (fired-void waste parts).
""",
))

W2.append(dict(
id="w2-ap", wave="W2", area="foodcost (receiving, GRNI, bills, cut-over) + tax (bill authority/WHT) + assets (bill equipment guard)", idx=10,
title="ONE receiving path with lots + GRNI, bills on FIFO, cash-settled receipts, supplier tax fields, FIFO cut-over",
summary="supplierPosting.ts rewrite, procurement service/routes/receiving/creditNotes/grniRoutes, inventory/cashPurchase.ts + fifoCutover.ts, reconciliation/routes.ts (delete one route).",
owns=["backend/src/modules/accounting/supplierPosting.ts", "backend/src/modules/procurement/service.ts", "backend/src/modules/procurement/routes.ts",
      "backend/src/modules/procurement/receiving.ts", "backend/src/modules/procurement/creditNotes.ts", "backend/src/modules/procurement/grniRoutes.ts (new)",
      "backend/src/modules/inventory/cashPurchase.ts (new)", "backend/src/modules/inventory/fifoCutover.ts (new)",
      "backend/src/modules/reconciliation/routes.ts (W2: delete POST /apply-missed-bill-variances only)",
      "backend/tests/grni.test.ts (new)", "backend/tests/supplierFifo.test.ts (new)", "backend/tests/fifoCutover.test.ts (new)", "backend/tests/receivingFifo.test.ts (new)",
      "backend/tests/grniRoutes.test.ts (new)", "backend/tests/cashPurchaseStock.test.ts (new)", "backend/tests/supplierBillInputAuthority.test.ts (new)",
      "backend/tests/billEquipmentGuard.test.ts (new)", "backend/tests/booksRound5.test.ts", "backend/tests/integrationPass2Books.test.ts", "backend/tests/resimBooks.test.ts",
      "backend/tests/apAging.test.ts", "backend/tests/auditProcurement.test.ts", "backend/tests/supplierPaymentsBank.test.ts",
      "backend/tests/supplierCreditNotes.test.ts (W2: moving-average re-pricing → lots + 5060 — verifier: unowned otherwise)",
      "backend/tests/receiving.test.ts (W2: moving-average unit cost → FIFO head; w3-stockdocs owns it in W3)"],
read=["plan_foodcost.json: PURCHASES, postings 1-5, 13-18, routes (procurement, GRNI), build_split B+C (receiving/service/grni/creditNotes/cashPurchase), data_migration PART 2",
      "plan_tax.json: shared_file_changes supplierPosting.ts + procurement/service.ts + routes.ts; plan_assets.json shared_file_changes procurement/service.ts createBill",
      "critic_assets_foodcost_1.json: violations 2 (one receiving path), 4 (company-less), 5 (GRNI write-off approval); missing (several lots per receipt line, ItemPriceHistory)",
      "critic_cash_delivery_onaccount_1.json violation 2 (one stock-in contract; only the cash document books it)",
      "critic_tax_people_0.json violation 8 (supplier picker), critic_assets_foodcost_0.json (one WHT resolver, bill override limits, credit notes excluded)"],
tasks=r"""
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
""",
consumes=r"""
- w1-stock: addLotTx, consumeFifoTx (supplier returns), repriceLotTx, ensureFifoReady, postGoodsReceiptTx, postClassReclassTx, postGrniOpeningTx,
  postGrniWriteOffTx, brandUsageShares/splitCents.
- w1-taxcore: computeWithholding, inputTaxCodeFor, TAX_AUTHORITY_KEYS, WHT_SECTIONS.  w1-fa-engine: assertNotEquipmentLine.
""",
exposes=r"""
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
""",
tests=r"""
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
""",
))

W2.append(dict(
id="w2-ledger", wave="W2", area="foodcost (COGS) + tax (4110) in the sale formula", idx=11,
title="Order completion and shift close: COGS by class from lots, 4110 delivery-fee leg, output tax via the one authority table",
summary="accounting/orderPosting.ts + shiftPosting.ts (W2 part). The on-account / 1115 changes come in W3 (w3-till).",
owns=["backend/src/modules/accounting/orderPosting.ts (W2)", "backend/src/modules/accounting/shiftPosting.ts (W2)",
      "backend/tests/deliveryFeeLedger.test.ts (new)", "backend/tests/cogsPosting.test.ts (new)",
      "backend/tests/auditLedgerSales.test.ts (W2: COGS/4110 expectations)", "backend/tests/booksLedger.test.ts (W2: COGS/4110 expectations)",
      "backend/tests/auditLedgerFollowups.test.ts (W2: COGS/4110 expectations)", "backend/tests/postingFailures.test.ts (W2: COGS/4110 expectations)"],
read=["plan_foodcost.json: postings 6-7, shared_file_changes orderPosting/shiftPosting",
      "plan_tax.json: postings order.complete / shift.close / refunds, shared_file_changes orderPosting/shiftPosting",
      "critic_tax_people_0.json violation 7 (one authority table incl. the province map)"],
tasks=r"""
**orderPosting.ts:** (FC) delete computeOrderCogsCents and the cogsForSoldLines import; postOrderCompletion resolves tenantId (order.concept.tenantId)
BEFORE building lines and calls `cogsLinesForOrders(tenantId, [order.id], { conceptId: order.conceptId, memo: conceptMemo })`;
`buildSaleLines(order, sa, cogsLines)` appends them in place of the single 5010/1210 pair (~449-453); refund paths unchanged (COGS stays booked).
(TX) SaleOrderFields Pick + deliveryFeeCents; SaleAccounting + deliveryFeeCents; computeSaleAccounting subtracts the fee from gross revenue
(identity: charged + wallet + gift card + discount = revenue + tax + svc + tip + fee); buildSaleLines Cr ACCT.DELIVERY_FEE_REVENUE (conceptId,
memo 'Delivery fee on <slug> #<ref>' — orderRefOf); the output-tax credit stays the full taxCents (food GST + fee GST) to outputTaxCodeFor(concept);
RefundShare + deliveryFeeCents (refundShareOf shares it; revenue = this − tax − svc − tip − fee); refundDebitLines Dr 4110; selects ~732 / ~854 add
deliveryFeeCents; header comment. Legacy orders (fee 0) book exactly as today. (TX critic) `OUTPUT_TAX_BY_PROVINCE` / `OUTPUT_TAX_ACCOUNTS` /
`outputTaxCodeFor` are now DERIVED from accounting/taxAuthorities.ts (w1-taxcore) — re-export the same names so importers keep working; one table.
**shiftPosting.ts:** (FC) per-brand COGS (~510-525) → `lines.push(...await cogsLinesForOrders(tenantId, b.orderIds, { conceptId: b.conceptId,
memo: \`@ ${b.conceptSlug} ${tag}\` }))`; drop the cogsForSoldLines import. (TX) select (~137) + deliveryFeeCents; brand accumulator + totals
deliveryFeeCents; Cr 4110 per brand (memo 'Delivery fees @ <slug>', conceptId); log line adds fee. (Till sales carry 0 today but the formula is
shared.)
Do NOT touch the till-clearing lines, the on-account branch, refundCreditAccount, saleBookingOf or refundDueCents — those are w3-till's in W3.
""",
consumes=r"""
- w1-stock: cogsLinesForOrders. w1-taxcore: taxAuthorities.ts (OUTPUT_TAX_BY_PROVINCE, outputTaxCodeFor). w0: ACCT.DELIVERY_FEE_REVENUE, Order fee columns.
""",
exposes=r"""
```ts
// accounting/orderPosting.ts (unchanged names, new fields)
export interface SaleAccounting { /* existing */ deliveryFeeCents: number }
export interface RefundShare { /* existing */ deliveryFeeCents: number }
export { OUTPUT_TAX_BY_PROVINCE, OUTPUT_TAX_ACCOUNTS, outputTaxCodeFor } // re-exported from taxAuthorities.ts
```
""",
tests=r"""
`deliveryFeeLedger` (completion entry balances with Cr 4110 + the full tax; a refund takes the 4110 share; a legacy order (fee 0) posts as before; a
till sale has no fee; two companies: B's delivery order posts to B's 4110 and output account). `cogsPosting` (order.complete posts one pair per
class from the lots, packaging to 5030/1230 for a DINE-IN order too; shift close per brand per class; a pre-cut-over order falls back to the legacy
pair with memo 'pre-FIFO order'). Update the COGS/4110 expectations in auditLedgerSales, booksLedger, auditLedgerFollowups, postingFailures (W2;
w3-till edits the same files in W3 for 1115).
""",
))

W2.append(dict(
id="w2-fa-capex", wave="W2", area="assets (CapEx side) + tax (CapEx WHT/input tax) + H25 prepaid engine", idx=12,
title="CapEx → register link, capitalisation request, WHT/input tax on CapEx, deposits, Quick buy, prepaid releases (CapEx + OpEx), cash seam",
summary="financePlanning/capexPosting.ts + routes.ts + companyRefs.ts, accounting/prepaidReleases.ts (source-agnostic), recordCapexPaymentFromCashTx.",
owns=["backend/src/modules/financePlanning/capexPosting.ts", "backend/src/modules/financePlanning/routes.ts", "backend/src/modules/financePlanning/companyRefs.ts",
      "backend/src/modules/accounting/prepaidReleases.ts (new)",
      "backend/tests/capexAssetLink.test.ts (new)", "backend/tests/prepaidReleases.test.ts (new)", "backend/tests/booksReconcile.test.ts (W2)",
      "backend/tests/moneyBigint.test.ts (fixed-asset section only, W2)"],
read=["plan_assets.json: summary 1-3, postings CAPITALISE / CAPEX INSTALMENT / CASH-REQUEST ADVANCE / PREPAID / DEPOSIT / ORPHAN, routes (CapEx), build_split C",
      "plan_tax.json: CONTRACT for the FA/CapEx area", "critic_assets_foodcost_0.json (all CapEx items: treatment, Quick buy bank only, capexPosting fixes, line lock, coverage, ids, H25 OpEx)",
      "critic_tax_people_0.json violation 6 (CapEx WHT via the one resolver; authority not code)"],
tasks=r"""
**capexPosting.ts:** delete capexLinkNote and the 'capex-line:' notes link — `findCapitalisedAssets` uses FixedAsset.capexLineId (status ≠ voided).
`capexAdvancesForLine(tenantId, lineId, db)` reads each payment's live entry through `liveRevision(…, tx)` (critic: liveRevisionsFor ignored the
tx — Quick buy's in-tx capitalisation must see the payment it just posted). `payableCodeForLine` (2012, or 2010 for legacy lines whose acquire
credited 2010) applies whether or not a live entry exists. TREATMENT_OF_CODE += {1360: deposit, 2012: capital}; the 'live money credit' is the
credit line that is NOT 2040. `capexTreatmentOf(line, projectType)`: **the line's treatment is the ONLY override** (remove the payment-level
`treatment` body field in routes.ts:~536 and opts.treatment); architect/design/project-consultant fees → capital on kitchen_buildout/refurb/
expansion/new_brand (H26); broker/legal → expense (6110); security/refundable deposit → deposit (1360); rent advance → prepaid (1310).
`syncCapexPaymentPosting` (syncSourcePosting 'capex.payment:<paymentId>', keepLiveDate when appropriate): WHT via **lib/withholding.ts
computeWithholding** with section = line.whtSection ?? supplier.defaultWhtSection ?? defaultSectionForCapex(treatment, projectType), base = gross −
input tax, exemption = the SUPPLIER's certificate (no per-payment exemption ref) + whtOverrideReason; fixed into whtCents/whtSection/whtRateBps/
filerStatus when first marked paid and recomputed from the fixed whtRateBps when the amount is edited; WHT never on deposits; 0 while the
company's withholding is off (opexAccounts' capex cases must keep passing). Input tax via `inputTaxCodeFor(line.inputTaxAuthority)` (never a free
code). Lines by treatment exactly as the FA plan (capital Dr 1340 / Cr money net / Cr 2040; after capitalisation Dr payableCodeForLine; prepaid Dr
1310; deposit Dr 1360 gross; expense Dr 6110). Guards 409 ADVANCE_APPLIED_TO_ASSET / PREPAID_RELEASING / DEPOSIT_RECLASSED; new prepaid payments
need coversFrom + coversMonths (422 PREPAID_TERM_REQUIRED) — legacy rows without coverage are flagged capex_prepaid_unscheduled by the worker.
`prepareCapitalisation(input, actor)` → fixedAssets/events.createRequest('capitalise') — EVERY capitalisation goes to the CEO (owner question
listed; today's ADMIN_ONLY control kept); the CEO's own preparation applies at once. `capexLedgerState` keyed on capexLineId, excludes
disposed/voided (M-04), adds disposedCents, whtCents, releasedCents, depositHeldCents. **Cash seam:** `recordCapexPaymentFromCashTx(tx, {
tenantId, lineId, spendLineId, amountCents, paidAt, creditCode, actorId })` creates a CapexPayment (source 'cash', paid) and posts
'capex.payment:<paymentId>' Dr 1340 / Cr creditCode (1011 for a box spend, 1355 for a cash-request settlement), no WHT; the project's company must
equal tenantId (else 422) and must exist (422 PROJECT_HAS_NO_COMPANY); the one-time guard is PettyCashSpendLine (tenantId, capexPaymentId)
(the caller writes it).
**accounting/prepaidReleases.ts — ONE source-agnostic engine (decision P7, critic H25-for-OpEx):** PrepaidRelease rows keyed (tenantId,
sourceType, sourceId, period); `releasePrepaidThrough(tenantId, throughPeriod, opts)` loops sources: 'capex_payment' (treatment prepaid: Dr 6010
(project.conceptId; null = shared) / Cr 1310) and 'opex_payment' (OpexPayment.treatment 'prepaid': Dr the category's expense code (line conceptId) /
Cr 1310 — the 1310 debit at payment is posted by w2-taxbooks); straight line over coversMonths from coversFrom (floor, remainder in the last
month); key 'prepaid.release:<sourceType>:<sourceId>:<YYYY-MM>' via syncSourcePosting with keepLiveDate + lateDatingFor (postedPeriod); never past
the source's live 1310 debit; refusal → flagPostingFailed (sourceType 'prepaid.release', entityType CapexPayment|OpexPayment, sourceId = payment id).
`releaseSourceThrough(sourceType, sourceId, period, opts)` for the reposter. `prepaidCloseChecks: CloseCheck[]` ('prepaid_release' block when a
completed month is unreleased; fix = run the release). Deposit return / reclass / orphan reverse functions live in capexPosting.ts.
**financePlanning/routes.ts:** line create/patch (supplierId → `assertSupplierOfCompany(project.tenantId)` 422; treatment locked after a payment
posts 409 TREATMENT_LOCKED; inputTaxCents + inputTaxAuthority; whtSection); **lock a capitalised or pending line** — PATCH line quantity /
unitCostCents / negotiatedCents / delivery & installed dates and the quote-winner route (~480-505) → 409 LINE_CAPITALISED (void and recapitalise);
payment create/patch (coversFrom/coversMonths, whtOverrideReason; no treatment field); DELETE line/project → 409 LINE_HAS_POSTINGS /
PROJECT_HAS_POSTINGS; capitalise route (~683-723) FA_WRITERS ['admin','owner','management','finance'] with body {classKey, inServiceAt?,
usefulLifeMonths?, salvageCents?, name?, locationId? (NEW field — assertLocationOfCompany), pool {typeKey, conceptId?}, costCents?} → 202 pending
(non-CEO) / 201 applied (CEO); errors per the FA plan. **Quick buy POST /finance/capex/quick-buy — BANK ONLY** (critic: no cash → 1010; cash
equipment comes only through the cash-request / petty-cash capex line): standing project per location (projectType 'equipment_only', isStanding,
the ACTIVE company); resolve EVERY client id to the active company (locationId, conceptId, supplierId, bankAccountId, pool conceptId → 422); one tx:
standing project → line (delivered today) → payment (posts) → capitalise request (applied for the CEO). Deposit-return, reclass-deposit (dry run
first), orphan reverse routes. GET /finance/capex(+/:id) add assetClasses, lookups.suppliers (system suppliers excluded), lookups.pools,
per-line capitalisation {assetIds, pendingEventId}, per-payment whtCents/releasedCents, books.disposedCents. Remove the ASSET_CATEGORIES imports
(use fixedAssets/classes.ts).
**companyRefs.ts:** `assertSupplierOfCompany(tenantId, supplierId)` (422 SUPPLIER_NOT_IN_COMPANY; a null project company → 422 PROJECT_HAS_NO_COMPANY).
""",
consumes=r"""
- w1-fa-engine: createRequest/applyEvent, ASSET_CLASS_DEFAULTS/getAssetClasses, postAcquisition, nextAssetTag, findOrCreatePool.
- w1-taxcore: computeWithholding, defaultSectionForCapex, inputTaxCodeFor.  w0: liveRevision(…, tx), keepLiveDate, lateDatingFor, PrepaidRelease model, CloseCheck.
""",
exposes=r"""
```ts
// financePlanning/capexPosting.ts
export function capexAdvancesForLine(tenantId: string, lineId: string, db: Db): Promise<Array<{ paymentId: string; advancedCents: number }>>
export function payableCodeForLine(tenantId: string, lineId: string, db: Db): Promise<'2012'|'2010'>
export function recordCapexPaymentFromCashTx(tx: Tx, a: { tenantId: string; lineId: string; spendLineId: string; amountCents: number;
  paidAt: Date; creditCode: '1011'|'1355'; actorId: string }): Promise<{ capexPaymentId: string; entryId: string }>
export function prepareCapitalisation(input: CapitaliseInput, actor: { id: string; role: string }): Promise<{ eventId: string; applied: boolean; assetIds: string[] }>
// accounting/prepaidReleases.ts
export function releasePrepaidThrough(tenantId: string, throughPeriod: string, o?: { postedBy?: string }): Promise<{ released: number; cents: number }>
export function releaseSourceThrough(sourceType: 'capex_payment'|'opex_payment', sourceId: string, throughPeriod: string, o?: { postedBy?: string }): Promise<void>
export const prepaidCloseChecks: CloseCheck[]
// financePlanning/companyRefs.ts
export function assertSupplierOfCompany(tenantId: string | null, supplierId: string): Promise<void>
```
""",
tests=r"""
`capexAssetLink` (editing notes no longer unlinks, spoofed notes don't link; pending/done capitalisation → 409; split N assets with sequential tags,
a pooled class → one layer; line/project delete with postings → 409; ADVANCE_APPLIED_TO_ASSET; LINE_CAPITALISED on PATCH and quote-winner; WHT
gross/net/2040 via the resolver, supplier exemption → 0, override reason; architect fee on a build-out → 1340 and capitalisable, broker → 6110;
deposit → 1360, return + forfeit; legacy 1310 deposit reclass; Quick buy one tx, bank only (cash → 400/422), rollback leaves nothing, every id of
another company → 422; capitalising when the delivery month is closed posts late and depreciation catches up; supplier of another company → 422;
the cash seam posts Dr 1340 / Cr 1011|1355 and refuses a project of another company; two companies on every CapEx route: B → 404, creates bind to the
active company). `prepaidReleases` (capex rent advance released monthly, idempotent, in the project's company, remainder in the last month,
PREPAID_RELEASING, PREPAID_TERM_REQUIRED on new rows; an OpEx prepaid payment (fixture: OpexPayment treatment 'prepaid' + its 1310 debit) releases to
its category code; a closed month posts late with postedPeriod; refusal flags 'prepaid.release'; close check blocks then clears). Update
booksReconcile (:507-556 capex link + classKey body + Cr 2012 + later payment Dr 2012 + legacy 2010; :520 rent advance needs coverage) and the
moneyBigint fixed-asset section (~605-617) rewritten through CapEx capitalisation (POST /accounting/fixed-assets now 422 USE_CAPEX). If w2-close's
period-close fixtures in booksReconcile trip a new block, apply the patch note w2-close sends (orchestrator relays) — you own the file in W2.
""",
))

W2.append(dict(
id="w2-taxbooks", wave="W2", area="tax (return) + people (return filters) + tax (OpEx input tax / WHT / prepaid)", idx=13,
title="Sales-tax return for H8-H13 + statutory filters; OpEx with vendor, input tax by authority, WHT, prepaid treatment",
summary="accounting/salesTaxReturn.ts, opex/posting.ts + routes.ts + categoryAccounts.ts.",
owns=["backend/src/modules/accounting/salesTaxReturn.ts", "backend/src/modules/opex/posting.ts", "backend/src/modules/opex/routes.ts",
      "backend/src/modules/opex/categoryAccounts.ts",
      "backend/tests/salesTaxReturnH8H13.test.ts (new)", "backend/tests/opexTaxWht.test.ts (new)", "backend/tests/opexPrepaid.test.ts (new)",
      "backend/tests/opexAccounts.test.ts",
      "backend/tests/taxPayments.test.ts (W2: sales-tax-return / payment cases; w1-taxcore had it in W1) — auditLedgerSales / auditLedgerFollowups also hit the return but are w2-ledger's this wave: send patch notes"],
read=["plan_tax.json: summary 1 (return), 2, 5, 6; shared_file_changes salesTaxReturn.ts; build_split T5",
      "plan_people.json: shared_file_changes salesTaxReturn.ts", "critic_tax_people_0.json: missing (supplyParts fallback, SUPPLY_ORDER, opex line picks, budget vs expense, vendor rule, vendor picker)",
      "critic_tax_people_1.json missing 'salesTaxReturn.ts follow-ups'", "critic_assets_foodcost_0.json missing 'H25 also applies to OpEx' + equipment guard on OpEx"],
tasks=r"""
**salesTaxReturn.ts:** import + re-export AUTHORITIES / AuthorityKey from accounting/taxAuthorities.ts (one table); ORDER_FOR_RETURN + deliveryFeeCents
/ deliveryFeeTaxCents; SupplyClass + 'delivery_charge' | 'deposit_forfeit' and SUPPLY_ORDER lists both; supplyParts gives the fee its own part
(value fee, tax feeTax, rate taxRatePct) and shares taxCents − feeTax over the item parts — including the 'no taxed item part' fallback (~400-405);
rateBreakdown reads 'reservation.deposit_capture:' entries dated in the period carrying an output-tax credit (supply deposit_forfeit, tender card,
authority from the account via the reclass target, value from the revenue credit); byAuthority + withheldByCustomersCents (Dr − Cr on 1335 from
'receivable.st_withheld:' / 'receivable.st_withheld.reversal:' entries in the period, mapped via ReceivablePayment.taxAuthority),
customerWithheldSetOffForPeriodCents, netAfterWithheldCents = output − input − withheld (top-level netPayable/carryForward use it); taxable sales
include 4110 per conceptId-tagged line (deliveryFeesCents, per-brand deliveryFeeCents); taxPaymentsFor maps customerWithheldSetOffCents; notes
(input-tax note points at 'Tax charged by' on bills and OpEx; delivery; deposits; withheld). (PP) the return's payments list keeps only AUTHORITIES +
WITHHOLDING keys (statutory challans filtered; GET …/payments labels or filters statutory rows); the WITHHOLDING 'wht' text no longer says '(and
salaries)'; the one-time 'statutory.reclass:' entry is excluded from 'withheld in the period'. CSV export carries the new rows.
**opex/posting.ts:** syncOpexPaymentPosting builds Dr <expense code> (actual + wht − inputTax, conceptId) / Dr inputTaxCodeFor(authority) inputTax /
Cr moneyAccountCode actual / Cr 2040 wht through syncSourcePosting; pick the EXPENSE debit and the MONEY credit explicitly (never by line order —
critic); validate balance; inputTax without authority → 422 INPUT_TAX_AUTHORITY_REQUIRED; payroll categories still skipped. **Prepaid treatment
(H25):** OpexPayment.treatment 'prepaid' (coverage required: coversFrom + coversMonths → 422 PREPAID_TERM_REQUIRED) posts Dr 1310 instead of the
expense; the monthly release is w2-fa-capex's prepaidReleases engine (source 'opex_payment'); refundable deposits are NOT booked through OpEx
(422 DEPOSIT_USE_CAPEX 'record refundable deposits in CapEx with treatment deposit').
**opex/routes.ts:** line create/patch: supplierId (the Supplier's tenantId must equal the CATEGORY's company — 422 SUPPLIER_NOT_IN_COMPANY; supplierId
wins over the free-text vendor, which is filled from the supplier name and kept for legacy lines), whtSection, inputTaxAuthority; payment
create/patch: invoiceCents, inputTaxCents, inputTaxAuthority, whtSection override, whtOverrideCents + whtOverrideReason, treatment, coversFrom,
coversMonths; computeWithholding(base = invoice − inputTax) fixes whtCents / whtRateBps / filerStatus and actualCents = invoice − WHT; errors 422
INVOICE_AMOUNT_REQUIRED / VENDOR_REQUIRED_FOR_WHT / INPUT_TAX_TOO_LARGE / INPUT_TAX_AUTHORITY_REQUIRED / WHT_OVERRIDE_REASON_REQUIRED / PERIOD_LOCKED.
**Equipment guard:** the payment's line name/notes through `assertNotEquipmentLine` → 422 USE_CAPEX (override admin/finance + flag
'equipment_override'). GET /opex/wht-quote?lineId&invoiceCents&inputTaxCents&section? (OPEX_GUARD; line scoped write → 404) → {whtCents, rateBps,
section, filerStatus, exempt, needsAtlCheck, cashCents, expenseCents}. **No GET /opex/vendors** — the page uses GET
/procurement/suppliers?view=picker&categoryId (w2-ap). post-unposted dry run reports the new reasons. Budget / variance / actuals / cashflow
responses compare the EXPENSE (actual + wht − inputTax), not the cash.
""",
consumes=r"""
- w1-taxcore: AUTHORITIES, inputTaxCodeFor, computeWithholding, customerWithheldAvailable. w1-fa-engine: assertNotEquipmentLine. w0: OpexLine/OpexPayment columns.
""",
exposes=r"""
```ts
// accounting/salesTaxReturn.ts — same exports; new fields on the return: byAuthority[].withheldByCustomersCents, customerWithheldSetOffForPeriodCents,
// netAfterWithheldCents; byRate supply classes 'delivery_charge' | 'deposit_forfeit'; deliveryFeesCents; taxableValueByConceptCents[].deliveryFeeCents
// opex/posting.ts
export function syncOpexPaymentPosting(paymentId: string, o?: { tx?: Tx; postedBy?: string }): Promise<SyncResult>
```
""",
tests=r"""
`salesTaxReturnH8H13` (delivery_charge and deposit_forfeit rows; withheldByCustomers nets SRB; B's 1335 absent from A; statutory payments not in the
return; reclass not in 'withheld'; SUPPLY_ORDER sort; fallback uses taxCents − feeTax). `opexTaxWht` (SRB-taxed security invoice 110,000 with
10,000 SRB input, s.153(1)(b) filer 9% → WHT 9,000, cash 101,000; entry Dr 6xxx 100,000 / Dr 1322 10,000 / Cr bank 101,000 / Cr 2040 9,000; edit
reposts @2; rent s.155; exempt vendor → 0; switch off → 0; section without vendor → 422; payroll category skipped; equipment line → 422 USE_CAPEX;
budget uses the expense; two companies: B's supplier on A's line → 422, B patching A's payment → 404, A's WHT in A's 2040 only, wht-quote B → 404).
`opexPrepaid` (prepaid payment posts Dr 1310 and needs coverage; deposit → 422). Update opexAccounts (capex cases unchanged).
""",
))

W2.append(dict(
id="w2-oa-recv", wave="W2", area="onaccount (receivables) + tax (H13 customer withholding)", idx=14,
title="On-account clients, cards, exposure, statements, bad-debt write-offs; sales tax withheld by clients",
summary="receivables/routes.ts, onAccount.ts (exposure / chargeable / charge / charge refund), customerAccounts.ts, statements.ts, writeOffs.ts, onAccountDaily worker.",
owns=["backend/src/modules/receivables/routes.ts", "backend/src/modules/receivables/onAccount.ts (new)", "backend/src/modules/receivables/customerAccounts.ts (new)",
      "backend/src/modules/receivables/statements.ts (new)", "backend/src/modules/receivables/writeOffs.ts (new)", "backend/src/workers/onAccountDaily.ts (new)",
      "backend/tests/onAccountClients.test.ts (new)", "backend/tests/onAccountExposure.test.ts (new)", "backend/tests/onAccountStatements.test.ts (new)",
      "backend/tests/badDebtWriteOff.test.ts (new)", "backend/tests/receivablesSalesTaxWithheld.test.ts (new)", "backend/tests/receivablesCredit.test.ts"],
read=["plan_onaccount.json: summary, schema, postings (statement, payment, write-off, recovery), routes (customer-accounts, receivables, write-offs), build_split B (+ A's onAccount.ts)",
      "plan_tax.json: summary 6, routes (receivables withholding), shared_file_changes receivables/routes.ts",
      "critic_cash_delivery_onaccount_2.json: violations 1, 2; missing (recovery reversal, statements claim booked charges only, statement H13 authority, capability flags, fnb_manager narrowing, revoked-card dedupe, platform SMTP)",
      "critic_tax_people_0.json violation 9 ('st_withheld')"],
tasks=r"""
**receivables/routes.ts:** EXPORT the private helpers (lockInvoice, restatus, nextNumber (prefix AR-ST- for statements), withNumberRetry,
assertLiveInvoice) instead of moving them (critic — less churn); balanceOf = total − paid − credited − withheld − writtenOff (0 for void / credit
notes); statusFor 'written_off' when writtenOff > 0 and balance ≤ 0; LIVE_KINDS = ['invoice','statement'] in list/aging; assertLiveInvoice accepts
statements; credit-notes refuse statements (409 STATEMENT_CREDIT_AT_TILL 'refund the bill at the till so the fiscal return files'); a statement
voids only with nothing received/withheld/credited/written off and RELEASES its charges (statementInvoiceId = null) with no reversal entry; the
invoice void claim also requires writtenOffCents 0; POST / accepts customerAccountId (same company as the active company else 422
CLIENT_NOT_IN_COMPANY; copies name/NTN); register writeOffs as a child plugin; header comment (G12/G14/G13 no longer 'not here yet').
**H13 (TX):** the withholding route body gains kind 'income_tax' (default, today's) | 'sales_tax' → ReceivablePayment method **'st_withheld'**
(never 'stwh') + taxAuthority; authority = the output account the invoice's 'receivable.issue' entry credited; for a STATEMENT (no issue entry) the
authority comes from its charges' brands via outputTaxCodeFor — 422 STATEMENT_MULTI_AUTHORITY when they span two; caps 422 NO_OUTPUT_TAX / 409
OVER_SALES_TAX_WITHHOLDING (> tax − credited tax − live st_withheld rows) / 409 OVER_WITHHOLDING; posts 'receivable.st_withheld:<paymentId>' Dr 1335 /
Cr 1110 (1110 line conceptId = invoice.conceptId) in the invoice-locked tx; `paymentKind` returns 'withholding' for 'wht' and 'st_withheld';
`sourceOfPayment(p)`; the reverse route reverses 'receivable.st_withheld'. Pre-check 1335 with assertTemplateAccounts (422, nothing saved).
**Recovery reversal (critic):** reversing a payment that carries writeOffId also decrements ReceivableWriteOff.recoveredCents and restores the
invoice's writtenOffCents in the same tx.
**receivables/onAccount.ts (used by the till in W3):** `CHARGE_ERRORS`; `lockAccountTx(tx, id)` (SELECT … FOR UPDATE); `exposureOfTx(db, accountId)` →
{unbilledCents (Σ amount − refunded of unbilled charges), invoicesDueCents (Σ max(0, balanceOf) of linked open/partial invoice + statement rows),
exposureCents, overdue {invoiceId, number, dueDate, balanceCents} | null (dueDate + overdueGraceDays < today PKT)}; `assertChargeableTx(tx, account,
{ conceptId, billCents, reference })` (409 ON_ACCOUNT_NOT_ACTIVE / ON_ACCOUNT_BRAND_NOT_ALLOWED / ON_ACCOUNT_OVERDUE {statementNumber, dueDate,
balanceCents} / ON_ACCOUNT_OVER_LIMIT {limitCents, exposureCents, availableCents, billCents}; 422 ON_ACCOUNT_REFERENCE_REQUIRED) — BLOCK, not warn
(owner Q3 default); `recordChargeTx(tx, {...})` (CustomerAccountCharge + card.lastUsedAt); `applyChargeRefundTx(tx, { orderId, refundPaymentId,
amountCents })` (refundedCents capped; when billed: lockInvoice + statement creditedCents + restatus); `flagRevokedCardUse(tenantId, cardId)` (one
open 'on_account_card_revoked_used' per card per day — critic dedupe). No import from pos/service (no cycle). Lock order order → client account →
invoice (header comment).
**customerAccounts.ts** (wave Z registers at /accounting/customer-accounts; '/accounting' gate): list/create/get/patch per the OA plan routes;
create binds to the ACTIVE company, conceptIds through assertConceptOwned 'create' (foreign → 422); status pending unless the actor is admin (then
active + approvedBy); a limit increase → requestedCreditLimitCents (CEO applies), a decrease at once; suspend (any editor + reason), reactivate
(admin only, 403), close (exposure 0 else 409 CLIENT_HAS_BALANCE); approve/reject (ADMIN_ONLY); cards issue/rotate/revoke via lib/onAccountCard.ts —
the code is returned ONCE and never stored, logged or audited (audit holds the hint); charges list; tie-out (1110 GL vs open invoices + statements
+ booked unbilled charges; unbilled not-yet-booked shown apart); remind (1/client/day, 409 REMINDED_TODAY); number OA-0001 under
pg_advisory_xact_lock per company. **Client detail (NTN, CNIC, limits) readers = ['admin','owner','management','finance']** (fnb_manager excluded —
critic); the list for FINANCIALS_VIEWERS shows names/status only to fnb_manager. Views return capability flags (canApprove, canEdit, canIssueCards)
so the UI keeps no role lists.
**statements.ts:** issueStatementTx (lockAccountTx then claim unbilled charges with chargedAt ≤ periodTo end of PKT day **whose sale is BOOKED** —
the home drawer's 'shift.close:' entry posted, or 'order.complete:' posted for a non-till bill; others listed 'not billed yet' — critic), creates
ReceivableInvoice kind 'statement' (AR-ST-YYYY-NNNN, withNumberRetry, due = issue + termsDays, amount/tax net of refunds, customerAccountId,
periodFrom/To) with NO ledger entry; bulk issue (active company; returns created/skipped; 409 NOTHING_TO_BILL single); HTML render (bills with date,
order ref (orderRefOf), brand, card, reference, FiscalDocument.fiscalNumber (kind sale), previous balance, total due, due date, company bank details,
'Statement — not a tax invoice'); send via lib/notify sendEmail (the ONE platform SMTP; set a per-company reply-to = the company's first brand email,
documented) → 422 NO_EMAIL.
**writeOffs.ts:** request (WRITE_OFF_REQUESTERS admin/owner/management/finance; amount ≤ balanceOf; reason 10-500; 1-5 evidence files via
lib/evidenceFile decodeEvidenceFile(allowPdf, 3 MB); bodyLimit 20 MB; 409 WRITE_OFF_OPEN / WRITE_OFF_EXCEEDS_BALANCE; 400 EVIDENCE_REQUIRED /
BAD_FILE; kind invoice|statement only); list; evidence download (sendEvidence); **approve (ADMIN_ONLY) — separation of duties through
lib/separation-of-duties.ts assertNotSelfApproval (the CEO is exempt, decision 27); a request the CEO raises applies at once**; approve tx:
lockAccountTx (when customerAccountId) → lockInvoice → claim requested→approved → amount ≤ balance (409) → writtenOffCents += amount → post
'receivable.write_off:<id>' Dr 6160 (split per conceptId pro rata to a statement's charges' net; the invoice's conceptId otherwise) / Cr 1110 (full
amount incl. tax; pre-check 6160 → 422 ACCOUNT_NOT_FOUND, nothing saved; closed period → 422) → restatus → suspend the client (statusReason
'bad_debt_written_off'); reject (note); cancel; recover {amountCents ≤ amount − recovered, receivedAt, method, bankAccountId?, reference?}:
'receivable.write_off_recovery:<paymentId>' Dr 1110 / Cr 6160 + 'receivable.payment:<paymentId>' Dr moneyAccountCode / Cr 1110 in ONE tx with the
counters (409 OVER_RECOVERY). Audit in the invoice's company.
**workers/onAccountDaily.ts** (09:20 PKT per active company; wave Z starts it): one 'on_account_overdue' flag per overdue statement/invoice
(high after 30 days; resolved when balance ≤ 0); one 'on_account_unbilled' flag per client with booked charges > 35 days unbilled.
""",
consumes=r"""
- w0: CustomerAccount* models, ReceivableWriteOff*, ReceivableInvoice/Payment columns, lib/onAccountCard.ts, lib/evidenceFile.ts, ACCT.BAD_DEBTS /
  ST_WITHHELD_BY_CUSTOMERS, assertTemplateAccounts. w1-taxcore: taxAuthorities (outputTaxCodeFor, authorityOfOutputCode). existing: assertNotSelfApproval.
""",
exposes=r"""
```ts
// receivables/onAccount.ts
export const CHARGE_ERRORS: Record<string, { status: number; message: string }>
export function lockAccountTx(tx: Tx, accountId: string): Promise<CustomerAccount>
export function exposureOfTx(db: Db, accountId: string): Promise<{ unbilledCents: number; invoicesDueCents: number; exposureCents: number;
  overdue: { invoiceId: string; number: string; dueDate: Date; balanceCents: number } | null }>
export function assertChargeableTx(tx: Tx, account: CustomerAccount, a: { conceptId: string; billCents: number; reference?: string | null }): Promise<void>
export function recordChargeTx(tx: Tx, a: { tenantId: string; accountId: string; cardId: string | null; orderId: string; paymentId: string;
  conceptId: string; shiftId: string | null; amountCents: number; taxCents: number; reference: string | null; chargedById: string }): Promise<CustomerAccountCharge>
export function applyChargeRefundTx(tx: Tx, a: { orderId: string; refundPaymentId: string; amountCents: number }): Promise<void>
export function flagRevokedCardUse(tenantId: string, cardId: string): Promise<void>
// receivables/routes.ts (now exported)
export { lockInvoice, restatus, nextNumber, withNumberRetry, assertLiveInvoice, balanceOf, totalOf, statusFor, paymentKind }
```
""",
tests=r"""
Two companies throughout: B → 404 on every A client/card/statement/write-off route; create binds to the active company; foreign brand in conceptIds
→ 422. `onAccountClients` (pending until the CEO approves; limit increase pending, decrease at once; reactivate admin-only; card code returned once,
DB holds hash + hint only, never in the audit; rotate kills the old code; fnb_manager can't read NTN/limits; capability flags). `onAccountExposure`
(exposure math incl. refunds; overdue after grace; assertChargeableTx refusals incl. two concurrent charges near the limit (one 409) via lockAccountTx;
applyChargeRefundTx on an unbilled and on a billed charge). `onAccountStatements` (claims exactly the BOOKED unbilled charges up to periodTo — an
open drawer's charge is listed 'not billed yet'; posts NO entry; payment Dr bank / Cr 1110; credit note → 409; void releases charges; bulk skips
empty clients; HTML lists fiscal numbers). `badDebtWriteOff` (evidence required; one open per invoice; non-admin approve → 403; finance requester
≠ CEO approver passes; a CEO-raised request applies at once; Dr 6160 / Cr 1110 in the invoice's company with the per-brand split for a statement;
status written_off, out of aging, client suspended; amount over balance after a later payment → 409; locked period → 422 nothing saved; recovery
reinstates + pays; reversing the recovery payment restores writtenOff and recoveredCents). `receivablesSalesTaxWithheld` (100,000 + 16,000 SRB
invoice, client withholds 3,200 → Dr 1335 / Cr 1110, balance down; over-cap → 409; reverse works; statement authority from its brands, two
authorities → 422; B → 404). receivablesCredit still passes with writtenOffCents in balanceOf.
""",
))

W2.append(dict(
id="w2-dlv-cod", wave="W2", area="delivery (COD custody) + tax/onaccount report rows", idx=15,
title="COD with the rider (H5): one COD status definition, rider debt (own and fleet riders), custody worker, reports",
summary="accounting/codPosting.ts, lib/cod.ts, reconciliation/codRoutes.ts, pos/routes.ts, workers/codCustody.ts, reports/service.ts.",
owns=["backend/src/modules/accounting/codPosting.ts (new)", "backend/src/lib/cod.ts (new)", "backend/src/modules/reconciliation/codRoutes.ts (w0 stub → fill)",
      "backend/src/modules/pos/routes.ts", "backend/src/workers/codCustody.ts (new)", "backend/src/modules/reports/service.ts",
      "backend/tests/codRiderDebt.test.ts (new)", "backend/tests/codCustody.test.ts (new)", "backend/tests/raastReports.test.ts",
      "backend/tests/resimWallet.test.ts (W2: salesByTender / cod-due cases only) — booksReconcile (w2-fa-capex) and cashControls (w2-cash-ledger) also hit salesByTender / cod-due but belong to those agents this wave: send patch notes"],
read=["plan_delivery.json: summary (COD), postings (rider debt, recovered), routes (cod-due, reconciliation/cod), build_split D",
      "critic_cash_delivery_onaccount_0.json: violation 9 (one lib/cod.ts), missing (legacy COD path, IC for fleet riders, 1351 reserved), code_facts (pickup rows, reversal key)",
      "plan_tax.json / plan_onaccount.json shared_file_changes reports/service.ts"],
tasks=r"""
**lib/cod.ts — ONE definition** read by /pos/cod-due, /reconciliation/cod, salesByTender and the custody worker: `COD_PAY_IN_HOURS = 12`,
`codDueWhere(scope)`, `codStatusOf(payment, order)` → 'with_rider' | 'overdue' | 'rider_owes' | **'at_counter'** (pickup/takeout cash orders — e.g.
WhatsApp 'pay at the counter' — never get a rider status, a rider debt or a rider-overdue flag; rider statuses only for fulfilmentType 'delivery'
with a riderId).
**accounting/codPosting.ts:** `bookCodRiderDebt({ paymentId, actorId, reason, legacy? })` in $transaction + lockOrderTx with the claim on
Payment.codRiderDebtAt IS NULL; preconditions: cash, pending, amount > 0, source ≠ pos, order completed, delivery with a rider, delivered with the
code (deliveryOtpVerifiedAt set) and 'order.complete:<orderId>' present in that company (409 COD_SALE_NOT_BOOKED). **Own rider** (rider.tenantId =
order company): 'cod.rider_debt:<paymentId>' Dr 1351 / Cr 1010 (conceptId both; memo names order ref, full order id and rider), codRiderDebtEntryId.
**Fleet rider of another company (H30 contract):** an IntercompanyTransfer via `postSystemTransferTx` (serviceClient tx; source 'cod', sourceRef
'cod:<paymentId>', debtor = the PROVIDER (Dr 1351 in its books), creditor = the CLIENT (Cr 1010 in its books), entry date now; codRiderDebtTransferId)
— the caller must belong to BOTH companies (`isMemberOfBoth`, else 403 NOT_IN_BOTH_COMPANIES 'a finance user of both companies books a fleet rider's
COD'). **Legacy path (critic):** COD delivered by the old manager override (deliveryOtpVerifiedAt NULL, order completed before this release) may be
booked with `legacy: true` + reason by admin/finance only — audited + flagException 'cod_cash_overdue' note. A replay → 200 {alreadyBooked: true}.
`reverseCodRiderDebtTx(tx, { paymentId, tenantId })` (own rider: reverseJournalEntry → key **'cod.rider_debt.reversal:<paymentId>'** Dr 1010 / Cr 1351 —
the real reversal shape), `reverseCodRiderDebtAfterCommit(paymentId)` (fleet rider: reverseSystemTransfer on serviceClient), and
`reverseCodRiderDebt(paymentId)` (for the reposter; nothingToPost when the debt entry/transfer is missing or already reversed). Constant
RIDER_COD_ACCOUNT = ACCT.RIDER_COD_RECEIVABLE with TODO(H5) note. w3-till wires the calls into settlePayment.
**reconciliation/codRoutes.ts** (mounted at /reconciliation/cod by w0): GET /?status=with_rider|overdue|rider_owes (FINANCE_TEAM + reconciliation
module; read scope via order.concept); POST /:paymentId/rider-debt {reason 5..500, legacy?} (admin, owner, management, finance; write scope → 404;
errors 422 NOT_CASH_ON_DELIVERY, 409 COD_ALREADY_PAID / COD_NOT_DELIVERED_WITH_CODE / COD_SALE_NOT_BOOKED, 422 NO_RIDER, 409 PERIOD_LOCKED).
**pos/routes.ts:** GET /cod-due imports COD_PAY_IN_HOURS + codStatusOf; rows add riderOwes {at, byName} | null and status; **the payout category zod
enum and GET /pos/payout-categories offer only PAYOUT_CATEGORIES of kind 'expense'** (the cogs keys are petty-cash only — CA critic; w2-cash-ledger adds
the `kind` field in expenseCategories.ts this wave: code against `c.kind !== 'cogs'` so it compiles before and after).
**workers/codCustody.ts** (every 30 min, loop per company; wave Z starts it): flagException 'cod_cash_overdue' per delivery COD Payment past
COD_PAY_IN_HOURS with no rider debt and no open flag; 'delivery_on_road_overdue' per delivery order picked up > 3 h ago, not delivered, not returned
(critic: nobody logged the food back); de-duplicated (kindsMatching); export runCodCustodyOnce.
**reports/service.ts (merged):** salesByTender 'cod_not_collected' → 'cod_rider_owes' (from Payment.codRiderDebtAt via codStatusOf); rename
cod.notCollected* → cod.riderOwes*; (TX) SALE_FIELDS + deliveryFeeCents, SalesTotals.deliveryFees (net of the refund share via refundShareOf), net
unchanged; (OA) TENDER_ORDER inserts 'on_account' after 'raast' (labels from tenderLabel).
""",
consumes=r"""
- w1-ic: postSystemTransferTx, reverseSystemTransfer, isMemberOfBoth (lib/companyPairs.ts). w0: Payment cod columns, ACCT.RIDER_COD_RECEIVABLE, reverseJournalEntry.
""",
exposes=r"""
```ts
// lib/cod.ts
export const COD_PAY_IN_HOURS = 12
export type CodStatus = 'with_rider'|'overdue'|'rider_owes'|'at_counter'
export function codDueWhere(scope: Prisma.ConceptWhereInput): Prisma.PaymentWhereInput
export function codStatusOf(p: { codRiderDebtAt: Date | null; createdAt: Date }, o: { fulfilmentType: string; riderId: string | null; completedAt: Date | null }, now?: Date): CodStatus
// accounting/codPosting.ts
export function bookCodRiderDebt(a: { paymentId: string; actor: { id: string; role: string; memberTenantIds: string[] }; reason: string; legacy?: boolean }): Promise<{ ok: true; entryId?: string; transferId?: string; alreadyBooked?: boolean }>
export function reverseCodRiderDebtTx(tx: Tx, a: { paymentId: string; tenantId: string }): Promise<{ reversed: boolean; needsAfterCommit: boolean }>
export function reverseCodRiderDebtAfterCommit(paymentId: string): Promise<void>
export function reverseCodRiderDebt(paymentId: string): Promise<{ reversed: boolean }>
export function runCodCustodyOnce(now?: Date): Promise<void>
```
""",
tests=r"""
`codRiderDebt` (two companies: B finance → 404 on A's payment; own rider posts Dr 1351/Cr 1010 in A under 'cod.rider_debt:<paymentId>', replay no-op;
refuses a POS order, a paid row, a pickup row (at_counter), an order delivered without a code, a missing order.complete, cashier/foh roles (403), a
role without the reconciliation module (403); legacy:true by finance with reason passes, by management → 403; fleet rider of B on A's order: a
finance user of A only → 403, of A and B → an IntercompanyTransfer source 'cod' in both books; reverseCodRiderDebtTx posts
'cod.rider_debt.reversal:<paymentId>'; salesByTender shows the rider-owes row, deliveryFees and on_account ordering). `codCustody` (flags per
company only for its own overdue delivery COD; no duplicate on re-run; pickup cash never flagged; on-road overdue flag). Update `raastReports`
(cod.notCollected* → cod.riderOwes*) and any cod-due / salesByTender suite.
""",
))

W2.append(dict(
id="w2-cash-ledger", wave="W2", area="cash (petty cash in the ledger) + delivery (trustops OTP route)", idx=16,
title="Petty cash on the books: 1011, sources incl. Garibsons/safe/bank/till, returns, spends with expense lines, counts, history backfill, tie-out",
summary="accounting/pettyCashPosting.ts, trustops/pettyCash.ts + routes.ts, expenseCategories.ts, pos/drawerToBox.ts, reconciliation/pettyCashBackfillRoutes.ts, petty-cash admin page + shared editors.",
owns=["backend/src/modules/accounting/pettyCashPosting.ts (new)", "backend/src/modules/trustops/pettyCash.ts (W2)", "backend/src/modules/trustops/routes.ts",
      "backend/src/modules/accounting/expenseCategories.ts", "backend/src/modules/pos/drawerToBox.ts (new)",
      "backend/src/modules/reconciliation/pettyCashBackfillRoutes.ts (w0 stub → fill)",
      "frontend/admin/src/app/finance/petty-cash/page.tsx", "frontend/admin/src/app/finance/petty-cash/TopUpModal.tsx (new)",
      "frontend/admin/src/app/finance/petty-cash/SpendModal.tsx (new)", "frontend/admin/src/app/finance/petty-cash/ReturnModal.tsx (new)",
      "frontend/admin/src/app/finance/petty-cash/TieOutBanner.tsx (new)", "frontend/admin/src/components/finance/SpendLinesEditor.tsx (new, W2)",
      "frontend/admin/src/components/finance/ReceiptUploader.tsx (new)", "frontend/admin/src/lib/photoPrep.ts (new)",
      "backend/tests/pettyCashLedger.test.ts (new)", "backend/tests/cashControls.test.ts (W2)", "backend/tests/sepTrustops.test.ts",
      "backend/tests/wave3Finance.test.ts (W2: charts carry 1011)", "backend/tests/integrationPass1.test.ts (W2: top-up source only)"],
read=["plan_cash.json: summary 1, 3, 4; postings (pettycash.*), routes (petty-cash), shared_file_changes, build_split A + C",
      "critic_cash_delivery_onaccount_1.json: violations 1 (till drop), 2 (stock contract — W3 does stock), 6 (locationId), 7 (backfill under /reconciliation); missing (custodian boxes, lock box in backfill, bytes, re-stamp)",
      "plan_delivery.json: removes 'GET /trustops/orders/:id/otp', routes verify-otp message"],
tasks=r"""
**accounting/pettyCashPosting.ts — the ONE poster:** `postPettyCashMovementTx(tx, movementId, opts?)` builds the entry purely from the stored movement
+ box + spend lines (live path and history backfill book exactly the same thing); tenantId = box.tenantId (a box with no company → 422
BOX_HAS_NO_COMPANY); sourceType 'pettycash.<type>' with sourceId = movementId — EXCEPT the till top-up (below); skips 'transfer'; stamps
journalEntryId (re-stamp after any syncSourcePosting repost — critic). Lines:
- top-up: Dr 1011 / Cr movement.accountCode — **garibsons → 2210 (H1, ONE constant FUNDING_ACCOUNT.garibsons = ACCT.DUE_TO_GARIBSONS)**; safe → 1010;
  bank → moneyAccountCode(tx, box.tenantId, { method:'bank', bankAccountId }) (live, linked, same company); cash_request change returned → 1355
  (memo 'CV-xxxxx change returned' — used from W3); opening (new box) → per chosen source.
- **till (critic — never a 'drop', never via 1010):** the top-up tx calls `recordDrawerToBoxTx` (pos/drawerToBox.ts, below) which writes a
  'payout'-type CashMovement on an open shift of the box's company (category 'petty_cash_topup', no PIN, no pos.payout entry) and the entry is
  'pettycash.till_topup:<cashMovementId>' Dr 1011 / Cr 1015 (keyed on the CashMovement id, so the shift close's existing ':<movementId>' skip rule
  books nothing for it; drawer expectation and the Z-report count it as a payout; the deposit expectation is unaffected).
- return (new movement type 'return'): Dr 1010 | bank code | 2210 / Cr 1011.
- spend: expense lines Dr each line.accountCode (6xxx) with conceptId = line ?? box.conceptId / Cr 1011 (5010/5020/5030 only on HISTORY-backfill
  picks — see expenseCategories.ts);
  bill-paying spend keeps procurement createPaymentTx (Dr 2010 / Cr 1010) and adds Dr 1010 / Cr 1011; a cash-request PAY (nature 'advance', used
  from W3) Dr 1355 / Cr 1011 memo 'CV-xxxxx advance to <holder>'. Stock and capex line kinds are accepted by the schema but answer 422
  STOCK_LINES_UNAVAILABLE / CAPEX_LINES_UNAVAILABLE in W2 (w3-cash-requests adds them in W3).
- reconcile (count): short Dr 8010 / Cr 1011, over Dr 1011 / Cr 8010, zero → nothing.
`resolveSpendLinesTx(tx, tenantId, inputs, { allowExplicit })` (expense lines; resolveSpendAccount; items/concepts/locations resolved to the company
→ 422 CONCEPT_NOT_IN_COMPANY / LOCATION_NOT_IN_COMPANY (critic); each expense line's description through assertNotEquipmentLine → 422 USE_CAPEX,
override keepers admin/finance + flag 'equipment_override'). `postCashVoucherSettlementTx` and `postCashVoucherConversionTx` are added by W3.
`pettyCashTieOut(tenantIds)` (Σ box floats vs 1011; open advances vs 1355; unbooked movements) via ledgerBalancesByCode.
`backfillPettyCash({ tenantIds, dryRun, postedBy, historicTopupSource, picks })` — placeAndPost (owner decision 6), withBackfillSlot; the box
opening = float − Σ movements computed INSIDE the posting tx with the box row locked (FOR UPDATE — critic); historic top-up with no source →
the per-company pick (default safe/1010; show the resulting 1010 balance and warn when it goes negative since the owner says GS Foods holds no
cash — Garibsons/2210 is the alternative); old spends mapped by PAYOUT key or expenseCodeForCategoryName else needs_category; voucher-linked
spends → advance Dr 1355 / Cr 1011 (the request stays 'disbursed', receipts due); reconcile → 8010; paired transfers → no entry; one-sided legacy
transfers → needs_review; picks persisted on the movement BEFORE posting; outcomes per the cash plan; re-runs find nothing.
**trustops/pettyCash.ts:** writeMovementTx loads the box (tenantId required), stamps tenantId/source/accountCode/bankAccountId/shiftId/cashMovementId/
cashVoucherId/conceptId/transferRef, creates spend lines, then postPettyCashMovementTx; writers extended (recordPettyCashTopupTx source/bankAccountId
/shiftId/cashVoucherId; recordPettyCashSpendTx nature 'expense'|'advance'|'bill', lines, cashVoucherId, conceptId; recordPettyCashCountTx → 8010;
recordPettyCashTransferTx stores transferRef, still no posting); new `recordPettyCashReturnTx`; float changes stay relative + conditional
(`floatCents >= amount`); header rewritten (removes TODO(C1/C2/C5)). recordPettyCashSpendTx stays THE one way money leaves a box.
**pos/drawerToBox.ts:** `recordDrawerToBoxTx(tx, { shiftId, tenantId, amountCents, reason, createdById })` → { cashMovementId }: assertShiftOf
(tenantId, shiftId, open) (422 SHIFT_NOT_IN_COMPANY), drawerExpectation ≥ amount (422 INSUFFICIENT_DRAWER_CASH), CashMovement {type 'payout',
category 'petty_cash_topup', …} in the tx. (A dedicated writer for this one move; pos/service.ts recordCashMovement is untouched.)
**expenseCategories.ts:** PAYOUT_CATEGORIES stays ONE list with `kind`: the existing 8 'expense'; + office 6170, courier 6175, staff_welfare 6180, phone
6022 (expense); kitchen_food 5010, kitchen_drinks 5020, kitchen_packaging 5030 (kind 'cogs' — **history backfill ONLY** (verifier fix: decision
  P6 + the owner's FIFO rule — food, drinks and packaging bought with cash TODAY come in as STOCK lines on a settled receipt (W3), and unmeasured
  items use InventoryItem.issueOnReceipt; a live spend / settlement line with a 'cogs' key → 422 USE_STOCK_LINE 'Food, drinks and packaging bought
  with cash are booked as stock lines so the food-cost report sees them'); GET /trustops/petty-cash/categories lists kind 'expense' only; the backfill
  picks may use the 'cogs' keys for pre-FIFO spends; the till filters them out too, w2-dlv-cod);
`resolveSpendAccount(db, tenantId, { categoryKey?, accountCode? }, { allowExplicit })` (key → its code, must be an active account of the company's
chart (422 ACCOUNT_NOT_FOUND); explicit code only when allowExplicit, through assertExpenseCode (6xxx); neither → 400 SPEND_CATEGORY_REQUIRED); header.
(Decision for CA critic 14, no code change: tip-pool payouts are never paid from a petty-cash box — leave tipPools PAYOUT_CASH_CODES without
1011, since recordPettyCashSpendTx stays THE one way money leaves a box; taxPayments.isMoney knowing 1011 is w1-taxcore's.)
**trustops/routes.ts (CA + DL):** every petty-cash route of the cash plan: box create (openingSource garibsons default | safe | bank | till), POST
/movements (top-up keeper or custodian ('till' keeper only); spend keeper or custodian (403 SPEND_NOT_ALLOWED); bodies/errors per the plan;
receiptIds ≤ 5; PHOTO_REQUIRED above OperationsConfig.photoRequiredAboveCents), POST /returns, POST /transfers, POST /boxes/:id/reconcile, POST
/receipts (custodian or keeper; lib/evidenceFile; bodyLimit 6 MB), GET /receipts/:id (sendEvidence), DELETE /receipts/:id (unlinked only), PATCH
/movements/:id/lines/:lineId (reclass via syncSourcePosting; 409 STOCK_LINE_FIXED), GET /categories, GET /open-drawers?boxId, GET /tie-out,
**GET /petty-cash/boxes?mine=1** (ALL_STAFF: boxes where custodianId = me in write scope; no movements, no bytes — critic: the custodian's box picker).
Never select attachment bytes in lists. (DL) remove GET /orders/:id/otp; verify-otp 423 message 'ask a manager to send the code to the rider
(Emergency overrides)'; lost_package description (~216) no longer says a manager marks it delivered.
**reconciliation/pettyCashBackfillRoutes.ts** (mounted at /reconciliation/backfill-petty-cash by w0 — critic: backfills live under /reconciliation):
POST / {dryRun = true, historicTopupSource per company, picks} ADMIN_ONLY, resolveTenantScope, withBackfillSlot (409 BACKFILL_RUNNING), one audit row
per company. (The UI section is w3-admin-finance's BackfillUnposted.tsx.)
**Admin (petty-cash page + shared components):** lib/photoPrep.ts (preparePhoto/kb/blob-url moved from cash-vouchers/photo.ts — leave that file
untouched; w3-cash-requests re-exports); ReceiptUploader; SpendLinesEditor (expense lines: category select from GET /trustops/petty-cash/categories
showing the code; explicit 6xxx for keepers; brand per line; running total — leave clean extension points for stock and capex lines, w3 adds
them); petty-cash page: top-up From (Garibsons cashier default, Safe, Bank account (BankAccountSelect), Till drawer (GET /open-drawers)), opening
source on create, Spend (SpendLinesEditor + ReceiptUploader + supplier bill as today), Return cash modal, Booked/Not booked badge + source label,
TieOutBanner (GET /tie-out), a link to Reconciliation → Backfill for the CEO's history run; copy rewritten (no 'not booked yet'). Tokens only.
""",
consumes=r"""
- w0: PettyCashMovement/SpendLine/attachments schema, ACCT.PETTY_CASH/DUE_TO_GARIBSONS/CASH_ADVANCES/CASH_DRAWER, lib/evidenceFile.ts, placeAndPost /
  withBackfillSlot exports, ledgerBalancesByCode. w1-fa-engine: assertNotEquipmentLine. existing: moneyAccountCode, createPaymentTx, drawerExpectation, assertShiftOf.
""",
exposes=r"""
```ts
// accounting/pettyCashPosting.ts
export const FUNDING_ACCOUNT: { garibsons: string; safe: string }   // H1 switch point
export function postPettyCashMovementTx(tx: Tx, movementId: string, opts?: RepostOptions): Promise<{ entryId: string | null }>
export function resolveSpendLinesTx(tx: Tx, tenantId: string, inputs: SpendLineInput[], o: { allowExplicit: boolean; actor: { id: string; role: string } }): Promise<ResolvedSpendLine[]>
export function pettyCashTieOut(tenantIds: string[]): Promise<Array<{ tenantId: string; floatsCents: number; ledger1011Cents: number; openAdvancesCents: number; ledger1355Cents: number; unbookedMovements: number; ok: boolean }>>
export function backfillPettyCash(a: { tenantIds: string[]; dryRun: boolean; postedBy: string; historicTopupSource: Record<string, 'safe'|'garibsons'>; picks?: Record<string, PickInput> }): Promise<BackfillRow[]>
// trustops/pettyCash.ts
export function recordPettyCashSpendTx(tx: Tx, input: PettyCashSpendInput & { nature: 'expense'|'advance'|'bill'; lines?: SpendLineInput[]; cashVoucherId?: string; conceptId?: string | null }): Promise<{ movementId: string }>
export function recordPettyCashTopupTx(tx: Tx, input: PettyCashTopupInput & { source: 'garibsons'|'safe'|'bank'|'till'|'cash_request'|'opening'; bankAccountId?: string; shiftId?: string; cashVoucherId?: string }): Promise<{ movementId: string }>
export function recordPettyCashReturnTx(tx: Tx, input: { boxId: string; amountCents: number; destination: 'safe'|'bank'|'garibsons'; bankAccountId?: string; reason: string; actorId: string }): Promise<{ movementId: string }>
// pos/drawerToBox.ts
export function recordDrawerToBoxTx(tx: Tx, a: { shiftId: string; tenantId: string; amountCents: number; reason: string; createdById: string }): Promise<{ cashMovementId: string }>
// accounting/expenseCategories.ts
export const PAYOUT_CATEGORIES: ReadonlyArray<{ key: string; label: string; code: string; kind: 'expense'|'cogs' }>
export function resolveSpendAccount(db: Db, tenantId: string, a: { categoryKey?: string; accountCode?: string }, o: { allowExplicit: boolean }): Promise<{ code: string; categoryKey: string | null }>
```
""",
tests=r"""
`pettyCashLedger` (two companies A/B with full charts): each top-up source books the stated Dr/Cr in the BOX's chart — Garibsons → 2210; till →
payout CashMovement + Dr 1011 / Cr 1015 and the shift close does NOT book it again, drawer expectation lower, deposit expectation unchanged; B's
bank or shift on A's box → 422 and nothing saved; spends by key (6xxx, conceptId), a live kitchen_food spend → 422 USE_STOCK_LINE (a backfill pick
of kitchen_food → 5010), explicit 6xxx by a keeper, by a custodian
→ 403, explicit 1210 → 422, no category → 400, equipment description → 422 USE_CAPEX (finance override flagged); location of B on A's spend → 422;
bill spend → Dr 2010/Cr 1010 + Dr 1010/Cr 1011; stock/capex lines → 422 *_UNAVAILABLE (W2); counts → 8010; transfer → no entry; return to Garibsons →
Dr 2210/Cr 1011; locked through today → 422 and float unchanged; replay no-op; tie-out ok after a mixed sequence, a hand-edited float → warn;
backfill dry-run outcomes (opening, assumed source + negative-1010 warning, needs_category, needs_review, voucher spend → 1355, closed month → current
month with note), a real run posts once, picks resolve needs_category, B's rows untouched by A's run, non-admin → 403; B → 404 on A's box, receipt,
line-reclass; GET boxes?mine=1 returns only my boxes. Update cashControls (spend guard, Booked, ledger lines), sepTrustops (otp route gone →
404; cross-company still 404/422), wave3Finance (charts carry 1011), integrationPass1 (:216 top-up sends a source).
""",
))

W2.append(dict(
id="w2-close", wave="W2", area="people (close, year end) + FA/TX/CA/FC report changes", idx=17,
title="ONE period-close checklist with CEO override, fiscal year + virtual roll-forward, statements/report categorisation fixes",
summary="accounting/closeChecks.ts, fiscalYear.ts (db helpers), reports.ts, accounting/routes.ts, lib/labour.ts, tenants/routes.ts (FY PATCH) + close/BS/TB admin pages.",
owns=["backend/src/modules/accounting/closeChecks.ts (new)", "backend/src/modules/accounting/fiscalYear.ts (extend)", "backend/src/modules/accounting/reports.ts",
      "backend/src/modules/accounting/routes.ts", "backend/src/lib/labour.ts", "backend/src/modules/tenants/routes.ts (W2: fiscalYearEndMonth only)",
      "frontend/admin/src/app/accounting/period-close/page.tsx", "frontend/admin/src/app/accounting/period-close/README.md",
      "frontend/admin/src/app/accounting/balance-sheet/page.tsx", "frontend/admin/src/app/accounting/trial-balance/page.tsx",
      "backend/tests/periodCloseChecklist.test.ts (new)", "backend/tests/fiscalYearReports.test.ts (new)", "backend/tests/cashFlowCategories.test.ts (new)",
      "backend/tests/manualJournalControlled.test.ts (new)", "backend/tests/auditAccounting.test.ts", "backend/tests/raastRecon.test.ts (W2: period-close fixtures only)"],
read=["plan_people.json: summary 3, routes (period-close, fiscal-year, TB/BS), build_split C, assumptions OWNER QUESTION 6-7",
      "critic_tax_people_1.json: missing (posting_failed by doc date, FY guard, FY relative to asOf), code_facts (closeWithUnmatchedRaast today)",
      "plan_assets.json shared_file_changes (accounting/routes.ts POST /journal, reports.ts categorise); critic_assets_foodcost_0.json violation 7 (cash flow)",
      "plan_tax.json routes POST /period-close; critic_tax_people_0.json (42xx other income)", "plan_cash.json shared_file_changes reports.ts (CASH_ACCOUNT_CODES)",
      "critic_assets_foodcost_1.json missing 'Brand P&L and management dashboards label all 5xxx as foodCostPct'"],
tasks=r"""
**closeChecks.ts — ONE checklist.** Core checks: 'raast' (block; raastOpenThrough), 'open_tills' (block; open shifts openedAt ≤ newLock of the
company), 'unposted_shifts' (block; backfillUnpostedShifts dry run rows closedAt ≤ newLock with would_post* / unbalanced / error), 'unposted_orders'
(block; backfillUnpostedOrders dry run ≤ newLock), 'posting_failed' (block; open/acknowledged posting_failed flags whose DOCUMENT date (flag
metadata, as REPOSTERS read it) ≤ newLock, or with no date — critic: never 'flag created ≤ newLock'), 'trial_balance' (block, NEVER overridable),
'bank_unmatched' (warn). `CLOSE_CHECKS = [...core, ...hrCloseChecks, ...statutoryCloseChecks, ...intercompanyCloseChecks, ...fixedAssetCloseChecks,
...cardPayoutCloseChecks]` (the orchestrator adds prepaidCloseChecks (w2-fa-capex) and inventoryCloseChecks (w3-fc-report) in wave Z — leave a
marked line). `monthsInRange(prevLock, newLock, firstEntryDate)` capped at 24; `closeChecklist(db, tenantId, newLock)` → {problems, blocks,
warnings, months, isYearEnd}; a check that throws → a 'check_failed' block (overridable) naming it.
**fiscalYear.ts:** add `fiscalYearEndMonthOf(db, tenantId)`, `fiscalYearsFor(db, tenantIds, at)`; FY computed RELATIVE TO the report's asOf (critic).
**reports.ts:** balanceSheet: per company P&L before its FY start = 'Retained earnings b/f', the rest to asOf = 'Profit for the year to date'
(earningsByCompany; totals.currentEarningsCents = their sum; differenceCents unchanged); trialBalance(tenantIds, asOf, { basis: 'inception'|'year' } =
'inception') with one computed virtual row per company in year basis (still balances). (FA) balance-sheet PPE groups (cost and accumulated per class);
P&L depreciation + impairment lines. **Cash flow (FA critic):** a capex.* / fixed_asset.* entry is categorised by its NON-cash line — 1340, 15xx,
1360, 2012 → investing; 1310, 6xxx, 2040 → operating; 'prepaid.release' has no cash line. (CA) CASH_ACCOUNT_CODES = [1010, 1011, 1015, bank codes,
1030] — safe/Garibsons ↔ box moves are transfers. (TX) 42xx shown as OTHER INCOME below operating revenue and excluded from sales KPIs. (FC)
brand P&L (~396-427): cost of sales split food / drinks / packaging through `costOfSalesSplit` (below); 'foodCostPct' relabelled 'cost of sales %'
on the brand-sales denominator. **Export the ONE denominator and split here (verifier fix — w3-fc-report and management/routes.ts import them in
W3; no second copy):** `brandSalesRevenueCents(db, tenantId, { from, to, conceptId? })` = brand sales 40xx (CONCEPT_REVENUE_CODE) net of 7010 / 7020;
4100 service charge, 4110 delivery fees and 42xx other income (4200 breakage) excluded; and `costOfSalesSplit(db, tenantId, { from, to, conceptId? })`
→ { foodCents, drinksCents, packagingCents }: 5010 / 5020 / 5030 directly, and the class-less 5040 / 5050 / 5060 lines split by the cost class of
the document behind them (the StockMovement rows' costClass for waste / count / cost_adjust / prep; for 5060 the GrniMatch bill line's item class);
only an untraceable remainder (pre-FIFO entries) stays in food. (Verifier: packaging counts can differ from usage at any brand — a missed "Box given"
shows as a packaging count LOSS, a wrong one as a GAIN, on 5050 — lumping 5050 into food would hide them in the food line.) The brand P&L uses both.
**lib/labour.ts:** the revenue denominator excludes 42xx (4110 delivery fees stay — they are sales).
**accounting/routes.ts:** GET /period-close?lockedThrough → existing fields + raastUnmatched (compat) + checks + months + isYearEnd + fiscalYear
(card unsettled days appear through the checklist); POST /period-close (ADMIN_ONLY; active company): {lockedThrough, note?, acknowledge?: {keys,
reason ≥ 10}, closeWithUnmatchedRaast?} → 409 CLOSE_NOT_READY {problems}; **409 RAAST_UNMATCHED kept when raast is the ONLY block, and the
closeWithUnmatchedRaast alias is accepted only then and keeps its audit action 'period.close_with_unmatched_raast'** (critic); 422
OVERRIDE_REASON_REQUIRED / NOT_OVERRIDABLE (trial_balance) / LOCK_IN_FUTURE / LOCK_CANNOT_REGRESS / NO_ACTIVE_COMPANY; advisory lock
'period-close:<tenantId>'; PeriodLock.overrides/overrideReason; audits 'period.close', 'period.close_override', 'period.year_end_close'; flagException
'period_close_override' (high); GET /period-close/history returns overrides. No area adds a separate 409 to this file (depreciation, prepaid, card,
stock are CloseChecks). GET /fiscal-year (companies in read scope). trial-balance ?basis; balance-sheet CSV rows (per company in All-companies view).
**(FA) POST /journal:** a line on a fixed_asset-controlled code needs `registerOverride { reason ≥ 10 }` → postJournalEntry controlledOverride (else the
journal's 422 REGISTER_CONTROLLED_ACCOUNT); with it, audited + flagException 'fixed_asset_gl_mismatch'. Intercompany-controlled accounts stay refused
(422 INTERCOMPANY_ACCOUNT_CONTROLLED from journal.ts).
**tenants/routes.ts (W2 part only):** PATCH /:id fiscalYearEndMonth int 1-12 (ADMIN_ONLY, memberTenantIds, foreign 404); once any close has spanned a
year end, a change needs {reason} (else 409 FY_CHANGE_AFTER_YEAR_END_CLOSE) and is audited 'tenant.fiscal_year_end' (category accounting) + flagged.
(w4-integration owns the merge changes in W4.)
**Admin:** period-close page (checklist chips: green clear / red block / amber warn via tokens; deep links + fix buttons (fix.path POST); CEO override
ticks + reason; 'Year-end close FY…' banner; FY-end month select for the CEO via PATCH /tenants/:id); balance-sheet (the two equity lines per company;
note that All-companies shows inter-company due-from/due-to gross); trial-balance (basis=year by default, virtual row muted, 'since inception' toggle).
""",
consumes=r"""
- w1: hrCloseChecks (w1-hr), statutoryCloseChecks (w1-taxcore), intercompanyCloseChecks (w1-ic), fixedAssetCloseChecks (w1-fa-engine),
  cardPayoutCloseChecks (w1-recon). w0: closeCheckTypes, fiscalYear (pure), PeriodLock columns, controlledOverride.
""",
exposes=r"""
```ts
// accounting/closeChecks.ts
export const CLOSE_CHECKS: CloseCheck[]
export function closeChecklist(db: Db, tenantId: string, newLock: Date): Promise<{ problems: CloseProblem[]; blocks: CloseProblem[]; warnings: CloseProblem[]; months: string[]; isYearEnd: boolean }>
// accounting/fiscalYear.ts
export function fiscalYearEndMonthOf(db: Db, tenantId: string): Promise<number>
export function fiscalYearsFor(db: Db, tenantIds: string[], at: Date): Promise<Array<{ tenantId: string; endMonth: number; start: Date; end: Date; label: string }>>
// accounting/reports.ts — THE food-cost / cost-of-sales denominator and class split (w3-fc-report + management/routes.ts import these)
export function brandSalesRevenueCents(db: Db, tenantId: string, a: { from: Date; to: Date; conceptId?: string }): Promise<number>
export function costOfSalesSplit(db: Db, tenantId: string, a: { from: Date; to: Date; conceptId?: string }): Promise<{ foodCents: number; drinksCents: number; packagingCents: number }>
```
""",
tests=r"""
`periodCloseChecklist` (two companies: each block → 409 CLOSE_NOT_READY with its key (open till, unposted shift, open posting_failed dated before
the lock, unlocked payroll via hrCloseChecks, pending IC transfer / uncharged fleet, a stub depreciation check); acknowledge + reason → 201,
PeriodLock.overrides saved, audit + high flag; short reason → 422; trial_balance never overridable; bank_unmatched alone → warn and the close
succeeds; raast-only → 409 RAAST_UNMATCHED and the alias passes with its own audit action; raast + another block → CLOSE_NOT_READY and the alias
does not bypass the other; B's open till / unlocked payroll never blocks A; year-end range audits 'period.year_end_close'). `fiscalYearReports`
(30 Jun vs 1 Jul split; B with FY end 12 splits on its own boundary in All-companies; differenceCents 0; TB basis=year balances with one virtual row
per company; default unchanged; PATCH FY admin-only, B → 404, 13 → 400, change after a year-end close needs a reason). `cashFlowCategories`
(capex instalment → investing; prepaid rent → operating; release no cash line; petty-cash top-up from the safe is a transfer). `manualJournalControlled`
(JE to 1510 without override → 422; with override → posted + flag; to a Due-from → 422). Update auditAccounting and raastRecon's period-close fixtures
where a new block trips them (booksReconcile is w2-fa-capex's this wave: send a patch note).
""",
))
