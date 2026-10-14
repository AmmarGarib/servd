# Wave B — shared files: merged changes and ONE owner per file per wave

Rule: in any wave a file has exactly ONE owner. A file may change hands between waves (waves are sequential, so two agents
never edit it at the same time). An agent that needs a change in a file it does not own in its wave writes the exact snippet
in its report ("patch notes"); the orchestrator applies it in wave Z (or hands it to that file's next owner).

Agent ids (see build-waves.md): `w0` = orchestrator before wave 1; `wZ` = orchestrator after wave 4.
W1: w1-stock, w1-taxcore, w1-fa-engine, w1-hr, w1-ic, w1-recon, w1-bans, w1-taxsales, w1-dlv-core
W2: w2-sale, w2-ap, w2-ledger, w2-fa-capex, w2-taxbooks, w2-oa-recv, w2-dlv-cod, w2-cash-ledger, w2-close
W3: w3-till, w3-stockdocs, w3-recipes, w3-fc-report, w3-dlv-return, w3-cash-requests, w3-fa-api, w3-admin-finance
W4: w4-integration, w4-admin-fa, w4-admin-stock, w4-admin-delivery, w4-apps, w4-customer, w4-admin-oa, w4-docs

Legend for areas: FA = assets, FC = foodcost, TX = tax, PP = people, CA = cash, DL = delivery, OA = onaccount.

---

## A. Orchestrator-only (wave 0 and/or wave Z)

### backend/prisma/schema.prisma + migrations — w0
Exactly schema-merged.prisma.md (two migration files), then `prisma generate`.

### backend/src/lib/chartOfAccounts.ts — w0
chart-merged.md §2–§5 (FA, FC, TX, PP, CA, DL, OA codes; renames; REQUIRED merge; `controlledBy` template field;
`assertTemplateAccounts`; `REGISTER_CONTROLLED_CODES`; reserved-range header incl. 6990 shared with D1).

### backend/src/modules/accounting/journal.ts — w0
chart-merged.md §6–§7: ACCT additions (all areas), TILL_CLEARING_CODES + ON_ACCOUNT_MEMO (OA), CONTROLLED_PREFIX + the controlled-account
rule incl. 'fixed_asset' override (PP + FA, one mechanism), `controlledOverride` input, `lateDatingFor` (FA). Nothing else.

### backend/src/modules/accounting/sourcePosting.ts — w0
- `syncSourcePosting(…, { keepLiveDate?: boolean })`: when a live revision exists and keepLiveDate is true, desired.entryDate reuses the
  live entry's date (late-dated system postings never churn — FA critic). Default false = today's behaviour (OpEx/petty-cash edits that
  change the date still repost).
- `liveRevisionsFor(tenantId, sourceType, sourceIds, tx?)` and `liveRevision(…, tx?)` read through the given tx (FA critic: Quick buy's
  in-tx capitalisation must see the payment posted earlier in the same tx).

### backend/src/lib/bankAccounts.ts — w0
`ledgerBalancesByCode(tenantId, codes, opts?: { asOf?: Date; db? })` — optional `journalEntry.entryDate <= asOf` (FA tie-out). Backward
compatible. (moneyAccountCode unchanged: a 'petty_cash' payment option for OpEx/CapEx/loans is a FOLLOW-UP — see build-waves.md §Z.)

### backend/src/lib/exceptions.ts — w0 (ExceptionKind union; String column, no migration)
FA: depreciation_failed, capex_uncapitalised, capex_advance_overdue, capex_orphan_advance, capex_prepaid_unscheduled,
fixed_asset_gl_mismatch, bill_equipment_override, equipment_override.
FC: stock_shortfall, stock_unrecorded, recipe_foreign_stock, stock_restore_failed.
PP: period_close_override, intercompany_mismatch.
CA: cash_advance_overdue, cash_request_needs_review.
DL: delivery_code_rerouted, food_returned, delivery_door_problem, cod_cash_overdue, delivery_on_road_overdue.
OA: on_account_card_revoked_used, on_account_overdue, on_account_unbilled, till_clearing_unexpected.
TX: card_payout_unmatched, gift_card_breakage_held.

### backend/src/lib/inventoryClass.ts (NEW) — w0
`INVENTORY_CATEGORIES`, `CostClass`, `costClassOf(category)`, `CLASS_ACCOUNTS` (food 1210/5010, beverage 1220/5020, packaging 1230/5030,
imports ACCT), `CLASS_LABEL` ('Food','Drinks','Packaging'). THE one class map (cash area's planned lib/stockAccounts.ts is NOT created).

### backend/src/lib/savepoint.ts (NEW) — w0
Move `withSavepoint` out of orders/service.ts:~2098 and export it; orders/service.ts imports it (w0 touches orders/service.ts only for this).

### backend/src/lib/evidenceFile.ts (NEW) — w0
Move `decodeVoucherPhoto` / `magicMatches` out of trustops/cashVouchers.ts: `decodeEvidenceFile(dataBase64, mime, { allowPdf, maxBytes = 3 MB })`
→ `{ bytes, mime, sizeBytes }` (400 BAD_PHOTO for images-only callers, 400 BAD_FILE when allowPdf); PDF magic '%PDF-'.
`sendEvidence(reply, row, filename)` (Content-Type, nosniff, private no-store, inline). cashVouchers.ts imports it (w0 import swap only).
Used by: cash receipts (CA), write-off evidence (OA). Replaces the planned trustops/attachments.ts decode part.

### backend/src/lib/onAccountCard.ts (NEW) — w0
`newCardCode()` → `{ code: 'SVOA-XXXXX-XXXXX-XXXXX-XXXXX', hash, hint }` (20 Crockford base32 chars from crypto.randomBytes),
`normalizeCardCode(raw)` (upper-case, strip spaces/dashes/'SVOA', O→0, I/L→1, length 20 else null), `hashCardCode(normalized)` sha256 hex,
`cardHintOf(normalized)` last 4.

### backend/src/modules/accounting/closeCheckTypes.ts (NEW) — w0
`CloseCheckSeverity = 'block'|'warn'`; `CloseCheckContext { db, tenantId, prevLock: Date|null, newLock: Date, months: string[], isYearEnd: boolean }`;
`CloseProblem { key, severity, title, detail, count, cents?, months?, link, fix?: { method:'POST', path, label }, overridable }`;
`CloseCheck { key, severity, overridable, run(ctx): Promise<CloseProblem|null> }`.

### backend/src/modules/accounting/fiscalYear.ts (NEW) — w0 (pure), then w2-close (db helpers)
w0: `fiscalYearOf(endMonth, at)` → `{ start, end, label 'FY2026-27' }` (PKT), `taxYearOf(at)` → `{ taxYear, start, end }` (ITO, Jul–Jun,
ending year), `isFiscalYearEndInRange(endMonth, prevLock, newLock)`. w2-close adds `fiscalYearEndMonthOf(db, tenantId)`,
`fiscalYearsFor(db, tenantIds, at)`. FA reads the tax year ONLY through `taxYearOf` (one year definition; PP critic).

### backend/src/lib/tenders.ts — w0
`ON_ACCOUNT_TENDER = 'on_account'` (NOT in TILL_TENDERS, so POST /pos/payments keeps refusing it), `REFUND_TENDERS += 'on_account'`,
`TENDER_LABEL.on_account = 'On account'`, compile check covers it.

### backend/src/modules/approvals/types.ts — w0
`APPROVAL_TYPES += 'fixed_asset_request','intercompany_transfer','on_account_client','bad_debt','raast_void','grni_writeoff','cash_request_hod'`.
(cash_voucher kept; relabelled by w4-integration.)

### backend/src/lib/moduleAccess.ts — w0
- MODULE_IDS += 'food_cost' (FC), 'emergency_overrides' (DL).
- DEFAULT_MODULE_ACCESS: food_cost → fnb_manager, boh_management, finance (owner/management/manager via ALL_MODULES lists; NOT foh_management,
  procurement, boh, kitchen). emergency_overrides → boh_management (chef), fnb_manager, foh_management (RGM — critic; owner Q) ; management
  and admin get it through ALL_MODULES; FILTER it OUT of OWNER_MODULES and MANAGER_MODULES (legacy 'manager').
- MODULE_GRANTS += 'food_cost', 'emergency_overrides'.
- GATED_PREFIXES (first match wins — insertion points matter):
  - before '/reports/menu-engineering': `{ prefix: '/reports/food-cost', anyOf: ['food_cost'], readAnyOf: ['food_cost','accounting'] }`
  - before '/procurement/bills': `{ prefix: '/procurement/grni', anyOf: ['procurement','accounting'] }` (finance REQUESTS a GRNI write-off; CEO approves)
  - '/procurement/suppliers' rule: readAnyOf += 'capital' (OpEx/CapEx vendor picker `?view=picker` — TX critic)
  - `{ prefix: '/emergency-overrides', anyOf: ['emergency_overrides'] }`
  - before '/crm': `{ prefix: '/crm/bans/:id/lift|release-contact', pattern: /^\/crm\/bans\/[^/]+\/(lift|release-contact)$/, anyOf: ['crm','complaints'] }`
  - `{ prefix: '/complaints', anyOf: ['complaints'] }` (DL critic: ban appeals carry phone/email/strikes)
  - NOT added (critics): '/accounting/fixed-assets/requests' widening, '/accounting/intercompany/transfers' widening — the approvals provider
    reads under the existing '/accounting' rule as the CEO.
- Comment updates: the '/dispatch' rule comment (no staff Delivered any more).

### backend/src/lib/workspaces.ts — w0
Finance → reports section modules ['reports','food_cost']; Operations.sections += `{ key: 'emergency', title: 'Emergency overrides', modules: ['emergency_overrides'] }`.
(every-module-in-one-workspace test stays green.)

### backend/src/modules/reconciliation/routes.ts — w0, then w2-ap
w0: register child plugins from STUB files (each `export default async function plugin(){}` with a header naming its owner):
`./cardPayoutRoutes.js` at '/card-payouts' (w1-recon), `./codRoutes.js` at '/cod' (w2-dlv-cod), `./pettyCashBackfillRoutes.js` at
'/backfill-petty-cash' (w2-cash-ledger). w2-ap: delete POST /apply-missed-bill-variances (~365-400) once the logic lives in fifoCutover.

### backend/src/modules/reconciliation/backfillOrders.ts — w0, then w4-integration
w0: export `placeAndPost`, `Reposter`, `RefusedDoc`, `RepostResult`, `withBackfillSlot`, `BackfillRunningError` (no behaviour change; CA backfill reuses them).
w4-integration (merged REPOSTERS, all areas):
- `RefusedPostingKind += 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire' | 'ic.fleet_charge' |
  'cod.rider_debt.reversal' | 'ledger.till_clearing_split'`.
- Reposter interface gains `multiPost?: boolean` — skips the exact-reference "Already on the books" check and decides nothingOwed in `load()`
  (TX critic: '@n' gift-card entries).
- FA 'fixed_asset.depreciation' (entityType FixedAsset, flag sourceId = entityId = assetId; post() ignores opts dates and calls
  `chargeAssetThrough(assetId, period, opts)` which late-dates per month); 'prepaid.release' (entity CapexPayment|OpexPayment by sourceType,
  sourceId = payment id; post → `releaseSourceThrough`).
- FC 'inventory.prep_draw' {entityType 'PrepBatch', nothingToPost {'batch_not_found','zero_value','not_ad_hoc'}, post → postPrepDraw};
  'inventory.waste' and 'pos.void_waste' value from stored WasteLog.estimatedCostCents, logs found by WasteLog.orderItemId (not notes),
  'pos.void_waste' reason filter IN VOID_WASTE_REASONS (FC + DL); 'inventory.count' from stored PhysicalCountLine.valueCents;
  unflaggedMisses += ad-hoc prep batches with no 'inventory.prep_draw:' entry, and cancelled orders with net-out sale rows and no
  return/waste rows (FC critic: cancel restore failure sweep).
- TX 'giftcard.expire' {entityType 'GiftCard', multiPost true, nothingOwed unless card.breakagePendingAt set, post → expireOneGiftCard}.
- PP 'ic.fleet_charge' {entityType 'FleetCharge', entityId '<agreementId>:<YYYY-MM>', nothingOwed when the IntercompanyTransfer with
  sourceRef 'fleet:<…>' is posted; post() refuses unless the operator belongs to BOTH companies (else nothingOwed + message 'ask the CEO
  to Charge now'); re-derives the first day open in BOTH companies}.
- DL 'cod.rider_debt.reversal' {entity Payment, post → reverseCodRiderDebt(paymentId), nothingToPost when the debt entry is missing or already reversed}.
- OA 'ledger.till_clearing_split' {entityType 'Tenant', flag sourceId = tenantId, post → sweepTillClearing(tenantId, {mode:'daily'})}.

### backend/src/index.ts — wZ
Register: foodCostRoutes '/reports/food-cost' (BEFORE reportRoutes), grniRoutes '/procurement/grni', fixedAssets plugin (already) +
child plugins, withholdingRoutes '/accounting/withholding', statutoryRoutes '/accounting/statutory', intercompanyRoutes
'/accounting/intercompany', customerAccountRoutes '/accounting/customer-accounts', posOnAccountRoutes '/pos' (second plugin), posBoxGivenRoutes '/pos' (third plugin),
emergencyOverridesRoutes '/emergency-overrides', banAppealRoutes '/storefront'. Workers (inside workersEnabled): startDepreciationWorker
(03:20 PKT), startIntercompanyFleetWorker (03:40), startTillClearingSweepWorker (03:10), startCashAdvanceOverdueWorker (09:10),
startOnAccountDailyWorker (09:20), startCodCustodyWorker (every 30 min). Boot (per company, after ensureChartOfAccounts, each try/catch
logged): ensureAssetClasses + reclassLegacyAccumulated, ensureFifoCutover (before listen), sweepTillClearing({mode:'cutover'}) once
(settings marker). /health: fixedAssets, fifoCutover, pettyCash tie-out, chartTemplateTypes, tillClearing, statutory reclass pending
(warn), cardPayouts unsettled (warn). Comment on startGiftCardExpiryWorker ('posts breakage').

### CLAUDE.md — wZ
New sections: Fixed assets v2; Food cost and stock (FIFO lots) incl. the packaging rule (FINAL owner rule: takeaway/delivery always; a packaging-vessel brand always; dine-in at a plate brand only on "Box given"; Concept.serviceVessel required at brand create);
Tax decisions (H8–H13); People, close and inter-company; Cash requests + petty cash in the ledger (replaces "Cash vouchers"); Delivery
code-only + Emergency overrides (rewrite BOTH Own-fleet bullets: no staff Delivered, code shown to the customer only); On-account
clients, bad debts, Raast void (+ rollback caveat: once an on_account payment or a voided Raast receipt exists the API must not roll back
below this release); amend the Raast "Tenders" bullet; BOOKS-06 sentence ("postSupplierBill books every bill to 1210") rewritten;
remove from "Pending owner/CA decisions": C1/C2/C5, G1–G14, F*, K* (record H1–H30 defaults in force); add TODO(asset-sale-tax).

### backend/tests/setup.ts — w0
Seed every template code (use CHART_OF_ACCOUNTS / ensureChartOfAccounts for the test companies' helper) and apply schema-merged.prisma.md
§5–§6 SQL after `db push` (read from the migration file, like terminal_charges_one_active_per_order).

### backend/tests/moneyBigint.test.ts — w0, then w2-fa-capex
w0: EXPECTED_BIGINT_FIELDS += schema §3.38, count from the generated DMMF. w2-fa-capex: rewrite the fixed-asset section (~605-617, incl. the
MAX_MONEY 422 case) through CapEx capitalisation (POST /accounting/fixed-assets now answers 422 USE_CAPEX).

### packages/types/src/order.ts (+ order.d.ts) — w0
Order item modifier gains optional `modifierId: string | null`; order gains `deliveryFeeCents?`, `deliveryFeeTaxCents?`.

### frontend/admin/src/lib/appRoles.ts — w0
ModuleId union += 'food_cost', 'emergency_overrides'; MODULES entries (food_cost: Finance/Reports "Food cost variance"; emergency_overrides:
section 'Service').

### frontend/admin/src/lib/moduleCatalog.ts — w0
- FC: MODULE_PAGES.food_cost = [{ label:'Food cost variance', href:'/reports/food-cost', hint:'Actual vs recipe per ingredient and brand, at the price paid (FIFO)' }];
  remove the accounting 'Food cost' sub-link (~151); add { label:'Received, not billed', href:'/procurement/grni', sub:true } under procurement AND accounting.
- FA: Fixed assets sub-item hint 'Register, automatic monthly depreciation, smallwares pools, disposals, PPE note'; accounting known-limits
  drop 'Charge month'; capital text mentions suppliers, WHT, Quick buy, capitalisation approval. (NO ModulePage.roles — critic.)
- PP: accounting subs 'Statutory payments' /accounting/statutory, 'Inter-company' /accounting/intercompany.
- OA: after Receivables `{ label:'On-account clients', href:'/accounting/receivables/clients', sub:true, hint:'Corporate clients who pay monthly — credit limits, QR cards, statements' }`.
- CA: 'Cash vouchers' → 'Cash requests' (hint 'Anyone asks for cash; HOD and director sign; the cashier pays; receipts book it');
  PERSONAL_PAGES += 'Cash requests' /finance/cash-vouchers; drop the explicit '/finance/cash-vouchers' from ALWAYS_OPEN_PREFIXES.
- DL: MODULE_PAGES.emergency_overrides = [{ label:'Emergency overrides', href:'/emergency-overrides', hint:'Send the hand-over code to the rider; log food a rider brought back' }];
  reconciliation hint mentions COD owed by riders.
- MODULE_GAPS rewrites: inventory (FIFO lots; per-outlet pools next), recipes (packaging section on every dish), procurement (GRNI), accounting
  (drop "no credit notes, statements or on-account tender" and the stale Sales-quadrants sentence), reconciliation (drop "petty-cash spends
  post nothing"), reports, food_cost ('per-outlet actual waits for per-outlet stock').
- No emoji icons on new entries.

### frontend/admin/next.config.js — w0
redirects(): `{ source: '/accounting/food-cost', destination: '/reports/food-cost', permanent: true }`.

### frontend/admin/src/app/exceptions/page.tsx — w0
Labels for every new ExceptionKind above (plain English).

---

## B. Shared backend files owned by builder agents

### backend/src/modules/orders/service.ts — w0 (savepoint import), then **w2-sale** (all merged changes)
- FC: move deductInventoryForOrder / restoreInventoryForOrder / autoEightySixDepletedItems / lockOrderForStock / STOCK_* into
  orders/stock.ts (re-export the two public names); completeOrder: `await ensureOrderDepleted(orderId)` before the claim tx;
  ingestOrder: persist `modifierId` only when that Modifier belongs to a non-deleted ModifierGroup of the line's menuItem (else null);
  depletion failure (today fire-and-forget) → flag 'stock_restore_failed'/sweep; KDS recall ('recalled', ~1805-1857) books the remade
  line's recipe as waste reason 'remake' (key 'inventory.waste:<wasteLogId>').
- FC + DL (merged cancel semantics):
  - `CancelOrderInput.cookedFood?: { wasteReason: 'cancelled_after_fire'; photoUrl? }` and
    `CancelOrderInput.returned?: { cause: 'refused'|'unreachable'|'other'; actorId: string; run: (tx) => Promise<ReturnedTxResult> }`.
  - `transitionOrder(…, { inCancelTx?: (tx) => Promise<T> })` runs right after markPreBillsCancelledTx when the claim changed, inside the
    cancel transaction; result returned out of transitionOrder.
  - Default cancel: unfired lines go back to their lots; FIRED lines are wasted 'cancelled_after_fire' — EXCEPT a delivery order whose
    `pickedUpAt` is set and not delivered: the generic cancel refuses 409 `USE_EMERGENCY_OVERRIDE` ("the food is with the rider; log it in
    Emergency overrides when it comes back") — only the override (DL) books returned_food, with the manager as actor.
  - cancelOrder audits in the ORDER's company (orderBooksOf / concept.tenantId), not input.actor.tenantId (DL critic).
  - restore/waste after commit: failures flag 'stock_restore_failed' (FC critic) instead of console.error only.
- TX: ingestOrder `...(opts.price && { … deliveryFeeCents: opts.price.deliveryFeeCents, deliveryFeeTaxCents: opts.price.deliveryFeeTaxCents })`.
- FC packaging (FINAL owner rule): every OrderItem create (ingestOrder ~576, add-items ~1188 / ~1223) snapshots `serviceVessel` from the line's
  brand (Concept.serviceVessel); `markBoxGiven` lives in lib/recipeCost.ts + orders/stock.ts (w2-sale); the route is pos/boxGivenRoutes.ts (w3-till).
- Text: COMPLETE_ON_DELIVERY / 'use Dispatch' wording lives in orders/routes.ts (w3-dlv-return).

### backend/src/modules/pos/service.ts — **w2-sale** (FC part), then **w3-till** (everything else)
w2-sale (FC):
- delete restoreVoidedLineStockTx + STOCK_DEPLETE/STOCK_RESTORE/STOCK_VOID_RESTORE (~1926-1999); the void handler (~2171-2183) calls
  `returnVoidedLineStockTx(tx, { orderId, tenantId, line })` for unfired lines and `wasteSoldLineTx(tx, { …, wasteReason:'void_after_fire' })`
  for fired lines (same result shape for the existing flagging).
- staff meal / compOrder (~2424): `await ensureOrderDepleted(order.id)` then `estimatedCostCents = await orderStockCostCents(order.id)`.
w3-till (TX + DL + OA + Raast-void):
- OA: export applyCoverageTx, afterTillSale, repriceForTenderTx, coveredCents, assertTakesMoney, paymentKeyOf, idempotencyKeyReused,
  tillFiscal (no behaviour change); quoteOrderForTender(method incl. 'on_account' → cash class); refundOrder for on_account: shiftId null,
  skip refundDrawerOf's cash rule; **applyChargeRefundTx inside writeRefundTx** whenever r.method === 'on_account' (OA critic: every writer
  of an on_account refund row — refundOrder, the void-on-paid-order path ~2156, the cancelled-ticket hand-back ~3378); refundDueOf excludes
  on_account (and comp); BASE_MONEY_ACCOUNTS += ACCT.TILL_CLEARING; ~3092 code IN TILL_CLEARING_CODES; ~3191/3213 CUSTOMER_AR → TILL_CLEARING;
  getZReport onAccountSales/onAccountCount/onAccountByClient (in totalSales).
- Raast void (OA C): refundDueOf, the Z-report's cancelledPaid and the till's hand-back options exclude payments whose raastReceipt.status is 'voided'.
- TX: TenderPricedOrder Pick + 'deliveryFeeCents'; tenderPriceOf passes it; repriceForTenderTx writes deliveryFeeTaxCents; void-line
  reprice (~1870) passes deliveryFeeCents; refund select (~3024) adds deliveryFeeCents (type completeness — till sales carry 0);
  cancelled-ticket unwind (~3125-3137) adds `add(ACCT.DELIVERY_FEE_REVENUE, b.deliveryFeeCents)`.
- DL: settlePayment — select codRiderDebtEntryId/codRiderDebtTransferId; own-rider debt: `reverseCodRiderDebtTx(tx, { paymentId, tenantId })`
  after the pending→paid claim (AppError → post-commit flagPostingFailed 'cod.rider_debt.reversal'); fleet-rider debt: after commit
  `reverseCodRiderDebtAfterCommit(paymentId)` (serviceClient, both books; failure → same flag).
- (CA does NOT edit pos/service.ts: the drawer→box move is modules/pos/drawerToBox.ts, w2-cash-ledger.)

### backend/src/modules/accounting/orderPosting.ts — **w2-ledger**, then **w3-till**
w2-ledger (FC + TX):
- FC: delete computeOrderCogsCents + the cogsForSoldLines import; postOrderCompletion resolves tenantId BEFORE building lines and calls
  `cogsLinesForOrders(tenantId, [order.id], { conceptId: order.conceptId, memo: conceptMemo })`; buildSaleLines(order, sa, cogsLines)
  appends them in place of the single 5010/1210 pair (~449-453). Refund paths unchanged (COGS stays booked).
- TX: SaleOrderFields Pick + deliveryFeeCents; SaleAccounting + deliveryFeeCents; computeSaleAccounting subtracts it from gross revenue;
  buildSaleLines Cr ACCT.DELIVERY_FEE_REVENUE (conceptId, memo 'Delivery fee on <slug> #<ref>'); RefundShare + deliveryFeeCents
  (refundShareOf shares it; revenue = this − tax − svc − tip − fee); refundDebitLines Dr 4110; selects ~732/~854 add deliveryFeeCents.
- TX critic: OUTPUT_TAX_BY_PROVINCE / OUTPUT_TAX_ACCOUNTS / outputTaxCodeFor derived from accounting/taxAuthorities.ts (re-exported).
w3-till (OA):
- buildSaleLines on_account block after Raast, before the 1030 rest: Σ paid on_account rows capped at `left` → Dr ACCT.CUSTOMER_AR,
  memo `${ON_ACCOUNT_MEMO} — ${conceptMemo}`; refundCreditAccount('on_account') → ACCT.CUSTOMER_AR (memo prefixed ON_ACCOUNT_MEMO);
  saleBookingOf (~636) code IN TILL_CLEARING_CODES; hand-back (~771) Dr ACCT.TILL_CLEARING; refundDueCents excludes on_account (like comp)
  and payments whose Raast receipt is 'voided'.

### backend/src/modules/accounting/shiftPosting.ts — **w2-ledger**, then **w3-till**
w2-ledger: FC per-brand COGS (~510-525) → `lines.push(...await cogsLinesForOrders(tenantId, b.orderIds, { conceptId: b.conceptId, memo: \`@ ${b.conceptSlug} ${tag}\` }))`
(drop cogsForSoldLines import); TX select (~137) + deliveryFeeCents, per-brand accumulator + Cr 4110 per brand (memo 'Delivery fees @ <slug>').
w3-till (OA): ShiftSales.onAccount {cents, byAccount}; in summariseShiftSales' home-drawer loop `else if (p.method === 'on_account') addOnAccount(...)`
BEFORE the card branch (an unknown paid method must never fall into 1030 — also add an explicit guard that throws for any unknown method);
NEVER_SOLD branch skips on_account like comp; buildShiftCloseEntry: one Dr ACCT.CUSTOMER_AR line per client (memo
`${ON_ACCOUNT_MEMO} — ${number} ${name} — ${refs} ${tag}`); lines ~471/474/506 and postPosCardFailure ~787 → ACCT.TILL_CLEARING;
cardRefundsToBook excludes on_account; header comment.

### backend/src/connectors/fiscal/payload.ts (+ connectors/types.ts comment) — **w1-taxsales**
- TX: delivery fee becomes a taxed line {lineId 'delivery:<orderId>', itemCode 'DELIVERY-CHARGE', description 'Delivery charge', qty 1,
  unit/gross fee, discount feeDiscount, taxable fee − feeDiscount, taxRatePct standard rate, taxCents feeTax}; discount covers food first, then
  the fee, then billDiscount; food tax = order.taxCents − feeTax; deliveryChargeCents = fee > 0 ? 0 : legacy remainder; toFbrInvoiceFields
  ItemCode 'DELIVERY' for that line; header ONL-R2-02. buildRefundPayload/totalsCheck unchanged.
- OA: buildFiscalSaleTx reads `tx.customerAccountCharge.findFirst({ where:{orderId}, select:{ account:{ select:{ legalName, ntn, strn, cnic, address }}}})`
  → buyer = client when present; CASH set += 'on_account' (paymentModeOf cash); toSrbInvoiceFields modeOfPay 'Cash' when every tender ∈
  {cash,on_account}; toFbrInvoiceFields PaymentMode 2 when methods include cash or on_account; defaultRefundMethod: all on_account → 'on_account'.

### backend/src/modules/pos/receipt.ts — **w1-taxsales**
TX: ReceiptData.deliveryFeeCents/deliveryFeeTaxCents; HTML 'Delivery charge' row; GST row '(incl. PKR x on delivery)'; rows add up to total.
OA: `paymentLabelOf(p: { method, gatewayRef, gatewayMeta })` (signature change; both callers in receipt.ts) → on_account label
`On account — <name> (<OA-number>)[ · <reference>]`; 'Client signature ________' line when any paid on_account row exists.

### backend/src/modules/invoices/service.ts — **w1-taxsales**
TX: TaxInvoice issue adds deliveryFeeCents; taxableValueCents = subtotal + fee; **total = max(0, subtotal + fee + tax + svc + tip − discount)**
(TX critic; equals the bill); a TaxInvoiceLine 'Delivery charge'; credit note mirrors it. OA: when input.buyer is absent and the order has a
CustomerAccountCharge, buyer = {name: legalName, strn, ntn, address}.

### backend/src/modules/storefront/routes.ts — **w1-taxsales**
TX: quote returns itemTaxCents + deliveryFeeTaxCents (taxCents = both); tip % base = itemTotal + itemTax; checkout response + GET
/storefront/orders/:id return both columns. DL: tracker (~1302): deliveryOtp null + handoverRerouted:true once rerouted. DL critic: GET
/storefront/account drops the global `isBlacklisted` flag (the customer UI reads GET /storefront/account/blocks from banAppealRoutes.ts).

### backend/src/lib/pricing.ts — **w1-taxsales**
OrderPrice + itemTaxCents + deliveryFeeTaxCents; taxCents = sum; discount clamp on itemTotal + itemTax; deliveryFeeTaxCents =
fee > 0 ? round(fee × standardRate / 100) : 0 (tender's standard rate, never an item class); total = net + fee + feeTax + svc; header rule
text. OA comment: tenderOf('on_account') = 'cash' (never add on_account to CARD_TENDERS without the CA).

### backend/src/modules/reports/service.ts — **w2-dlv-cod**
DL: salesByTender 'cod_not_collected' → 'cod_rider_owes' (Payment.codRiderDebtAt via lib/cod.ts codStatusOf); cod.notCollected* → cod.riderOwes*.
TX: SALE_FIELDS + deliveryFeeCents; SalesTotals.deliveryFees (net of the refund share). OA: TENDER_ORDER inserts 'on_account' after 'raast'.

### backend/src/modules/pos/routes.ts — **w2-dlv-cod**
DL: GET /cod-due imports COD_PAY_IN_HOURS + codStatusOf from lib/cod.ts; rows add riderOwes {at, byName} | null and status
'with_rider'|'overdue'|'rider_owes'|'at_counter' (pickup cash orders never get a rider status). CA critic: the payout category zod enum and
GET /pos/payout-categories offer only PAYOUT_CATEGORIES of kind 'expense' (the cogs keys are petty-cash only).

### backend/src/modules/inventory/voidWaste.ts — **w2-sale**
FC + DL merged: `wasteSoldLineTx(tx, { orderId, tenantId, line, wasteReason: 'void_after_fire'|'cancelled_after_fire'|'returned_food', actorId, conceptId })`
relabels the line's net-out sale rows to sale_void + waste (stock unchanged), one WasteLog per item (tenantId, conceptId, orderItemId,
FIFO cost), postVoidWaste by class (Cr 1210/1220/1230 incl. packaging) inside the tx, key 'pos.void_waste:<orderItemId>'.
Exports VOID_WASTE_REASONS = ['void_after_fire','cancelled_after_fire','returned_food'], RETURN_WASTE_REASON = 'returned_food'; old
wasteVoidedFiredLineTx kept as an alias. ('remake' uses postWasteLog under 'inventory.waste:<wasteLogId>', not this key.)

### backend/src/modules/accounting/supplierPosting.ts — **w2-ap**
FC: rewrite postSupplierBill (GRNI matches, repriceLotTx, 6xxx expense lines), postSupplierBillVoid (incl. legacy path),
postSupplierCreditNote (+ void); costAdjustmentCode always 5060; delete the moving-average machinery (revalueItem, revalueForBillVariance,
billVarianceLines, varianceRecordsOf, matchedByOtherBills, receivedSince, applyCarriedBillVarianceTx); postWasteLog moved to
inventoryPosting.ts (re-export kept until w4-integration updates backfillOrders' import); rewrite the K2 comment (~645-653).
TX: input line `inputTaxCodeFor(bill.taxAuthority)` with memo naming the authority; WHT memo uses whtSection/whtRateBps;
`withholdingForBill(db, { tenantId, supplier, subtotalCents, section, at })` DELEGATES to lib/withholding.ts computeWithholding (ONE WHT
resolver — FA + TX critics); comment on inputTaxCodeOfBill 'G7 done'.

### backend/src/modules/procurement/service.ts — **w2-ap**
FC: createBill receipt links (receiptLineId belongs to this supplier/item; 422 STOCK_LINE_NEEDS_RECEIPT / RECEIPT_LINE_MISMATCH / OVER_BILLED /
EXPENSE_ACCOUNT_REQUIRED / assertExpenseCode); keep the INT4 cap on non-stock lines; refuse bills to a system supplier (422 SYSTEM_SUPPLIER).
TX: CreateBillInput + taxAuthority?, whtSection?; supplier read includes filer fields; store taxAuthority (default supplier.defaultTaxAuthority
?? 'fbr'), whtSection, whtRateBps; whtCents from withholdingForBill.
FA: for each non-stock line, `assertNotEquipmentLine({ description, expenseAccountCode, notEquipment, notEquipmentReason }, actor)` (equipment +
smallwares nouns, service/disposable negations; 15xx/1340 codes) → 422 USE_CAPEX; override only for finance/admin (critic), audited
'supplier_bill.not_equipment_override' + flag 'bill_equipment_override' (high) in the supplier's company; credit notes excluded.

### backend/src/modules/procurement/routes.ts — **w2-ap**
FC: billLineSchema + receiptLineId?, expenseAccountCode?; FA: + notEquipment?, notEquipmentReason? (≥10 chars); TX: billCreateSchema +
taxAuthority z.enum(TAX_AUTHORITY_KEYS).optional(), whtSection z.enum([...WHT_SECTIONS,'none']).optional(); supplier create (~217) / patch
(~276) + filerStatus, whtExemptCertNo, whtExemptUntil, defaultTaxAuthority, defaultWhtSection; TX critic: GET /procurement/suppliers?view=picker
&categoryId=|tenantId= → projection {id,name,filerStatus,whtExemptUntil,defaultWhtSection,defaultTaxAuthority} of the OpEx category's (or
named) company in WRITE scope (404 foreign); system suppliers never listed.

### backend/src/modules/reconciliation/service.ts — **w1-recon**
TX + critic: factor adjustStatementLine's split posting (BOOKS-11, ~290-404) into `postCardPayoutSplitTx(tx, …)` used by the manual adjust,
auto-match and confirm; once card payouts are on for a company, a manual adjust that credits 1030 on the payout bank claims
CardSettlementDay rows (status 'manual_adjust') or answers 409 USE_CARD_PAYOUT_CONFIRM; importBankStatement third pass after Raast;
unmatchStatementLine → 409 CARD_PAYOUT_LINE; bank-line adjust to a fixed_asset-controlled code needs `registerOverride {reason}` (FA).

### backend/src/modules/accounting/salesTaxReturn.ts — **w2-taxbooks**
TX: import + re-export AUTHORITIES/AuthorityKey from taxAuthorities.ts; ORDER_FOR_RETURN + deliveryFeeCents/deliveryFeeTaxCents; SupplyClass +
'delivery_charge' | 'deposit_forfeit' (SUPPLY_ORDER lists both); supplyParts gives the fee its own part and its fallback uses taxCents − feeTax;
rateBreakdown reads 'reservation.deposit_capture:' entries carrying output tax; byAuthority + withheldByCustomersCents (from
'receivable.st_withheld:' / '.reversal' entries via ReceivablePayment.taxAuthority), customerWithheldSetOffForPeriodCents,
netAfterWithheldCents; taxable sales + 4110 per brand; notes; taxPaymentsFor maps customerWithheldSetOffCents.
PP: the return's payments list keeps only AUTHORITIES + WITHHOLDING keys (statutory challans filtered; GET …/payments labels/filters them);
the WITHHOLDING 'wht' text no longer says '(and salaries)'; the 'statutory.reclass' entry is excluded from 'withheld in period'.

### backend/src/modules/accounting/taxPayments.ts — **w1-taxcore**
PP: STATUTORY + StatutoryKey; TAX_PAYMENT_AUTHORITIES += salary_tax, eobi, sessi; settlementAccounts resolves them (liability 2042/2043/2044,
input null → NO_INPUT_SET_OFF); recordTaxPayment calls assertTemplateAccounts; G3 TODO removed.
TX: customerWithheldSetOffCents input, guard (422 NO_WITHHELD_SET_OFF for wht/stwh), advisory lock 'tax-stwh:<authority>' + cap
(`customerWithheldAvailable(db, tenantId, authority, asOf)` exported), extra Cr 1335 line, row field; settlementOf/linkTaxPayment read a Cr 1335
line as customerWithheldSetOffCents (critic); isMoney knows 1011 (CA critic); settlementAccounts imports taxAuthorities; TODO(G7) removed.

### backend/src/modules/accounting/reports.ts — **w2-close**
PP: balanceSheet b/f vs current-year per company (earningsByCompany; currentEarningsCents = sum); trialBalance(tenantIds, asOf, {basis}).
FA + critic: cash-flow categorises capex.* / fixed_asset.* by the NON-cash line (1340, 15xx, 1360, 2012 → investing; 1310, 6xxx, 2040 →
operating; 'prepaid.release' has no cash line); balance-sheet PPE groups (cost/accumulated per class), P&L depreciation + impairment lines.
CA: CASH_ACCOUNT_CODES = [1010, 1011, 1015, 1020(bank codes), 1030].
TX critic: 42xx shown as Other income below operating revenue; excluded from sales KPIs.
FC critic: brand P&L (~396-427) splits cost of sales into food / drinks / packaging (5010 / 5020 / 5030 + the class shares of the class-less
5040 / 5050 / 5060 lines, by the movement or bill-line item class; untraceable pre-FIFO remainder in food — verifier fix) and relabels
foodCostPct 'cost of sales %' with the brand-sales (40xx) denominator. Exports THE denominator `brandSalesRevenueCents` (40xx net of 7010/7020;
4100, 4110, 42xx excluded) and `costOfSalesSplit` — reports/foodCost.ts and management/routes.ts (w3-fc-report) import them (verifier fix: one
definition, produced in W2 before its W3 consumers).

### backend/src/modules/accounting/routes.ts — **w2-close**
PP: GET/POST /period-close through closeChecks.ts (acknowledge, CLOSE_NOT_READY, RAAST_UNMATCHED kept when raast is the only block and the
closeWithUnmatchedRaast alias keeps its audit action), advisory lock, PeriodLock.overrides, audits + period_close_override flag,
'period.year_end_close'; GET /period-close/history returns overrides; GET /fiscal-year; trial-balance ?basis; balance-sheet CSV rows.
TX: CARD_UNSETTLED is a CloseCheck from cardPayouts.ts (no separate 409 in this file); GET lists unsettled card days.
FA: depreciation / prepaid-release blocks are CloseChecks (no DEPRECIATION_NOT_CHARGED 409 here); POST /journal accepts
`registerOverride {reason ≥10}` → postJournalEntry controlledOverride, audits, flags fixed_asset_gl_mismatch.
(The sales-tax-return payment zod enum picks the statutory keys up from taxPayments.ts automatically.)

### backend/src/lib/labour.ts — **w2-close**
Labour % revenue denominator excludes 42xx other income (4200 breakage); 4110 delivery fees stay in (they are sales) — TX critic.

### backend/src/modules/accounting/expenseCategories.ts — **w2-cash-ledger**
PAYOUT_CATEGORIES (ONE list) + kind field: existing 8 'expense'; + office 6170, courier 6175, staff_welfare 6180, phone 6022 (expense);
kitchen_food 5010, kitchen_drinks 5020, kitchen_packaging 5030 (kind 'cogs', petty-cash HISTORY BACKFILL picks only — a live spend / settlement
line with a 'cogs' key → 422 USE_STOCK_LINE; cash-bought food comes in as stock lines on a settled receipt, decision P6 — verifier fix); `resolveSpendAccount(db, tenantId,
{categoryKey?, accountCode?}, {allowExplicit})`; header.

### backend/src/modules/trustops/routes.ts — **w2-cash-ledger**
CA: every petty-cash route in the cash plan (box create source, movements with sources/lines/receiptIds, returns, receipts, categories,
open-drawers, tie-out, line reclass) + GET /petty-cash/boxes?mine=1 (ALL_STAFF, custodian's own boxes in write scope, no movements/bytes).
DL: remove GET /orders/:id/otp; verify-otp 423 message 'ask a manager to send the code to the rider (Emergency overrides)'; lost_package
description text (~216).

### backend/src/modules/trustops/pettyCash.ts + accounting/pettyCashPosting.ts — **w2-cash-ledger**, then **w3-cash-requests**
w2: the ledger (writers, poster, expense lines, backfill, tie-out); stock/capex line kinds answer 422 STOCK_LINES_UNAVAILABLE /
CAPEX_LINES_UNAVAILABLE. w3: add stock lines (inventory/cashPurchase.ts recordCashPurchaseStockTx, keepers/inventory-module roles only)
and capex lines (capexPosting.recordCapexPaymentFromCashTx) for BOTH box spends and settlements.

### backend/src/modules/trustops/cashVouchers.ts — w0 (evidenceFile import), then **w3-cash-requests**

### backend/src/modules/hr/ledger.ts, hr/routes.ts, hr/service.ts — **w1-hr**
PP: statutory accounts 2042/2043/2044 + assertTemplateAccounts; Dr 6036 gratuity; fix the F&F sibling-reversal lookup
(`${FNF_ACCRUAL}.reversal:<id>`, not 'reverses:…'); gratuity calc reuses calculate's grossSalaryCents; eobi_challan per owner Q1.
CA: hr/ledger.ts loanPayingAccount('cash_request') → {method:'cash_request', code: ACCT.CASH_ADVANCES, bankAccountId:null};
hr/routes.ts cancelling an approved loan with data.paidFrom 'cash_request' → 409 LOAN_FROM_CASH_REQUEST; hr/service.ts exports
`directManagerUserIdOf(tenantId, userId)` (HR's canActOnStep('hod') rule — CA critic: no second HOD definition) and
`teamUserIdsUnder(tenantId, managerUserId)` (the /hr/team walk, which then calls it); getFormat merges missing default system fields into
saved final_settlement formats (PP critic).

### backend/src/modules/tenants/routes.ts — **w2-close**, then **w3-recipes**, then **w4-integration**
w3-recipes: the company-create route's first brand requires `serviceVessel` ('plate'|'packaging'; 400 when missing). Same agent: concepts/routes.ts
POST requires it, PATCH edits it (audited 'concept.service_vessel').
w2-close: PATCH /:id fiscalYearEndMonth (ADMIN_ONLY, memberTenantIds, 1–12, audited 'tenant.fiscal_year_end' category accounting; refused
409 FY_CHANGE_AFTER_YEAR_END_CLOSE once a close spanned a year end unless {reason} given — then audited + flagged).
w4-integration (merge, inside the merge tx): FA (rename colliding assetTags '-<srcSlug>', merge FixedAssetClass by key, repoint fixed_asset*,
prepaid_releases); FC (stock_lots, stock_movements, grni_matches); TX (card_settlements/days); OA (customer_accounts/cards/charges,
receivable_write_offs/attachments); CA (cash_voucher_settlements, petty_cash_spend_lines); DL (customer_strikes.tenantId); PP: refuse 422
MERGE_HAS_INTERCOMPANY when either company has controlled 'intercompany' accounts with lines or any intercompany_transfers / fleet_rates row.

### backend/src/modules/setup/routes.ts — **w1-taxcore** (operations-config), then **w4-integration** (chart guards)
w1-taxcore (W1 — verifier fix: the W3 operations page and the W3 cash-request worker consume it, so it cannot wait for W4):
TX: PATCH /setup/operations-config zod DROPS withholdingTaxPct (ONE writer: PUT /accounting/withholding/rates) and keeps withholdingTaxEnabled.
CA: + cashAdvanceSettleDays int 1–365 (audited).
w4-integration (W4): FA + PP + OA: PATCH /setup/chart-of-accounts/:id refuses isActive:false on a REQUIRED code, a controlled account (422
ACCOUNT_CONTROLLED), or the cost/accum code of an active FixedAssetClass (422 ACCOUNT_IN_USE); rename allowed. POST never sets controlledBy.

### backend/src/modules/management/routes.ts — **w1-bans**, then **w3-fc-report**
w1-bans: open-complaints KPIs (~190, 237, 245) filter kind='complaint'. w3-fc-report: foodCostPct (~92, 107) split/relabel with
accounting/reports.ts brandSalesRevenueCents + costOfSalesSplit (w2-close's one definition; food/drinks/packaging).

### backend/src/modules/approvals/providers.ts + README.md + tests/approvalsInbox.test.ts — **w4-integration**
Providers (each reads the module's own queue as the caller, actions call the module's own routes, `delegable:false` unless noted):
fixed_asset_request (accounting, ADMIN_ONLY, /accounting/fixed-assets/requests?status=pending), intercompany_transfer (accounting,
ADMIN_ONLY, disabledReason when the CEO is not in both companies), on_account_client (accounting, ADMIN_ONLY, /accounting/customer-accounts?pending=1),
bad_debt (accounting, ADMIN_ONLY, /accounting/receivables/write-offs?status=requested; NO requester-based disabledReason — CEO exempt, decision 27),
raast_void (reconciliation, ADMIN_ONLY, /reconciliation/raast/receipts?voidRequested=1), grni_writeoff (procurement|accounting, ADMIN_ONLY,
/procurement/grni?writeOffRequested=1), cash_request_hod (no module, approverRoles null, /trustops/cash-vouchers?view=hod, sign/reject),
cash_voucher relabelled 'Cash requests' (title `${number} — ${payeeName} — PKR`, facts per cash plan, delegable kept true).
FC critic: the recipe provider (~212-218) derives a modifier recipe's company via modifier → group → menuItem → concept.

### backend/src/modules/receivables/routes.ts — **w2-oa-recv**
OA (statements kind, written_off, write-off routes as child plugin, customerAccountId on POST /, statement void/credit-note rules, export the
private helpers lockInvoice/restatus/nextNumber/withNumberRetry/assertLiveInvoice rather than moving them) + TX H13 (withholding kind
'sales_tax' → method 'st_withheld', Dr 1335 / Cr 1110 'receivable.st_withheld:<paymentId>', authority from the issue entry or — for a
statement — from its charges' brands (refuse 422 STATEMENT_MULTI_AUTHORITY when they span two authorities), caps, reverse route) +
OA critic: reversing a payment with writeOffId decrements recoveredCents and restores writtenOffCents in the same tx.

### backend/src/modules/recipes/routes.ts (+ par-sheet if a plate assumption breaks) — **w3-recipes**

### backend/src/modules/inventory/routes.ts, crosschecks/routes.ts, crosschecks/countPosting.ts, stockTransfers/routes.ts, workers/shrinkageTrend.ts — **w3-stockdocs**

### backend/src/modules/reservations/depositCapture.ts, giftCards/*, workers/giftCardExpiry.ts — **w1-taxsales**

### backend/src/modules/dispatch/*, rider/*, lib/deliveryOtp.ts, workers/riderScoring.ts — **w1-dlv-core**

### backend/src/lib/strikes.ts, crm/*, complaints/*, adapters/whatsapp/conversation.ts, lib/marketingAudience.ts, workers/loyaltyTriggers.ts, lib/customerRollups.ts, opsReports/routes.ts — **w1-bans**

### backend/src/modules/positions/contributions.ts + routes.ts, lib/companyPairs.ts (NEW) — **w1-ic**

### backend/src/modules/orders/routes.ts — **w3-dlv-return**
Remove POST /:id/cod-unpaid and /:id/refused-at-door; COMPLETE_ON_DELIVERY message → 'a delivery completes only with the customer's code'.

### backend/src/modules/fixedAssets/* — **w1-fa-engine** (engine files), **w3-fa-api** (routes, requests, pools.routes, reports, README)

### backend/src/modules/financePlanning/* + accounting/prepaidReleases.ts — **w2-fa-capex**

### backend/src/modules/opex/* — **w2-taxbooks**

### backend/src/connectors/raast/accounts.ts, reconciliation/raast.ts, raastRoutes.ts — **w1-recon**

### backend/.sim/books/fin403.ts, backend/.sim/ui-r2/verify/zzverify_ui_3.test.ts — **w3-fa-api** (update or delete the removed FA API importers)

---

## C. Shared admin / customer files

| File | Owner (wave) | Merged changes |
|---|---|---|
| frontend/admin/src/app/accounting/page.tsx | w3-fc-report, then w4-admin-fa | FC: hub gauge reads /reports/food-cost/summary, corrected labels, link; FA: LEDGER_LINKS gains Fixed assets |
| frontend/admin/src/app/reconciliation/page.tsx (+ CardPayouts.tsx, CodTab.tsx, BackfillUnposted.tsx, README; delete MissedBillVariances.tsx) | w3-admin-finance | TX: mount CardPayouts + 'Card payout' chip + 'Card payout?' action; DL: COD tab; FC: remove MissedBillVariances mount + delete the component; CA: petty-cash history backfill section in BackfillUnposted.tsx (POST /reconciliation/backfill-petty-cash) |
| frontend/admin/src/app/reconciliation/RaastTab.tsx | w1-recon | OA: voided chip, CEO void, finance 'Ask the CEO to void', contra 1115 labels; capability flags from the server (canVoid/canRequestVoid) — no local role lists |
| frontend/admin/src/app/procurement/page.tsx | w4-admin-stock | FC: bill lines stock (Fill from PO / Fill from receipt) or expense (category → 6xxx); TX: supplier Tax block + bill 'Tax charged by' + WHT section; FA: equipment refusal → 'Not equipment' override (finance/CEO only) |
| frontend/admin/src/app/accounting/receivables/page.tsx | w4-admin-oa | OA: statements, written_off, write-off request/recovery, credit-note hidden for statements, client picker; TX: withholding dialog 'Income tax (s.153) → 1330' / 'Sales tax withheld by client → 1335' |
| frontend/admin/src/app/orders/[id]/page.tsx | w4-admin-oa | TX: 'Delivery fee' row + GST '(incl. PKR x on delivery)'; OA: on_account tender label/colour, HAND_BACK_TENDERS |
| frontend/admin/src/app/configuration/operations/page.tsx | w3-admin-finance | TX: withholding % input → link to Accounting → Sales tax return → Withholding rates (switch stays); CA: cashAdvanceSettleDays field |
| frontend/admin/src/app/inventory/page.tsx | w4-admin-stock | FC: waste drawer brand/outlet, issue-on-receipt toggle, assign-company opening cost, G15 'Purchase order' button → /procurement new PO |
| frontend/admin/src/components/finance/SpendLinesEditor.tsx, ReceiptUploader.tsx, lib/photoPrep.ts | w2-cash-ledger, then w3-cash-requests (stock + capex line kinds) | CA |
| frontend/admin/src/app/finance/cash-vouchers/** | w3-cash-requests | CA |
| frontend/admin/src/app/finance/petty-cash/** | w2-cash-ledger | CA |
| frontend/admin/src/app/finance/capex/page.tsx, capital-ledger/page.tsx, accounting/fixed-assets/**, components/fixedAssets/**, accounting/README.md | w4-admin-fa | FA |
| frontend/admin/src/app/accounting/sales-tax-return/**, finance/opex/page.tsx, gift-cards/page.tsx, configuration/delivery-zones/page.tsx | w3-admin-finance | TX (+ PP: statutory rows filtered on the return page) |
| frontend/admin/src/app/accounting/statutory/page.tsx | w1-taxcore | PP |
| frontend/admin/src/app/accounting/intercompany/page.tsx, workforce/positions/view.tsx | w1-ic | PP |
| frontend/admin/src/app/accounting/period-close/**, balance-sheet/page.tsx, trial-balance/page.tsx | w2-close | PP |
| frontend/admin/src/app/hr/settings/page.tsx, hr/s/[section]/page.tsx, components/hr/RecordDetail.tsx | w1-hr | PP |
| frontend/admin/src/app/reports/food-cost/**, reports/page.tsx, menu-engineering/[id]/page.tsx, accounting/food-cost/page.tsx (delete) + its README | w3-fc-report | FC |
| frontend/admin/src/app/accounting/recipes/**, configuration/modifiers/page.tsx, KitchenRecipe.tsx | w3-recipes | FC |
| frontend/admin/src/app/inventory/count/**, inventory/prep/page.tsx, sourcing/page.tsx, procurement/receiving/page.tsx, procurement/grni/page.tsx (new) | w4-admin-stock | FC |
| frontend/admin/src/app/emergency-overrides/page.tsx | w3-dlv-return | DL |
| frontend/admin/src/app/dispatch/page.tsx, riders/page.tsx, complaints/page.tsx, pos/shift/DrawerPanels.tsx | w4-admin-delivery | DL: no Delivered; 'Enter customer's code' (POST /trustops/orders/:id/verify-otp, attemptsLeft, 423 lock); appeals; COD pay-in grouping |
| frontend/admin/src/components/pos/** (PaymentModal, OnAccountPanel, tillApi), app/refunds/RefundOptions.tsx, app/refunds/refundEngine.ts, app/pos/shift/page.tsx, lib/api.ts, accounting/receivables/clients/**, components/finance/OnAccountCardPrint.tsx, WriteOffDialog.tsx, app READMEs (pos, refunds, receivables) | w4-admin-oa | OA |
| frontend/storefront/src/app/[concept]/checkout/page.tsx | w4-customer | TX: fee + one GST row 'incl. PKR x on delivery'; DL: BANNED → BlockedNotice with appeal |
| frontend/storefront/src/app/[concept]/order/[id]/page.tsx, app/account/page.tsx, components/auth/LoginForm.tsx, SignupForm.tsx, components/account/BlockedNotice.tsx (new), reserve + group-order pages | w4-customer | DL (+ TX tracker fee row) |
| mobile/app/[concept]/checkout.tsx, mobile/app/order/[id].tsx, mobile/app/login.tsx, mobile/app/(tabs)/account.tsx | w4-customer | TX: server quote, real checkout body, no local 17%, text segment labels, PICKUP ONLY until a pin picker exists (no expo-location → no package change); DL: BANNED notice + appeal |
| tablet/src/lib/printer.ts | w4-customer | TX: Delivery line before Tax |
| tablet/app/(staff)/overrides.tsx, _layout.tsx, dispatch.tsx; rider/**; frontend/storefront/src/lib/riderApi.ts; storefront rider pages; docs/rider-app.md | w4-apps | DL |
| docs/*.md (fixed-assets, food-cost, petty-cash, on-account, raast, TAX_SETUP, pos-connector-api), backend module READMEs not owned above, .handoff/fixes/D1D3-spec.md amendment | w4-docs | all areas |
