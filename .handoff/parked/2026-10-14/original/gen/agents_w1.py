W1 = []

W1.append(dict(
id="w1-stock", wave="W1", area="foodcost", idx=0,
title="FIFO lot ledger, brand shares, COGS by class, inventory postings",
summary="lib/stockLedger.ts (THE stock writer), brandShare, accounting/cogs.ts, accounting/inventoryPosting.ts (all FC postings that are not bills/sales).",
owns=["backend/src/lib/stockLedger.ts (new)", "backend/src/lib/brandShare.ts (new)", "backend/src/modules/accounting/cogs.ts (new)",
      "backend/src/modules/accounting/inventoryPosting.ts (new)",
      "backend/tests/stockLedger.test.ts (new)", "backend/tests/inventoryPostings.test.ts (new)", "backend/tests/cogsByClass.test.ts (new)",
      "backend/tests/brandShare.test.ts (new)"],
read=["plan_foodcost.json: summary, postings 1, 8, 10-19, shared_file_changes 'stockLedger SIGNATURES' and 'cogs/inventoryPosting SIGNATURES', build_split A+B",
      "critic_assets_foodcost_1.json (several lots per receipt line; company-less items; ItemPriceHistory; late-receipt shortfall; issue on receipt; alignment to its own line)"],
tasks=r"""
**lib/stockLedger.ts — the ONLY code that changes stock.** Every change writes append-only `StockMovement` rows in the caller's transaction;
`InventoryItem.currentStock` stays a cache (= Σ open `remainingQty`) so the auto-86 and every reader keep working.
- Lock item rows in id order (`lockItemsTx`); open lots scanned in (receivedAt, id) order (index `stock_lots_open_fifo`).
- Exact value closure: a draw that empties a lot takes its whole `remainingValueCents`; |qty| < 1e-9 counts as zero; values never drift.
- Company: `lot.tenantId === item.tenantId === caller tenantId`, else AppError CROSS_COMPANY_STOCK (500). An item with `tenantId` NULL is refused
  on EVERY stock write: 422 ITEM_HAS_NO_COMPANY (critic — company-less stock must never get lots).
- `clamp=true` (sales only) takes what the lots hold and records `shortfallQty` + `shortfallValueCents` (memo at `latestPurchaseCostCents`);
  `clamp=false` → 422 NEGATIVE_STOCK.
- `refreshItemCostTx` sets `unitCostCents` = FIFO head (oldest open lot) else latest lot else the typed estimate. It does NOT write
  ItemPriceHistory (critic: price history = purchase prices only — written by `addLotTx` for receipt lots and by bill re-pricing in w2-ap).
- **Late-receipt shortfall settle (critic (c), default ON, owner may switch off later):** when a RECEIPT lot is added, settle the open sale
  shortfalls of that item from the last `SHORTFALL_SETTLE_DAYS = 7` days FIFO from the new lot: one `shortfall_settle` movement per settled
  sale row (`settlesMovementId`, orderId/orderItemId/conceptId copied, value at the new lot), then post `postShortfallSettleTx` in the same tx.
  The settled amount of a sale row = Σ its settle rows (never mutate movement rows). `cogsLinesForOrders` never reads settle rows (no double count).
- **Issue on receipt (critic (d)):** when the item has `issueOnReceipt`, a new receipt lot is consumed in full at once (`issue_on_receipt`
  movement, brandShares by usage, brand-less if none) and posted by `postIssueOnReceiptTx` in the same tx.
- `ensureFifoReady(tenantId)`: if Setting `foodcost.fifoCutoverAt:<tenantId>` is missing, run
  `(await import('../modules/inventory/fifoCutover.js')).ensureFifoCutover(tenantId)` (file arrives in W2 from w2-ap; guard the dynamic
  import so W1 tests that set the marker directly pass). MUST be called by callers BEFORE they open their transaction (it locks all the
  company's items in one big tx) — document it in the header.

**lib/brandShare.ts:** `brandUsageShares(db, tenantId, itemId, at, days = 30)` from Σ `theoreticalQty` of `sale` movements by conceptId in the
trailing window (H20); `splitCents(total, shares)` largest-remainder, sums exactly; `[]` when nobody used the item (head office, brand-less).

**accounting/cogs.ts:** `cogsLinesForOrders` = one Dr 50x0 / Cr 12x0 pair per class from −Σ valueCents of the orders' `sale`, `sale_return`,
`sale_void` movements, conceptId on both lines; legacy fallback: an order placed before its company's cut-over marker with no movements →
existing `cogsForSoldLines` (lib/recipeCost.ts) to 5010/1210 with memo 'pre-FIFO order'. `orderStockCostCents(orderId)` = the order's net lot value.

**accounting/inventoryPosting.ts** — every function: tenant from the SOURCE row, balance asserted, idempotent key, class accounts from
`CLASS_ACCOUNTS[costClass]`, brand-less amounts split into brand-tagged pairs by `brandUsageShares` (store the split on the movement rows'
`brandShares` so the report reads what was posted):
1. `postGoodsReceiptTx(tx, receiptId)` — 'procurement.receipt:<receiptId>': Dr 1210/1220/1230 per class Σ lot value / Cr 2015 (quantity priced
   by a pending bill is credited to 2015 at the billed price, netting that bill's pending debit). Receipts with `settledByType` set
   (decision P6 — cash food buys) post NOTHING: return `{ posted: false, reason: 'settled_by_cash' }`. Brand-less lines. A refusal throws
   (the receipt rolls back).
2. `postWasteLog(id, opts & { tx? })` — MOVED here from supplierPosting.ts (w2-ap deletes the old body and re-exports this): 'inventory.waste:<id>'
   Dr 5040 / Cr class inventory at `WasteLog.estimatedCostCents` (the FIFO value taken); brand = WasteLog.conceptId else the usage split;
   date recordedAt; savepoint pattern; refusal → flagPostingFailed (existing REPOSTER).
3. `postStockCount(id, opts & { tx? })` — MOVED here from crosschecks/countPosting.ts (w3-stockdocs turns that file into a re-export):
   'inventory.count:<countId>'. kind 'spot': short Dr 5050 / Cr class (count_loss FIFO value), over Dr class / Cr 5050 (count_gain lot at the
   latest purchase price); kind 'opening' (H19): Dr class / Cr 3020 at the entered unit cost — never 5050. Values from
   `PhysicalCountLine.valueCents`, brand split from stored brandShares.
4. `postPrepDraw(batchId, opts & { tx? })` — NEW 'inventory.prep_draw:<id>': Dr 50x0 / Cr 12x0 at the FIFO value drawn (`drawValueCents`), usage split.
5. `postGrniWriteOffTx(tx, receiptLineId, actor)` — 'procurement.grni_writeoff:<receiptLineId>': Dr 2015 / Cr 5060 for the open unbilled
   value, usage split. (The request/approve flow is w2-ap's.)
6. `postItemReclassTx(tx, { itemId, auditLogId, fromClass, toClass, valueCents })` — 'inventory.item_reclass:<itemId>:<auditLogId>'.
7. `postClassReclassTx(tx, tenantId, byClass)` — 'inventory.class_reclass:<tenantId>' Dr 1220/1230 / Cr 1210 (cut-over, once).
8. `postGrniOpeningTx(tx, tenantId, { received: byClass, billedAhead: byClass })` — 'procurement.grni_opening:<tenantId>' (cut-over, once).
9. `postFifoAlign(tenantId, { dryRun, actor })` — 'inventory.fifo_align:<tenantId>', once, CEO, dry run first: Dr/Cr 12x0 against **3020**
   (prior-period difference — critic; Hasnain to confirm; the report shows it on its own line, never in 'unexplained'). Errors 409
   ALREADY_ALIGNED / CUTOVER_NOT_RUN. (The route is w3-fc-report's.)
10. `postShortfallSettleTx(tx, { lotId, rows })` — 'inventory.shortfall_settle:<lotId>': Dr 50x0 per brand / Cr 12x0.
11. `postIssueOnReceiptTx(tx, { lotId })` — 'inventory.issue_on_receipt:<lotId>': Dr 50x0 (usage split) / Cr 12x0.
Postings never change stock; lots never change except through stockLedger.
""",
consumes=r"""
- w0: `lib/inventoryClass.ts` (costClassOf, CLASS_ACCOUNTS), `lib/savepoint.ts`, ACCT.GRNI / COST_ADJUSTMENT / RETAINED_EARNINGS / INVENTORY_* /
  *_COST / WASTE / INVENTORY_VARIANCE, `postJournalEntry`, `flagPostingFailed`, lib/money.ts.
- existing: `cogsForSoldLines` in lib/recipeCost.ts (legacy fallback only — w2-sale rewrites recipeCost; keep the call by name).
""",
exposes=r"""
```ts
// lib/stockLedger.ts
export const SHORTFALL_SETTLE_DAYS = 7
export type MovementKind = 'receipt'|'opening'|'fifo_cutover'|'count_gain'|'count_loss'|'sale'|'sale_return'|'sale_void'|'waste'|'prep_draw'
  |'supplier_return'|'cost_adjust'|'class_reclass'|'legacy_return'|'issue_on_receipt'|'shortfall_settle'
  // 'transfer_out' | 'transfer_in' are allowed by the DB CHECK but RESERVED for per-outlet stock (the next build) — never written in wave B
export interface MovementRow { id: string; lotId: string | null; inventoryItemId: string; qty: number; valueCents: number; costClass: CostClass }
export function lockItemsTx(tx: Tx, itemIds: string[]): Promise<void>
export function addLotTx(tx: Tx, a: { tenantId: string; inventoryItemId: string; qty: number; unitCostCents: number; valueCents?: number;
  kind: 'receipt'|'opening'|'count_gain'|'fifo_cutover'|'legacy_return'; lotSourceType: 'goods_receipt_line'|'count_gain'|'opening'|'fifo_cutover'|'legacy_return';
  lotSourceId: string; movementSourceType: string; movementSourceId: string; receiptLineId?: string; locationId?: string | null;
  receivedAt: Date; createdById?: string | null }): Promise<{ lotId: string; movementId: string; settled?: { valueCents: number } }>
export function consumeFifoTx(tx: Tx, a: { tenantId: string; inventoryItemId: string; qty: number; kind: MovementKind; sourceType: string;
  sourceId: string; clamp: boolean; orderId?: string; orderItemId?: string; conceptId?: string | null; locationId?: string | null;
  theoreticalQty?: number; brandShares?: Array<{ conceptId: string; share: number }>; occurredAt: Date; createdById?: string | null })
  : Promise<{ takenQty: number; shortfallQty: number; valueCents: number; rows: MovementRow[] }>
export function returnToLotsTx(tx: Tx, a: { rows: MovementRow[]; kind: 'sale_return'|'supplier_return'|'legacy_return'; sourceType: string; sourceId: string; occurredAt: Date }): Promise<{ valueCents: number }>
export function relabelToWasteTx(tx: Tx, a: { rows: MovementRow[]; wasteLogIdByItem: Record<string, string>; conceptId: string | null; occurredAt: Date }): Promise<{ valueCents: number }>
export function repriceLotTx(tx: Tx, a: { lotId: string; deltaCents: number; qtyBasis: number; sourceType: string; sourceId: string }): Promise<{ onHandCents: number; usedCents: number }>
export function refreshItemCostTx(tx: Tx, itemId: string): Promise<void>
export function latestPurchaseCostCents(db: Db, itemId: string): Promise<number | null>
export function lotValuation(db: Db, tenantId: string, asOf?: Date): Promise<Record<CostClass, number>>
export function ensureFifoReady(tenantId: string): Promise<void>   // call BEFORE opening a transaction
// lib/brandShare.ts
export function brandUsageShares(db: Db, tenantId: string, itemId: string, at: Date, days?: number): Promise<Array<{ conceptId: string; share: number }>>
export function splitCents(totalCents: number, shares: Array<{ conceptId: string; share: number }>): Array<{ conceptId: string | null; cents: number }>
// accounting/cogs.ts
export function cogsLinesForOrders(tenantId: string, orderIds: string[], o: { conceptId: string | null; memo: string }, db?: Db): Promise<JournalLineInput[]>
export function orderStockCostCents(orderId: string, db?: Db): Promise<number>
// accounting/inventoryPosting.ts
export function postGoodsReceiptTx(tx: Tx, receiptId: string): Promise<{ posted: boolean; reason?: 'settled_by_cash'; entryId?: string }>
export function postWasteLog(id: string, opts?: RepostOptions & { tx?: Tx }): Promise<PostResult>
export function postStockCount(id: string, opts?: RepostOptions & { tx?: Tx }): Promise<PostResult>
export function postPrepDraw(batchId: string, opts?: RepostOptions & { tx?: Tx }): Promise<PostResult>
export function postGrniWriteOffTx(tx: Tx, receiptLineId: string, actor: { id: string }): Promise<{ entryId: string; valueCents: number }>
export function postItemReclassTx(tx: Tx, a: { itemId: string; auditLogId: string; fromClass: CostClass; toClass: CostClass; valueCents: number }): Promise<void>
export function postClassReclassTx(tx: Tx, tenantId: string, byClass: Record<CostClass, number>): Promise<void>
export function postGrniOpeningTx(tx: Tx, tenantId: string, a: { received: Record<CostClass, number>; billedAhead: Record<CostClass, number> }): Promise<void>
export function postFifoAlign(tenantId: string, o: { dryRun: boolean; actor: { id: string } }): Promise<{ byClass: Record<CostClass, number>; posted: boolean }>
export function postShortfallSettleTx(tx: Tx, a: { lotId: string; byConcept: Array<{ conceptId: string | null; costClass: CostClass; cents: number }> }): Promise<void>
export function postIssueOnReceiptTx(tx: Tx, a: { lotId: string }): Promise<void>
```
(Names of `RepostOptions` / `PostResult` follow the existing REPOSTERS shape in backfillOrders.ts.)
""",
tests=r"""
- `stockLedger.test.ts`: FIFO across 3 lots; last draw takes the exact remainder; returns go back to the same lots; clamp records shortfall +
  memo value; NEGATIVE_STOCK without clamp; CROSS_COMPANY_STOCK; ITEM_HAS_NO_COMPANY; relabelToWaste keeps stock unchanged; reprice splits
  on-hand/used; refreshItemCost moves the head and writes NO price history; a receipt lot settles a 3-day-old shortfall (not an 8-day-old one);
  issue-on-receipt consumes the lot at once; replays write nothing (unique key).
- `inventoryPostings.test.ts`: each posting balanced and idempotent; beverage/packaging items hit 1220/5020 and 1230/5030; a brand-less waste
  split across two brands sums exactly; settled-by-cash receipt posts nothing; opening count → 3020 never 5050; alignment → 3020, once;
  two companies: A's receipt/waste/count never posts in B's chart; a B tx cannot consume A's lot.
- `cogsByClass.test.ts`: one pair per class with conceptId; sale_void rows net out; pre-cut-over order without movements → legacy 5010/1210 'pre-FIFO order'.
- `brandShare.test.ts`: shares from theoretical usage; window; largest remainder.
""",
))

W1.append(dict(
id="w1-taxcore", wave="W1", area="tax + people", idx=1,
title="Tax authorities table, ONE withholding resolver, tax payments (customer-withheld set-off + statutory keys), statutory payments page",
summary="accounting/taxAuthorities.ts, lib/withholding.ts, withholding routes, taxPayments.ts (tax + people), accounting/statutory.ts + routes + admin page.",
owns=["backend/src/modules/accounting/taxAuthorities.ts (new)", "backend/src/lib/withholding.ts (new)",
      "backend/src/modules/accounting/withholdingRoutes.ts (new)", "backend/src/modules/accounting/taxPayments.ts",
      "backend/src/modules/accounting/statutory.ts (new)", "backend/src/modules/accounting/statutoryRoutes.ts (new)",
      "frontend/admin/src/app/accounting/statutory/page.tsx (new)",
      "backend/src/modules/setup/routes.ts (W1: PATCH /setup/operations-config zod only — w4-integration adds the chart guards in W4)",
      "backend/tests/taxWithholdingRates.test.ts (new)", "backend/tests/taxPaymentWithheldSetOff.test.ts (new)",
      "backend/tests/withholdingRegister.test.ts (new)", "backend/tests/statutoryPayments.test.ts (new)",
      "backend/tests/operationsConfigWaveB.test.ts (new)",
      "backend/tests/taxPayments.test.ts (W1: statutory keys + customer-withheld set-off expectations; w2-taxbooks owns it in W2)"],
read=["plan_tax.json: summary 5-6, build_split T1, routes (withholding, sales-tax-return payments), CONTRACT for the FA/CapEx area",
      "plan_people.json: summary 2, build_split B, routes (statutory)",
      "critic_tax_people_0.json + _1.json (one authority table incl. province map; settlementOf reads Cr 1335; statutory reclass one-time with source 'statutory.reclass'; one accrued-vs-paid computation)"],
tasks=r"""
**accounting/taxAuthorities.ts — THE authority table.** `AuthorityKey = 'fbr'|'pra'|'srb'|'kpra'|'bra'`, `TAX_AUTHORITY_KEYS`, `AUTHORITIES`
(copy verbatim from salesTaxReturn.ts using the new ACCT input constants) AND the province map `OUTPUT_TAX_BY_PROVINCE` / output-account rule
(copy from orderPosting.ts:~35-58, same behaviour incl. srbPosId → 2032). Export `inputTaxCodeFor(key)`, `outputTaxCodeFor(concept: { province,
srbPosId })`, `authorityOfOutputCode(code)`, `authorityOfInputCode(code)`. Do NOT edit salesTaxReturn.ts or orderPosting.ts: w2-taxbooks and
w2-ledger re-point them to this file in W2 (one table).

**lib/withholding.ts — the ONE WHT resolver** (bills, OpEx, CapEx all call it; supplierPosting.withholdingForBill delegates to it in W2).
`WHT_SECTIONS = ['153_1_a','153_1_b','153_1_c','155']` (goods / services / contracts / rent), `FILER_STATUSES = ['filer','non_filer','exempt','unknown']`,
`DEFAULT_WHT_RATES` bps (CA placeholders): 153_1_a 500/1000, 153_1_b 900/1800, 153_1_c 700/1400, 155 1500/3000 (filer/non-filer).
`withholdingRatesFor(db, tenantId)` → `{ enabled: ops.withholdingTaxEnabled, rates (stored JSON merged over defaults; when null 153_1_a filer =
round(withholdingTaxPct × 10000)), defaultsUsed }`. `computeWithholding(db, { tenantId, supplier|null, filerStatus?, section|null, baseCents, at })`
→ `{ whtCents, rateBps, section, filerStatus, exempt, needsAtlCheck }`: disabled or no section → 0; exempt with whtExemptUntil ≥ at → 0;
non_filer → nonFilerBps; filer/unknown → filerBps (+ needsAtlCheck when unknown); `whtCents = Math.round(base × bps / 10000)`, assertMoneyFits.
`defaultSectionForCapex(treatment, projectType)`: capital on kitchen_buildout|refurb|expansion|new_brand → '153_1_c', other capital → '153_1_a',
prepaid (rent) → '155', expense (broker/legal) → '153_1_b', deposit → null (FA critic mapping).

**accounting/withholdingRoutes.ts** (registered at /accounting/withholding in wave Z; under the existing '/accounting' gate):
GET /rates (FINANCIALS_VIEWERS, active company) → `{ enabled, rates, defaultsUsed }`; PUT /rates (admin, finance; activeTenantId; bps 0..5000;
writes OperationsConfig.withholdingRates of the active company AND keeps withholdingTaxPct = 153_1_a filerBps / 10000; audited; 422
NO_ACTIVE_COMPANY) — this becomes the ONLY writer of withholdingTaxPct (you remove it from PATCH /setup/operations-config, below);
GET /register?from&to&format=csv (FINANCIALS_VIEWERS; resolveTenantScope): one row per WHT deduction from supplier bills (non-void, whtCents > 0,
NET of supplier credit notes' WHT), paid OpEx payments (whtCents > 0) and CapEx payments (whtCents > 0 — the column exists from w0); columns
company, date, source, document, vendor, NTN (taxId), filer status, section, rate, base, WHT; CSV through accounting/csv.ts. Add a CA note in the
response: bill WHT is fixed at bill date while s.153 is deducted at payment.

**accounting/taxPayments.ts** (both areas):
- PP (H7): `StatutoryKey = 'salary_tax'|'eobi'|'sessi'`, `STATUTORY` [{ key, label, name, account: ACCT.SALARY_TAX_PAYABLE|EOBI_PAYABLE|SOCIAL_SECURITY_PAYABLE }],
  TAX_PAYMENT_AUTHORITIES += the three (the zod enum on POST /accounting/sales-tax-return/payments picks them up), settlementAccounts resolves them
  (liability 2042/2043/2044, input null → 422 NO_INPUT_SET_OFF), recordTaxPayment calls `assertTemplateAccounts` in its tx; remove TODO(G3).
  Link/void work unchanged for the new keys; linking an entry that debits 2090 → 422 NOT_A_TAX_PAYMENT.
- TX (H13): `customerWithheldSetOffCents` input (zMoneyCents, default 0); 422 NO_WITHHELD_SET_OFF for authority wht/stwh; the cap under advisory lock
  (tenantId, 'tax-stwh:<authority>') = min(1335 balance at paidAt and at end of time, Σ live 'receivable.st_withheld' rows for that authority −
  Σ earlier set-offs) → 422 WITHHELD_SET_OFF_TOO_LARGE; the extra Cr 1335 line; `settlementOf` / `linkTaxPayment` read a Cr 1335 line in a linked
  manual entry as customerWithheldSetOffCents (critic — never as money paid); `isMoney` knows 1011 (petty cash); settlementAccounts imports
  taxAuthorities; remove TODO(G7). Export `customerWithheldAvailable(db, tenantId, authority, asOf)` for the return.
  NOTE: customer-withheld sales tax uses ReceivablePayment.method **'st_withheld'** and sourceType **'receivable.st_withheld'** (critic) — never 'stwh'
  (that key stays OUR agent withholding, 2041).

**accounting/statutory.ts — ONE accrued-vs-paid computation** (the HR report links here; it never recomputes from payslips):
`statutorySummary(db, tenantId, fromMonth, toMonth)` per month per scheme: accrued = net credits on 2042/2043/2044 from entries whose reference
starts 'hr.' dated in the month; the reclass shown separately; paid from SalesTaxPayment (authority, periodFrom = month start); balance at month
end; overpaid flag; `legacyHrChallans` = HrRecord section 'eobi_challan' rows ('recorded in HR, not on the books'). `reclassPreview(db, tenantId)`
(HR-sourced EOBI/SESSI/tax credits on 2090/2040 per entry, split by payslip lines / F&F data, reversals subtract, pro-rata where a run drifted;
current 2090/2040 balances; manual debits; done flag). `postReclass(tenantId, amounts, userId, note)`: ONE-TIME **'statutory.reclass:<tenantId>'**
(critic: not 'hr.' so it never counts as accrued; NO reverse route), dated today, advisory lock; 409 RECLASS_DONE; 422 RECLASS_OVER_BALANCE /
NOTHING_TO_RECLASS / PERIOD_LOCKED. `statutoryCloseChecks: CloseCheck[]` (both warn): 'statutory_reclass' (HR-sourced amounts left, no reclass),
'statutory_unpaid' (accrued > paid for months before the last month in range).
**statutoryRoutes.ts** (wave Z registers at /accounting/statutory): GET / (FINANCIALS_VIEWERS, active company), GET /reclass, POST /reclass
(TAX_PAYERS = admin, finance); audit category 'accounting'.
**setup/routes.ts — PATCH /setup/operations-config only (moved here from W4 so the W3 operations page and the W3 cash-request worker find
the backend ready — verifier fix):** the zod DROPS `withholdingTaxPct` (ONE writer: PUT /accounting/withholding/rates; keep
`withholdingTaxEnabled` and `withholdingTaxRecoverable`; a body that still sends withholdingTaxPct is ignored, never saved) and GAINS
`cashAdvanceSettleDays: z.number().int().min(1).max(365).optional()` (H3; audited through the existing changed-fields audit; read by the W3
cash-request worker). Touch nothing else in setup/routes.ts — the chart-of-accounts guards are w4-integration's in W4.
**Admin /accounting/statutory/page.tsx:** month range; table per scheme (accrued / paid / owed; cleared in green via tokens); Record payment dialog
→ POST /accounting/sales-tax-return/payments {authority salary_tax|eobi|sessi, period, paidCents (rupees→paisa), bank via BankAccountSelect,
cprNumber}; Link existing entry; Void with reason; the one-time reclass panel (preview, editable amounts, post); legacy HR challan list.
""",
consumes=r"""
- w0: ACCT (SALARY_TAX_PAYABLE, EOBI_PAYABLE, SOCIAL_SECURITY_PAYABLE, ST_WITHHELD_BY_CUSTOMERS, PRA/SRB/KPRA/BRA_TAX_INPUT, PETTY_CASH),
  `assertTemplateAccounts`, `CloseCheck` types, `ledgerBalancesByCode`, accounting/csv.ts, BankAccountSelect (admin).
""",
exposes=r"""
```ts
// accounting/taxAuthorities.ts
export type AuthorityKey = 'fbr'|'pra'|'srb'|'kpra'|'bra'
export const TAX_AUTHORITY_KEYS: readonly AuthorityKey[]
export const AUTHORITIES: Record<AuthorityKey, { label: string; outputCode: string; inputCode: string }>
export function inputTaxCodeFor(key: AuthorityKey): string
export function outputTaxCodeFor(concept: { province: string | null; srbPosId: number | null }): string
export function authorityOfOutputCode(code: string): AuthorityKey | null
export function authorityOfInputCode(code: string): AuthorityKey | null
// lib/withholding.ts
export const WHT_SECTIONS: readonly ['153_1_a','153_1_b','153_1_c','155']; export type WhtSection = typeof WHT_SECTIONS[number]
export const FILER_STATUSES: readonly ['filer','non_filer','exempt','unknown']
export function withholdingRatesFor(db: Db, tenantId: string): Promise<{ enabled: boolean; rates: Record<WhtSection, { filerBps: number; nonFilerBps: number }>; defaultsUsed: boolean }>
export function computeWithholding(db: Db, a: { tenantId: string; supplier: { filerStatus: string; whtExemptUntil: Date | null } | null;
  filerStatus?: string; section: WhtSection | null; baseCents: number; at: Date })
  : Promise<{ whtCents: number; rateBps: number; section: WhtSection | null; filerStatus: string; exempt: boolean; needsAtlCheck: boolean }>
export function defaultSectionForCapex(treatment: 'capital'|'prepaid'|'deposit'|'expense', projectType: string): WhtSection | null
// accounting/taxPayments.ts
export type StatutoryKey = 'salary_tax'|'eobi'|'sessi'
export const STATUTORY: ReadonlyArray<{ key: StatutoryKey; label: string; name: string; account: string }>
export function customerWithheldAvailable(db: Db, tenantId: string, authority: AuthorityKey, asOf: Date): Promise<number>
// accounting/statutory.ts
export function statutorySummary(db: Db, tenantId: string, fromMonth: string, toMonth: string): Promise<StatutorySummary>
export const statutoryCloseChecks: CloseCheck[]
```
""",
tests=r"""
Two companies A/B throughout. `taxWithholdingRates`: PUT binds the active company only (B's GET still defaults), bps > 5000 → 422, legacy pct maps
to 153_1_a filer; computeWithholding table (exempt in/after expiry, non-filer, unknown → filer + needsAtlCheck, switch off → 0, capex section map).
`withholdingRegister`: A's rows never in B; credit-note WHT nets; CSV columns. `taxPaymentWithheldSetOff`: SRB set-off up to available, 422 above,
B can't use A's 1335, 'wht' + set-off → 422, entry balances, a linked manual entry with Cr 1335 counts as set-off not paid. `statutoryPayments`
(people B list): eobi payment Dr 2043 / Cr A's bank, binds to the ACTIVE company; B voiding A's → 404; second same month → 409 TAX_PAYMENT_EXISTS;
input set-off → 422 NO_INPUT_SET_OFF; locked paidAt → 422, nothing saved; link of a 2042 manual entry works, a 2090 one → 422; GET /statutory nets to
0 after accrual + payment (accrual via a journal fixture 'hr.payroll.accrual:<id>'); reclass preview / post / 409 RECLASS_DONE / 422 over balance /
B never touched; the close check warns only for the company with residue. `operationsConfigWaveB`: PATCH /setup/operations-config with
withholdingTaxPct leaves the stored value unchanged; cashAdvanceSettleDays 1-365 saved for the ACTIVE company only (B's row untouched; 0 / 366 → 400);
the audit row names the field. `taxPayments.test.ts`: update only what the statutory keys / set-off change.
""",
))

W1.append(dict(
id="w1-fa-engine", wave="W1", area="assets", idx=2,
title="Fixed-asset engine: classes, schedule, automatic depreciation, events, pools, tax, close check",
summary="fixedAssets/classes, schedule, service (chargeThrough = THE depreciation path), events, pools, tax, closeCheck.",
owns=["backend/src/modules/fixedAssets/classes.ts (new)", "backend/src/modules/fixedAssets/schedule.ts (new)",
      "backend/src/modules/fixedAssets/service.ts", "backend/src/modules/fixedAssets/events.ts (new)", "backend/src/modules/fixedAssets/pools.ts (new)",
      "backend/src/modules/fixedAssets/tax.ts (new)", "backend/src/modules/fixedAssets/closeCheck.ts (new)",
      "backend/tests/fixedAssetsSchedule.test.ts (new)", "backend/tests/fixedAssetsRun.test.ts (new; w3-fa-api adds worker cases in W3)",
      "backend/tests/fixedAssetsEvents.test.ts (new)", "backend/tests/baseLayers.test.ts (FA parts only in W1)"],
read=["plan_assets.json: summary, postings (all except CapEx instalment/prepaid/deposit), build_split A, data_migration",
      "critic_assets_foodcost_0.json: violations 1, 7; missing 'pool requests re-check units', 'disposal and void debit per row accumCode'; code_facts on sourcePosting dates and REPOSTERS"],
tasks=r"""
Follow FA plan agent A with these corrections:
- **No autoDepreciation switch** (owner: automatic). `getFixedAssetPolicy(tenantId)` reads capexUncapitalisedAlertDays, capexAdvanceOverdueDays,
  deferredTaxRateBp, assetTagPrefix via getOperationsConfig.
- **classes.ts** — ONE class list `ASSET_CLASS_DEFAULTS` (codes from ACCT): kitchen_equipment 1510/1591 60 mo tax 15% IA 25%; furniture_fixtures
  1520/1592 84 mo 15% IA 0; it_equipment 1530/1593 36 mo 30% IA 25%; vehicles 1540/1594 60 mo 15% IA 0; leasehold 1550/1595 120 mo (capped at
  leaseEndsAt) 10% IA 0; buildings 1505/1596 240 mo 10% IA 0; power_equipment 1515/1597 84 mo 15% IA 25%; office_equipment 1525/1598 60 mo 15% IA 25%;
  smallwares 1560/1599 24 mo pooled 15% IA 0; land 1500 not depreciable. `SMALLWARE_TYPES`; `ensureAssetClasses(tenantId)` (adds missing keys
  only); `getAssetClasses(tenantId, db)`; `classOf`. **Equipment guard (used by bills, OpEx, petty cash, cash requests, inventory items):**
  `looksLikeEquipment(text) → { matched: string | null }` (equipment + smallwares nouns — fryer, oven, chiller, freezer, grill, range, hood,
  mixer, blender, generator, UPS, laptop, printer, POS, AC, fridge, table, chair, knife/knives, ladle, bowl, plate, tray, pot, pan, cutlery,
  glassware …; negated by service markers repair/service/maintenance/cleaning/installation/rental/hire/refill and disposable markers
  disposable/paper/kraft/foil/plastic/takeaway/packaging/ml); `assertNotEquipmentLine({ description, expenseAccountCode, notEquipment?,
  notEquipmentReason? }, actor: { role: string }) → { overridden: boolean }`: expense code in REGISTER_CONTROLLED_CODES or 1340 → always 422
  USE_CAPEX; a match without override → 422 USE_CAPEX ('This line is equipment (matched "<word>"). Equipment goes on the register only through
  CapEx — Finance → Project tracker → Quick buy.'); an override (reason ≥ 10 chars) is allowed ONLY for roles admin and finance (critic) else 403
  OVERRIDE_NOT_ALLOWED; the CALLER audits and flags ('bill_equipment_override' high for bills, 'equipment_override' elsewhere).
- **schedule.ts** pure (PKT months): periodOfPkt, lastDayPkt, planCharges(asset, chargedMap, adjustments, throughPeriod), forecast, nextMonthlyCharge,
  nbvAt(asset, events, charges, asOf). Remaining depreciable ÷ remaining UNCHARGED months, strictly in order from the in-service month,
  full-month convention (in-service month charged, disposal month not), capped at cost − salvage (M-01), method none for land.
- **service.ts:** `chargeThrough(tenantId, throughPeriod, { postedBy, assetIds?, db? })` — per asset its own tx + advisory lock; syncSourcePosting
  'fixed_asset.depreciation' id `<assetId>:<YYYY-MM>` with `keepLiveDate: true` and `lateDatingFor` (late month → postedPeriod), Dr 6150 /
  Cr the class accum code (both conceptId = the brand that month); upsert FixedAssetDepreciation (accumCode, conceptId, locationId,
  postedPeriod); a P2002 race = 'already'; a refused asset → flagException 'depreciation_failed' + flagPostingFailed (sourceType
  'fixed_asset.depreciation', entityType 'FixedAsset', sourceId = entityId = **assetId** — critic) and continue; writes a FixedAssetRun row
  (chargedCount/Cents, lateCount, failedCount). 422 MONTH_NOT_ENDED for an unfinished month. `chargeAssetThrough(assetId, throughPeriod, opts)`
  for the reposter (ignores opts.entryDate/memoNote; late-dates per month). `postAcquisition` extended (class codes, Dr input tax 132x, split
  credits: Cr 1340 advanced / Cr 2012 owed, lateDatingFor). `reclassLegacyAccumulated(tenantId)` ('fixed_asset.acc_dep_reclass:<tenantId>',
  Dr 1590 / Cr 159x for rows still on accumCode '1590', rows updated in the same tx). `nextAssetTag(tx, tenantId)` (advisory lock, prefix from
  policy, 5 digits). **Keep `runDepreciation` and `ASSET_CATEGORIES` as thin deprecated aliases** (runDepreciation → chargeThrough;
  ASSET_CATEGORIES = class keys) because fixedAssets/routes.ts (w3-fa-api) and financePlanning (w2-fa-capex) still import them this wave;
  w3-fa-api deletes the aliases. Delete chargeFor.
- **events.ts:** createRequest(input, actor), needsApproval(kind), applyEvent(eventId, approverId), rejectEvent, cancelEvent. All kinds
  (capitalise, disposal, pool_write_off(+_alloc), impairment, change_estimate, transfer, pool_transfer(+_alloc), void, undispose, count) with
  the postings of the FA plan. `capitalise` reads advances via a dynamic import of `../financePlanning/capexPosting.js` `capexAdvancesForLine`
  (w2-fa-capex — guard so W1 compiles; capitalise tests come in W2). Claim pending→posted with updateMany; the CEO's own request applies at once;
  non-CEO approval-required kinds stay pending; transfer and count apply at once (finance). **Re-check units on hand when a pool request is
  applied** (several pending requests can exceed the pool → 409 UNITS_EXCEED_POOL). **Disposal and void debit accumulated per depreciation row's
  accumCode** (1590 for unreclassed legacy rows, 159x otherwise). Disposal date rules (422 DISPOSAL_DATE), proceeds via moneyAccountCode,
  gain/loss 8030; impairment 6155 capped at NBV − salvage; change of estimate prospective; void reverses acquisition + live depreciation +
  impairments (409 ASSET_HAS_EVENTS if a posted disposal/write-off/transfer exists); undispose reverses and catches up. Approval failures roll
  back and keep `errorMessage` on the event.
- **pools.ts:** findOrCreatePool(tx, { tenantId, locationId, conceptId, classKey, typeKey }) and FIFO allocation across layers (oldest inServiceAt).
- **tax.ts:** taxSchedule(tenantId, taxYear) using `taxYearOf` from accounting/fiscalYear.ts (ONE year definition), freezeTaxYear (409
  TAX_YEAR_FROZEN, 422 TAX_YEAR_OPEN), deferredTax (report only, policy.deferredTaxRateBp).
- **closeCheck.ts:** `fixedAssetCloseChecks: CloseCheck[]` — 'depreciation' (block, overridable: active assets with an uncharged month ending ≤
  newLock; fix POST /accounting/fixed-assets/depreciate; link /accounting/fixed-assets?uncharged=1), 'capitalisation_pending' (warn).
  `chargeForClose(tenantId, lockedThrough, postedBy)` runs chargeThrough for completed months. (The 'prepaid_release' check is w2-fa-capex's
  prepaidReleases.ts.)
""",
consumes=r"""
- w0: ACCT class codes, REGISTER_CONTROLLED_CODES, `lateDatingFor`, `syncSourcePosting(…, { keepLiveDate })`, `taxYearOf`, `CloseCheck`,
  moneyAccountCode, flagException/flagPostingFailed, getOperationsConfig.
""",
exposes=r"""
```ts
// fixedAssets/classes.ts
export const ASSET_CLASS_DEFAULTS: ReadonlyArray<{ key: string; label: string; costAccountCode: string; accumAccountCode: string | null;
  depreciable: boolean; pooled: boolean; defaultLifeMonths: number | null; taxRateBp: number; taxInitialAllowanceBp: number }>
export const SMALLWARE_TYPES: readonly string[]
export function ensureAssetClasses(tenantId: string): Promise<number>
export function getAssetClasses(tenantId: string, db?: Db): Promise<FixedAssetClass[]>
export function looksLikeEquipment(text: string): { matched: string | null }
export function assertNotEquipmentLine(input: { description: string; expenseAccountCode?: string | null; notEquipment?: boolean;
  notEquipmentReason?: string | null }, actor: { role: string }): { overridden: boolean }
export function getFixedAssetPolicy(tenantId: string): Promise<FixedAssetPolicy>
// fixedAssets/service.ts
export function chargeThrough(tenantId: string, throughPeriod: string, o: { postedBy: string; assetIds?: string[]; db?: Db }): Promise<ChargeRunResult>
export function chargeAssetThrough(assetId: string, throughPeriod: string, o?: { postedBy?: string }): Promise<ChargeRunResult>
export function postAcquisition(tx: Tx, asset: FixedAsset, a: { advancedCents: number; owedCents: number; inputTaxCents: number; inputTaxCode: string | null; natural: Date }): Promise<void>
export function reclassLegacyAccumulated(tenantId: string): Promise<{ posted: boolean; cents: number }>
export function nextAssetTag(tx: Tx, tenantId: string): Promise<string>
// fixedAssets/events.ts
export function createRequest(input: CreateEventInput, actor: { id: string; role: string }): Promise<{ event: FixedAssetEvent; applied: boolean }>
export function applyEvent(eventId: string, approverId: string): Promise<FixedAssetEvent>
export function rejectEvent(eventId: string, approverId: string, note: string): Promise<FixedAssetEvent>
export function cancelEvent(eventId: string, actorId: string): Promise<FixedAssetEvent>
export function needsApproval(kind: string): boolean
// fixedAssets/pools.ts (w2-fa-capex's Quick buy / capitalise of smallwares uses it)
export function findOrCreatePool(tx: Tx, a: { tenantId: string; locationId: string; conceptId: string | null; classKey: string; typeKey: string }): Promise<FixedAssetPool>
// fixedAssets/closeCheck.ts
export const fixedAssetCloseChecks: CloseCheck[]
export function chargeForClose(tenantId: string, lockedThrough: Date, postedBy: string): Promise<void>
```
""",
tests=r"""
`fixedAssetsSchedule` (exact cost − salvage, full-month convention, 24-month smallwares layer, land never charged, remainder in the last month,
out-of-order legacy charges never exceed depreciable (M-01), impairment/change-estimate/partial-out bases prospective, nbvAt past date, 00:30
PKT on the 1st). `fixedAssetsRun` (engine part: missing months charged in order; a closed month posts into the open month with the note and
postedPeriod under the SAME reference; a re-sync keeps the live date; deactivated class account fails one asset → depreciation_failed +
posting_failed and the others still charge; concurrent chargeThrough posts once; MONTH_NOT_ENDED; two companies into their own ledgers;
legacy 1590 reclass once; the close check blocks and chargeForClose clears it). `fixedAssetsEvents` (all kinds except capitalise: CEO
immediate vs finance pending; disposal bank/cash + BANK_ACCOUNT_REQUIRED + gain/loss 8030; backdated disposal reverses later charges; pool
write-off FIFO across two layers + units re-checked at apply; impairment 6155; change of estimate; brand transfer nets to zero and later
depreciation carries the new brand; pool unit transfer with carried accumulated; void + undispose; count posts nothing; disposal of a legacy
row debits 1590; trial balance zero per company after each case). `baseLayers.test.ts`: chargeThrough replaces runDepreciation, credits 1591,
the M-01 case. Assets are created in tests through a fixture helper (insert + postAcquisition) — CapEx capitalisation arrives in W2.
""",
))

W1.append(dict(
id="w1-hr", wave="W1", area="people (+ cash HR seams)", idx=3,
title="Gratuity, statutory accrual accounts, HR close checks, HOD helper, cash-advance → HR loan",
summary="hr/* (gratuity, 2042-2044, F&F fixes, eobi_challan per Q1, close checks, directManagerUserIdOf, createLoanFromCashAdvanceTx) + HR admin bits.",
owns=["backend/src/modules/hr/logic.ts", "backend/src/modules/hr/ledger.ts", "backend/src/modules/hr/forms.ts", "backend/src/modules/hr/routes.ts",
      "backend/src/modules/hr/reports.ts", "backend/src/modules/hr/letters.ts", "backend/src/modules/hr/service.ts",
      "backend/src/modules/hr/closeChecks.ts (new)", "backend/src/modules/hr/advanceLoan.ts (new)",
      "frontend/admin/src/components/hr/RecordDetail.tsx", "frontend/admin/src/app/hr/settings/page.tsx", "frontend/admin/src/app/hr/s/[section]/page.tsx",
      "backend/tests/hrGratuity.test.ts (new)", "backend/tests/hrStatutoryAccrual.test.ts (new)", "backend/tests/hrAdvanceLoan.test.ts (new)",
      "backend/tests/hrFinalSettlementLedger.test.ts", "backend/tests/hrModule.test.ts", "backend/tests/auditPeopleHr.test.ts"],
read=["plan_people.json: summary 1-2, build_split A, routes (hr), data_migration 6",
      "critic_tax_people_1.json: F&F sibling-reversal bug, saved HR formats, payroll baseline, one statutory computation, Q1",
      "plan_cash.json: shared_file_changes hr/ledger.ts + hr/routes.ts; critic_cash_delivery_onaccount_1.json violation 4 (HOD = HR rule)"],
tasks=r"""
**Gratuity (H6).** HrSettings.gratuity {enabled true, eligibleTypes ['permanent'], minServiceMonths 12, partYearOverMonths 6, daysPerYear 30} +
deep merge; pure `gratuityFor(emp, lastWorkingDay, lastGrossCents, settings)` (day-precise service; counted = years + (remainder > 6 months ? 1 : 0);
needs ≥ 1 full year and an eligible type; amount = round(lastGross/30 × daysPerYear) × countedYears); settlementParts/settlementNet gain
`gratuity`; finalSettlement returns it. `/final-settlement/calculate` REUSES its existing grossSalaryCents (salaryForPeriod at the last working
day — do not call it again) and returns gratuity + gratuityDetail; prepareRecord INT4-guards it (422 AMOUNT_TOO_LARGE); PUT /settings zod gains
gratuity; F&F letter gains a Gratuity row; forms.ts final_settlement field 'gratuity' (money, system). **Saved formats:** getFormat (hr/service.ts)
merges any missing default SYSTEM fields into a company's saved final_settlement format (and letter format rows), so validateAgainst never drops
'gratuity' and checkFormat accepts the next edit (critic) — with a test using a saved format.
**Statutory accounts (H7).** postPayrollAccrual / postFinalSettlementAccrual credit 2043 = EOBI employee + employer, 2044 = SESSI employer,
2042 = salary tax (replacing STATUTORY_PAYABLE '2090' / TAX_PAYABLE 2040); F&F adds Dr 6036 = gratuity and Cr 2020 net incl. gratuity; both call
`assertTemplateAccounts(tx, tenantId, codes)` first (an operator-owned code → 422 ACCOUNT_CODE_TAKEN, the lock/approval rolls back).
**Fix the F&F sibling-reversal lookup** (hr/ledger.ts ~315): look up `${FNF_ACCRUAL}.reversal:<id>` (journal references are always
`sourceType:sourceId`; 'reverses:…' never matches) — replace-after-cancel works again; test it.
**eobi_challan (owner Q1 — the orchestrator confirms before launch; DEFAULT if not told otherwise = retire):** createRecord refuses new
eobi_challan records with 409 SECTION_MOVED ('EOBI, SESSI and salary tax challans are recorded in Accounting → Statutory payments') — once, in
createRecord (covers /records/:section and /me/records/:section); rows stay readable; section page banner + no New button. If the orchestrator
says Q1 = keep HR's form, skip this bullet only.
**HR report 'statutory':** NOT a second computation — it returns a pointer to /accounting/statutory (or calls accounting/statutory.ts
statutorySummary once w1-taxcore's file exists; same wave, so link only).
**hr/closeChecks.ts** `hrCloseChecks: CloseCheck[]`: 'payroll' (block, overridable): months in ctx.months FROM the company's first HrPayrollRun
period on (baseline — critic: never block pre-servd months or joiningDate-null staff before then) with payable staff need a locked run and,
when it has money, a 'hr.payroll.accrual:<id>' entry; 'fnf_unposted' (block, overridable): approved final_settlement records approved ≤ newLock
with no 'hr.final_settlement.accrual:<id>' entry (fix POST /hr/final-settlement/post-unposted).
**Cash-area seams (CA):** hr/ledger.ts `loanPayingAccount`: data.paidFrom 'cash_request' → `{ method:'cash_request', code: ACCT.CASH_ADVANCES,
bankAccountId: null }`, memo 'Moved from an unsettled cash request'. hr/routes.ts: cancelling an approved loan with data.paidFrom 'cash_request'
→ 409 LOAN_FROM_CASH_REQUEST. hr/advanceLoan.ts `createLoanFromCashAdvanceTx` (HrRecord section 'loan', status approved, formVersion from
getFormat, category 'advance', quantity = installments, effectiveDate = 1st of next PKT month, approvals [{step:'ceo', decision:'approved',
byUserId, note}], data { paidFrom:'cash_request', cashVoucherId }, then the existing postLoanDisbursement → Dr 1350 / Cr 1355; idempotent on the
record). hr/service.ts exports **`directManagerUserIdOf(tenantId, userId)`** (the SAME rule as canActOnStep('hod') / approvalSubject: the direct
reporting manager's login, HR fallback when none) and **`teamUserIdsUnder(tenantId, managerUserId)`** (extracted from the /hr/team walk, which
then calls it) — the cash-requests HOD check uses these; there is NO hr/reportingLine.ts (critic).
**Admin:** RecordDetail Calculate fills gratuity + service breakdown; HR settings gratuity block; eobi_challan section banner. Tokens only.
""",
consumes=r"""
- w0: ACCT.SALARY_TAX_PAYABLE/EOBI_PAYABLE/SOCIAL_SECURITY_PAYABLE/GRATUITY/CASH_ADVANCES/STAFF_LOANS, `assertTemplateAccounts`, CloseCheck types.
""",
exposes=r"""
```ts
// hr/logic.ts
export function gratuityFor(emp: { employmentType: string; joiningDate: Date | null }, lastWorkingDay: Date, lastGrossCents: number,
  s: GratuitySettings): { eligible: boolean; reason: string | null; years: number; months: number; days: number; countedYears: number; amountCents: number }
// hr/closeChecks.ts
export const hrCloseChecks: CloseCheck[]
// hr/service.ts
export function directManagerUserIdOf(tenantId: string, userId: string, db?: Db): Promise<string | null>
export function teamUserIdsUnder(tenantId: string, managerUserId: string, db?: Db): Promise<string[]>
// hr/advanceLoan.ts
export function createLoanFromCashAdvanceTx(tx: Tx, a: { tenantId: string; employeeId: string; amountCents: number; installments: number;
  approvedById: string; cashVoucherId: string; number: string }): Promise<{ recordId: string }>
```
""",
tests=r"""
`hrGratuity` (11 months → 0; exactly 1y6m → 1 year; 1y6m1d → 2; 3y7m → 4; probation → 0 with reason; disabled → 0; lastGross from the latest
revision; calculate returns it; approval posts Dr 6036 / Cr 2020 incl. gratuity in A only; > INT4 → 422; saved-format company still gets the
field; B's HR → 404 on calculate/approve/paid for A's leaver). `hrStatutoryAccrual` (payroll lock → 2043/2044/2042 and nothing to 2090/2040; F&F
same; A's 2043 retyped → 422 ACCOUNT_CODE_TAKEN and the run stays approved; B unaffected; eobi_challan 409 SECTION_MOVED (default) and old rows
listed; hrCloseChecks blocks an unlocked run month after the baseline and never before it; B's unlocked run never blocks A). `hrAdvanceLoan`
(createLoanFromCashAdvanceTx posts Dr 1350 / Cr 1355, loansFor counts it, cancel → 409 LOAN_FROM_CASH_REQUEST; directManagerUserIdOf /
teamUserIdsUnder follow the reporting line, B's tree invisible). Update `hrFinalSettlementLedger` (2090/2040 → 2043/2044/2042; cancel of an OLD
2090-era accrual still reverses 2090/2040; replace-after-cancel now works), `hrModule`, `auditPeopleHr`.
""",
))

W1.append(dict(
id="w1-ic", wave="W1", area="people (inter-company)", idx=4,
title="Inter-company accounts and transfers (H30), shared-fleet recharge, legacy tie-out, COD seam",
summary="intercompany/* + worker + lib/companyPairs.ts; exposes postSystemTransferTx/reverseSystemTransfer for the COD area; admin /accounting/intercompany.",
owns=["backend/src/modules/intercompany/accounts.ts (new)", "backend/src/modules/intercompany/service.ts (new)", "backend/src/modules/intercompany/fleet.ts (new)",
      "backend/src/modules/intercompany/legacy.ts (new)", "backend/src/modules/intercompany/closeChecks.ts (new)", "backend/src/modules/intercompany/routes.ts (new)",
      "backend/src/modules/intercompany/README.md (new)", "backend/src/workers/intercompanyFleet.ts (new)", "backend/src/lib/companyPairs.ts (new)",
      "backend/src/modules/positions/contributions.ts", "backend/src/modules/positions/routes.ts",
      "frontend/admin/src/app/accounting/intercompany/page.tsx (new)", "frontend/admin/src/app/workforce/positions/view.tsx",
      "backend/tests/intercompany.test.ts (new)", "backend/tests/intercompanyFleet.test.ts (new)", "backend/tests/intercompanyLegacy.test.ts (new)",
      "backend/tests/controlledAccounts.test.ts (new)"],
read=["plan_people.json: summary 4-5, schema (IntercompanyTransfer, FleetRate), postings (fleet, manual, settlement, netting, reversal, legacy), routes (intercompany), build_split D",
      "critic_tax_people_1.json: violations 3-5, 8; missing (fleet REPOSTER shape, claim+postings in one tx, recovery account, COD crossing, FleetRate unique, legacy at split dates)"],
tasks=r"""
Follow people plan agent D with these corrections:
- **lib/companyPairs.ts:** move `assertBothSidesOwned` out of positions/contributions.ts (29-45) — ONE membership check: the caller belongs to
  BOTH companies AND one side is the active company (403 NOT_IN_BOTH_COMPANIES / 422 ACTIVE_COMPANY_NOT_A_PARTY); also export
  `isMemberOfBoth(user, a, b)` (no active-party requirement) for system-adjacent uses (COD rider debt, reposter guard). contributions.ts imports it.
- **No gate widening** (the CEO holds 'accounting'; the approvals provider reads under the existing '/accounting' rule).
- **Accounts:** `ensurePairAccounts(tx, a, b)` under pg_advisory_xact_lock(hashtext('ic.pair:'+min+':'+max)): 'Due from <other>' (asset, first
  free 1450-1499) and 'Due to <other>' (liability, first free 2150-2199) in EACH company, controlledBy 'intercompany', counterpartyTenantId,
  description 'Inter-company with <name>. Confirm with your CA.'; reuse existing (partial unique); 422 NO_FREE_IC_CODE. `pairBalances`.
- **Transfers:** createTransfer (assertBothSidesOwned; codes active + non-controlled in the right chart; banks via moneyAccountCode per side;
  balance limits under the pair lock: 422 SETTLEMENT_OVER_BALANCE / NETTING_OVER_BALANCE), approveTransfer / rejectTransfer / reverseTransfer
  (CEO, member of both). **The submitted→posted claim and BOTH postJournalEntry calls run in ONE serviceClient transaction** (a PERIOD_LOCKED in
  either book rolls back the claim; pre-check both locks to name the closed company). Same reference 'ic.transfer:<id>' in both books; audit in
  BOTH companies. Reversal 'ic.transfer.reversal' in both, CEO only.
- **Shared fleet (H30, owner Q2/Q3 defaults):** FleetRate per agreement (CEO, member of both; 409 RATE_PERIOD_CHARGED / RATE_EXISTS; audit both).
  `tripsFor` = COUNT(DISTINCT orderId) of 'picked_up' RiderJobEvents with tenantId = client and riderTenantId = provider in the PKT month (raw SQL
  `::int`, grouped by order concept). `chargeFleetMonth(agreementId, month, opts)`: system-posted IntercompanyTransfer (source 'fleet', sourceRef
  'fleet:<agreementId>:<YYYY-MM>', status posted, preparedById 'system' or the CEO): client Dr 6035 per client brand / Cr Due-to-provider;
  provider Dr Due-from-client / **Cr 6990 Costs Recharged to Group Companies** (critic: one recovery account shared with D1; 6035 stays gross
  rider wages). Entry date = month end, or the first day open in BOTH companies + withLateNote naming the month. Idempotent (unique sourceRef +
  reference + pair lock). Refusal → flagPostingFailed sourceType 'ic.fleet_charge', entityType 'FleetCharge', entityId '<agreementId>:<month>'.
  `chargeAllEnded(now)` (rate > 0, from fromPeriod, max 3 months back). Worker `startIntercompanyFleetWorker` (node-cron '40 3 * * *'
  Asia/Karachi, running guard, serviceClient) + `runFleetChargesOnce` for tests.
- **COD seam for the delivery area (H5 + H30):** `postSystemTransferTx(serviceTx, { kind:'charge', source:'cod'|'fleet', sourceRef, debtorTenantId,
  creditorTenantId, amountCents, entryDate, debtorAccountCode, creditorAccountCode, conceptSplit?, memo, preparedById })` (posts both books in the
  given serviceClient tx, status posted, idempotent on sourceRef) and `reverseSystemTransfer(transferId, reason, { entryDate?, tx? })`. For a fleet
  rider's unpaid COD the debtor is the PROVIDER (Dr 1351 in its books, the rider owes it) and the creditor the CLIENT (Cr 1010 in its books).
- **Legacy residue (H30) — at the split migrations' dates, not today's difference (critic):** `controlTieOut(db, tenantId, asOf)` (2050 vs Σ
  wallets, 2060 vs points × value, 2080 vs live gift-card balances); `legacyEvidence`; `writeOffLegacy(tenantId, code, reason, userId, dryRun)`
  writes off ONLY the difference measured as at the split migration (loyalty 20261010150300, wallet 20261011160000 — rebuild the subledger at
  that date from loyalty_transactions / wallet_transactions; the wallet migration header names Dr 6060 / Cr 2050); later drift stays a
  'control_tieout' warning. Key 'legacy.cross_company_writeoff:<tenantId>:<code>', once (409 ALREADY_WRITTEN_OFF), CEO + reason.
- **closeChecks.ts** `intercompanyCloseChecks`: 'intercompany_pending' (block), 'fleet_recharge' (block; fix POST /accounting/intercompany/fleet/charge),
  'fleet_no_rate' (warn), 'intercompany_mismatch' (warn), 'intercompany_unsettled' (warn), 'control_tieout' (warn).
- **routes.ts** (wave Z registers at /accounting/intercompany): every route in the people plan's routes list; zod; zMoneyCents/zInt4Cents; audits.
- **Reposter shape for w4-integration (document in README + report):** flag only; load() → nothingOwed when the transfer with sourceRef
  'fleet:<…>' is posted; post() refuses unless the operator belongs to both companies (message 'ask the CEO to Charge now'); re-derives the
  common open day.
- Comment fixes: positions/contributions.ts:29-33, positions/routes.ts:45, admin workforce/positions/view.tsx:37 (planning figure only; the ledger
  side is the inter-company transfer). Owner Q5 (TenantContribution posting) is OPEN — do not post contributions.
- Admin /accounting/intercompany (tabs Balances | Transfers | Shared fleet | Tie-out & legacy): mismatch in red, approve/reject for the CEO, rates,
  Charge now, legacy write-off with preview; tokens only; flag in the UI that the All-companies balance sheet shows due-from/due-to gross (no
  consolidation eliminations).
""",
consumes=r"""
- w0: Account.controlledBy/counterpartyTenantId + the journal.ts 'ic.' rule; ACCT.WAGES_RIDERS, GROUP_RECHARGES (6990), MARKETING_PROMO,
  RIDER_COD_RECEIVABLE, CASH_ON_HAND; `withLateNote` / period-lock helpers; moneyAccountCode; CloseCheck types.
""",
exposes=r"""
```ts
// lib/companyPairs.ts
export function assertBothSidesOwned(req: FastifyRequest, a: string, b: string): Promise<void>
export function isMemberOfBoth(user: { id: string; memberTenantIds: string[] }, a: string, b: string): boolean
// intercompany/accounts.ts
export function ensurePairAccounts(tx: Tx, a: string, b: string): Promise<{ aDueFrom: string; aDueTo: string; bDueFrom: string; bDueTo: string }>
// intercompany/service.ts
export function postSystemTransferTx(serviceTx: Tx, a: { kind: 'charge'; source: 'cod'|'fleet'; sourceRef: string; debtorTenantId: string;
  creditorTenantId: string; amountCents: number; entryDate: Date; debtorAccountCode: string; creditorAccountCode: string;
  conceptSplit?: Array<{ conceptId: string; cents: number }>; memo: string; preparedById: string })
  : Promise<{ transferId: string; debtorEntryId: string; creditorEntryId: string; alreadyPosted: boolean }>
export function reverseSystemTransfer(transferId: string, reason: string, o?: { entryDate?: Date; tx?: Tx }): Promise<void>
// intercompany/fleet.ts
export function chargeFleetMonth(agreementId: string, month: string, o?: { entryDate?: Date; memoNote?: string; postedBy?: string }): Promise<{ charged: boolean; transferId?: string }>
export function runFleetChargesOnce(now?: Date): Promise<void>
export function startIntercompanyFleetWorker(): void
// intercompany/legacy.ts
export function controlTieOut(db: Db, tenantId: string, asOf: Date): Promise<ControlTieOut>
// intercompany/closeChecks.ts
export const intercompanyCloseChecks: CloseCheck[]
```
""",
tests=r"""
`controlledAccounts` (manual JE on a Due-from → 422 INTERCOMPANY_ACCOUNT_CONTROLLED; an 'ic.transfer' posting passes; deactivation refusal is
w4-integration's — leave a TODO test name in the report). `intercompany` (companies A, B and unrelated C: pair accounts created once in both
charts, operator code 1450 skipped; finance in A+B submits a settlement, CEO approves, both books post under 'ic.transfer:<id>', A.dueTo(B) ==
B.dueFrom(A); finance only in A → 403; active company neither party → 422; C → 404 on get/approve/reverse and its list excludes A-B; over balance
→ 422; netting; B's period locked → 422 naming B and nothing in A; reverse in both; approve twice → 409; postSystemTransferTx idempotent on
sourceRef). `intercompanyFleet` (trips per pair per month; per-brand conceptId on the client lines; provider credits 6990 not 6035; charge twice →
one transfer; closed month → first common open day + note; refused posting flags 'ic.fleet_charge'; rate change after a charged month → 409;
B-only staff cannot set A-B rates; the close check blocks the uncharged month for both). `intercompanyLegacy` (tie-out per company; write-off of
the split-date difference only, later drift stays a warning; dry run then post; second → 409; B → 404; ADMIN only).
""",
))

W1.append(dict(
id="w1-recon", wave="W1", area="tax (card payouts) + onaccount (Raast void)", idx=5,
title="Card payouts at payout (H12) on top of BOOKS-11, Raast 'void, never booked' (CEO), till-clearing contra",
summary="reconciliation/cardPayouts + routes + service.ts (BOOKS-11 helper), raast.ts/raastRoutes.ts void, connectors/raast/accounts.ts, RaastTab.tsx.",
owns=["backend/src/modules/reconciliation/cardPayouts.ts (new)", "backend/src/modules/reconciliation/cardPayoutRoutes.ts (w0 stub → fill)",
      "backend/src/modules/reconciliation/service.ts", "backend/src/modules/reconciliation/raast.ts", "backend/src/modules/reconciliation/raastRoutes.ts",
      "backend/src/modules/reconciliation/README.md", "backend/src/connectors/raast/accounts.ts",
      "frontend/admin/src/app/reconciliation/RaastTab.tsx",
      "backend/tests/cardPayouts.test.ts (new)", "backend/tests/raastVoid.test.ts (new)", "backend/tests/raastRecon.test.ts (W1)", "backend/tests/raastBankConfig.test.ts"],
read=["plan_tax.json: summary 4, schema (CardSettlement), postings card.settlement, routes card-payouts, build_split T4",
      "plan_onaccount.json: summary (Raast void), routes raast void, build_split C",
      "critic_tax_people_0.json violation 1 + missing 'card-payout day source', 'refused card.settlement'; critic_cash_delivery_onaccount_2.json violation 6 + Raast notes"],
tasks=r"""
**Card payouts (H12) — EXTEND BOOKS-11, never a second split posting** (flag this reuse in your report for the owner):
- Factor the split posting out of `adjustStatementLine` (~290-404: bank leg + Dr 6080 / Cr 1030, balance + active-account checks) into
  `postCardPayoutSplitTx(tx, { tenantId, lineId, grossCents, feeCents, netCents, bankCode, sourceType, sourceId, memo })`; the manual adjust,
  the auto-match and the confirm all call it. Once card payouts are enabled for a company, a manual adjust that credits 1030 on the payout bank
  must CLAIM CardSettlementDay rows (CardSettlement status 'manual_adjust') or answer 409 USE_CARD_PAYOUT_CONFIRM — 1030 is never cleared twice.
- Settings: `cardSettlementSettings(db, tenantId)` zod-parses OperationsConfig.cardSettlement { enabled false, payoutBankAccountId, unitMode
  'company'|'brand'|'terminal' = 'company', mdrBps 0, feeTaxBps 0, lagDays 2, toleranceBps 30, maxBatchDays 3, maxFeeBps 500, startDay }.
- **Day gross from card Payment rows** (method card, status paid, by PKT payment time — processedAt ?? createdAt; card refunds negative), grouped
  by unit (company, or brand:<conceptId>, or terminal:<terminalId> from TerminalCharge) — NOT from 1030 entry dates (shift close dates card lines at
  closedAt and without conceptId — critic). Exclude days before startDay or already in card_settlement_days.
- `findCardPayoutFits(tx, { tenantId, settings, lines })`: runs ending 1..lagDays+1 days before the line, length 1..maxBatchDays, per unit; fit when
  |net − gross×(1 − mdr×(1+feeTax))| ≤ max(100, gross×tol). EXACTLY one fit per line and no run claimed by two lines, else nothing (never a guess).
- `postCardSettlementTx` (advisory lock (tenantId,'card-settlement'), re-validate, period-lock + active-account pre-check → a locked/missing case
  leaves the line unmatched with a reason, never a 500; CardSettlement + days; 'card.settlement:<lineId>[@n]' Dr payout bank net / Dr 6080 fee /
  Cr 1030 gross via postCardPayoutSplitTx; line matched to the bank leg). A failed auto-post raises flagException 'card_payout_unmatched' and the
  unmatched line + the close check are the queue (no REPOSTER — documented and tested); add **POST /card-payouts/rematch** (admin, finance; active
  company) to retry fits for unmatched payout-bank credits.
- `undoCardSettlement` (APPROVERS; reverseJournalEntry, delete settlement → days freed, line unmatched). `unsettledCardDaysThrough(db, tenantId,
  lockedThrough)` and **`cardPayoutCloseChecks: CloseCheck[]`** ('card_unsettled' block, overridable, when enabled and card days ≤ lockedThrough −
  (lagDays + 3) are unsettled; link /reconciliation?tab=card-payouts) — the period-close route lists it through the checklist (no 409 of its own).
- importBankStatement: third pass after Raast when enabled and bankAccountId = payoutBankAccountId (collect fits into cardSkip, the generic pass skips
  them); post after commit, each in its own tx; result adds cardPayoutMatchedCount. unmatchStatementLine → 409 CARD_PAYOUT_LINE.
- cardPayoutRoutes.ts (registered by w0 at /reconciliation/card-payouts): GET/PUT /settings (PUT admin/finance, payout bank must be a live linked bank
  of the company → 422 BANK_ACCOUNT_NOT_IN_COMPANY; ranges per tax plan; startDay = today on first enable; audited), GET / (settlements + unsettled
  days), GET /lines/:lineId/suggestions, POST /lines/:lineId/confirm {days[]} (409 LINE_NOT_UNMATCHED / DAY_ALREADY_SETTLED; 422
  NO_CARD_MONEY_ON_DAYS / FEE_OUT_OF_RANGE / PERIOD_LOCKED / CARD_PAYOUTS_OFF), POST /:settlementId/undo, POST /rematch. Bank-lines GET adds
  cardSettlement {id, dayFrom, dayTo, feeCents} for the chip (route file: whichever file serves it — if it is reconciliation/routes.ts, patch note).
- Bank-line adjust to a fixed_asset-controlled code requires `registerOverride { reason }` (passes `controlledOverride` to postJournalEntry; audit;
  flag fixed_asset_gl_mismatch).
**Raast void (OA C):** WRITE_OFF_CONTRAS = ['1115','8010','1350'] (default '1115' in raastRoutes; existing entries untouched, reversals mirror);
saleBookedTx's held-line lookup uses code IN TILL_CLEARING_CODES; NON_BANK_MONEY_CODES += '1115'. New `raastVoidEligibilityTx`, `requestRaastVoid`,
`rejectRaastVoidRequest`, `voidNeverBooked` (lockRaastTx first; status provisional (409 RAAST_NOT_PROVISIONAL); !saleBookedTx (409 RAAST_SALE_BOOKED);
order cancelled|rejected (409 RAAST_ORDER_NOT_CANCELLED); every shift holding the order's payments or the receipt closed with no open
posting_failed flag (409 RAAST_CLOSE_PENDING); **no refund row on the order points at this receipt (gatewayMeta.raast.receiptId) — critic, 409
RAAST_REFUND_EXISTS**; conditional claim provisional→voided; bankRef kept; resolve the receipt's raast_* flags; audit 'raast.receipt.void' with the
RECEIPT's tenantId; NO posting). Routes: POST /receipts/:id/void-request (admin, owner, management, finance; module reconciliation), POST
/receipts/:id/void (ADMIN_ONLY), POST /receipts/:id/void-request/reject (ADMIN_ONLY {note}); receipts list status enum + 'voided', ?voidRequested=1,
receiptView adds orderStatus, voidRequest {at, by, reason} and **capability flags canVoid / canRequestVoid** for the caller. (Post-void exclusions in
refund-due / Z-report / hand-back are w3-till's.)
**RaastTab.tsx:** 'voided' chip (muted token); CEO 'Void — never booked' on eligible receipts (reason; confirm 'no ledger entry; the statement credit
is booked with the bank-line adjustment'); finance 'Ask the CEO to void' + pending badge; write-off contra labels 'Customer owes (1115 till
clearing) / Loss (8010) / Staff owes (1350)'; buttons driven by canVoid/canRequestVoid, never a local role list.
""",
consumes=r"""
- w0: CardSettlement/CardSettlementDay models, RaastReceipt void columns + 'voided' enum value, TILL_CLEARING_CODES, ACCT.TILL_CLEARING/CARD_FEES/
  CARD_RECEIVABLE, controlledOverride, CloseCheck types, stub cardPayoutRoutes registered at /reconciliation/card-payouts.
""",
exposes=r"""
```ts
// reconciliation/cardPayouts.ts
export function cardSettlementSettings(db: Db, tenantId: string): Promise<CardSettlementSettings>
export function unsettledCardDaysThrough(db: Db, tenantId: string, lockedThrough: Date): Promise<{ count: number; cents: number; days: string[] }>
export const cardPayoutCloseChecks: CloseCheck[]
// reconciliation/service.ts
export function postCardPayoutSplitTx(tx: Tx, a: { tenantId: string; lineId: string; grossCents: number; feeCents: number; netCents: number;
  bankCode: string; sourceType: string; sourceId: string; memo: string }): Promise<{ entryId: string; bankLineId: string }>
// reconciliation/raast.ts
export function voidNeverBooked(receiptId: string, a: { actorId: string; reason: string }): Promise<RaastReceipt>
```
""",
tests=r"""
`cardPayouts` (exact fit: balanced Dr bank / Dr 6080 / Cr 1030, line matched, days claimed; two fitting runs → nothing posted + suggestions list
both, confirm posts; 3-day weekend batch; re-import does not double-post; locked period → unmatched with reason, import 200; fee > maxFeeBps → 422;
undo frees days; unit 'brand' keys days per brand; a manual BOOKS-11 adjust on the payout bank claims the days (and the same day then never
auto-matches) or 409 USE_CARD_PAYOUT_CONFIRM; rematch; two companies: B's import never consumes A's days, B confirm/undo on A's line → 404,
settings PUT with B's bank in A → 422, GET list/suggestions B → 404). `raastVoid` (B → 404; finance requests, non-admin void → 403; each
eligibility refusal incl. a refund row; success posts nothing, status voided, raastOpenThrough no longer counts it; the same bankRef at the till
still → RAAST_REF_USED; audit tenant = A; capability flags). Update `raastRecon` (write-off contra 1115; legacy 1110 refund-due fixtures still count
as booked) and `raastBankConfig` (NON_BANK_MONEY_CODES includes 1115).
""",
))

W1.append(dict(
id="w1-bans", wave="W1", area="delivery (strikes, bans, appeals)", idx=6,
title="Strikes and bans per company, ban appeals via the help desk, complaint readers filtered",
summary="lib/strikes.ts, crm, complaints (+ appeals), storefront banAppealRoutes, WhatsApp APPEAL, per-company ban readers everywhere.",
owns=["backend/src/lib/strikes.ts", "backend/src/modules/crm/customerScope.ts", "backend/src/modules/crm/routes.ts", "backend/src/modules/complaints/routes.ts",
      "backend/src/modules/complaints/appeals.ts (new)", "backend/src/modules/storefront/banAppealRoutes.ts (new)", "backend/src/adapters/whatsapp/conversation.ts",
      "backend/src/lib/marketingAudience.ts", "backend/src/workers/loyaltyTriggers.ts", "backend/src/lib/customerRollups.ts",
      "backend/src/modules/management/routes.ts (complaint KPI filter only, W1)", "backend/src/modules/opsReports/routes.ts",
      "backend/tests/strikesPerCompany.test.ts (new)", "backend/tests/banAppeals.test.ts (new)", "backend/tests/sepCrm.test.ts"],
read=["plan_delivery.json: summary (strikes/bans/appeals), schema (CustomerStrike, OrderComplaint), routes (blocks, appeals, complaints, crm), build_split C, data_migration 1-3",
      "critic_cash_delivery_onaccount_0.json: violations 4, 5, 10; missing (OrderComplaint readers, release-contact, WhatsApp check at brand pick, conceptSlug resolution, cod_unpaid manual kind, lift keeps strikes)"],
tasks=r"""
**lib/strikes.ts:** `RecordStrikeArgs.tenantId?` resolved from the source order / reservation (concept.tenantId) when absent, REQUIRED when there is
no source. `maybePromoteToBan(customerId, tenantId)` under advisory lock 'ban:<tenant>:<customer>': count that company's active strikes (column;
legacy NULL rows by attribution); at weight ≥ 3 create CustomerBan {tenantId, customerId, email, phone, reason, bannedById: null} unless an active
ban OF THAT COMPANY exists (the old global check let company B's staff ban block A's auto-ban — fixed); sync Customer.strikeCount (sum) and
bannedAt (any active ban). A refused-at-door strike always weighs 1 ('3 strikes' literally); reservation no-shows count toward the same company;
manual CRM strikes keep severity 1-3. reverseStrike: per the strike's company, lifts only that company's auto-ban. activeBanAtCompany /
bannedCustomerIdsAtCompany / banCompanies read CustomerBan.tenantId first, fall back to attribution only when NULL. BANNED AppError details
{banId, companyName, appeal}. Extract `liftBanTx` / `releaseBanContactTx`. **Release-contact (owner Q7 default yes):** removes the phone (or email)
from the ban AND from the banned Customer account (the old account keeps its other sign-in), so the next phone sign-in creates a fresh account.
**Lift on appeal keeps the company's strikes** (owner Q6 default) — say so in the UI copy. A legacy NULL-company ban can be lifted by admin only.
**crm:** /strikes and /bans write tenantId = the ACTIVE company (create); remove 'cod_unpaid' from the manual strike kinds (still readable);
/bans/:id/lift resolves linked open appeals (status resolved, resolution) and notifies the customer (sendPhoneMessage/sendEmail); new POST
/bans/:id/release-contact {contact:'phone'|'email', reason} (MANAGERS; only this company's ban → 404). The gate pattern rule (w0) opens both to
'complaints' holders. customerScope.ts strikeCompanies/banCompanies use the column.
**complaints/routes.ts:** scopeTenantWhere on GET /, GET /stats (critic — today fail-open on tenantFilter) and PATCH; ?kind=complaint|ban_appeal;
appeal rows carry ban {id, reason, bannedAt, auto} + this company's strikes — to MANAGERS only; PATCH refuses status 'resolved' on an appeal (409
APPEAL_DECIDED_BY_LIFT — only lift/release resolve it); 'closed' = block kept (customer notified). The '/complaints' module gate is w0's.
**complaints/appeals.ts** `createBanAppeal({ banId, customerId?, contactPhone?, conceptId?, reason, message, via })`: conceptId resolved ON THE
SERVER to a brand of the ban's company (the blocked brand if given and of that company, else the latest order/reservation brand there, else the
company's first active brand; a client conceptSlug of another company is ignored); category 'other', title 'Ban appeal'; one open appeal per ban
(partial unique → 409 APPEAL_OPEN); 30-day cool-down after a decline (429 APPEAL_TOO_SOON). An unattributable NULL ban appeals at the company of
the brand the customer was refused at.
**storefront/banAppealRoutes.ts** (wave Z registers at /storefront): GET /account/blocks (requireCustomerAuth; matches id, email, phone) → {blocks:
[{banId, companyName, brands[] (formatBrandName), since, appeal {status 'none'|'open'|'declined', at}}]}; POST /account/ban-appeals {banId,
reason 'new_number'|'mistake'|'other', message 10..1000, conceptSlug?} (contact from the session; rate limit 3/hour/customer; ban must match → 404).
**WhatsApp (conversation.ts):** check the ban when the brand is PICKED (not only at the final order); BANNED reply 'Reply APPEAL to ask our help
desk to review this'; 'appeal' handled in the TOP-LEVEL keyword router with the session's brand → createBanAppeal (contactPhone = sender; one open
per ban).
**Company-separation fixes in readers (critic, same change):** lib/marketingAudience.ts drops the global `bannedAt: null` and uses
bannedCustomerIdsAtCompany; workers/loyaltyTriggers.ts referral check uses activeBanAtCompany for the referral's company, and the complaint
follow-up filters kind='complaint' (never text a blocked customer 'did we make it right?'); lib/customerRollups.ts complaint count kind='complaint';
management/routes.ts open-complaint KPIs (~190, 237, 245) kind='complaint' (W1 — w3-fc-report edits this file later for foodCostPct);
opsReports/routes.ts complaint-cluster flag (~232) kind='complaint'; crm/routes.ts profile list (~449) kind='complaint'.
""",
consumes=r"""
- w0: CustomerStrike.tenantId, OrderComplaint kind/banId/contactPhone + relation, partial uniques, migration backfill + split of legacy
  multi-company auto-bans, GATED '/complaints' + '/crm/bans/:id/(lift|release-contact)' rules.
""",
exposes=r"""
```ts
// lib/strikes.ts
export function recordStrike(a: RecordStrikeArgs & { tenantId?: string }): Promise<{ recorded: boolean; duplicate: boolean; banId?: string }>
export function activeBanAtCompany(db: Db, a: { customerId?: string; email?: string; phone?: string; tenantId: string }): Promise<CustomerBan | null>
export function bannedCustomerIdsAtCompany(db: Db, tenantId: string): Promise<string[]>
export function liftBanTx(tx: Tx, a: { banId: string; actorId: string; reason: string }): Promise<void>
export function releaseBanContactTx(tx: Tx, a: { banId: string; contact: 'phone'|'email'; actorId: string; reason: string }): Promise<void>
// complaints/appeals.ts
export function createBanAppeal(a: { banId: string; customerId?: string; contactPhone?: string; conceptId?: string; reason: string; message: string; via: 'storefront'|'mobile'|'whatsapp' }): Promise<{ appealId: string }>
```
""",
tests=r"""
`strikesPerCompany` (2 strikes at A + 1 at B → no ban; third at A → ban tenantId A; A checkout BANNED with details, B allowed; reversing one A
strike lifts A's auto-ban only; racing promotions → one ban; a staff ban at B does not stop A's auto-ban; B's manual strike/ban on a customer of A
only → 404; marketing audience and referral check per company). `banAppeals` (blocks lists matching bans only; appeal lands on an A brand; B's
complaints list doesn't show it and B's PATCH → 404; fnb_manager (complaints, no crm) lifts through the widened gate and the appeal resolves;
second open → 409; decline then re-appeal < 30 days → 429; release-contact clears the phone on the ban AND the account; PATCH 'resolved' on an
appeal → 409; WhatsApp APPEAL creates one appeal with contactPhone = sender; GET /complaints/stats scoped; complaint follow-up never targets an
appeal). Update `sepCrm` to the column-based attribution.
""",
))

W1.append(dict(
id="w1-taxsales", wave="W1", area="tax (customer-facing) + onaccount (fiscal/receipt)", idx=7,
title="Delivery-fee GST on top, fiscal DELIVERY-CHARGE line, receipts/invoices, on-account fiscal buyer, gift-card breakage, kept deposits",
summary="lib/pricing.ts, storefront routes, pos/receipt.ts, invoices/service.ts, connectors/fiscal/payload.ts, giftCards/*, giftCardExpiry worker, depositCapture.",
owns=["backend/src/lib/pricing.ts", "backend/src/modules/storefront/routes.ts", "backend/src/modules/pos/receipt.ts", "backend/src/modules/invoices/service.ts",
      "backend/src/connectors/fiscal/payload.ts", "backend/src/connectors/types.ts", "backend/src/modules/giftCards/books.ts", "backend/src/modules/giftCards/routes.ts",
      "backend/src/modules/giftCards/README.md", "backend/src/workers/giftCardExpiry.ts", "backend/src/modules/reservations/depositCapture.ts",
      "backend/tests/deliveryFeeTax.test.ts (new)", "backend/tests/deliveryFeeReceiptInvoice.test.ts (new)", "backend/tests/fiscalDeliveryLine.test.ts (new)",
      "backend/tests/fiscalOnAccountPayload.test.ts (new)", "backend/tests/giftCardBreakage.test.ts (new)", "backend/tests/depositForfeitTax.test.ts (new)",
      "backend/tests/resimFiscal.test.ts"],
read=["plan_tax.json: summary 1-3, schema (Order, TaxInvoice, GiftCard), postings (deposit, giftcard.*), routes (storefront, receipt, gift cards), shared_file_changes pricing/payload/receipt/invoices, build_split T2+T3",
      "plan_onaccount.json: shared_file_changes payload.ts, invoices/service.ts, receipt.ts",
      "critic_tax_people_0.json: gift-card violations/missing (first expiry only, ISSUE_NOT_BOOKED, cursor, REPOSTER), TaxInvoice total, ADMIN_ONLY forfeit",
      "critic_cash_delivery_onaccount_2.json code_facts (paymentLabelOf, FBR/SRB modes)"],
tasks=r"""
**Delivery fee (owner + H9).** lib/pricing.ts priceOrder: OrderPrice + itemTaxCents + deliveryFeeTaxCents; taxCents = sum; discount clamp on
itemTotal + itemTax; deliveryFeeTaxCents = fee > 0 ? Math.round(fee × standardRate / 100) : 0 (the order's tender standard rate: 15% cash, 8%
card/Raast/online/wallet — never an item class, even for a zero-rated basket); net (service-charge base) unchanged; total = net + fee + feeTax +
service charge; service charge and tip % never include the fee or its GST. Header rule text. Comment: tenderOf('on_account') = 'cash' (cash class;
never add it to CARD_TENDERS without the CA). ingestOrder writes the two Order columns (w2-sale adds the 2 lines; you must keep `opts.price`
carrying them).
storefront/routes.ts: GET /storefront/quote adds itemTaxCents + deliveryFeeTaxCents (pricedTotal incl. fee GST; tip % base = itemTotal + itemTax);
POST /storefront/orders response + GET /storefront/orders/:id return deliveryFeeCents/deliveryFeeTaxCents; **tracker (~1302): deliveryOtp null and
handoverRerouted: true once Order.handoverReroutedAt is set (delivery area)**; GET /storefront/account drops the global isBlacklisted flag (the
customer UI reads GET /storefront/account/blocks — w1-bans).
pos/receipt.ts: ReceiptData deliveryFeeCents/deliveryFeeTaxCents; HTML 'Delivery charge' row; GST row '(incl. PKR x on delivery)'; rows add up to
the total. **On-account (OA):** `paymentLabelOf(p: { method, gatewayRef, gatewayMeta })` (both callers are in this file) → 'On account — <name>
(<OA-0003>)[ · <reference>]'; 'Client signature ________' line when any paid on_account row exists.
invoices/service.ts: TaxInvoice deliveryFeeCents; taxableValueCents = subtotal + fee; **totalCents = max(0, subtotal + fee + tax + svc + tip −
discount)** (critic — equals the bill and the fiscal payload's totals); a TaxInvoiceLine 'Delivery charge'; the credit note mirrors it. **OA:**
when input.buyer is absent and the order has a CustomerAccountCharge, buyer = the client {name: legalName, strn, ntn, address}.
connectors/fiscal/payload.ts buildFiscalSaleTx: the fee becomes a taxed line {lineId 'delivery:<orderId>', itemCode 'DELIVERY-CHARGE', description
'Delivery charge', qty 1, unit/gross fee, discount feeDiscount, taxable fee − feeDiscount, taxRatePct = the order's standard rate, taxCents feeTax};
discount covers food first, then the fee line, then billDiscount; food tax = order.taxCents − feeTax; saleValueCents/discountCents include them;
deliveryChargeCents = fee > 0 ? 0 : the legacy remainder rule; toFbrInvoiceFields ItemCode 'DELIVERY' (PCT 9963.1100 until the vendor/CA says
otherwise); header ONL-R2-02; buildRefundPayload/totalsCheck unchanged. **OA:** buyer = the on-account client (legalName, ntn, strn, cnic,
address) via `tx.customerAccountCharge.findFirst({ where: { orderId } })`; CASH set += 'on_account' (paymentModeOf → cash; today it is 'mixed');
toSrbInvoiceFields modeOfPay 'Cash' when every tender ∈ {cash, on_account}; toFbrInvoiceFields PaymentMode 2 when methods include cash or
on_account (vendor to confirm); defaultRefundMethod all on_account → 'on_account'. connectors/types.ts: comment on deliveryChargeCents ('legacy
untaxed fee; 0 when the fee is a line'). Nothing reaches the POS outside completeOrder.
**Gift cards (H11) — critic-corrected:**
- `expireOneGiftCard(cardId, now?, db?)` in one row-locked tx (lockGiftCardTx): status expired / expiredAt; if the card's 'giftcard.issue' entry
  was never posted (ISSUE_NOT_BOOKED, same check as voidGiftCard) → the card still expires but breakage is HELD: set breakagePendingAt /
  breakagePendingReason, flagException 'gift_card_breakage_held', balance untouched; else claim the balance (updateMany where balance = B), post
  'giftcard.expire:<cardId>' Dr 2080 / Cr 4200 (sold) or Cr 6060 (promotional), conceptId = card.conceptId, breakageCents += B, breakageAt,
  clear breakagePendingAt. A refused posting rolls the card back, sets breakagePendingAt, flagPostingFailed (sourceType 'giftcard.expire',
  entityType 'GiftCard', sourceId = cardId).
- **Breakage only at the card's FIRST expiry**: value a refund later puts back on an expired card is NEVER swept — it waits in the manager queue
  (the existing voidedHoldingValue pattern) and is settled through voidGiftCard (refund, or forfeit by the CEO).
- `expireDueGiftCards` processes each card once per run with an (expiresAt, id) cursor (no re-query starvation) and also retries cards with
  breakagePendingAt set.
- voidGiftCard: disposition 'forfeit' on a SOLD card allowed for **ADMIN_ONLY (the CEO)** — a manager/owner gets 403 FORFEIT_NEEDS_CEO (critic:
  owner pattern) — posts Dr 2080 / Cr 4200, breakageCents += B; promotional forfeit unchanged (6060); delete FORFEIT_PENDING_DECISION.
- giftCardBooksCheck adds breakage {count, cents} per company; GET /gift-cards/books-check returns it; README + worker header ('posts breakage').
**Kept no-show deposit (H10):** depositCapture.ts keeps sourceType 'reservation.deposit_capture', its claim and REPOSTER; lines Dr 1030 D / Cr
revenueCodeForConcept(slug) D − T / Cr outputTaxCodeFor(concept) T, T = round(D × taxRateCard / (100 + taxRateCard)), all conceptId; no fiscal
document; remove TODO(G9). (Use the output-account rule already in orderPosting.ts this wave; w2-ledger re-points it to taxAuthorities.ts.)
Note: `ordersReconcile.test.ts` belongs to w1-dlv-core this wave — put the "card total includes the fee GST" assertion in deliveryFeeTax.test.ts.
""",
consumes=r"""
- w0: Order.deliveryFeeCents/deliveryFeeTaxCents, TaxInvoice.deliveryFeeCents, GiftCard breakage columns, CustomerAccountCharge model, ACCT
  DELIVERY_FEE_REVENUE / GIFT_CARD_BREAKAGE, lib/tenders ON_ACCOUNT_TENDER, Order.handoverReroutedAt.
""",
exposes=r"""
```ts
// lib/pricing.ts
export interface OrderPrice { /* existing fields */ itemTaxCents: number; deliveryFeeCents: number; deliveryFeeTaxCents: number; taxCents: number }
// giftCards/books.ts
export function expireOneGiftCard(cardId: string, now?: Date, db?: Db): Promise<{ expired: boolean; breakageCents: number; held: boolean }>
// pos/receipt.ts
export function paymentLabelOf(p: { method: string; gatewayRef: string | null; gatewayMeta?: unknown }): { label: string; reference: string | null }
```
""",
tests=r"""
`deliveryFeeTax` (COD cash 15%: fee 15,000 → 2,250; online card 8%: 1,200; service-charge base excludes the fee; tip % base excludes fee GST;
free zone 0/0; checkout stores the columns and total = quote; rider cashToCollect includes fee + GST; WhatsApp priceCart and group orders fee 0;
two companies: B's delivery order stores B's figures). `deliveryFeeReceiptInvoice` (receipt rows add up; TaxInvoice includes the fee line;
a discount larger than the food → invoice total == bill; credit note mirrors). `fiscalDeliveryLine` (DELIVERY-CHARGE line, deliveryChargeCents 0,
totalsCheck ok when loyalty covers more than the food, legacy order keeps the remainder rule, refund payload sums). `fiscalOnAccountPayload`
(buyer = client, mode cash for FBR/SRB, refund method on_account). `giftCardBreakage` (two companies: A's sweep posts 4200 for sold, 6060 for
promotional, B untouched; second run one entry; refund value on an expired card is NOT swept (manager queue); ISSUE_NOT_BOOKED holds + flags;
missing 4200 → card stays, breakagePendingAt + posting_failed, retried next run after the chart is fixed; cursor processes each card once; sold
forfeit by owner/manager → 403, by admin → Dr 2080/Cr 4200; B voiding A's card → 404; books check difference 0). `depositForfeitTax` (8% on 5,000 →
tax 370, revenue 4,630, SRB brand → 2032, tagged; second sweep no-op; release after capture → 409; B can't mark A's no-show (404)).
Update `resimFiscal` (new delivery order → DELIVERY-CHARGE line + deliveryChargeCents 0; legacy rows keep the remainder).
""",
))

W1.append(dict(
id="w1-dlv-core", wave="W1", area="delivery (code only, reroute, rider app)", idx=8,
title="Delivery completes only with the customer's code; reroute-to-rider service; door problems; rider app server side",
summary="dispatch/service+routes (no staff Delivered), rider/service+routes, deliveryOtp, riderScoring; exposes rerouteHandoverCode for the Emergency overrides module.",
owns=["backend/src/modules/dispatch/service.ts", "backend/src/modules/dispatch/routes.ts", "backend/src/modules/rider/service.ts", "backend/src/modules/rider/routes.ts",
      "backend/src/lib/deliveryOtp.ts", "backend/src/workers/riderScoring.ts",
      "backend/tests/emergencyReroute.test.ts (new)", "backend/tests/dispatch.test.ts", "backend/tests/riderApp.test.ts", "backend/tests/ordersReconcile.test.ts",
      "backend/tests/accessControl.test.ts (verify-otp / Delivered parts)"],
read=["plan_delivery.json: summary (code only, reroute, rider), routes (rider, dispatch), build_split A (minus emergencyOverrides module and trustops routes)",
      "critic_cash_delivery_onaccount_0.json: violation 7 (takeRiderOff callers), missing (texts that still say a manager marks it delivered), code_facts"],
tasks=r"""
- **markDelivered is code-only:** delete staffClose and its helpers (assertStaffMayClose, staffMayCloseWhere, managerRequired,
  riderClosesWithCode); every caller passes a verified code; stamp deliveryOtpVerifiedAt every time; the job-event note says when the code was
  rerouted. Remove POST /dispatch/orders/:id/delivered. Board select adds handoverReroutedAt.
- lib/deliveryOtp.ts: DELIVERY_OTP_READERS = [] (no staff role reads the customer's code — managers reading it would be a disguised Delivered
  override; owner question listed). (GET /trustops/orders/:id/otp is removed by w2-cash-ledger, which owns trustops/routes.ts.)
- **rerouteHandoverCode(orderId, { actor, reason })** (exported; the route lives in the Emergency overrides module, w3-dlv-return): validate (a
  delivery; not delivered; status ready; a rider; app job picked up (pickedUpAt) or the rider is not on the app; not already rerouted) then ONE tx:
  conditional claim (handoverReroutedAt IS NULL, deliveredAt IS NULL, riderId unchanged); new generateDeliveryOtp(); snapshot attempts into
  handoverRerouteAttempts, reset deliveryOtpAttempts to 0; handoverRerouteRiderId; jobEventTx 'code_rerouted' with actorId. After commit: WhatsApp
  sendText to the normalised rider phone (catch → sentToRider false); audit 'delivery.code_rerouted' in the ORDER's company; flagException
  'delivery_code_rerouted' (high). Errors 422 NOT_A_DELIVERY, 409 ALREADY_DELIVERED / NOT_READY / NOT_PICKED_UP / ALREADY_REROUTED / ORDER_CHANGED,
  422 NO_RIDER / RIDER_HAS_NO_PHONE. `resendReroutedCode(orderId, actor)` (same code, same rider; 409 NOT_REROUTED / ALREADY_DELIVERED).
- **Pinning after a reroute:** an explicit dispatcher assign/unassign to another rider → 409 CODE_WITH_RIDER; but `takeRiderOff` called by system
  loops (offer-timeout worker riderDispatch.ts:~136, fleet agreement end riders/routes.ts:~174, rider going off shift rider/service.ts:~184) with
  onlyIfNotAccepted / onlyIfRiderId returns `changed: false` (a no-op), never throws (critic).
- jobEventTx / recordJobEvent accept actorId.
- Rider side: toJob adds handover {rerouted, reroutedAt, code (only when rerouted to THIS rider), whatsappSent} and doorProblem {kind, at};
  new reportDoorProblem + POST /rider/jobs/:orderId/door-problem {kind 'no_code'|'refused'|'unreachable', note?, lat?, lng?} (own open job only else
  404; 409 NOT_PICKED_UP; deduped per order+kind for 5 min; 10/min per rider) → 'door_problem' event + flagException 'delivery_door_problem' in the
  order's company; setShift(offline) returns cashHeldCents (pending COD on this rider's delivered orders not paid in — a warning, never a block);
  sendHandoverCode copy 'once you have your order and have paid'; deliverJob lock message points to Emergency overrides. Rewrite stale texts:
  rider/service.ts ~323 (NO_OTP 'Call the dispatcher to mark it delivered'), ~351 (lost_package description). 423 lock message: 'ask a manager to
  send the code to the rider (Emergency overrides)'.
- workers/riderScoring.ts: exclude returnCause='refused' cancels from a rider's lost rate; treat handoverRerouteAttempts ≥ 3 or a reroute as an
  OTP signal (metadata).
""",
consumes=r"""
- w0: Order reroute/return columns, RiderJobEventType code_rerouted/door_problem/returned, RiderJobEvent.actorId, exception kinds.
""",
exposes=r"""
```ts
// dispatch/service.ts
export function rerouteHandoverCode(orderId: string, a: { actor: { id: string; tenantId: string | null }; reason: string })
  : Promise<{ ok: true; sentToRider: boolean; riderPhoneHint: string }>
export function resendReroutedCode(orderId: string, actor: { id: string }): Promise<{ ok: true; sentToRider: boolean }>
export function jobEventTx(tx: Tx, a: { orderId: string; riderId: string; tenantId: string; riderTenantId: string; type: RiderJobEventType; note?: string; actorId?: string | null }): Promise<void>
export function recordJobEvent(a: /* same as jobEventTx */ JobEventInput): Promise<void>   // serviceClient, after commit (fleet riders)
```
""",
tests=r"""
`emergencyReroute` (service-level, two companies: once per order (second → 409); the code rotates (old code 403s in the rider app); attempts reset
with the snapshot kept; the event carries actorId; exception lands in A; WhatsApp mocked to the rider's phone; assign to another rider → 409;
system takeRiderOff loops are no-ops; only the assigned rider's app shows the code; a fleet rider of B carrying A's order can be rerouted by A's
manager). Update `dispatch` / `riderApp` (POST /dispatch/orders/:id/delivered → 404; the rider deliver flow unchanged; door-problem scoped to the
own job; admin no longer reads deliveryOtp (~765)), `ordersReconcile` (markDelivered with a verified code), `accessControl` (verify-otp / Delivered
cases).
""",
))
