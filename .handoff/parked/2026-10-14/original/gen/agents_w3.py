W3 = []

W3.append(dict(
id="w3-till", wave="W3", area="onaccount (till + ledger) + tax / delivery / Raast-void hooks at the till", idx=18,
title="On-account tender at the till, till-clearing contra 1115, Z-report, delivery-fee unwind, Raast-void exclusions, COD rider-debt reversal",
summary="pos/service.ts (all non-FC changes), pos/onAccountTender.ts + onAccountRoutes.ts, orderPosting.ts + shiftPosting.ts (OA part), accounting/tillClearing.ts + its worker.",
owns=["backend/src/modules/pos/service.ts (W3: everything except the FC changes w2-sale already landed)",
      "backend/src/modules/pos/onAccountTender.ts (new)", "backend/src/modules/pos/onAccountRoutes.ts (new)",
      "backend/src/modules/accounting/orderPosting.ts (W3: on-account + 1115 only)", "backend/src/modules/accounting/shiftPosting.ts (W3: on-account + 1115 only)",
      "backend/src/modules/accounting/tillClearing.ts (new)", "backend/src/workers/tillClearingSweep.ts (new)",
      "backend/tests/onAccountTill.test.ts (new)", "backend/tests/onAccountLedger.test.ts (new)", "backend/tests/tillClearing.test.ts (new)",
      "backend/tests/tillHooksWaveB.test.ts (new: 4110 unwind, Raast-void exclusions, COD settle reversal)",
      "backend/src/modules/pos/boxGivenRoutes.ts (new)", "backend/tests/boxGiven.test.ts (new)",
      "backend/tests/auditLedgerFollowups.test.ts (W3: 1110 → 1115 till-clearing assertions)", "backend/tests/auditLedgerSales.test.ts (W3: same)",
      "backend/tests/booksLedger.test.ts (W3: same)", "backend/tests/auditMoneyFollowups.test.ts", "backend/tests/raastRefund.test.ts",
      "backend/tests/raastLedger.test.ts", "backend/tests/postingFailures.test.ts (W3: same)", "backend/tests/baseLayers.test.ts (W3: till-clearing assertions only)"],
read=["plan_onaccount.json: summary, postings (till sale, shift close, refund, till clearing), routes (POST /pos/on-account/*), shared_file_changes (pos/service.ts, orderPosting.ts, shiftPosting.ts), build_split A-till-ledger",
      "plan_tax.json: shared_file_changes pos/service.ts (TenderPricedOrder, cancelled-ticket unwind 4110)",
      "plan_delivery.json: shared_file_changes pos/service.ts (settlePayment rider-debt reversal)",
      "critic_cash_delivery_onaccount_2.json: violations 1, 2, 3, 7, 10 (coverage rule, refusals, every refund writer, one-time cut-over sweep, voided Raast exclusions)",
      "shared-files.md §B pos/service.ts, orderPosting.ts, shiftPosting.ts (the exact merged change lists — follow them line by line)"],
tasks=r"""
You own pos/service.ts, orderPosting.ts and shiftPosting.ts in W3. w2-sale (FC void/comp hooks) and w2-ledger (COGS by class, 4110) have
ALREADY changed them: read them as they are on disk, keep those changes, and touch only what is listed here.
**On-account at the till (owner: corporate clients with a credit limit and a QR card the cashier scans; no manager approval per bill):**
- **pos/service.ts — export, no behaviour change:** applyCoverageTx, afterTillSale, repriceForTenderTx, coveredCents, assertTakesMoney, paymentKeyOf,
  idempotencyKeyReused, tillFiscal. `quoteOrderForTender(orderId, method)` accepts 'on_account' and prices it at the CASH class (tenderOf → 'cash').
  POST /pos/payments keeps refusing on_account (it is not in TILL_TENDERS — w0) — the ONLY way in is the on-account route below.
- **pos/onAccountTender.ts:** `lookupCardForOrder({ orderId, code, actor })` — the order from write scope (404 foreign); the card found by
  `hashCardCode(normalizeCardCode(code))` WITHIN the order's company only (order.concept.tenantId) → 404 ON_ACCOUNT_CARD_UNKNOWN for unknown or
  another company's card (never confirm existence); revoked → `flagRevokedCardUse(tenantId, cardId)` + 409 ON_ACCOUNT_CARD_REVOKED; returns
  { account { id, number, legalName, limitCents, exposureCents, availableCents, requiresReference }, card { id, label, hint }, quote { dueCents,
  taxRatePct }, blocked: null | { code, message } } (blocked = what assertChargeableTx would refuse, read-only).
  `chargeOrderToAccount({ orderId, shiftId, code, reference, idempotencyKey, actor })` — ONE transaction: lockOrderTx → idempotent replay (same
  key → the same payment, never a second charge) → assertNoActiveTerminalChargeTx → assertTakesMoney → not completed → nothing paid yet, no tip,
  no promo / wallet / gift card / loyalty credit, no pending check-split portion (409 ON_ACCOUNT_WHOLE_BILL) → `repriceForTenderTx(['on_account'])`
  → assert `order.taxRatePct === concept.taxRateCash` (409 ON_ACCOUNT_RATE — critic) → lockAccountTx → assertChargeableTx (block, never warn) →
  Payment { method 'on_account', status 'paid', shiftId, gatewayRef = client number, gatewayMeta { idempotencyKey, onAccount { accountId, cardId,
  number, name, reference } } } → recordChargeTx → `applyCoverageTx('till')` and REQUIRE `coverage.completedNow` (critic: the completion rule, not
  completionDoor) else 409 ON_ACCOUNT_NOT_HERE and the whole tx rolls back (delivery / pickup / online orders end up here). After commit:
  afterTillSale → completeOrder (exactly ONE fiscal sale document; tender on_account; buyer = the client — w1-taxsales payload; the cash rate). No
  manager PIN. No loyalty earn on an on-account bill (owner default). Audit 'order.on_account_charge' in the ORDER's company. Lock order: order →
  client account → invoice (never the other way).
- **pos/onAccountRoutes.ts** (a second plugin wave Z registers at '/pos'; /pos is ungated): POST /pos/on-account/lookup {orderId uuid, code ≤ 40}
  (CASHIERS, rateLimit 20/min); GET /pos/orders/:orderId/on-account/quote (CASHIERS; foreign → 404); POST /pos/orders/:orderId/on-account
  {shiftId uuid, code, reference? ≤ 80, idempotencyKey 8-100} (CASHIERS; assertShiftOf(order's company, shiftId, open) + assertDrawerOperator)
  → { payment, charge, orderCompleted, fiscal, srb }. Error codes and messages from `CHARGE_ERRORS` (w2-oa-recv), shown verbatim by the till.
- **Refunds (pos/service.ts):** refundOrder for an on_account payment: shiftId null and refundDrawerOf's cash rule skipped; **call
  `applyChargeRefundTx` inside `writeRefundTx` whenever r.method === 'on_account'** so EVERY writer of an on_account refund row reaches it
  (refundOrder, the void-on-paid-order path ~2156, the cancelled-ticket hand-back ~3378 — critic). `refundDueOf` excludes on_account (and comp).
- **Till clearing contra 1115 (pos/service.ts):** BASE_MONEY_ACCOUNTS += ACCT.TILL_CLEARING; ~3092 match `code IN TILL_CLEARING_CODES` (1115 +
  legacy 1110); ~3191 / ~3213 ACCT.CUSTOMER_AR → ACCT.TILL_CLEARING for till-clearing lines (1110 stays for real receivables).
- **Z-report:** getZReport gains onAccountSales / onAccountCount / onAccountByClient (inside totalSales).
**orderPosting.ts (OA, W3 part):** buildSaleLines on_account block after Raast and before the 1030 rest: Σ paid on_account rows capped at `left` →
Dr ACCT.CUSTOMER_AR (1110 — a real receivable) memo `${ON_ACCOUNT_MEMO} — ${conceptMemo}`; refundCreditAccount('on_account') → ACCT.CUSTOMER_AR
(memo prefixed ON_ACCOUNT_MEMO); saleBookingOf (~636) `code IN TILL_CLEARING_CODES`; hand-back (~771) Dr ACCT.TILL_CLEARING; refundDueCents excludes
on_account (like comp) and payments whose Raast receipt is 'voided'. Do not touch the COGS / 4110 changes of w2-ledger.
**shiftPosting.ts (OA, W3 part):** ShiftSales.onAccount { cents, byAccount }; in summariseShiftSales' home-drawer loop `else if (p.method ===
'on_account') addOnAccount(...)` BEFORE the card branch, and an explicit guard that THROWS for any unknown paid method (an unknown method must
never fall into 1030); the NEVER_SOLD branch skips on_account like comp; buildShiftCloseEntry: one Dr ACCT.CUSTOMER_AR line per client (memo
`${ON_ACCOUNT_MEMO} — ${number} ${name} — ${refs} ${tag}`); lines ~471 / ~474 / ~506 and postPosCardFailure ~787 → ACCT.TILL_CLEARING;
cardRefundsToBook excludes on_account; header comment.
**accounting/tillClearing.ts + workers/tillClearingSweep.ts (critic — one-time cut-over, then reversals only):**
`sweepTillClearing(tenantId, { mode: 'cutover'|'daily' })` under pg_advisory_xact_lock('till-clearing:'+tenantId). 'cutover' runs ONCE (Setting
marker `ledger.tillClearingCutoverAt:<tenantId>`): the legacy till-clearing balance sitting on 1110 (groupBy over 1110 lines EXCLUDING
'receivable.%' references and ON_ACCOUNT_MEMO memos) moves to 1115 under 'ledger.till_clearing_split:<tenantId>:<n>'. 'daily' moves ONLY
reversals of pre-cut-over till-clearing entries; any other non-AR 1110 activity (manual journals included) → flagException 'till_clearing_unexpected'
in that company, never moved automatically. A refused posting → flagPostingFailed('ledger.till_clearing_split', 'Tenant', tenantId) (w4-integration
wires the REPOSTER: post → sweepTillClearing(tenantId, { mode: 'daily' })). Worker: daily 03:10 PKT (node-cron, Asia/Karachi), serviceClient, loop
per active company, running guard, export `runTillClearingSweepOnce()` for tests. Wave Z starts the worker and runs the cut-over once at boot.
**Tax (pos/service.ts):** TenderPricedOrder Pick + 'deliveryFeeCents'; tenderPriceOf passes it; repriceForTenderTx writes deliveryFeeTaxCents; the
void-line reprice (~1870) passes deliveryFeeCents; the refund select (~3024) adds deliveryFeeCents (type completeness — till sales carry 0); the
cancelled-ticket unwind (~3125-3137) adds `add(ACCT.DELIVERY_FEE_REVENUE, b.deliveryFeeCents)` (TX critic).
**Raast "void, never booked" (pos/service.ts):** refundDueOf, the Z-report's cancelledPaid and the till's hand-back options exclude payments whose
raastReceipt.status is 'voided' (w1-recon owns the void itself).
**"Box given" (packaging rule, FINAL owner rule):** pos/boxGivenRoutes.ts (a plugin wave Z registers at '/pos'; /pos is ungated):
POST /pos/orders/:orderId/items/:itemId/box-given { undo?: boolean } (any staff of the order's company who can use the till or the floor — the
till's STAFF list; foreign order or a line not on that order → 404) → w2-sale `markBoxGiven(itemId, actor, { undo })` → { boxGiven, depleted };
409 BOX_NOT_NEEDED (takeaway / delivery / a packaging-vessel line — it already counts) and 409 ORDER_COMPLETED for an undo after completion,
both in words. Order lines already come back with every scalar column (serviceVessel, boxGiven) wherever the till / order page read them —
check the selects on that path and add the two fields where a narrow `select` drops them; the UI shows the button when the order is dine-in
and the line's vessel is 'plate' (null = a legacy line → treat as plate; the server has the last word).
**Delivery — COD the rider owes (pos/service.ts settlePayment):** select codRiderDebtEntryId / codRiderDebtTransferId; own-rider debt: call
`reverseCodRiderDebtTx(tx, { paymentId, tenantId })` right after the pending→paid claim (an AppError → after commit flagPostingFailed
'cod.rider_debt.reversal' with sourceId = paymentId); fleet-rider debt (an inter-company transfer): after commit `reverseCodRiderDebtAfterCommit
(paymentId)` (serviceClient, both companies' books; failure → the same flag). Never hold the tx across it.
""",
consumes=r"""
- w0: ON_ACCOUNT_TENDER / REFUND_TENDERS (lib/tenders.ts), ACCT.TILL_CLEARING / CUSTOMER_AR / DELIVERY_FEE_REVENUE, TILL_CLEARING_CODES, ON_ACCOUNT_MEMO,
  lib/onAccountCard.ts (normalizeCardCode, hashCardCode), Payment cod columns, Order fee columns.
- w2-oa-recv: CHARGE_ERRORS, lockAccountTx, exposureOfTx, assertChargeableTx, recordChargeTx, applyChargeRefundTx, flagRevokedCardUse.
- w1-taxsales: fiscal payload buyer = the client (customerAccountCharge read), paymentLabelOf. w1-recon: RaastReceipt 'voided'. w2-dlv-cod:
  reverseCodRiderDebtTx / reverseCodRiderDebtAfterCommit. w2-ledger: orderPosting/shiftPosting COGS + 4110 (keep).
""",
exposes=r"""
```ts
// pos/onAccountTender.ts
export function lookupCardForOrder(a: { orderId: string; code: string; actor: StaffActor }): Promise<OnAccountLookup>
export function chargeOrderToAccount(a: { orderId: string; shiftId: string; code: string; reference?: string | null; idempotencyKey: string; actor: StaffActor })
  : Promise<{ payment: Payment; charge: CustomerAccountCharge; orderCompleted: boolean; fiscal: unknown; srb: unknown }>
// pos/onAccountRoutes.ts
export default async function posOnAccountRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: app.register(posOnAccountRoutes, { prefix: '/pos' })
// accounting/tillClearing.ts
export function sweepTillClearing(tenantId: string, o: { mode: 'cutover'|'daily' }): Promise<{ moved: number; cents: number; flagged: number }>
// workers/tillClearingSweep.ts
export function startTillClearingSweepWorker(): void
export function runTillClearingSweepOnce(now?: Date): Promise<void>
// pos/boxGivenRoutes.ts
export default async function posBoxGivenRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: app.register(posBoxGivenRoutes, { prefix: '/pos' })
// pos/service.ts (newly exported, unchanged behaviour)
export { applyCoverageTx, afterTillSale, repriceForTenderTx, coveredCents, assertTakesMoney, paymentKeyOf, idempotencyKeyReused, tillFiscal }
```
""",
tests=r"""
`onAccountTill` (two companies): B's cashier → 404 on A's order; A's card scanned on B's order → 404 ON_ACCOUNT_CARD_UNKNOWN; the charge, the shift
close lines and the fiscal document are stamped with A; one charge completes the order once with exactly ONE fiscal sale document (tender on_account,
buyer = the client, taxRatePct = the cash rate); no PIN needed; the idempotent replay returns the same payment; two concurrent charges near the
limit → one 409 ON_ACCOUNT_OVER_LIMIT; overdue / suspended / pending / brand-not-allowed refused; reference required when the client says so; a
delivery or pickup order → 409 ON_ACCOUNT_NOT_HERE and nothing saved; a tip, a promo, a gift card or a part-paid bill → 409 ON_ACCOUNT_WHOLE_BILL; a
revoked card raises the flag once; POST /pos/payments with on_account still refused. `onAccountLedger`: shift close Dr 1110 per client, the entry
balances, the Z-report shows on-account inside total sales; a non-till dine-in bill's order.complete debits 1110; a refund to the account → Cr 1110
+ fiscal return + charge refunded + statement credited (via each refund writer incl. the void-on-paid path and the cancelled-ticket hand-back); a
refused posting saves nothing; an unknown paid method makes the shift close throw (never 1030). `tillClearing`: new till-clearing lines land on 1115;
a legacy REFUND DUE on 1110 is still found by saleBookingOf / Raast saleBookedTx / the cancelled unwind; the cut-over moves the legacy balance once,
a re-run posts nothing; the daily run skips ON ACCOUNT and receivable.* lines and flags a manual 1110 journal as till_clearing_unexpected; a locked
period flags posting_failed. `tillHooksWaveB`: cancelled-ticket unwind of a delivery order reverses 4110 too; a voided Raast receipt is excluded from
refund-due, cancelledPaid and the hand-back options; settling a COD the rider owes posts Dr 1010 / Cr 1351 in the same tx ('cod.rider_debt.reversal:
<paymentId>') and a fleet rider's debt reverses after commit in both companies; a refused reversal is flagged. `boxGiven` (two companies): B's
staff → 404 on A's line; a Simmer dine-in line → boxGiven true and its packaging depleted once (a second tap writes nothing); undo before
completion returns it; undo after completion → 409; a takeaway line or a Stackd line → 409 BOX_NOT_NEEDED. Update the listed existing suites'
till-clearing expectations 1110 → 1115 (keep 1110 for invoices and on-account) — nothing else in them.
""",
))

W3.append(dict(
id="w3-stockdocs", wave="W3", area="foodcost (stock documents: counts, waste, prep, transfers, item edits)", idx=19,
title="Counts (spot + opening), waste, prep batches, transfers and item edits on FIFO lots; shortfall flags",
summary="crosschecks/routes.ts + countPosting.ts, inventory/routes.ts, stockTransfers/routes.ts, workers/shrinkageTrend.ts.",
owns=["backend/src/modules/crosschecks/routes.ts", "backend/src/modules/crosschecks/countPosting.ts (becomes a re-export)",
      "backend/src/modules/inventory/routes.ts", "backend/src/modules/stockTransfers/routes.ts", "backend/src/workers/shrinkageTrend.ts",
      "backend/tests/spotCounts.test.ts (new)", "backend/tests/openingCounts.test.ts (new)", "backend/tests/wasteFifo.test.ts (new)",
      "backend/tests/prepBatchFifo.test.ts (new)", "backend/tests/stockTransferReceive.test.ts (new)", "backend/tests/wasteAnalyticsScope.test.ts (new)",
      "backend/tests/itemCategoryReclass.test.ts (new)",
      "backend/tests/auditKitchen.test.ts", "backend/tests/resimKitchen.test.ts", "backend/tests/stockCounts.test.ts", "backend/tests/sepTrustops.test.ts (stock cases only)",
      "backend/tests/receiving.test.ts (W3: /crosschecks/receiving + locationId; w2-ap had it in W2) — adjust only what FIFO changes; postingFailures (w3-till) and wave3Kitchen / wave3Gates (w3-fc-report) also exercise these routes but belong to those agents this wave: send patch notes"],
read=["plan_foodcost.json: COUNTS / WASTE / PREP paragraphs of summary, postings 6-12 + 14 + 16, routes (counts, prep, waste, inventory PATCH, waste-analytics, transfers), build_split C (crosschecks / inventory / stockTransfers / shrinkageTrend)",
      "critic_assets_foodcost_1.json: violations 4 (company-less), 9 (keep COST_FROM_DELIVERIES / costSource names), 13 (opening counts: finance/CEO/management; cost defaults to the latest purchase price)"],
tasks=r"""
Every stock change goes through lib/stockLedger.ts (w1-stock) — never `inventoryItem.update({ currentStock })` directly. Call `ensureFifoReady(tenantId)`
BEFORE opening a transaction; inside the tx `lockItemsTx` the items in id order. Postings run in a savepoint (`withSavepoint`) so a refused posting
never undoes the stock document: the document stands, the refusal is flagged (flagPostingFailed with the existing sourceTypes) and the response
carries the ledger result `{ posted: boolean, entryId?, error? }`.
**crosschecks/routes.ts:**
- POST /crosschecks/receiving: body gains `locationId?` and passes it to receiveGoods (w2-ap validates it: 422 LOCATION_NOT_IN_COMPANY).
- **Counts** POST /crosschecks/physical-counts { kind: 'spot'|'opening' = 'spot', locationId?, lines [{ inventoryItemId, physicalQty, reason?,
  unitCostCents? }], notes? } — STOCK_COUNTERS; binds to the ACTIVE company; foreign item → 404 (existing); location of another company → 422
  LOCATION_NOT_IN_COMPANY. **Spot:** book qty snapshotted under the item locks; short → `consumeFifoTx` kind 'count_loss' (clamp false); over →
  `addLotTx` kind 'count_gain' at `latestPurchaseCostCents` (else the item's estimate); a zero-book OVER with no cost raises flag
  'stock_unrecorded' instead of a 0 % variance line; PhysicalCountLine.valueCents / unitCostCents stored; `postStockCount` (Dr/Cr 5050) in a
  savepoint; existing shrinkage flags kept. **Opening (H19 — stock found by the first count of an item never counted or received):** only
  ['admin','owner','management','finance'] (403 OPENING_COUNT_ROLE — critic: not floor managers); 422 OPENING_NOT_ALLOWED when the item already
  has any lot or stock movement (received, counted or cut over with stock); unit cost = the line's unitCostCents, default the latest purchase
  price, else the item's estimate, else 422 OPENING_COST_REQUIRED; `addLotTx` kind 'opening'; posts Dr class inventory / Cr 3020 — never 5050.
- GET /crosschecks/physical-counts?kind&from&to (now with lines, values and ledger status); GET /crosschecks/physical-counts/:id (404 foreign);
  GET /crosschecks/physical-counts/suggested?n=8&locationId (STOCK_COUNTERS): a weighted random sample of the active company's high-value items
  (on-hand lot value × 30-day usage), excluding items counted in the last 7 days; costs hidden for floor roles (`costsHiddenFor`). No month-end
  stocktake is required anywhere (owner).
- **Prep batches** POST /crosschecks/prep-batches + `locationId?`: a sub-recipe batch stays a yield record only (sale-time explosion already
  consumes its inputs — keep the existing comment); an AD-HOC batch (no recipe) draws its inputs FIFO (`consumeFifoTx` kind 'prep_draw', clamp
  false → 409 INSUFFICIENT_STOCK as today), stores `PrepBatch.drawValueCents` and posts `postPrepDraw` (Dr 50x0 / Cr 12x0, usage split) in a
  savepoint. RECIPE_NOT_IN_COMPANY kept.
**crosschecks/countPosting.ts:** becomes `export { postStockCount } from '../accounting/inventoryPosting.js'` (+ any type it exported) so existing
importers keep compiling (w4-integration repoints backfillOrders' import).
**inventory/routes.ts:**
- POST /inventory/:id/waste { quantity, unit, reason, photoUrl?, notes?, conceptId?, locationId? }: brand through `assertConceptOwned(req, id,
  'create')` and it must be the ITEM's company (422 BRAND_NOT_IN_COMPANY); location rule as above; `consumeFifoTx` kind 'waste' (clamp false → 422
  NEGATIVE_STOCK); WasteLog { tenantId, conceptId, locationId, estimatedCostCents = the FIFO value }; `postWasteLog` in a savepoint (flag on
  refusal); PHOTO_REQUIRED / UNIT_MISMATCH kept. Waste reasons accepted from staff: spoilage | over_prep | expired | damaged | other (the sold-line
  reasons and transit_loss / remake are system-only).
- POST/PATCH /inventory: `category` is `z.enum(INVENTORY_CATEGORIES)` (400 otherwise); a class-crossing change on an item with stock posts
  `postItemReclassTx` in the same tx (key uses the audit row id); `unitCostCents` editable only while the item has NO lots → 422
  COST_FROM_DELIVERIES (existing name kept — critic); costSource stays 'deliveries' | 'opening'; `issueOnReceipt` toggle (MANAGERS + inventory
  module; audited — unmeasured consumables such as oil and salt are issued to cost on receipt).
- **Company-less items (critic):** every stock write refuses an item with no company (422 ITEM_HAS_NO_COMPANY — enforced in stockLedger; surface
  the message). Assigning a company to a company-less item that holds stock (PATCH { tenantId } — ['admin','owner','management','finance'], the
  company must be one the operator belongs to) creates an OPENING count for it in the same transaction (one line, physicalQty = currentStock, unit
  cost from the body or the estimate, 422 OPENING_COST_REQUIRED) → lot + Dr class / Cr 3020 — the opening path above, never a second one.
- GET /inventory/waste-analytics: view-aware company scope (empty scope denies), company-less items excluded, costs hidden for floor roles.
- GET /inventory list/detail: `unitCostCents` is the FIFO head (w1-stock keeps it fresh); add `onHandValueCents` (Σ open lot value) for
  FINANCIALS_VIEWERS + keepers only.
**stockTransfers/routes.ts** PATCH /:id/receive { receivedQuantity, shortfallReason? }: 422 OVER_RECEIVED (above sent); a shortfall needs a reason
(422 SHORTFALL_REASON_REQUIRED) and is booked as waste reason 'transit_loss' (consumeFifoTx kind 'waste' + WasteLog + postWasteLog in a
savepoint); another company's transfer → 404 (existing).
**workers/shrinkageTrend.ts:** per company (existing loop), a nightly 'stock_shortfall' flag per item from Σ shortfallQty of its sale movements in
the last 7 days still unsettled (one open flag per item — kindsMatching de-dup); stock_unrecorded lines are skipped in the shrinkage % average.
""",
consumes=r"""
- w1-stock: lockItemsTx, addLotTx, consumeFifoTx, latestPurchaseCostCents, ensureFifoReady; inventoryPosting postStockCount / postPrepDraw /
  postWasteLog / postItemReclassTx. w2-ap: receiveGoods(locationId). w0: lib/inventoryClass.ts, lib/savepoint.ts, PhysicalCount/PrepBatch/WasteLog
  columns, exception kinds stock_shortfall / stock_unrecorded.
""",
exposes=r"""
```ts
// crosschecks/countPosting.ts
export { postStockCount } from '../accounting/inventoryPosting.js'
// routes (wave Z: no new registration — same plugins)
// POST /crosschecks/physical-counts → 201 { count, lines, ledger: { posted: boolean; entryId?: string; error?: string } }
// GET  /crosschecks/physical-counts/suggested?n&locationId → { items: Array<{ id, name, unit, onHandQty, onHandValueCents?: number }> }
```
""",
tests=r"""
Two companies in every file: B → 404 on A's count, item, transfer; creates bind to the active company; a location of another company → 422; a brand of
another company on waste → 422 BRAND_NOT_IN_COMPANY. `spotCounts` (short → count_loss FIFO value Dr 5050 / Cr class; over → count_gain lot at the
latest purchase price; zero-book over → stock_unrecorded flag, no 0 % line; a refused posting keeps the count and flags; suggested excludes items
counted in 7 days and hides costs for boh). `openingCounts` (finance → Dr 1210 / Cr 3020 at the entered cost, default the latest price; second
opening of the same item → 422 OPENING_NOT_ALLOWED; an item already received → 422; boh_management → 403 OPENING_COUNT_ROLE; assigning a company to a
company-less item with stock creates the opening lot + entry once). `wasteFifo` (FIFO value across two lots, WasteLog carries tenantId/conceptId/
locationId, Dr 5040 / Cr 1230 for a packaging item; NEGATIVE_STOCK; refusal flagged, waste stands). `prepBatchFifo` (ad-hoc draw values + posts
'inventory.prep_draw:<id>'; sub-recipe batch draws nothing; INSUFFICIENT_STOCK rolls back). `stockTransferReceive` (OVER_RECEIVED; shortfall → transit_loss
waste booked; SHORTFALL_REASON_REQUIRED). `wasteAnalyticsScope` (B's finance in single-company view never sees A's or company-less waste; empty scope
denied). `itemCategoryReclass` (category change with stock posts the reclass once; unitCostCents edit with lots → 422 COST_FROM_DELIVERIES; bad category → 400).
""",
))

W3.append(dict(
id="w3-recipes", wave="W3", area="foodcost (recipes: packaging on every dish, modifier recipes, costing)", idx=20,
title="Recipe Packaging section on every dish (used by order type / brand vessel / Box given), brand service vessel, modifier recipes, costing on real packaging",
summary="recipes/routes.ts (+ par-sheet if it assumes every line is food), recipe admin pages, KitchenRecipe, modifiers page.",
owns=["backend/src/modules/recipes/routes.ts", "backend/src/modules/recipes/README.md", "backend/src/modules/par-sheet/routes.ts (only if packaging lines break it)",
      "frontend/admin/src/app/accounting/recipes/RecipeForm.tsx", "frontend/admin/src/app/accounting/recipes/page.tsx",
      "frontend/admin/src/app/accounting/recipes/[id]/page.tsx", "frontend/admin/src/app/accounting/recipes/KitchenRecipe.tsx",
      "frontend/admin/src/app/configuration/modifiers/page.tsx",
      "backend/src/modules/concepts/routes.ts (W3: serviceVessel on create / PATCH only)", "backend/src/modules/concepts/README.md",
      "backend/src/modules/tenants/routes.ts (W3: serviceVessel on the company-create first brand only)",
      "backend/tests/recipePackaging.test.ts (new)", "backend/tests/modifierRecipes.test.ts (new)", "backend/tests/serviceVessel.test.ts (new)",
      "existing recipe suites (grep tests/ for \"'/recipes\" — except wave3Kitchen / wave3Gates, which are w3-fc-report's: send a patch note)"],
read=["plan_foodcost.json: RECIPES paragraph of summary, routes (recipes), build_split D + the recipe part of G",
      "critic_assets_foodcost_1.json: violations 1 (no plate wear; Q factor is the one allowance), 6 (RecipeKind 'modifier'), 11 (costing-preview, by-item, KitchenRecipe)",
      "schema-merged.prisma.md decision P1 + §3.22 (the FINAL owner packaging rule: order type + brand service vessel + 'box given'; no plateWearPct, no servedWhen)"],
tasks=r"""
**THE packaging rule (FINAL owner rule — see the common brief):** every PLATE recipe ALWAYS has an optional Packaging section (all brands).
Whether a sale uses it is decided at the sale (w2-sale `packagingApplies`): takeaway/delivery → yes; a brand whose primary service vessel is
'packaging' (Stackd) → yes on every order; dine-in at a plate brand → only when staff tap "Box given". So a recipe CAN be approved without
packaging (a dine-in-only plate brand is valid); costing shows plate MC (food + drinks) AND target MC per order type (dine-in / takeaway /
delivery) = plate MC + packaging where it applies for that brand. A packaging-vessel brand's recipe with NO packaging line → a warning
('Stackd serves in packaging — add the vessel') on the recipe and in the report, never a block. NO servedWhen per line, NO plate-wear %
(the existing `qFactorPct` is the ONLY pricing allowance: plate wear, garnish, oil — pricing only, never stock, never posted).
**recipes/routes.ts:**
- DELETE the GET /recipes/food-cost handler (~1356-1495) and the imports only it used — the path now answers 404 (the report lives at
  /reports/food-cost, w3-fc-report; w0 added the admin redirect).
- ingredientSchema gains `section: z.enum(['ingredients','packaging']).default('ingredients')`. Validation (one helper used by create, update,
  PUT and costing-preview): a packaging-class item (`costClassOf(item.category) === 'packaging'`) in 'ingredients' → 422 PACKAGING_SECTION_ONLY;
  a non-packaging item in 'packaging' → 422 NOT_PACKAGING; a packaging section on a component (sub-recipe) or a modifier recipe → 422
  PACKAGING_ON_PLATES_ONLY; an item not of the recipe's company (plate → its brand's company; modifier → modifier → group → menu item → brand) →
  422 ITEM_NOT_IN_COMPANY; a company-less item → 422 ITEM_HAS_NO_COMPANY.
  Legacy rows (verifier): migration backfill 15 moves packaging-class items to 'packaging' on PLATE recipes only, so a sub-recipe that already
  holds a packaging-class item in 'ingredients' must stay editable — validate only NEW or CHANGED lines (an untouched legacy line passes, with a
  'packaging item in a sub-recipe' warning), never refuse the whole save because of a line the user did not touch.
- recipeShape: `packagingPct` dropped from input (ignored if sent, never written — the column is retired); `qFactorPct` unchanged; `modifierId?`.
- **Packaging warning (not a block):** a plate recipe of a brand whose serviceVessel is 'packaging' with no packaging line returns a
  `warnings: ['PACKAGING_MISSING']` on save/approve and in costing-preview; plate brands get no warning (dine-in-only dishes are valid).
- **Modifier recipes** (RecipeKind 'modifier', w0 enum): `kind: 'modifier'` + `modifierId`, no menuItemId, no packaging; one recipe per modifier
  (409 MODIFIER_HAS_RECIPE); the modifier → group → menu item → brand chain must be in CREATE scope (foreign → 404; a cross-company attach → 422
  MODIFIER_NOT_IN_COMPANY); negative quantities ('removes', e.g. "no cheese") ONLY on modifier recipes (422 NEGATIVE_QTY_NOT_ALLOWED elsewhere —
  the consumption clamps at zero per line, w2-sale). Adjust the superRefine and every list filter that assumed kind ∈ {plate, component}.
- **Costing** (GET /:id/costing ~711-900, POST /costing-preview ~598, GET /by-item/:menuItemId ~903 — critic): read the w2-sale `RecipeCost`:
  `stockByClass` { food, beverage, packaging }, `packagingCents`, `standardCents` (= food + drinks = the plate MC), `targetMcCents` { dine_in,
  takeout, delivery } (plate MC + packaging where it applies to that order type for the brand's vessel), `qCents` (Q factor allowance).
  plateCostCents = standardCents; break-even and target price use the brand's main order type's target MC (dine_in for a plate brand, which
  equals plate MC; any order type for a packaging brand) + qCents where the formula used the Q factor — the `packagingFactor` (packagingPct) is
  gone; profitability per order type uses the real packaging lines. Detail and list return
  `warnings`: outsideCompany[] (lines whose item is another company's), costedWhileUnapproved (status ≠ production on a live menu item), noPackaging
  (a plate recipe of a PACKAGING-vessel brand with no packaging line; false for plate brands). by-item returns lines grouped by section so the
  kitchen sees what to pack in.
- **Brand service vessel (concepts/routes.ts + tenants/routes.ts, W3 parts only):** POST /concepts requires `serviceVessel: z.enum(['plate',
  'packaging'])` (no default on the API — 400 when missing; the owner wants the choice made at brand creation); PATCH /concepts/:id accepts it
  (write scope, foreign → 404), audited 'concept.service_vessel' with from/to; the company-create route that makes the first brand (tenants/routes.ts
  ~447 / ~481) requires it for that brand too. GET responses include it. A change applies to lines rung up from then on (OrderItem.serviceVessel
  snapshot, w2-sale) — say so in the audit note. concepts/README.md: one paragraph.
- par-sheet/routes.ts: if it explodes recipes into prep quantities, skip packaging-section lines (packaging is not prepped). Touch nothing else.
- recipes/README.md: the packaging rule, sections, modifier recipes, costing fields.
**Admin:** RecipeForm.tsx — a Packaging section on every plate recipe (item picker limited to packaging-class items; NO per-line order-type
choice; helper text 'Used on takeaway and delivery, on every order at a brand that serves in packaging, and on dine-in when staff tap Box
given'); the packaging % field removed; Q factor relabelled 'Q factor — pricing allowance (plate wear, garnish, oil); not stock'; warnings as
banners (outside company and costed while unapproved — red; no packaging at a packaging brand — amber, Approve stays enabled); modifier mode (menu
item → modifier group → modifier pickers; negative quantity allowed with the label 'removes'). recipes/page.tsx — a 'No packaging' badge (amber,
packaging brands only) and a filter. [id]/page.tsx — cost breakdown Food / Drinks / Packaging, plate MC, and target MC for Dine-in / Takeaway /
Delivery (from targetMcCents), with the Q allowance on its own line labelled 'in menu pricing, not stock'. KitchenRecipe.tsx — shows the Packaging section ('Pack in'). configuration/modifiers/page.tsx — an 'Ingredients' action
per modifier opening (or creating) its recipe. Tokens only; plain English; phone width.
""",
consumes=r"""
- w2-sale: lib/recipeCost.ts (RecipeCost.stockByClass / packagingCents / standardCents / qCents, packagingApplies). w0: RecipeIngredient.section,
  Recipe.modifierId, RecipeKind 'modifier', lib/inventoryClass.ts costClassOf.
""",
exposes=r"""
```ts
// GET /recipes/:id/costing (and POST /recipes/costing-preview) response additions
{ stockByClass: { food: number; beverage: number; packaging: number }; packagingCents: number; standardCents: number; qCents: number;
  targetMcCents: { dine_in: number; takeout: number; delivery: number };
  warnings: { outsideCompany: Array<{ lineId: string; itemName: string }>; costedWhileUnapproved: boolean; noPackaging: boolean } }
// recipe error codes: PACKAGING_SECTION_ONLY, NOT_PACKAGING, PACKAGING_ON_PLATES_ONLY, ITEM_NOT_IN_COMPANY,
//   ITEM_HAS_NO_COMPANY, MODIFIER_HAS_RECIPE, MODIFIER_NOT_IN_COMPANY, NEGATIVE_QTY_NOT_ALLOWED
```
""",
tests=r"""
`recipePackaging` (two companies): packaging item in ingredients → 422; non-packaging item in packaging → 422; packaging on a sub-recipe → 422; approve a
a Stackd (vessel 'packaging') recipe with no packaging → saved with warning PACKAGING_MISSING, a Simmer (plate) one → no warning; costing:
target MC dine-in = plate MC for Simmer, = plate MC + packaging for Stackd; target MC takeaway/delivery = plate MC + packaging for both; qCents reported apart and never inside standardCents;
packagingPct sent → ignored; GET /recipes/food-cost → 404; A's recipe with B's packaging item → 422 ITEM_NOT_IN_COMPANY; B → 404 on A's recipe;
warnings noPackaging / outsideCompany / costedWhileUnapproved. `modifierRecipes`: create for own modifier; B's modifier → 404; cross-company attach → 422
MODIFIER_NOT_IN_COMPANY; second recipe → 409; negative qty only on modifier recipes; costing-preview and by-item include sections.
`serviceVessel` (two companies): POST /concepts without serviceVessel → 400, with 'packaging' → stored; company create without it for the first brand
→ 400; PATCH by B on A's brand → 404; PATCH writes the audit with from/to; an order line rung up before the change keeps its snapshot.
""",
))

W3.append(dict(
id="w3-fc-report", wave="W3", area="foodcost (the variance report, its API, email, hub gauge, management KPI)", idx=21,
title="ONE food-cost variance report (actual vs recipe at the price paid, food / drinks / packaging), API, scheduled email, admin pages",
summary="reports/foodCost.ts + foodCostRoutes.ts, workers/scheduledReports.ts, management/routes.ts (foodCostPct), /reports/food-cost admin, hub gauge, menu-engineering page.",
owns=["backend/src/modules/reports/foodCost.ts (new)", "backend/src/modules/reports/foodCostRoutes.ts (new)", "backend/src/workers/scheduledReports.ts",
      "backend/src/modules/management/routes.ts (W3: foodCostPct only)",
      "frontend/admin/src/app/reports/food-cost/page.tsx (new)", "frontend/admin/src/app/reports/food-cost/components/* (new)",
      "frontend/admin/src/app/reports/page.tsx", "frontend/admin/src/app/menu-engineering/[id]/page.tsx",
      "frontend/admin/src/app/accounting/food-cost/page.tsx (DELETE) + any README in that folder (delete or repoint)",
      "frontend/admin/src/app/accounting/page.tsx (W3: the food-cost gauge only)",
      "backend/tests/foodCostReport.test.ts (new)", "backend/tests/foodCostAccess.test.ts (new)", "backend/tests/scheduledFoodCost.test.ts (new)",
      "backend/tests/wave3Kitchen.test.ts", "backend/tests/wave3Gates.test.ts", "management suites asserting foodCostPct (grep tests/ for foodCostPct)"],
read=["plan_foodcost.json: summary REPORT paragraph, routes (REPORT block), build_split E + F",
      "critic_assets_foodcost_1.json: violations 1 (Q only), 12 (food / drinks / packaging split, brand-sales denominator), 14 (alignment line), 15 (null-company schedule)",
      "critic_tax_people_0.json violation 10 (42xx other income out of sales KPIs)"],
tasks=r"""
**reports/foodCost.ts — the ONE engine (no second copy anywhere; the old GET /recipes/food-cost is deleted by w3-recipes):** foodCostSummary,
ingredientVariance, itemMovements, inventoryValuation, foodCostFlags, foodCostWarnings, `inventoryCloseChecks`, buildFoodCostEmail — all reading
StockMovement / StockLot rows plus the ledger lines.
- **Revenue (the denominator):** import `brandSalesRevenueCents` and `costOfSalesSplit` from accounting/reports.ts (w2-close defined them in W2 —
  brand sales 40xx net of 7010/7020; 4100 service charge, 4110 delivery fees and 42xx other income excluded). Never re-implement them here.
- **Theoretical** = per sold line, the recipe's food + drinks plus its PACKAGING when `packagingApplies(order, line)` (w2-sale — THE seam: takeaway /
  delivery, a packaging-vessel line, or a dine-in line marked "Box given"; decision P1 FINAL) at the real lot prices consumed, plus the shortfall
  memo. **Material cost (MC) by order type:** the summary and each brand block show theoretical vs actual MC split dine-in / takeaway / delivery
  (orders by fulfilmentType; the packaging line follows the same rule). Comps and staff meals are classified from Payment method 'comp' and gatewayMeta.comp.kind
  (pro rata for partial comps). Cost classes: food / drinks / packaging = 5010 / 5020 / 5030 plus the class shares of 5040 / 5050 / 5060 exactly as
  `costOfSalesSplit` (w2-close) splits them (by the movement / bill-line class; untraceable pre-FIFO remainder in food) — packaging count gains
  at plate brands therefore show in the PACKAGING line.
- **Explained buckets:** comps, staff meals, waste by reason (spoilage, over_prep, expired, damaged, other, void_after_fire, cancelled_after_fire,
  returned_food, transit_loss, remake), prep draws, count variance, issue on receipt, shortfall settles, price adjustments (5060). The FIFO
  cut-over ALIGNMENT difference (3020) is its own line — never 'unexplained' (critic). Allowance shown: Q factor only, labelled 'in menu pricing,
  not stock' (no plate wear).
- Brand view: measured rows plus usage-allocated rows (brandShares stored on the movements), labelled 'allocated'.
- Warnings: items with no recipe, null-cost lots, sub-recipes without a yield, unapproved recipes on live items, modifiers sold with no recipe,
  foreign lines, open shifts / open orders (timing), recipes of a PACKAGING-vessel brand with no packaging line (decision P1; plate brands never
  warn), pre-cut-over periods ('no FIFO data before <date>').
- Status never green with missing data: 'no_data' | 'incomplete' | 'good' | 'warning' | 'critical'; the target % comes from the brand / company
  setting the existing report used (no hard-coded 30 %).
- Raw SQL casts sums `::bigint` then `toCents`; never `SELECT *` of a widened table.
- `inventoryCloseChecks: CloseCheck[]` (warn, overridable — NO stocktake requirement): 'grni_stale' (receipt lines unbilled > 30 days: count,
  cents, link /procurement/grni) and 'inventory_postings_pending' (open posting_failed flags for inventory.* / procurement.* sources dated ≤ the lock).
  Wave Z adds them to CLOSE_CHECKS.
**reports/foodCostRoutes.ts** (wave Z registers at '/reports/food-cost' BEFORE reportRoutes; w0 added the gate rule) — requireAuth(...FINANCE_TEAM),
dates YYYY-MM-DD as PKT (400 BAD_DATE), resolveTenantScope (empty scope denies), conceptId / locationId / inventoryItemId / tenantId resolved to their
company (foreign → 404); revenue and % fields only for FINANCIALS_VIEWERS — everyone else gets `revenueHidden: true` with quantities and PKR at cost.
GET /summary (one block per company — never blended), GET /ingredients?tenantId&conceptId&locationId&costClass&sort, GET
/ingredients/:inventoryItemId/movements, GET /valuation?tenantId&asOf (lots by class vs 1210/1220/1230; reconciling items: issued-not-yet-booked,
failed postings, the pre-FIFO difference; 2015 vs open receipt lines − pending matches), GET /flags?tenantId (read-only: shrinkage, shrinkage_trend,
yield_low, stock_shortfall, stock_unrecorded, recipe_foreign_stock + posting_failed for inventory.* sources), GET /export.csv?view=summary|ingredients|
valuation, POST /align-inventory { tenantId, dryRun = true } (ADMIN_ONLY → `postFifoAlign`; 404 foreign; 409 ALREADY_ALIGNED / CUTOVER_NOT_RUN).
**workers/scheduledReports.ts:** 'food_cost' → buildFoodCostEmail for the schedule's OWN company (period since lastRunAt, else the previous 7 PKT days;
summary, top 10 unexplained ingredients, warnings; revenue only when the schedule's creator role is in FINANCIALS_VIEWERS); a schedule with tenantId
NULL fails 'failed: no company' (critic); 'menu_engineering' → the existing reports/menu-engineering.ts function; any other type throws → lastStatus
'failed: …'. Remove the stub.
**management/routes.ts (~92, ~107):** foodCostPct split into foodPct / drinksPct / packagingPct + costOfSalesPct on the brand-sales denominator, computed
by `brandSalesRevenueCents` + `costOfSalesSplit` from accounting/reports.ts (one definition). Keep the old field name as costOfSalesPct's alias only if a test or page reads it (report it).
**Admin:** /reports/food-cost — tabs Summary | Ingredients | Valuation | Flags; Summary: food revenue*, theoretical %*, actual %*, AvT points*, a
waterfall (theoretical → comps → staff meals → waste by reason → prep → counts → issue on receipt → price adjustments → actual) with explained vs
unexplained, per brand (measured vs allocated), MC by order type (Dine-in / Takeaway / Delivery), per item, the Q allowance line, the alignment line, warnings as amber banners; Ingredients: sortable by
unexplained PKR, class (Food / Drinks / Packaging) and brand filters, drill-down to lot movements; Valuation: GL tie-out with reconciling items and
the CEO's 'Align' button (dry-run preview first); Flags: read-only list linking to /exceptions; PKT date range; CSV; labels 'Incomplete data' / 'No
sales'; revenue fields hidden when revenueHidden. /reports page: a 'Food cost variance' link-tab when canOpenPath('/reports/food-cost').
menu-engineering/[id]: 'Actual food cost' → 'Plate cost % of price'; the waterfall shows the recipe's packaging lines and the Q allowance instead of
packaging % (remove the packagingPct state and the 8 default). accounting/page.tsx: the hub gauge reads GET /reports/food-cost/summary, shows actual
vs theoretical with corrected labels, links to /reports/food-cost (w4-admin-fa adds the Fixed assets ledger link in W4). Delete
accounting/food-cost/page.tsx (the redirect is in next.config.js). Tokens only (text-success / s-badge-green on target, red over).
""",
consumes=r"""
- w1-stock: StockMovement / StockLot data, lotValuation, postFifoAlign, brandShare. w2-ap: readCutover (pre-FIFO difference, cut-over date).
  w2-sale: RecipeCost (standardCents = plate MC, packagingCents, targetMcCents per order type) + packagingApplies. w2-close: brandSalesRevenueCents + costOfSalesSplit (accounting/reports.ts — the ONE
  denominator and class split). w0: closeCheckTypes, the '/reports/food-cost' gate, module food_cost + MODULE_GRANTS.
""",
exposes=r"""
```ts
// reports/foodCost.ts
export function foodCostSummary(db: Db, a: { tenantIds: string[]; from: Date; to: Date; conceptId?: string; locationId?: string; revenueVisible: boolean }): Promise<FoodCostCompanyBlock[]>
// (brandSalesRevenueCents / costOfSalesSplit live in accounting/reports.ts — w2-close; import them, do not re-export a copy)
export const inventoryCloseChecks: CloseCheck[]
export function buildFoodCostEmail(db: Db, schedule: ScheduledReport): Promise<{ subject: string; html: string }>
// reports/foodCostRoutes.ts
export default async function foodCostRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/reports/food-cost' BEFORE reportRoutes
```
""",
tests=r"""
`foodCostAccess`: every /reports/food-cost route — B → 404 on A's conceptId / inventoryItemId / tenantId; the portfolio view returns separate company
blocks; empty scope denied; foh_management 403 (no food_cost); boh_management 200 with revenueHidden and no revenue fields; finance and fnb_manager
200 with revenue; a CEO untick → 403; an 'accounting'-only role can GET the summary but cannot POST align; align is ADMIN_ONLY. `foodCostReport`:
identity theoretical + explained + unexplained + alignment == ledger cost-of-sales group per brand (open orders and shifts shown as timing); a
refunded order stays in theoretical; service charge, delivery fee and 4200 excluded from revenue; packaging counted for a Simmer takeaway / delivery
order, a Stackd dine-in order and a Simmer dine-in line marked Box given, NOT for a plain Simmer dine-in order; MC split by order type; an order at
23:30 PKT falls on the right day; zero revenue → 'no_data'; a null-cost lot → 'incomplete'; valuation ties to the GL when everything is posted;
inventoryCloseChecks warn on a stale GRNI line. `scheduledFoodCost`: emails only its own company; a NULL-company schedule → 'failed: no company';
an unknown type → 'failed…'. wave3Kitchen / wave3Gates updated to the new path, gate row and MODULE_GRANTS; management suites to the split fields.
""",
))

W3.append(dict(
id="w3-dlv-return", wave="W3", area="delivery (Emergency overrides: code to the rider, food came back)", idx=22,
title="Emergency overrides module: send the hand-over code to the rider, log food a rider brought back as waste, strikes on refusal",
summary="orders/returnedFood.ts, orders/routes.ts (removals + message), emergencyOverrides/{routes,service,README}, admin /emergency-overrides page.",
owns=["backend/src/modules/orders/returnedFood.ts (new)", "backend/src/modules/orders/routes.ts",
      "backend/src/modules/emergencyOverrides/routes.ts (new)", "backend/src/modules/emergencyOverrides/service.ts (new)",
      "backend/src/modules/emergencyOverrides/README.md (new)", "frontend/admin/src/app/emergency-overrides/page.tsx (new)",
      "backend/tests/emergencyOverrides.test.ts (new)", "backend/tests/foodReturned.test.ts (new)",
      "backend/tests/managerVoids.test.ts (W3: rewrite the refused-at-door cases to cancel/void)",
      "backend/tests/integrationPass1.test.ts (W3: refused-at-door cases only)", "backend/tests/cashControls.test.ts (W3: delete the cod-unpaid section; point to codRiderDebt.test.ts)"],
read=["plan_delivery.json: summary, postings (food returned), routes (emergency-overrides, removed routes), build_split A (emergencyOverrides) + B (returnedFood) + E (page)",
      "critic_cash_delivery_onaccount_0.json: violations 1 (paid tenders accepted, pickedUpAt, order's company audit, serviceClient job event, till manager approval), 2 (roles), 4 (no Delivered buttons), Q4 (unreachable = no strike)"],
tasks=r"""
**Owner rule:** a delivery completes ONLY with the customer's code (no staff "Delivered" — w1-dlv-core removed it). When the customer can't give the
code, a manager SENDS the code to the rider's WhatsApp; when the food comes back (refused, unpaid, unreachable) the RGM / chef / F&B manager logs it
here and it is booked as food WASTE. Both actions live in the new "Emergency overrides" section (module `emergency_overrides`: boh_management,
fnb_manager, foh_management (RGM) + management/admin through ALL_MODULES — w0 set the defaults and the '/emergency-overrides' gate).
**orders/returnedFood.ts** `returnUndeliveredOrder(orderId, { actor: { id, email, tenantId, role }, cause: 'refused'|'unreachable'|'other', reason })`:
- Load + validate: a delivery order (422 NOT_A_DELIVERY); not delivered (409 ALREADY_DELIVERED); not completed (409 ORDER_COMPLETED_USE_REFUND);
  an active, picked-up order (app jobs need `pickedUpAt` — 409 NOT_PICKED_UP; 409 ORDER_NOT_ACTIVE otherwise); a rider set (422 NO_RIDER); no active
  terminal charge (409 TERMINAL_CHARGE_ACTIVE). **Paid tenders are ACCEPTED (critic):** the food is wasted either way; any money paid stays for the
  EXISTING cancelled-ticket hand-back (refundOrder → refundDueOnCancelledTicket) — the response returns `refundDueCents` so the manager sees it.
  For a till-channel ('pos') order run the existing `requireManagerApproval` so the approver is recorded like every other void.
- `cancelOrder(orderId, { reason: 'Returned by rider — <cause>: <reason>', actor, approverId: actor.id, action: 'order.returned_by_rider',
  onlyFrom: [the on-the-road statuses], returned: { cause, actorId: actor.id, run } })` (w2-sale hook). `run(tx)` inside the cancel transaction: for
  each non-voided FIRED line `wasteSoldLineTx(tx, { orderId, tenantId, line, wasteReason: RETURN_WASTE_REASON, actorId, conceptId })` (stock stays
  out; Dr 5040 / Cr 1210|1220|1230 by class incl. packaging, key 'pos.void_waste:<orderItemId>'); claim the PENDING COD cash payments → 'failed'
  with gatewayMeta.voided { reason: 'returned_undelivered', at, by } (no fiscal document — the order never completed; pre-bills are cancelled by
  cancelOrder); set Order.returnedAt + returnCause. Returns { wasteLogIds, wasteCostCents, codVoidedCents, postingErrors }.
- After commit: the 'returned' RiderJobEvent through `recordJobEvent` (serviceClient, OUTSIDE the RLS transaction — a fleet rider belongs to another
  company) with actorId; flagPostingFailed per line whose waste posting was refused (same metadata as voidOrderItem); flagException 'food_returned'
  in the ORDER's company with amountCents = the waste cost; `recordStrike({ customerId, kind: 'cod_refused', sourceType: 'order', sourceId, severity:
  1, reason, recordedById, tenantId: order's company })` ONLY when cause === 'refused' (owner default Q4: unreachable is no strike). A replay → 409
  (the claim is already cancelled), no second waste or strike.
**orders/routes.ts:** remove POST /:id/cod-unpaid (~325) and POST /:id/refused-at-door (~390) (paths 404); COMPLETE_ON_DELIVERY message → 'A delivery
completes only with the customer's code — the rider enters it in the rider app. If the customer can't give it, a manager can send it to the rider
(Emergency overrides).'; comment ~274 updated.
**emergencyOverrides/service.ts + routes.ts** (wave Z registers at '/emergency-overrides'): guard requireAuth(...MANAGERS) + the module gate; scope
through the order's concept (`scopeTenantWhere` on concept.tenantId: read for lists, write for actions; foreign → 404).
- GET /emergency-overrides/orders → { onTheRoad: [{ orderId, ref (orderRefOf), brand, customerName, stage, rider { id, name, fleetPartner },
  cashToCollectCents, codeLocked, rerouted, doorProblem, minutesOut }], recent: [RiderJobEvent code_rerouted | returned of the last 14 days with
  actor, rider, reason] }. A fleet partner's rider appears only on the client company's own orders.
- POST /orders/:id/send-code-to-rider { reason 10-300 } → `rerouteHandoverCode` (w1-dlv-core) → { ok, sentToRider, riderPhoneHint } (its 409/422
  codes pass through: NOT_A_DELIVERY, ALREADY_DELIVERED, NOT_READY, NO_RIDER, NOT_PICKED_UP, ALREADY_REROUTED, RIDER_HAS_NO_PHONE, ORDER_CHANGED).
- POST /orders/:id/send-code-to-rider/resend {} → `resendReroutedCode` (409 NOT_REROUTED / ALREADY_DELIVERED; rate limit 3 per 10 min per order).
- POST /orders/:id/food-returned { cause, reason 5-500 } → returnUndeliveredOrder → { ok, wasteCostCents, wasteLogIds, codVoidedCents, refundDueCents,
  strike: { recorded, duplicate } | null }.
- README: the contract, roles, what each action books, the owner questions still open (Q1 RGM login, Q5 prepaid returned food).
**Admin page /emergency-overrides** (polls every 8 s): table of orders on the road; 'Send code to rider' dialog (reason required; 'one per order;
reviewed'); 'Food came back' dialog (cause radio: 'Refused or would not pay — records a strike' / 'Could not reach the customer' / 'Our mistake or
other'; reason; a preview of the lines that will be booked as waste and of the COD that will be voided; after success shows refundDueCents with a
link to the order's hand-back when > 0); recent-overrides log; every error code in words. Tokens only, no emoji.
""",
consumes=r"""
- w2-sale: cancelOrder `returned` hook, wasteSoldLineTx, RETURN_WASTE_REASON. w1-dlv-core: rerouteHandoverCode, resendReroutedCode, recordJobEvent.
  w1-bans: recordStrike(tenantId). w0: Order.returnedAt/returnCause, module emergency_overrides + gate, exception kinds food_returned / delivery_code_rerouted.
""",
exposes=r"""
```ts
// orders/returnedFood.ts
export function returnUndeliveredOrder(orderId: string, a: { actor: { id: string; email: string; tenantId: string | null; role: string };
  cause: 'refused'|'unreachable'|'other'; reason: string }): Promise<{ ok: true; wasteCostCents: number; wasteLogIds: string[]; codVoidedCents: number;
  refundDueCents: number; strike: { recorded: boolean; duplicate: boolean } | null }>
// emergencyOverrides/routes.ts
export default async function emergencyOverridesRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/emergency-overrides'
```
""",
tests=r"""
`emergencyOverrides` (two companies): B → 404 on A's order for list, send-code and food-returned; roles: cashier and owner → 403, boh_management,
fnb_manager, foh_management and management → 200 (a CEO untick of the module → 403); reroute once per order (second → 409), the code rotates (the old
code is refused in the rider app), attempts reset with the snapshot kept, the event carries actorId, the exception lands in A, WhatsApp mocked to the
rider's phone; assignRider to another rider → 409; a fleet rider of B carrying A's order: A's manager can reroute, B's cannot see it. `foodReturned`:
order 'cancelled' with returnedAt/returnCause; one WasteLog per line with reason returned_food; Dr 5040 / Cr 1210 (Cr 1230 for the packaging) in A
under 'pos.void_waste:<lineId>'; stock NOT restored; the COD row 'failed'; no FiscalDocument; pre-bills cancelled; a paid card order is accepted and
returns refundDueCents (the hand-back pays it later); a strike with tenantId A only for 'refused'; replay → 409 with no second waste or strike;
completed → 409; delivered → 409; not picked up → 409; a locked period → the cancel stands and posting_failed is flagged; the generic cancel of a
picked-up delivery → 409 USE_EMERGENCY_OVERRIDE (w2-sale). The old routes (/cod-unpaid, /refused-at-door) → 404. Rewrite the managerVoids /
integrationPass1 cases that used refused-at-door; delete the cod-unpaid section of cashControls.
""",
))

W3.append(dict(
id="w3-cash-requests", wave="W3", area="cash (cash requests replace vouchers; receipts book the expense; stock + capex lines)", idx=23,
title="Cash requests: anyone raises → HOD → director → custodian pays (advance on 1355) → holder's receipts book it; overdue → loan/director (H3)",
summary="trustops/cashVouchers.ts rework, trustops/cashRequestSettle.ts, pettyCash.ts + pettyCashPosting.ts (W3: stock + capex lines, settlement/conversion posters), cashAdvanceOverdue worker, cash-requests admin pages.",
owns=["backend/src/modules/trustops/cashVouchers.ts", "backend/src/modules/trustops/cashRequestSettle.ts (new)",
      "backend/src/modules/trustops/pettyCash.ts (W3: stock + capex line kinds)", "backend/src/modules/accounting/pettyCashPosting.ts (W3: stock/capex lines, settlement + conversion posters)",
      "backend/src/workers/cashAdvanceOverdue.ts (new)",
      "frontend/admin/src/app/finance/cash-vouchers/** (page.tsx, [id]/page.tsx, VoucherDetail.tsx, VoucherForm.tsx, VoucherPrint.tsx, data.ts, photo.ts, ui.tsx, SettlePanel.tsx (new), ConvertPanel.tsx (new))",
      "frontend/admin/src/components/finance/SpendLinesEditor.tsx (W3: stock + capex line kinds)", "frontend/admin/src/components/finance/ReceiptUploader.tsx (W3, if needed)",
      "backend/tests/cashVouchers.test.ts (rewritten for cash requests)", "backend/tests/cashRequestSettle.test.ts (new)",
      "backend/tests/cashAdvanceOverdue.test.ts (new)", "backend/tests/pettyCashStockCapexLines.test.ts (new)"],
read=["plan_cash.json: summary 2, postings (cashvoucher.*), routes (cash-vouchers), build_split B + D",
      "critic_cash_delivery_onaccount_1.json: violations 2 (one stock-in contract), 4 (HOD = HR's rule, no hr/reportingLine.ts), 5 (H3 worker auto-converts), 9 (legacy holders), 10 (custodian box picker), 11 (HOD provider), 15 (hygiene)",
      "critic_assets_foodcost_0.json violation 2 (cash-bought equipment only through the cash-request seam)"],
tasks=r"""
**Flow (owner, replaces the voucher flow):** anyone raises → HOD signs → director (the CEO, role admin) approves → Jamil sb (the box custodian) PAYS
and marks it paid (no photo) → the holder uploads receipts → the receipts book the expense. Paying is an ADVANCE: Dr 1355 / Cr 1011 (H3); receipts
book Dr expense / Cr 1355; change goes back to a box (Dr 1011 / Cr 1355); unsettled after `cashAdvanceSettleDays` (default 30) converts (H3). The
paper stays 'Cash payment voucher' with CV numbers; the UI says 'Cash requests'.
**trustops/cashVouchers.ts (rework; header rewritten):**
- Raise: requireAuth(ALL_STAFF), binds to activeTenantId; { amountCents (zInt4Cents > 0), purpose, voucherDate?, conceptId?, department?,
  holderUserId? (default me; another member login of the company allowed), payeeName? (default the holder's name), boxId? (keepers only → 403
  BOX_PICK_KEEPERS_ONLY) } → 'draft'. 422 NO_ACTIVE_COMPANY / CONCEPT_NOT_IN_COMPANY / PAYEE_NOT_IN_COMPANY / BOX_NOT_IN_COMPANY. No category.
- List/read scoping: keepers (CASH_KEEPERS) everything in read scope; others only rows they raised, hold, may sign as HOD, or approved-or-later on a box
  they hold (or unboxed approved in a company where they hold a box); `?view=mine|hod|to_pay|receipts_due|overdue|all` + status + cursor (400
  BAD_CURSOR). Lists never select attachment bytes.
- **HOD (critic — HR's rule, no second hierarchy):** sign-hod allowed for a cash keeper OR the holder's direct manager login
  (`directManagerUserIdOf(tenantId, holderUserId)` from hr/service.ts); 'waiting for my signature' uses `teamUserIdsUnder`. The holder can never
  sign (409 SELF_SIGN_HOD); others 403 NOT_HOD. draft → hod_signed.
- approve: ADMIN_ONLY, 409 SAME_SIGNER kept (the director is never the HOD signer); reject from draft (HOD-eligible) or hod_signed (CEO) with a
  note; cancel by the raiser (draft) or a keeper (draft | hod_signed | approved) — 409 VOUCHER_NOT_CANCELLABLE; PATCH draft only.
- **POST /:id/pay { boxId? }** (replaces /disburse): the custodian of the box or a keeper (only a keeper may change a box already set; default = the
  custodian's only box in the request's company (GET /petty-cash/boxes?mine=1)) — ONE tx: claim approved → disbursed (409 ALREADY_PAID /
  VOUCHER_NOT_APPROVED / BOX_UNAVAILABLE), set boxId / cashierName / dueBy (= now + cashAdvanceSettleDays), `recordPettyCashSpendTx({ nature:
  'advance', cashVoucherId, … })` (Dr 1355 / Cr 1011; 400 INSUFFICIENT_FLOAT rolls back). 403 NOT_CUSTODIAN; 422 BOX_NOT_IN_COMPANY /
  PERIOD_LOCKED. **Only this puts money in cash; nothing else moves cash.**
- Remove POST /:id/photo and /:id/disburse; add GET /:id/attachments/:aid (sendEvidence; legacy 'signed_voucher' photos still readable).
- Legacy disbursed rows with no holder (payeeUserId null): shown as 'needs review' — keepers only, never flagged against preparedById, never converted
  until finance names the holder: PATCH /:id { holderUserId } by a keeper is the ONE edit allowed outside 'draft' (only on such a row; audited).
**trustops/cashRequestSettle.ts (child routes of cash-vouchers):** POST /:id/receipts { photo, mime } (holder or keeper; status disbursed; ≤ 20 per
request → 409 TOO_MANY_RECEIPTS; lib/evidenceFile images; bodyLimit 6 MB); DELETE /:id/receipts/:aid (uploader or keeper, unlinked only → 409
RECEIPT_IN_USE); **POST /:id/settlements** { lines [expense | stock | capex], receiptIds [≥ 1], note? } (holder or keeper; voucher row FOR UPDATE; Σ
lines ≤ remaining (= amount − settled − returned − converted) → 422 RECEIPTS_OVER_ADVANCE; 400 RECEIPT_REQUIRED / LINES_EMPTY; 422
RECEIPT_NOT_ON_REQUEST): `resolveSpendLinesTx`, create CashVoucherSettlement (seq) + PettyCashSpendLine rows (settlementId), link receipts,
**stock lines → `recordCashPurchaseStockTx(tx, { settledBy: { kind: 'cash_voucher_settlement', id, creditAccountCode: '1355' }, … })`, capex lines
→ `recordCapexPaymentFromCashTx(tx, { …, creditCode: '1355' })`**, then `postCashVoucherSettlementTx` (ONE entry 'cashvoucher.settle:<settlementId>':
Dr each line's account (6xxx / 12x0 by class / 1340 — never a 'cogs' key: 422 USE_STOCK_LINE) / Cr 1355), counters, status 'settled' when remaining = 0; PATCH
/:id/settlements/:sid/lines/:lineId { categoryKey | accountCode } (CASH_GUARD; expense lines only → 409 STOCK_LINE_FIXED; syncSourcePosting
repost + re-stamp); POST /:id/return-change { amountCents, boxId? } (custodian of the box (default the request's) or keeper; ≤ remaining → 422
OVER_REMAINING; `recordPettyCashTopupTx({ source: 'cash_request', cashVoucherId })` Dr 1011 / Cr 1355, no top-up-limit check); POST /:id/convert
{ to: 'director_account'|'staff_loan', installments? (1-24), note } (ADMIN_ONLY; disbursed with remaining > 0): director_account needs a holder with
role admin|owner (422 HOLDER_NOT_A_DIRECTOR) → `postCashVoucherConversionTx` Dr 1356 / Cr 1355; staff_loan needs an active HrEmployee of the request's
company linked to the holder (422 HOLDER_NOT_AN_EMPLOYEE) → `createLoanFromCashAdvanceTx` (w1-hr; Dr 1350 / Cr 1355 via its loan disbursement with
paidFrom 'cash_request') → status 'converted'.
**pettyCash.ts + pettyCashPosting.ts (W3 additions to w2-cash-ledger's files):** line kinds 'stock' and 'capex' now work for BOTH a direct box spend
(Cr 1011, settledBy kind 'petty_cash_movement') and a settlement (Cr 1355): stock lines only for keepers or inventory-module roles (403
STOCK_LINES_NOT_ALLOWED), the item must be the company's, quantity + unit convert (422 UNIT_MISMATCH), refused on a spend that pays a supplier bill
(422 STOCK_ON_BILL_SPEND), PettyCashSpendLine.receiptLineId stored; capex lines need a CapEx line of the same company (422 CAPEX_LINE_NOT_IN_COMPANY),
capexPaymentId stored (one-time guard per company) — cash-bought equipment comes ONLY through this seam (no cash → 1010 path). Expense lines keep the
equipment guard (assertNotEquipmentLine → 422 USE_CAPEX). Add `postCashVoucherSettlementTx(tx, settlementId, opts?)` and
`postCashVoucherConversionTx(tx, voucherId, by)`; remove the W2 *_UNAVAILABLE refusals.
**workers/cashAdvanceOverdue.ts (H3 — the worker auto-converts):** daily 09:10 PKT, loop over companies that HAVE overdue requests (not only
isActive tenants), serviceClient: disbursed requests with dueBy < now and remaining > 0 and overdueFlaggedAt null → holder is a director (admin|owner)
→ convert to the director's account (convertedById 'system'); holder is an active employee → staff loan (installments default 3); neither (or
legacy with no holder) → flagException 'cash_advance_overdue' (request's company, amount = remaining); stamp overdueFlaggedAt. Export
`runCashAdvanceOverdueOnce(now?)`. A refused conversion → flag 'cash_request_needs_review'.
**Admin (/finance/cash-vouchers/** + shared editors):** relabel to 'Cash requests'; '+ Request cash' for every login; views My requests / Waiting for
my signature / Waiting for director / To pay / Receipts due / Overdue / Settled / All; VoucherForm (amount, purpose, needed on, brand, department,
holder (me or another login for keepers), box for keepers only — no category); VoucherDetail steps Raised → HOD → Director → Paid → Receipts (x of y)
→ Settled / Converted; actions by capability flags the API returns (Sign as HOD, Approve / Reject, Pay (box picker from GET
/trustops/petty-cash/boxes?mine=1, confirm 'cash handed to <holder>'), Print); SettlePanel (ReceiptUploader to /:id/receipts, SpendLinesEditor,
'Submit receipts', settlements list with lines and receipt thumbnails, finance line reclass, 'Change returned'); ConvertPanel (CEO); VoucherPrint
(+ 'Raised by', 'Receipts due by'); data.ts (statuses settled / converted / needs review; words for every new error code; delete
CATEGORY_SUGGESTIONS); photo.ts re-exports lib/photoPrep. SpendLinesEditor gains 'Stock item' lines (item picker GET /inventory/items, hidden on
403; quantity + unit + amount) and 'Equipment (CapEx)' lines (CapEx line picker, finance only). Tokens only, no emoji.
""",
consumes=r"""
- w2-cash-ledger: recordPettyCashSpendTx / recordPettyCashTopupTx, resolveSpendLinesTx, postPettyCashMovementTx, FUNDING_ACCOUNT, GET boxes?mine=1,
  SpendLinesEditor / ReceiptUploader / lib/photoPrep. w2-ap: recordCashPurchaseStockTx. w2-fa-capex: recordCapexPaymentFromCashTx.
  w1-hr: directManagerUserIdOf, teamUserIdsUnder, createLoanFromCashAdvanceTx. w1-fa-engine: assertNotEquipmentLine. w0: lib/evidenceFile.ts,
  CashVoucher / Settlement / SpendLine schema, ACCT.CASH_ADVANCES / DIRECTOR_CURRENT / STAFF_LOANS / PETTY_CASH, OperationsConfig.cashAdvanceSettleDays.
""",
exposes=r"""
```ts
// accounting/pettyCashPosting.ts (W3 additions)
export function postCashVoucherSettlementTx(tx: Tx, settlementId: string, opts?: RepostOptions): Promise<{ entryId: string }>
export function postCashVoucherConversionTx(tx: Tx, voucherId: string, by: { id: string }): Promise<{ entryId: string }>
// workers/cashAdvanceOverdue.ts
export function startCashAdvanceOverdueWorker(): void
export function runCashAdvanceOverdueOnce(now?: Date): Promise<{ converted: number; flagged: number }>
// trustops/cashVouchers.ts — list rows carry capability flags for the UI
// { canSignHod, canApprove, canReject, canCancel, canPay, canUploadReceipts, canSettle, canReturnChange, canConvert, canReclass }
```
""",
tests=r"""
`cashVouchers` (rewritten, two companies): a cashier raises in the active company (draft, holder = self); a holder from B → 422; HOD = a keeper or the
holder's direct manager login, an unrelated staff member → 403, the holder → 409 SELF_SIGN_HOD; director ADMIN_ONLY + 409 SAME_SIGNER; pay by the
custodian with NO photo posts Dr 1355 / Cr 1011, sets dueBy and lowers the float; two concurrent pays pay once; INSUFFICIENT_FLOAT rolls back; a
non-custodian non-keeper → 403; the old /disburse and /photo → 404; B → 404 on every route of A's request. `cashRequestSettle`: receipts bad bytes →
400, another user → 403, > 20 → 409; a partial settlement posts Dr lines / Cr 1355 and stays disbursed; over the remaining → 422; no receipt → 400;
another request's receipt → 422; a stock line creates a settled goods receipt + lot and Dr 1210 (1230 for packaging) / Cr 1355 in ONE entry; a capex
line creates the CapEx payment once (replay no-op) and Dr 1340; return change posts Dr 1011 / Cr 1355 then settled; racing settlements never exceed
the amount; reclass reverses and reposts; convert: CEO only, director_account Dr 1356 / Cr 1355, staff_loan creates an approved HR loan (Dr 1350 /
Cr 1355; HR cancel → 409 LOAN_FROM_CASH_REQUEST); holder not an employee → 422. `cashAdvanceOverdue`: a director's overdue rest converts to 1356, an
employee's to a staff loan, a non-employee non-director is flagged once — each in the request's company only; legacy no-holder rows are never
touched. `pettyCashStockCapexLines`: direct box spend with a stock line (keeper) → settled receipt + Dr 12x0 / Cr 1011; custodian without the
inventory module → 403; stock line on a bill spend → 422; B's item / CapEx line → 422/404.
""",
))

W3.append(dict(
id="w3-fa-api", wave="W3", area="assets (API, reports, automatic monthly worker)", idx=24,
title="Fixed-asset API: register, requests (finance asks, CEO approves), pools and counts, classes/policy, reports incl. tax; the depreciation worker",
summary="fixedAssets/routes.ts + requests.ts + pools.routes.ts + reports.ts + README, workers/depreciation.ts; removes the deprecated aliases and the hand-add route.",
owns=["backend/src/modules/fixedAssets/routes.ts", "backend/src/modules/fixedAssets/requests.ts (new, registered inside routes.ts)",
      "backend/src/modules/fixedAssets/pools.routes.ts (new, registered inside routes.ts)", "backend/src/modules/fixedAssets/reports.ts (new)",
      "backend/src/modules/fixedAssets/README.md (new)", "backend/src/modules/fixedAssets/service.ts (W3: delete the deprecated runDepreciation / ASSET_CATEGORIES aliases only)",
      "backend/src/workers/depreciation.ts (new)",
      "backend/.sim/books/fin403.ts", "backend/.sim/ui-r2/verify/zzverify_ui_3.test.ts",
      "backend/tests/fixedAssetsCompany.test.ts (new)", "backend/tests/fixedAssetsReports.test.ts (new)", "backend/tests/fixedAssetsRls.test.ts (new)",
      "backend/tests/fixedAssetsRun.test.ts (W3: worker cases)", "backend/tests/wave3Finance.test.ts (W3: fixed-asset cases)", "backend/tests/sepFinance.test.ts (W3: fixed-asset cases)"],
read=["plan_assets.json: routes (all /accounting/fixed-assets), build_split B, removes, assumptions",
      "critic_assets_foodcost_0.json: violations 1 (no autoDepreciation), 9 (no gate widening, no ModulePage.roles), 17 (tie-out as-of), 20 (two-company cases, .sim importers), 21 (every capitalisation to the CEO — open question)"],
tasks=r"""
**Owner rules:** depreciation is AUTOMATIC monthly (no switch); no threshold; smallwares pooled per outlet/type (24 months), big items individual;
disposals / scraps / write-downs: finance requests, the CEO approves (the F&B manager NOT); no opening / pre-servd assets; equipment only via CapEx.
**Routes** (all under '/accounting/fixed-assets', the existing plugin; module gate 'accounting' — do NOT add gate rules or ModulePage.roles — critic).
Roles local to the module: READERS = FINANCIALS_VIEWERS; FA_WRITERS = ['admin','owner','management','finance']; APPROVER = ADMIN_ONLY. Reads use the
RLS prisma client; every write audited with the ROW's tenantId; foreign → 404; cross-company ids on create → 422.
- GET / (READERS, read scope; asOf, status, classKey, conceptId, locationId, poolId, kind, format=csv): rows with tenantId, companyName, cost,
  accumulated, NBV as of asOf, nextChargeCents, lastChargedPeriod, pendingRequestCount; totalsByCompany always; totals for a single company; lastRun
  per company (FixedAssetRun). GET /lookups (classes per company in scope, SMALLWARE_TYPES, locations, brands, suppliers, pools, disposal kinds — the
  page calls no other gated path). GET /:id (asset, posted + forecast schedule, events, depreciation rows, tax schedule, CapEx link, journal refs).
  PATCH /:id (FA_WRITERS, write; descriptive fields only: name, serialNumber, notes, warrantyUntil, documentUrls, photoUrls, supplierId via
  assertSupplierOfCompany → 422; cost / life / dates / class / brand / location / capexLineId → 400; audited before/after).
- POST / → 422 USE_CAPEX ('Equipment goes on the register only through CapEx (Finance → Project tracker or Quick buy)') — handler removed.
- POST /depreciate { throughPeriod 'YYYY-MM' } (FA_WRITERS; 'charge now / catch up' for the ACTIVE company): chargeThrough → which company it charged;
  422 MONTH_NOT_ENDED, 400 BAD_PERIOD, 409 RUN_IN_PROGRESS. GET /runs (READERS).
- **Requests (requests.ts):** POST /:id/requests { kind: disposal|impairment|change_estimate|void|undispose|transfer, effectiveDate, reason ≥ 10, payload }
  (FA_WRITERS; disposal payload { kind sale|scrap|lost|stolen, proceedsCents, method, bankAccountId } via moneyAccountCode; transfer { toLocationId,
  toConceptId } same company → 422) → createRequest: approval kinds 202 pending for non-CEO, 201 applied for the CEO; transfer 201 at once; 422
  DISPOSAL_DATE, 409 ALREADY_DISPOSED / REQUEST_PENDING / ASSET_HAS_EVENTS. POST /:id/dispose stays as an alias creating a disposal request. GET
  /requests?status&kind (READERS — the queue the approvals provider reads). POST /requests/:id/approve (APPROVER → applyEvent; 409 NOT_PENDING /
  BOOKS_CLOSED_TODAY; module errors pass through and the event keeps errorMessage), /reject { note } (APPROVER), /cancel (requester or APPROVER).
- **Pools (pools.routes.ts):** GET /pools?locationId&conceptId&typeKey (units on hand, layers, NBV, last count); POST /pools/:poolId/requests { kind:
  write_off|transfer_units, units, effectiveDate, reason, payload } (write_off 202/201; transfer_units 201; 422 UNITS_EXCEED_POOL); POST
  /pools/:poolId/counts { countedUnits, countedAt, note } (FA_WRITERS + fnb_manager; a posted 'count' event, no money; returns the shortfall).
- Classes / policy: GET /classes (READERS); PATCH /classes/:id (APPROVER; label, defaultLifeMonths, taxRateBp, taxInitialAllowanceBp, pooled, isActive
  — account codes fixed per key); GET /policy (READERS); PATCH /policy (APPROVER, activeTenantId: capexUncapitalisedAlertDays, capexAdvanceOverdueDays,
  deferredTaxRateBp, assetTagPrefix — NO autoDepreciation; writes only that company's OperationsConfig row, invalidates its cache;
  /setup/operations-config is NOT widened).
- **Reports (reports.ts):** /reports/schedule?from&to&groupBy=class|brand|location|pool|asset, /reports/roll-forward?from&to, /reports/nbv?asOf&groupBy,
  /reports/tie-out?asOf (register vs GL per class cost + accumulated via `ledgerBalancesByCode(…, { asOf })`, 1590 residue, 2012 vs CapEx owed, 1310
  vs unreleased prepaid, 1360 vs deposits held; as-of reports use postedPeriod and the posting date — critic), /reports/advances?asOf (1340 by line,
  age, flags delivered_uncapitalised / overdue_delivery / capitalisation_pending / orphan), /reports/tax?taxYear (single company = activeTenantId),
  POST /reports/tax/:taxYear/freeze (APPROVER; 409 TAX_YEAR_FROZEN; 422 TAX_YEAR_OPEN), /reports/deferred-tax?taxYear (report only); format=csv via toCsv
  (CSV equals JSON). READERS; resolveTenantScope.
**workers/depreciation.ts:** `startDepreciationWorker()` — node-cron '20 3 * * *' Asia/Karachi, in-process running guard, serviceClient;
`runDepreciationOnce(now?)` loops companies (deletedAt null) → runForTenant: (1) ensureAssetClasses + reclassLegacyAccumulated, (2) chargeThrough to
the previous PKT month (ALWAYS — no switch), (3) `releasePrepaidThrough` (w2-fa-capex) to the previous month, (4) de-duplicated flags
(shrinkageTrend pattern): capex_uncapitalised, capex_advance_overdue, capex_orphan_advance, capex_prepaid_unscheduled (legacy rows only),
fixed_asset_gl_mismatch (current balances only — critic), depreciation_failed; (5) FixedAssetRun rows. Wave Z starts it and adds /health.
**Clean-up:** delete the deprecated `runDepreciation` / `ASSET_CATEGORIES` aliases w1-fa-engine kept (grep: no importer may remain — financePlanning
was moved by w2-fa-capex; if one remains, report it); update or delete the .sim importers of the removed API (fin403.ts, zzverify_ui_3.test.ts).
README.md: chargeThrough is the one path; event kinds and who approves; posting keys and the late-dating rule; capexLineId; the class-account map;
the open owner question (every capitalisation to the CEO).
""",
consumes=r"""
- w1-fa-engine: classes / schedule / service / events / pools / tax / closeCheck exports. w2-fa-capex: releasePrepaidThrough, assertSupplierOfCompany,
  capex lookups. w0: ledgerBalancesByCode asOf, FixedAsset* schema, taxYearOf.
""",
exposes=r"""
```ts
// workers/depreciation.ts
export function startDepreciationWorker(): void
export function runDepreciationOnce(now?: Date): Promise<Array<{ tenantId: string; charged: number; failed: number }>>
// fixedAssets/reports.ts
export function fixedAssetTieOut(db: Db, tenantIds: string[], asOf?: Date): Promise<Array<{ tenantId: string; byClass: Array<{ classKey: string; costDiffCents: number; accumDiffCents: number }>; legacy1590Cents: number; ok: boolean }>>
// (wave Z /health: fixedAssets = fixedAssetTieOut + the last FixedAssetRun per company)
```
""",
tests=r"""
`fixedAssetsCompany` (two companies): B → 404 on every A row route (GET/PATCH /:id, requests, approve/reject/cancel, pools, counts, classes PATCH,
tax freeze, /depreciate charges only the active company); creates bind to the active company; cross-company location / brand / supplier / pool ids
→ 422; the portfolio view labels companies; lookups and policy are per company; fnb_manager 403 on every write except pool counts, 200 on reads;
POST / → 422 USE_CAPEX. `fixedAssetsReports`: roll-forward ties to the GL per class; NBV as of 30 June by class/brand/location/pool; tie-out shows
the 1590 residue and as-of balances; a manual JE to 1510 without an override → 422, with one → mismatch flag on the next worker run; advances flags;
tax IA/WDV, freeze idempotent and frozen years unchanged after a class-rate edit; deferred tax at 29 %; CSV equals JSON; B's scope excludes A.
`fixedAssetsRun` (worker cases): the worker loops both companies into their own ledgers, idempotently, writes FixedAssetRun rows, releases prepaid,
raises de-duplicated flags. `fixedAssetsRls`: with RLS_ENFORCE=1, A cannot read or update B's rows in the new / extended fixed-asset tables;
serviceClient sees both. wave3Finance: finance capitalise → 202 pending, CEO approve → 201, fnb_manager 403 on writes / 200 on reads. sepFinance
(~281-288): POST / → 422 USE_CAPEX; the cross-company location 422 moves to the capitalise body.
""",
))

W3.append(dict(
id="w3-admin-finance", wave="W3", area="admin UI — tax, reconciliation (card payouts, COD, backfill), operations config, OpEx, gift cards, delivery zones", idx=None,
title="Admin finance pages: sales-tax return (H8-H13 rows, withholding rates/register), card payouts, COD tab, petty-cash history backfill, OpEx tax/WHT, gift-card breakage, settings",
summary="UI only — reconciliation page + tabs, sales-tax-return pages, OpEx page, gift cards, delivery zones, operations config.",
owns=["frontend/admin/src/app/reconciliation/page.tsx", "frontend/admin/src/app/reconciliation/CardPayouts.tsx (new)",
      "frontend/admin/src/app/reconciliation/CodTab.tsx (new)", "frontend/admin/src/app/reconciliation/BackfillUnposted.tsx",
      "frontend/admin/src/app/reconciliation/README.md", "frontend/admin/src/app/reconciliation/MissedBillVariances.tsx (DELETE)",
      "frontend/admin/src/app/accounting/sales-tax-return/page.tsx", "frontend/admin/src/app/accounting/sales-tax-return/README.md",
      "frontend/admin/src/app/accounting/sales-tax-return/WithholdingRates.tsx (new)", "frontend/admin/src/app/accounting/sales-tax-return/WithholdingRegister.tsx (new)",
      "frontend/admin/src/app/finance/opex/page.tsx", "frontend/admin/src/app/gift-cards/page.tsx",
      "frontend/admin/src/app/configuration/delivery-zones/page.tsx", "frontend/admin/src/app/configuration/operations/page.tsx"],
read=["plan_tax.json: build_split T6-admin-ui, routes (withholding, card payouts, opex wht-quote, gift cards)",
      "plan_delivery.json: build_split E (CodTab only); plan_cash.json: critic 7 (history backfill UI lives in BackfillUnposted.tsx); plan_people.json: statutory rows filtered on the return",
      "the backend route files on disk: accounting/withholdingRoutes.ts, reconciliation/cardPayoutRoutes.ts + codRoutes.ts + pettyCashBackfillRoutes.ts, opex/routes.ts, giftCards/routes.ts, setup/routes.ts"],
tasks=r"""
1. **Sales tax return page:** new rows Delivery charges, No-show deposits kept, per authority 'Withheld by customers (1335)' and 'Net after withholding';
   statutory challans (salary tax / EOBI / SESSI) are NOT listed among the return's payments (they live on Accounting → Statutory payments); the
   record-payment dialog gains 'Withheld by customers set off' (shows the available amount from the API; 422 NO_WITHHELD_SET_OFF in words). Tabs
   'Withholding rates' (WithholdingRates.tsx — editable for admin/finance via PUT /accounting/withholding/rates, read-only otherwise by the API's
   capability flag) and 'Withholding register' (WithholdingRegister.tsx — table + CSV link). README.
2. **Reconciliation:** CardPayouts.tsx — settings card (payout bank via BankAccountSelect, MDR %, tax on fee %, lag days, tolerance, unit), settlements
   list, unsettled card days, Re-run, Undo for approvers; mount it in page.tsx with a 'Card payout' chip on matched lines and a 'Card payout?' action on
   unmatched credits of the payout bank (suggestions → Confirm; 409 USE_CARD_PAYOUT_CONFIRM / CARD_PAYOUT_LINE in words). CodTab.tsx — COD with
   rider / overdue / owed by rider (GET /reconciliation/cod?status=…) with 'Book as owed by rider' (reason; finance) and the legacy option when the
   API offers it. BackfillUnposted.tsx — a 'Petty-cash history' section (CEO): dry run table (per company historic top-up source pick, Garibsons or
   Safe, with the resulting 1010 balance and a warning when it goes negative), picks for needs_category / needs_review, then Post (POST
   /reconciliation/backfill-petty-cash; 409 BACKFILL_RUNNING). Remove the MissedBillVariances mount and delete MissedBillVariances.tsx (its route is
   gone). README.
3. **OpEx page:** line form — Vendor picker (GET /procurement/suppliers?view=picker&categoryId=…, 'Add in Procurement' link when canOpenPath), WHT
   section, usual tax authority, prepaid term (coversFrom / coversMonths) for rent advances; mark-paid form — invoice amount (incl. sales tax), sales
   tax + 'Charged by', WHT from /opex/wht-quote (rate, filer chip, amber 'Check ATL status' when needsAtlCheck), cash paid, override + reason;
   BankAccountSelect; equipment refusal (422 USE_CAPEX) explained with a link to CapEx Quick buy.
4. **Gift cards:** the void dialog offers 'Keep the money (breakage — other income, no sales tax)' for sold cards to admin only (the API decides —
   show what it allows); the drawer shows breakage amount/date and 'held' when the issue was never booked; the books check shows breakage.
5. **Delivery zones:** fee label 'Fee (before GST)' + helper 'GST is added at checkout at the brand's rate: 15 % cash, 8 % card or Raast'.
6. **Operations config:** the withholding % input becomes a link to Accounting → Sales tax return → Withholding rates (the on/off switch stays);
   a 'Cash requests: receipts due within (days)' field (cashAdvanceSettleDays 1-365).
All pages: tokens only, money typed in rupees, server figures shown as given (no tax maths in the browser), every error code in words, phone width.
""",
consumes=r"""
- w1-taxcore withholding routes; w1-recon card payout routes; w2-dlv-cod codRoutes; w2-cash-ledger backfill route; w2-taxbooks OpEx routes + wht-quote;
  w1-taxsales gift-card routes; w1-taxcore (W1) already dropped withholdingTaxPct from PATCH /setup/operations-config and added cashAdvanceSettleDays
  (1-365) — the page must not send withholdingTaxPct.
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. Run `npx tsc --noEmit -p .` in frontend/admin and make your files clean. Manual checklist for the orchestrator's screenshots: the
return page with the new rows as finance; withholding rates read-only for management; card payout confirm flow; COD tab as finance; petty-cash
history dry run as the CEO; OpEx mark-paid with WHT quote; gift-card breakage option visible only to the CEO; phone width without horizontal scroll.
""",
))
