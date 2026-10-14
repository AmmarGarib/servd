# Wave B — build waves (the orchestrator's master plan)

Scratch: `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB`. Inputs: schema-merged.prisma.md, chart-merged.md, shared-files.md, briefs/<agent-id>.md (one self-contained brief per builder — launch each agent with only its brief path). All builder agents run on Opus (`model: "opus"`, CLAUDE.md). Every file has ONE owner per wave (shared-files.md). Backend agents test on their own Postgres DB `servd_test_wb_<id>` (127.0.0.1:5432, user postgres) and their own Redis index on `redis://127.0.0.1:6390/<idx>`; UI and docs agents run no tests (tsc only). No agent runs builds, dev servers, the whole suite, production calls or commits.

**Packaging (FINAL owner rule, 2026-10-13):** every plate recipe has an optional Packaging section; a sale uses it for takeaway / delivery, on every order of a packaging-vessel brand (Concept.serviceVessel, required at brand create; Stackd), and on a dine-in line only when staff tap 'Box given' (OrderItem.boxGiven); target MC per order type follows the same rule; the Q factor stays the only pricing allowance; one seam `packagingApplies(order, line)`.

## Summary

| Wave | Agents (parallel) | Backend DB / Redis |
|---|---|---|
| W0 | orchestrator — schema, chart, shared libs, stubs, test base, admin shared files | — |
| W1 | w1-stock, w1-taxcore, w1-fa-engine, w1-hr, w1-ic, w1-recon, w1-bans, w1-taxsales, w1-dlv-core | w1-stock→0, w1-taxcore→1, w1-fa-engine→2, w1-hr→3, w1-ic→4, w1-recon→5, w1-bans→6, w1-taxsales→7, w1-dlv-core→8 |
| W2 | w2-sale, w2-ap, w2-ledger, w2-fa-capex, w2-taxbooks, w2-oa-recv, w2-dlv-cod, w2-cash-ledger, w2-close | w2-sale→9, w2-ap→10, w2-ledger→11, w2-fa-capex→12, w2-taxbooks→13, w2-oa-recv→14, w2-dlv-cod→15, w2-cash-ledger→16, w2-close→17 |
| W3 | w3-till, w3-stockdocs, w3-recipes, w3-fc-report, w3-dlv-return, w3-cash-requests, w3-fa-api, w3-admin-finance | w3-till→18, w3-stockdocs→19, w3-recipes→20, w3-fc-report→21, w3-dlv-return→22, w3-cash-requests→23, w3-fa-api→24 |
| W4 | w4-integration, w4-admin-fa, w4-admin-stock, w4-admin-delivery, w4-apps, w4-customer, w4-admin-oa, w4-docs | w4-integration→26 |
| WZ | orchestrator — index.ts, workers, boot, /health, CLOSE_CHECKS, CLAUDE.md, full suite, builds, screenshots, ship | — |


## Wave 0 — the orchestrator alone (serial; nothing fans out until all of this is green)

0. **Owner inputs.** Confirm owner Q1 (EOBI/SESSI/salary-tax challans: default = HR's eobi_challan form retired, finance records them in the tax-payments
   register). Everything else builds on the stated defaults (section "Owner / accountant questions" below) — none blocks the start.
1. **Test infrastructure.** Postgres at 127.0.0.1:5432 (user postgres). Create one database per backend agent (names in the wave tables:
   `servd_test_wb_<id with underscores>`; every name contains 'test' as tests/setup.ts requires). Start ONE Redis for the whole build:
   `redis-server --port 6390 --databases 32 --save '' --appendonly no --daemonize yes` (32 databases — the default 16 is not enough). Each backend
   agent owns one index (0-26). Never point an agent at another agent's DB or index, never at production.
2. **Schema** — exactly `schema-merged.prisma.md`: edit `backend/prisma/schema.prisma`; write `prisma/migrations/20261014085900_finance_wave_b_enums/
   migration.sql` (enum ADD VALUE only — never used inside either migration) and `20261014090000_finance_wave_b/migration.sql` (header with the P3009
   runbook, DDL, backfills §4 in order, partial uniques §5, CHECKs §6, RLS §7); `prisma validate`; `prisma generate`. **Migration dry run:** on a
   scratch DB built with `prisma db push` from the PREVIOUS schema (git stash) plus a few rows per touched table, apply the two migration files with
   `psql -v ON_ERROR_STOP=1 -f …` in order, then `prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma --exit-code`
   must show no drift beyond the SQL-only objects; run each backfill twice (idempotent).
3. **Chart + journal** — exactly `chart-merged.md` (chartOfAccounts.ts: codes, renames, reserved-range header, REQUIRED, `controlledBy`,
   `assertTemplateAccounts`, `REGISTER_CONTROLLED_CODES`; journal.ts: ACCT names, TILL_CLEARING_CODES, ON_ACCOUNT_MEMO, CONTROLLED_PREFIX, the
   controlled-account rule with `controlledOverride`, `lateDatingFor`).
4. **Shared libs** — `shared-files.md` §A, every item marked w0: sourcePosting.ts (`keepLiveDate`, tx-aware `liveRevision(s)`), bankAccounts.ts
   (`ledgerBalancesByCode` asOf), exceptions.ts (every new ExceptionKind), lib/inventoryClass.ts, lib/savepoint.ts (+ the import swap in
   orders/service.ts), lib/evidenceFile.ts (+ the import swap in cashVouchers.ts), lib/onAccountCard.ts, accounting/closeCheckTypes.ts,
   accounting/fiscalYear.ts (pure part), lib/tenders.ts, approvals/types.ts, lib/moduleAccess.ts (module ids food_cost + emergency_overrides,
   defaults, MODULE_GRANTS, GATED_PREFIXES insertions in the stated order), lib/workspaces.ts, reconciliation/routes.ts (+ the three stub child
   plugin files), reconciliation/backfillOrders.ts (exports only), packages/types order fields.
5. **Tests base** — tests/setup.ts seeds every template code (ensureChartOfAccounts for the test companies helper) and applies §5-§6 SQL from the
   migration file after `db push`; tests/moneyBigint.test.ts EXPECTED_BIGINT_FIELDS += schema §3.38 (50 → 92) with the count from the DMMF.
6. **Admin shared** — lib/appRoles.ts, lib/moduleCatalog.ts (all area entries + MODULE_GAPS rewrites; no ModulePage.roles), next.config.js redirect
   /accounting/food-cost → /reports/food-cost, app/exceptions/page.tsx labels.
7. **Verify** — `npx tsc --noEmit -p .` in backend and frontend/admin clean; run tests/moneyBigint, the module-access / workspace suites
   (grep tests/ for MODULE_GRANTS, GATED_PREFIXES, workspaces) and one posting suite on a w0 database; commit on main ("wave B w0").
8. **Launch W1** — all W1 agents in ONE message, `model: "opus"`, each told only: "Your brief is `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/briefs/<id>.md` — read it in full and follow it."


---

# W1 — 9 agents in parallel

| id | area | DB | Redis |
|---|---|---|---|
| w1-stock | foodcost | `servd_test_wb_w1_stock` | 6390/0 |
| w1-taxcore | tax + people | `servd_test_wb_w1_taxcore` | 6390/1 |
| w1-fa-engine | assets | `servd_test_wb_w1_fa_engine` | 6390/2 |
| w1-hr | people (+ cash HR seams) | `servd_test_wb_w1_hr` | 6390/3 |
| w1-ic | people (inter-company) | `servd_test_wb_w1_ic` | 6390/4 |
| w1-recon | tax (card payouts) + onaccount (Raast void) | `servd_test_wb_w1_recon` | 6390/5 |
| w1-bans | delivery (strikes, bans, appeals) | `servd_test_wb_w1_bans` | 6390/6 |
| w1-taxsales | tax (customer-facing) + onaccount (fiscal/receipt) | `servd_test_wb_w1_taxsales` | 6390/7 |
| w1-dlv-core | delivery (code only, reroute, rider app) | `servd_test_wb_w1_dlv_core` | 6390/8 |


## w1-stock — FIFO lot ledger, brand shares, COGS by class, inventory postings

Area: foodcost · Test DB **`servd_test_wb_w1_stock`** · Redis **`redis://127.0.0.1:6390/0`** (index 0) — yours alone · brief: `briefs/w1-stock.md`

lib/stockLedger.ts (THE stock writer), brandShare, accounting/cogs.ts, accounting/inventoryPosting.ts (all FC postings that are not bills/sales).

**Owned files**

- `backend/src/lib/stockLedger.ts (new)`
- `backend/src/lib/brandShare.ts (new)`
- `backend/src/modules/accounting/cogs.ts (new)`
- `backend/src/modules/accounting/inventoryPosting.ts (new)`
- `backend/tests/stockLedger.test.ts (new)`
- `backend/tests/inventoryPostings.test.ts (new)`
- `backend/tests/cogsByClass.test.ts (new)`
- `backend/tests/brandShare.test.ts (new)`

**Tasks (outline — full text in the brief)**

  - **lib/stockLedger.ts — the ONLY code that changes stock.** Every change writes append-only `StockMovement` rows in the caller's transaction;
  - Lock item rows in id order (`lockItemsTx`); open lots scanned in (receivedAt, id) order (index `stock_lots_open_fifo`).
  - Exact value closure: a draw that empties a lot takes its whole `remainingValueCents`; |qty| < 1e-9 counts as zero; values never drift.
  - Company: `lot.tenantId === item.tenantId === caller tenantId`, else AppError CROSS_COMPANY_STOCK (500). An item with `tenantId` NULL is refused
  - `clamp=true` (sales only) takes what the lots hold and records `shortfallQty` + `shortfallValueCents` (memo at `latestPurchaseCostCents`);
  - `refreshItemCostTx` sets `unitCostCents` = FIFO head (oldest open lot) else latest lot else the typed estimate. It does NOT write
  - **Late-receipt shortfall settle (critic (c), default ON, owner may switch off later):** when a RECEIPT lot is added, settle the open sale
  - **Issue on receipt (critic (d)):** when the item has `issueOnReceipt`, a new receipt lot is consumed in full at once (`issue_on_receipt`
  - `ensureFifoReady(tenantId)`: if Setting `foodcost.fifoCutoverAt:<tenantId>` is missing, run
  - **lib/brandShare.ts:** `brandUsageShares(db, tenantId, itemId, at, days = 30)` from Σ `theoreticalQty` of `sale` movements by conceptId in the
  - **accounting/cogs.ts:** `cogsLinesForOrders` = one Dr 50x0 / Cr 12x0 pair per class from −Σ valueCents of the orders' `sale`, `sale_return`,
  - **accounting/inventoryPosting.ts** — every function: tenant from the SOURCE row, balance asserted, idempotent key, class accounts from
  - 1. `postGoodsReceiptTx(tx, receiptId)` — 'procurement.receipt:<receiptId>': Dr 1210/1220/1230 per class Σ lot value / Cr 2015 (quantity priced
  - 2. `postWasteLog(id, opts & { tx? })` — MOVED here from supplierPosting.ts (w2-ap deletes the old body and re-exports this): 'inventory.waste:<id>'
  - 3. `postStockCount(id, opts & { tx? })` — MOVED here from crosschecks/countPosting.ts (w3-stockdocs turns that file into a re-export):
  - 4. `postPrepDraw(batchId, opts & { tx? })` — NEW 'inventory.prep_draw:<id>': Dr 50x0 / Cr 12x0 at the FIFO value drawn (`drawValueCents`), usage split.
  - 5. `postGrniWriteOffTx(tx, receiptLineId, actor)` — 'procurement.grni_writeoff:<receiptLineId>': Dr 2015 / Cr 5060 for the open unbilled
  - 6. `postItemReclassTx(tx, { itemId, auditLogId, fromClass, toClass, valueCents })` — 'inventory.item_reclass:<itemId>:<auditLogId>'.
  - 7. `postClassReclassTx(tx, tenantId, byClass)` — 'inventory.class_reclass:<tenantId>' Dr 1220/1230 / Cr 1210 (cut-over, once).
  - 8. `postGrniOpeningTx(tx, tenantId, { received: byClass, billedAhead: byClass })` — 'procurement.grni_opening:<tenantId>' (cut-over, once).
  - 9. `postFifoAlign(tenantId, { dryRun, actor })` — 'inventory.fifo_align:<tenantId>', once, CEO, dry run first: Dr/Cr 12x0 against **3020**
  - 10. `postShortfallSettleTx(tx, { lotId, rows })` — 'inventory.shortfall_settle:<lotId>': Dr 50x0 per brand / Cr 12x0.
  - 11. `postIssueOnReceiptTx(tx, { lotId })` — 'inventory.issue_on_receipt:<lotId>': Dr 50x0 (usage split) / Cr 12x0.

**Consumes**

- w0: `lib/inventoryClass.ts` (costClassOf, CLASS_ACCOUNTS), `lib/savepoint.ts`, ACCT.GRNI / COST_ADJUSTMENT / RETAINED_EARNINGS / INVENTORY_* /
  *_COST / WASTE / INVENTORY_VARIANCE, `postJournalEntry`, `flagPostingFailed`, lib/money.ts.
- existing: `cogsForSoldLines` in lib/recipeCost.ts (legacy fallback only — w2-sale rewrites recipeCost; keep the call by name).


**Exposes**

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


**Tests — run on `servd_test_wb_w1_stock`, Redis index 0**

- `stockLedger.test.ts`: FIFO across 3 lots; last draw takes the exact remainder; returns go back to the same lots; clamp records shortfall +
  memo value; NEGATIVE_STOCK without clamp; CROSS_COMPANY_STOCK; ITEM_HAS_NO_COMPANY; relabelToWaste keeps stock unchanged; reprice splits
  on-hand/used; refreshItemCost moves the head and writes NO price history; a receipt lot settles a 3-day-old shortfall (not an 8-day-old one);
  issue-on-receipt consumes the lot at once; replays write nothing (unique key).
- `inventoryPostings.test.ts`: each posting balanced and idempotent; beverage/packaging items hit 1220/5020 and 1230/5030; a brand-less waste
  split across two brands sums exactly; settled-by-cash receipt posts nothing; opening count → 3020 never 5050; alignment → 3020, once;
  two companies: A's receipt/waste/count never posts in B's chart; a B tx cannot consume A's lot.
- `cogsByClass.test.ts`: one pair per class with conceptId; sale_void rows net out; pre-cut-over order without movements → legacy 5010/1210 'pre-FIFO order'.
- `brandShare.test.ts`: shares from theoretical usage; window; largest remainder.



## w1-taxcore — Tax authorities table, ONE withholding resolver, tax payments (customer-withheld set-off + statutory keys), statutory payments page

Area: tax + people · Test DB **`servd_test_wb_w1_taxcore`** · Redis **`redis://127.0.0.1:6390/1`** (index 1) — yours alone · brief: `briefs/w1-taxcore.md`

accounting/taxAuthorities.ts, lib/withholding.ts, withholding routes, taxPayments.ts (tax + people), accounting/statutory.ts + routes + admin page.

**Owned files**

- `backend/src/modules/accounting/taxAuthorities.ts (new)`
- `backend/src/lib/withholding.ts (new)`
- `backend/src/modules/accounting/withholdingRoutes.ts (new)`
- `backend/src/modules/accounting/taxPayments.ts`
- `backend/src/modules/accounting/statutory.ts (new)`
- `backend/src/modules/accounting/statutoryRoutes.ts (new)`
- `frontend/admin/src/app/accounting/statutory/page.tsx (new)`
- `backend/src/modules/setup/routes.ts (W1: PATCH /setup/operations-config zod only — w4-integration adds the chart guards in W4)`
- `backend/tests/taxWithholdingRates.test.ts (new)`
- `backend/tests/taxPaymentWithheldSetOff.test.ts (new)`
- `backend/tests/withholdingRegister.test.ts (new)`
- `backend/tests/statutoryPayments.test.ts (new)`
- `backend/tests/operationsConfigWaveB.test.ts (new)`
- `backend/tests/taxPayments.test.ts (W1: statutory keys + customer-withheld set-off expectations; w2-taxbooks owns it in W2)`

**Tasks (outline — full text in the brief)**

  - **accounting/taxAuthorities.ts — THE authority table.** `AuthorityKey = 'fbr'|'pra'|'srb'|'kpra'|'bra'`, `TAX_AUTHORITY_KEYS`, `AUTHORITIES`
  - **lib/withholding.ts — the ONE WHT resolver** (bills, OpEx, CapEx all call it; supplierPosting.withholdingForBill delegates to it in W2).
  - **accounting/withholdingRoutes.ts** (registered at /accounting/withholding in wave Z; under the existing '/accounting' gate):
  - **accounting/taxPayments.ts** (both areas):
  - PP (H7): `StatutoryKey = 'salary_tax'|'eobi'|'sessi'`, `STATUTORY` [{ key, label, name, account: ACCT.SALARY_TAX_PAYABLE|EOBI_PAYABLE|SOCIAL_SECURITY_PAYABLE }],
  - TX (H13): `customerWithheldSetOffCents` input (zMoneyCents, default 0); 422 NO_WITHHELD_SET_OFF for authority wht/stwh; the cap under advisory lock
  - **accounting/statutory.ts — ONE accrued-vs-paid computation** (the HR report links here; it never recomputes from payslips):
  - **statutoryRoutes.ts** (wave Z registers at /accounting/statutory): GET / (FINANCIALS_VIEWERS, active company), GET /reclass, POST /reclass
  - **setup/routes.ts — PATCH /setup/operations-config only (moved here from W4 so the W3 operations page and the W3 cash-request worker find
  - **Admin /accounting/statutory/page.tsx:** month range; table per scheme (accrued / paid / owed; cleared in green via tokens); Record payment dialog

**Consumes**

- w0: ACCT (SALARY_TAX_PAYABLE, EOBI_PAYABLE, SOCIAL_SECURITY_PAYABLE, ST_WITHHELD_BY_CUSTOMERS, PRA/SRB/KPRA/BRA_TAX_INPUT, PETTY_CASH),
  `assertTemplateAccounts`, `CloseCheck` types, `ledgerBalancesByCode`, accounting/csv.ts, BankAccountSelect (admin).


**Exposes**

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


**Tests — run on `servd_test_wb_w1_taxcore`, Redis index 1**

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



## w1-fa-engine — Fixed-asset engine: classes, schedule, automatic depreciation, events, pools, tax, close check

Area: assets · Test DB **`servd_test_wb_w1_fa_engine`** · Redis **`redis://127.0.0.1:6390/2`** (index 2) — yours alone · brief: `briefs/w1-fa-engine.md`

fixedAssets/classes, schedule, service (chargeThrough = THE depreciation path), events, pools, tax, closeCheck.

**Owned files**

- `backend/src/modules/fixedAssets/classes.ts (new)`
- `backend/src/modules/fixedAssets/schedule.ts (new)`
- `backend/src/modules/fixedAssets/service.ts`
- `backend/src/modules/fixedAssets/events.ts (new)`
- `backend/src/modules/fixedAssets/pools.ts (new)`
- `backend/src/modules/fixedAssets/tax.ts (new)`
- `backend/src/modules/fixedAssets/closeCheck.ts (new)`
- `backend/tests/fixedAssetsSchedule.test.ts (new)`
- `backend/tests/fixedAssetsRun.test.ts (new; w3-fa-api adds worker cases in W3)`
- `backend/tests/fixedAssetsEvents.test.ts (new)`
- `backend/tests/baseLayers.test.ts (FA parts only in W1)`

**Tasks (outline — full text in the brief)**

  - **No autoDepreciation switch** (owner: automatic). `getFixedAssetPolicy(tenantId)` reads capexUncapitalisedAlertDays, capexAdvanceOverdueDays,
  - **classes.ts** — ONE class list `ASSET_CLASS_DEFAULTS` (codes from ACCT): kitchen_equipment 1510/1591 60 mo tax 15% IA 25%; furniture_fixtures
  - **schedule.ts** pure (PKT months): periodOfPkt, lastDayPkt, planCharges(asset, chargedMap, adjustments, throughPeriod), forecast, nextMonthlyCharge,
  - **service.ts:** `chargeThrough(tenantId, throughPeriod, { postedBy, assetIds?, db? })` — per asset its own tx + advisory lock; syncSourcePosting
  - **events.ts:** createRequest(input, actor), needsApproval(kind), applyEvent(eventId, approverId), rejectEvent, cancelEvent. All kinds
  - **pools.ts:** findOrCreatePool(tx, { tenantId, locationId, conceptId, classKey, typeKey }) and FIFO allocation across layers (oldest inServiceAt).
  - **tax.ts:** taxSchedule(tenantId, taxYear) using `taxYearOf` from accounting/fiscalYear.ts (ONE year definition), freezeTaxYear (409
  - **closeCheck.ts:** `fixedAssetCloseChecks: CloseCheck[]` — 'depreciation' (block, overridable: active assets with an uncharged month ending ≤

**Consumes**

- w0: ACCT class codes, REGISTER_CONTROLLED_CODES, `lateDatingFor`, `syncSourcePosting(…, { keepLiveDate })`, `taxYearOf`, `CloseCheck`,
  moneyAccountCode, flagException/flagPostingFailed, getOperationsConfig.


**Exposes**

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


**Tests — run on `servd_test_wb_w1_fa_engine`, Redis index 2**

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



## w1-hr — Gratuity, statutory accrual accounts, HR close checks, HOD helper, cash-advance → HR loan

Area: people (+ cash HR seams) · Test DB **`servd_test_wb_w1_hr`** · Redis **`redis://127.0.0.1:6390/3`** (index 3) — yours alone · brief: `briefs/w1-hr.md`

hr/* (gratuity, 2042-2044, F&F fixes, eobi_challan per Q1, close checks, directManagerUserIdOf, createLoanFromCashAdvanceTx) + HR admin bits.

**Owned files**

- `backend/src/modules/hr/logic.ts`
- `backend/src/modules/hr/ledger.ts`
- `backend/src/modules/hr/forms.ts`
- `backend/src/modules/hr/routes.ts`
- `backend/src/modules/hr/reports.ts`
- `backend/src/modules/hr/letters.ts`
- `backend/src/modules/hr/service.ts`
- `backend/src/modules/hr/closeChecks.ts (new)`
- `backend/src/modules/hr/advanceLoan.ts (new)`
- `frontend/admin/src/components/hr/RecordDetail.tsx`
- `frontend/admin/src/app/hr/settings/page.tsx`
- `frontend/admin/src/app/hr/s/[section]/page.tsx`
- `backend/tests/hrGratuity.test.ts (new)`
- `backend/tests/hrStatutoryAccrual.test.ts (new)`
- `backend/tests/hrAdvanceLoan.test.ts (new)`
- `backend/tests/hrFinalSettlementLedger.test.ts`
- `backend/tests/hrModule.test.ts`
- `backend/tests/auditPeopleHr.test.ts`

**Tasks (outline — full text in the brief)**

  - **Gratuity (H6).** HrSettings.gratuity {enabled true, eligibleTypes ['permanent'], minServiceMonths 12, partYearOverMonths 6, daysPerYear 30} +
  - **Statutory accounts (H7).** postPayrollAccrual / postFinalSettlementAccrual credit 2043 = EOBI employee + employer, 2044 = SESSI employer,
  - **Fix the F&F sibling-reversal lookup** (hr/ledger.ts ~315): look up `${FNF_ACCRUAL}.reversal:<id>` (journal references are always
  - **eobi_challan (owner Q1 — the orchestrator confirms before launch; DEFAULT if not told otherwise = retire):** createRecord refuses new
  - **HR report 'statutory':** NOT a second computation — it returns a pointer to /accounting/statutory (or calls accounting/statutory.ts
  - **hr/closeChecks.ts** `hrCloseChecks: CloseCheck[]`: 'payroll' (block, overridable): months in ctx.months FROM the company's first HrPayrollRun
  - **Cash-area seams (CA):** hr/ledger.ts `loanPayingAccount`: data.paidFrom 'cash_request' → `{ method:'cash_request', code: ACCT.CASH_ADVANCES,
  - **Admin:** RecordDetail Calculate fills gratuity + service breakdown; HR settings gratuity block; eobi_challan section banner. Tokens only.

**Consumes**

- w0: ACCT.SALARY_TAX_PAYABLE/EOBI_PAYABLE/SOCIAL_SECURITY_PAYABLE/GRATUITY/CASH_ADVANCES/STAFF_LOANS, `assertTemplateAccounts`, CloseCheck types.


**Exposes**

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


**Tests — run on `servd_test_wb_w1_hr`, Redis index 3**

`hrGratuity` (11 months → 0; exactly 1y6m → 1 year; 1y6m1d → 2; 3y7m → 4; probation → 0 with reason; disabled → 0; lastGross from the latest
revision; calculate returns it; approval posts Dr 6036 / Cr 2020 incl. gratuity in A only; > INT4 → 422; saved-format company still gets the
field; B's HR → 404 on calculate/approve/paid for A's leaver). `hrStatutoryAccrual` (payroll lock → 2043/2044/2042 and nothing to 2090/2040; F&F
same; A's 2043 retyped → 422 ACCOUNT_CODE_TAKEN and the run stays approved; B unaffected; eobi_challan 409 SECTION_MOVED (default) and old rows
listed; hrCloseChecks blocks an unlocked run month after the baseline and never before it; B's unlocked run never blocks A). `hrAdvanceLoan`
(createLoanFromCashAdvanceTx posts Dr 1350 / Cr 1355, loansFor counts it, cancel → 409 LOAN_FROM_CASH_REQUEST; directManagerUserIdOf /
teamUserIdsUnder follow the reporting line, B's tree invisible). Update `hrFinalSettlementLedger` (2090/2040 → 2043/2044/2042; cancel of an OLD
2090-era accrual still reverses 2090/2040; replace-after-cancel now works), `hrModule`, `auditPeopleHr`.



## w1-ic — Inter-company accounts and transfers (H30), shared-fleet recharge, legacy tie-out, COD seam

Area: people (inter-company) · Test DB **`servd_test_wb_w1_ic`** · Redis **`redis://127.0.0.1:6390/4`** (index 4) — yours alone · brief: `briefs/w1-ic.md`

intercompany/* + worker + lib/companyPairs.ts; exposes postSystemTransferTx/reverseSystemTransfer for the COD area; admin /accounting/intercompany.

**Owned files**

- `backend/src/modules/intercompany/accounts.ts (new)`
- `backend/src/modules/intercompany/service.ts (new)`
- `backend/src/modules/intercompany/fleet.ts (new)`
- `backend/src/modules/intercompany/legacy.ts (new)`
- `backend/src/modules/intercompany/closeChecks.ts (new)`
- `backend/src/modules/intercompany/routes.ts (new)`
- `backend/src/modules/intercompany/README.md (new)`
- `backend/src/workers/intercompanyFleet.ts (new)`
- `backend/src/lib/companyPairs.ts (new)`
- `backend/src/modules/positions/contributions.ts`
- `backend/src/modules/positions/routes.ts`
- `frontend/admin/src/app/accounting/intercompany/page.tsx (new)`
- `frontend/admin/src/app/workforce/positions/view.tsx`
- `backend/tests/intercompany.test.ts (new)`
- `backend/tests/intercompanyFleet.test.ts (new)`
- `backend/tests/intercompanyLegacy.test.ts (new)`
- `backend/tests/controlledAccounts.test.ts (new)`

**Tasks (outline — full text in the brief)**

  - **lib/companyPairs.ts:** move `assertBothSidesOwned` out of positions/contributions.ts (29-45) — ONE membership check: the caller belongs to
  - **No gate widening** (the CEO holds 'accounting'; the approvals provider reads under the existing '/accounting' rule).
  - **Accounts:** `ensurePairAccounts(tx, a, b)` under pg_advisory_xact_lock(hashtext('ic.pair:'+min+':'+max)): 'Due from <other>' (asset, first
  - **Transfers:** createTransfer (assertBothSidesOwned; codes active + non-controlled in the right chart; banks via moneyAccountCode per side;
  - **Shared fleet (H30, owner Q2/Q3 defaults):** FleetRate per agreement (CEO, member of both; 409 RATE_PERIOD_CHARGED / RATE_EXISTS; audit both).
  - **COD seam for the delivery area (H5 + H30):** `postSystemTransferTx(serviceTx, { kind:'charge', source:'cod'|'fleet', sourceRef, debtorTenantId,
  - **Legacy residue (H30) — at the split migrations' dates, not today's difference (critic):** `controlTieOut(db, tenantId, asOf)` (2050 vs Σ
  - **closeChecks.ts** `intercompanyCloseChecks`: 'intercompany_pending' (block), 'fleet_recharge' (block; fix POST /accounting/intercompany/fleet/charge),
  - **routes.ts** (wave Z registers at /accounting/intercompany): every route in the people plan's routes list; zod; zMoneyCents/zInt4Cents; audits.
  - **Reposter shape for w4-integration (document in README + report):** flag only; load() → nothingOwed when the transfer with sourceRef
  - Comment fixes: positions/contributions.ts:29-33, positions/routes.ts:45, admin workforce/positions/view.tsx:37 (planning figure only; the ledger
  - Admin /accounting/intercompany (tabs Balances | Transfers | Shared fleet | Tie-out & legacy): mismatch in red, approve/reject for the CEO, rates,

**Consumes**

- w0: Account.controlledBy/counterpartyTenantId + the journal.ts 'ic.' rule; ACCT.WAGES_RIDERS, GROUP_RECHARGES (6990), MARKETING_PROMO,
  RIDER_COD_RECEIVABLE, CASH_ON_HAND; `withLateNote` / period-lock helpers; moneyAccountCode; CloseCheck types.


**Exposes**

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


**Tests — run on `servd_test_wb_w1_ic`, Redis index 4**

`controlledAccounts` (manual JE on a Due-from → 422 INTERCOMPANY_ACCOUNT_CONTROLLED; an 'ic.transfer' posting passes; deactivation refusal is
w4-integration's — leave a TODO test name in the report). `intercompany` (companies A, B and unrelated C: pair accounts created once in both
charts, operator code 1450 skipped; finance in A+B submits a settlement, CEO approves, both books post under 'ic.transfer:<id>', A.dueTo(B) ==
B.dueFrom(A); finance only in A → 403; active company neither party → 422; C → 404 on get/approve/reverse and its list excludes A-B; over balance
→ 422; netting; B's period locked → 422 naming B and nothing in A; reverse in both; approve twice → 409; postSystemTransferTx idempotent on
sourceRef). `intercompanyFleet` (trips per pair per month; per-brand conceptId on the client lines; provider credits 6990 not 6035; charge twice →
one transfer; closed month → first common open day + note; refused posting flags 'ic.fleet_charge'; rate change after a charged month → 409;
B-only staff cannot set A-B rates; the close check blocks the uncharged month for both). `intercompanyLegacy` (tie-out per company; write-off of
the split-date difference only, later drift stays a warning; dry run then post; second → 409; B → 404; ADMIN only).



## w1-recon — Card payouts at payout (H12) on top of BOOKS-11, Raast 'void, never booked' (CEO), till-clearing contra

Area: tax (card payouts) + onaccount (Raast void) · Test DB **`servd_test_wb_w1_recon`** · Redis **`redis://127.0.0.1:6390/5`** (index 5) — yours alone · brief: `briefs/w1-recon.md`

reconciliation/cardPayouts + routes + service.ts (BOOKS-11 helper), raast.ts/raastRoutes.ts void, connectors/raast/accounts.ts, RaastTab.tsx.

**Owned files**

- `backend/src/modules/reconciliation/cardPayouts.ts (new)`
- `backend/src/modules/reconciliation/cardPayoutRoutes.ts (w0 stub → fill)`
- `backend/src/modules/reconciliation/service.ts`
- `backend/src/modules/reconciliation/raast.ts`
- `backend/src/modules/reconciliation/raastRoutes.ts`
- `backend/src/modules/reconciliation/README.md`
- `backend/src/connectors/raast/accounts.ts`
- `frontend/admin/src/app/reconciliation/RaastTab.tsx`
- `backend/tests/cardPayouts.test.ts (new)`
- `backend/tests/raastVoid.test.ts (new)`
- `backend/tests/raastRecon.test.ts (W1)`
- `backend/tests/raastBankConfig.test.ts`

**Tasks (outline — full text in the brief)**

  - **Card payouts (H12) — EXTEND BOOKS-11, never a second split posting** (flag this reuse in your report for the owner):
  - Factor the split posting out of `adjustStatementLine` (~290-404: bank leg + Dr 6080 / Cr 1030, balance + active-account checks) into
  - Settings: `cardSettlementSettings(db, tenantId)` zod-parses OperationsConfig.cardSettlement { enabled false, payoutBankAccountId, unitMode
  - **Day gross from card Payment rows** (method card, status paid, by PKT payment time — processedAt ?? createdAt; card refunds negative), grouped
  - `findCardPayoutFits(tx, { tenantId, settings, lines })`: runs ending 1..lagDays+1 days before the line, length 1..maxBatchDays, per unit; fit when
  - `postCardSettlementTx` (advisory lock (tenantId,'card-settlement'), re-validate, period-lock + active-account pre-check → a locked/missing case
  - `undoCardSettlement` (APPROVERS; reverseJournalEntry, delete settlement → days freed, line unmatched). `unsettledCardDaysThrough(db, tenantId,
  - importBankStatement: third pass after Raast when enabled and bankAccountId = payoutBankAccountId (collect fits into cardSkip, the generic pass skips
  - cardPayoutRoutes.ts (registered by w0 at /reconciliation/card-payouts): GET/PUT /settings (PUT admin/finance, payout bank must be a live linked bank
  - Bank-line adjust to a fixed_asset-controlled code requires `registerOverride { reason }` (passes `controlledOverride` to postJournalEntry; audit;
  - **Raast void (OA C):** WRITE_OFF_CONTRAS = ['1115','8010','1350'] (default '1115' in raastRoutes; existing entries untouched, reversals mirror);
  - **RaastTab.tsx:** 'voided' chip (muted token); CEO 'Void — never booked' on eligible receipts (reason; confirm 'no ledger entry; the statement credit

**Consumes**

- w0: CardSettlement/CardSettlementDay models, RaastReceipt void columns + 'voided' enum value, TILL_CLEARING_CODES, ACCT.TILL_CLEARING/CARD_FEES/
  CARD_RECEIVABLE, controlledOverride, CloseCheck types, stub cardPayoutRoutes registered at /reconciliation/card-payouts.


**Exposes**

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


**Tests — run on `servd_test_wb_w1_recon`, Redis index 5**

`cardPayouts` (exact fit: balanced Dr bank / Dr 6080 / Cr 1030, line matched, days claimed; two fitting runs → nothing posted + suggestions list
both, confirm posts; 3-day weekend batch; re-import does not double-post; locked period → unmatched with reason, import 200; fee > maxFeeBps → 422;
undo frees days; unit 'brand' keys days per brand; a manual BOOKS-11 adjust on the payout bank claims the days (and the same day then never
auto-matches) or 409 USE_CARD_PAYOUT_CONFIRM; rematch; two companies: B's import never consumes A's days, B confirm/undo on A's line → 404,
settings PUT with B's bank in A → 422, GET list/suggestions B → 404). `raastVoid` (B → 404; finance requests, non-admin void → 403; each
eligibility refusal incl. a refund row; success posts nothing, status voided, raastOpenThrough no longer counts it; the same bankRef at the till
still → RAAST_REF_USED; audit tenant = A; capability flags). Update `raastRecon` (write-off contra 1115; legacy 1110 refund-due fixtures still count
as booked) and `raastBankConfig` (NON_BANK_MONEY_CODES includes 1115).



## w1-bans — Strikes and bans per company, ban appeals via the help desk, complaint readers filtered

Area: delivery (strikes, bans, appeals) · Test DB **`servd_test_wb_w1_bans`** · Redis **`redis://127.0.0.1:6390/6`** (index 6) — yours alone · brief: `briefs/w1-bans.md`

lib/strikes.ts, crm, complaints (+ appeals), storefront banAppealRoutes, WhatsApp APPEAL, per-company ban readers everywhere.

**Owned files**

- `backend/src/lib/strikes.ts`
- `backend/src/modules/crm/customerScope.ts`
- `backend/src/modules/crm/routes.ts`
- `backend/src/modules/complaints/routes.ts`
- `backend/src/modules/complaints/appeals.ts (new)`
- `backend/src/modules/storefront/banAppealRoutes.ts (new)`
- `backend/src/adapters/whatsapp/conversation.ts`
- `backend/src/lib/marketingAudience.ts`
- `backend/src/workers/loyaltyTriggers.ts`
- `backend/src/lib/customerRollups.ts`
- `backend/src/modules/management/routes.ts (complaint KPI filter only, W1)`
- `backend/src/modules/opsReports/routes.ts`
- `backend/tests/strikesPerCompany.test.ts (new)`
- `backend/tests/banAppeals.test.ts (new)`
- `backend/tests/sepCrm.test.ts`

**Tasks (outline — full text in the brief)**

  - **lib/strikes.ts:** `RecordStrikeArgs.tenantId?` resolved from the source order / reservation (concept.tenantId) when absent, REQUIRED when there is
  - **Lift on appeal keeps the company's strikes** (owner Q6 default) — say so in the UI copy. A legacy NULL-company ban can be lifted by admin only.
  - **crm:** /strikes and /bans write tenantId = the ACTIVE company (create); remove 'cod_unpaid' from the manual strike kinds (still readable);
  - **complaints/routes.ts:** scopeTenantWhere on GET /, GET /stats (critic — today fail-open on tenantFilter) and PATCH; ?kind=complaint|ban_appeal;
  - **complaints/appeals.ts** `createBanAppeal({ banId, customerId?, contactPhone?, conceptId?, reason, message, via })`: conceptId resolved ON THE
  - **storefront/banAppealRoutes.ts** (wave Z registers at /storefront): GET /account/blocks (requireCustomerAuth; matches id, email, phone) → {blocks:
  - **WhatsApp (conversation.ts):** check the ban when the brand is PICKED (not only at the final order); BANNED reply 'Reply APPEAL to ask our help
  - **Company-separation fixes in readers (critic, same change):** lib/marketingAudience.ts drops the global `bannedAt: null` and uses

**Consumes**

- w0: CustomerStrike.tenantId, OrderComplaint kind/banId/contactPhone + relation, partial uniques, migration backfill + split of legacy
  multi-company auto-bans, GATED '/complaints' + '/crm/bans/:id/(lift|release-contact)' rules.


**Exposes**

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


**Tests — run on `servd_test_wb_w1_bans`, Redis index 6**

`strikesPerCompany` (2 strikes at A + 1 at B → no ban; third at A → ban tenantId A; A checkout BANNED with details, B allowed; reversing one A
strike lifts A's auto-ban only; racing promotions → one ban; a staff ban at B does not stop A's auto-ban; B's manual strike/ban on a customer of A
only → 404; marketing audience and referral check per company). `banAppeals` (blocks lists matching bans only; appeal lands on an A brand; B's
complaints list doesn't show it and B's PATCH → 404; fnb_manager (complaints, no crm) lifts through the widened gate and the appeal resolves;
second open → 409; decline then re-appeal < 30 days → 429; release-contact clears the phone on the ban AND the account; PATCH 'resolved' on an
appeal → 409; WhatsApp APPEAL creates one appeal with contactPhone = sender; GET /complaints/stats scoped; complaint follow-up never targets an
appeal). Update `sepCrm` to the column-based attribution.



## w1-taxsales — Delivery-fee GST on top, fiscal DELIVERY-CHARGE line, receipts/invoices, on-account fiscal buyer, gift-card breakage, kept deposits

Area: tax (customer-facing) + onaccount (fiscal/receipt) · Test DB **`servd_test_wb_w1_taxsales`** · Redis **`redis://127.0.0.1:6390/7`** (index 7) — yours alone · brief: `briefs/w1-taxsales.md`

lib/pricing.ts, storefront routes, pos/receipt.ts, invoices/service.ts, connectors/fiscal/payload.ts, giftCards/*, giftCardExpiry worker, depositCapture.

**Owned files**

- `backend/src/lib/pricing.ts`
- `backend/src/modules/storefront/routes.ts`
- `backend/src/modules/pos/receipt.ts`
- `backend/src/modules/invoices/service.ts`
- `backend/src/connectors/fiscal/payload.ts`
- `backend/src/connectors/types.ts`
- `backend/src/modules/giftCards/books.ts`
- `backend/src/modules/giftCards/routes.ts`
- `backend/src/modules/giftCards/README.md`
- `backend/src/workers/giftCardExpiry.ts`
- `backend/src/modules/reservations/depositCapture.ts`
- `backend/tests/deliveryFeeTax.test.ts (new)`
- `backend/tests/deliveryFeeReceiptInvoice.test.ts (new)`
- `backend/tests/fiscalDeliveryLine.test.ts (new)`
- `backend/tests/fiscalOnAccountPayload.test.ts (new)`
- `backend/tests/giftCardBreakage.test.ts (new)`
- `backend/tests/depositForfeitTax.test.ts (new)`
- `backend/tests/resimFiscal.test.ts`

**Tasks (outline — full text in the brief)**

  - **Delivery fee (owner + H9).** lib/pricing.ts priceOrder: OrderPrice + itemTaxCents + deliveryFeeTaxCents; taxCents = sum; discount clamp on
  - **Gift cards (H11) — critic-corrected:**
  - `expireOneGiftCard(cardId, now?, db?)` in one row-locked tx (lockGiftCardTx): status expired / expiredAt; if the card's 'giftcard.issue' entry
  - **Breakage only at the card's FIRST expiry**: value a refund later puts back on an expired card is NEVER swept — it waits in the manager queue
  - `expireDueGiftCards` processes each card once per run with an (expiresAt, id) cursor (no re-query starvation) and also retries cards with
  - voidGiftCard: disposition 'forfeit' on a SOLD card allowed for **ADMIN_ONLY (the CEO)** — a manager/owner gets 403 FORFEIT_NEEDS_CEO (critic:
  - giftCardBooksCheck adds breakage {count, cents} per company; GET /gift-cards/books-check returns it; README + worker header ('posts breakage').
  - **Kept no-show deposit (H10):** depositCapture.ts keeps sourceType 'reservation.deposit_capture', its claim and REPOSTER; lines Dr 1030 D / Cr

**Consumes**

- w0: Order.deliveryFeeCents/deliveryFeeTaxCents, TaxInvoice.deliveryFeeCents, GiftCard breakage columns, CustomerAccountCharge model, ACCT
  DELIVERY_FEE_REVENUE / GIFT_CARD_BREAKAGE, lib/tenders ON_ACCOUNT_TENDER, Order.handoverReroutedAt.


**Exposes**

```ts
// lib/pricing.ts
export interface OrderPrice { /* existing fields */ itemTaxCents: number; deliveryFeeCents: number; deliveryFeeTaxCents: number; taxCents: number }
// giftCards/books.ts
export function expireOneGiftCard(cardId: string, now?: Date, db?: Db): Promise<{ expired: boolean; breakageCents: number; held: boolean }>
// pos/receipt.ts
export function paymentLabelOf(p: { method: string; gatewayRef: string | null; gatewayMeta?: unknown }): { label: string; reference: string | null }
```


**Tests — run on `servd_test_wb_w1_taxsales`, Redis index 7**

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



## w1-dlv-core — Delivery completes only with the customer's code; reroute-to-rider service; door problems; rider app server side

Area: delivery (code only, reroute, rider app) · Test DB **`servd_test_wb_w1_dlv_core`** · Redis **`redis://127.0.0.1:6390/8`** (index 8) — yours alone · brief: `briefs/w1-dlv-core.md`

dispatch/service+routes (no staff Delivered), rider/service+routes, deliveryOtp, riderScoring; exposes rerouteHandoverCode for the Emergency overrides module.

**Owned files**

- `backend/src/modules/dispatch/service.ts`
- `backend/src/modules/dispatch/routes.ts`
- `backend/src/modules/rider/service.ts`
- `backend/src/modules/rider/routes.ts`
- `backend/src/lib/deliveryOtp.ts`
- `backend/src/workers/riderScoring.ts`
- `backend/tests/emergencyReroute.test.ts (new)`
- `backend/tests/dispatch.test.ts`
- `backend/tests/riderApp.test.ts`
- `backend/tests/ordersReconcile.test.ts`
- `backend/tests/accessControl.test.ts (verify-otp / Delivered parts)`

**Tasks (outline — full text in the brief)**

  - **markDelivered is code-only:** delete staffClose and its helpers (assertStaffMayClose, staffMayCloseWhere, managerRequired,
  - lib/deliveryOtp.ts: DELIVERY_OTP_READERS = [] (no staff role reads the customer's code — managers reading it would be a disguised Delivered
  - **rerouteHandoverCode(orderId, { actor, reason })** (exported; the route lives in the Emergency overrides module, w3-dlv-return): validate (a
  - **Pinning after a reroute:** an explicit dispatcher assign/unassign to another rider → 409 CODE_WITH_RIDER; but `takeRiderOff` called by system
  - jobEventTx / recordJobEvent accept actorId.
  - Rider side: toJob adds handover {rerouted, reroutedAt, code (only when rerouted to THIS rider), whatsappSent} and doorProblem {kind, at};
  - workers/riderScoring.ts: exclude returnCause='refused' cancels from a rider's lost rate; treat handoverRerouteAttempts ≥ 3 or a reroute as an

**Consumes**

- w0: Order reroute/return columns, RiderJobEventType code_rerouted/door_problem/returned, RiderJobEvent.actorId, exception kinds.


**Exposes**

```ts
// dispatch/service.ts
export function rerouteHandoverCode(orderId: string, a: { actor: { id: string; tenantId: string | null }; reason: string })
  : Promise<{ ok: true; sentToRider: boolean; riderPhoneHint: string }>
export function resendReroutedCode(orderId: string, actor: { id: string }): Promise<{ ok: true; sentToRider: boolean }>
export function jobEventTx(tx: Tx, a: { orderId: string; riderId: string; tenantId: string; riderTenantId: string; type: RiderJobEventType; note?: string; actorId?: string | null }): Promise<void>
export function recordJobEvent(a: /* same as jobEventTx */ JobEventInput): Promise<void>   // serviceClient, after commit (fleet riders)
```


**Tests — run on `servd_test_wb_w1_dlv_core`, Redis index 8**

`emergencyReroute` (service-level, two companies: once per order (second → 409); the code rotates (old code 403s in the rider app); attempts reset
with the snapshot kept; the event carries actorId; exception lands in A; WhatsApp mocked to the rider's phone; assign to another rider → 409;
system takeRiderOff loops are no-ops; only the assigned rider's app shows the code; a fleet rider of B carrying A's order can be rerouted by A's
manager). Update `dispatch` / `riderApp` (POST /dispatch/orders/:id/delivered → 404; the rider deliver flow unchanged; door-problem scoped to the
own job; admin no longer reads deliveryOtp (~765)), `ordersReconcile` (markDelivered with a verified code), `accessControl` (verify-otp / Delivered
cases).



## Gates between waves (orchestrator; after W1, W2 and W3)

1. Collect every report. Apply patch notes to orchestrator-owned files at once; patch notes for a file a LATER agent owns are appended to that agent's
   brief under "Patch notes to apply first" before it launches. Conflicting notes → decide, record the decision in the next briefs.
2. For each backend agent: rerun its exact test command on its own DB; `npx tsc --noEmit -p .` in backend (and frontend/admin if touched). Red →
   resume that agent (SendMessage) with the failure; never patch around it silently.
3. Personal review (CLAUDE.md: money, tax, auth and tenant isolation are never delegated below the orchestrator):
   - after W1: lib/stockLedger.ts (FIFO maths, exact closure, company checks), lib/withholding.ts, fixedAssets chargeThrough + events postings,
     intercompany postings (both books, one tx), card-payout split, ban promotion per company, delivery-fee tax maths + fiscal payload, reroute.
   - after W2: recipe explosion + packaging by order type / vessel / Box given, cancel / void / return semantics in orders/service.ts, supplierPosting rewrite + cut-over,
     orderPosting / shiftPosting COGS + 4110, capexPosting, salesTaxReturn, on-account exposure + write-offs, codPosting, pettyCashPosting, close checks.
   - after W3: chargeOrderToAccount + every on_account refund writer, till-clearing cut-over, opening counts → 3020, returnedFood, settlement poster +
     H3 auto-conversion, depreciation worker.
4. Commit on main per wave ("wave B W1" …). Launch the next wave in ONE message.


---

# W2 — 9 agents in parallel

| id | area | DB | Redis |
|---|---|---|---|
| w2-sale | foodcost (sale side) + delivery/tax hooks in orders | `servd_test_wb_w2_sale` | 6390/9 |
| w2-ap | foodcost (receiving, GRNI, bills, cut-over) + tax (bill authority/WHT) + assets (bill equipment guard) | `servd_test_wb_w2_ap` | 6390/10 |
| w2-ledger | foodcost (COGS) + tax (4110) in the sale formula | `servd_test_wb_w2_ledger` | 6390/11 |
| w2-fa-capex | assets (CapEx side) + tax (CapEx WHT/input tax) + H25 prepaid engine | `servd_test_wb_w2_fa_capex` | 6390/12 |
| w2-taxbooks | tax (return) + people (return filters) + tax (OpEx input tax / WHT / prepaid) | `servd_test_wb_w2_taxbooks` | 6390/13 |
| w2-oa-recv | onaccount (receivables) + tax (H13 customer withholding) | `servd_test_wb_w2_oa_recv` | 6390/14 |
| w2-dlv-cod | delivery (COD custody) + tax/onaccount report rows | `servd_test_wb_w2_dlv_cod` | 6390/15 |
| w2-cash-ledger | cash (petty cash in the ledger) + delivery (trustops OTP route) | `servd_test_wb_w2_cash_ledger` | 6390/16 |
| w2-close | people (close, year end) + FA/TX/CA/FC report changes | `servd_test_wb_w2_close` | 6390/17 |


## w2-sale — Recipe explosion with packaging by order type + brand vessel + Box given, per-line FIFO depletion, cancel/void/return semantics, orders/service.ts

Area: foodcost (sale side) + delivery/tax hooks in orders · Test DB **`servd_test_wb_w2_sale`** · Redis **`redis://127.0.0.1:6390/9`** (index 9) — yours alone · brief: `briefs/w2-sale.md`

lib/recipeCost.ts, orders/stock.ts, inventory/voidWaste.ts, orders/service.ts (all merged), pos/service.ts (FC part).

**Owned files**

- `backend/src/lib/recipeCost.ts`
- `backend/src/modules/orders/stock.ts (new)`
- `backend/src/modules/orders/service.ts`
- `backend/src/modules/inventory/voidWaste.ts`
- `backend/src/modules/pos/service.ts (FC part only — W2)`
- `backend/tests/orderStock.test.ts (new)`
- `backend/tests/packagingDepletion.test.ts (new)`
- `backend/tests/modifierStock.test.ts (new)`
- `backend/tests/cancelReturnedHook.test.ts (new)`
- `backend/tests/recipeCost.test.ts`
- `backend/tests/integrationPass2Orders.test.ts`
- `backend/tests/auditTillShift.test.ts`
- `backend/tests/auditOrdersFollowup.test.ts`
- `backend/tests/managerVoids.test.ts (FC void parts, W2)`
- `backend/tests/resimTill.test.ts (W2: the void_after_fire / stock.sale_deplete / Cr 1210 cases — verifier: unowned otherwise)`
- `backend/tests/auditOrdersRefund.test.ts (W2: the deductInventoryForOrder / cancel restore cases only)`

**Tasks (outline — full text in the brief)**

  - **THE packaging rule (decision P1 — FINAL owner rule, see the common brief):** a sold line consumes its dish's Packaging section ONLY when
  - **lib/recipeCost.ts (THE explosion/costing):** CostItem gains tenantId + category; recipe lines gain `section`; roots carry Recipe.modifierId/kind.
  - **orders/stock.ts (bodies moved from orders/service.ts; service.ts re-exports deductInventoryForOrder / restoreInventoryForOrder):**
  - `deductInventoryForOrder(orderId)`: `ensureFifoReady(tenantId)` first (outside any tx); claim through the write-once 'stock.sale_deplete' audit
  - `restoreInventoryForOrder(orderId, { cookedFood?, actorId, approverId })`: unfired lines → `returnToLotsTx` (exact lots); fired lines →
  - `returnVoidedLineStockTx(tx, { orderId, tenantId, line })`, `ensureOrderDepleted(orderId)` (outside any tx), `wasteReturnedOrder(orderId,
  - **inventory/voidWaste.ts (FC + DL merged):** `wasteSoldLineTx(tx, { orderId, tenantId, line, wasteReason, actorId, conceptId })` — relabels the
  - **orders/service.ts — every merged change (you are the only W2 owner):**
  - FC: the moves above; completeOrder `await ensureOrderDepleted(orderId)` before the claim tx; ingestOrder persists `modifierId` only when that
  - **KDS recall (~1805-1857, ItemStatus 'recalled'):** the remake re-cooks the line → book the line's recipe as waste reason 'remake' (consumeFifoTx
  - **Cancel semantics (FC + DL):** `CancelOrderInput.cookedFood?` and `CancelOrderInput.returned?: { cause, actorId, run(tx) }`;
  - TX: ingestOrder writes `deliveryFeeCents` / `deliveryFeeTaxCents` from `opts.price` (w1-taxsales already returns them).
  - **pos/service.ts — FC part only in W2 (w3-till owns the file in W3):** delete restoreVoidedLineStockTx + STOCK_DEPLETE / STOCK_RESTORE /

**Consumes**

- w1-stock: consumeFifoTx, returnToLotsTx, relabelToWasteTx, ensureFifoReady, lockItemsTx; cogs.orderStockCostCents; inventoryPosting.postWasteLog.
- w0: RecipeKind 'modifier', Recipe.modifierId, RecipeIngredient.section, WasteLog columns, Order fee columns, lib/savepoint.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_sale`, Redis index 9**

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



## w2-ap — ONE receiving path with lots + GRNI, bills on FIFO, cash-settled receipts, supplier tax fields, FIFO cut-over

Area: foodcost (receiving, GRNI, bills, cut-over) + tax (bill authority/WHT) + assets (bill equipment guard) · Test DB **`servd_test_wb_w2_ap`** · Redis **`redis://127.0.0.1:6390/10`** (index 10) — yours alone · brief: `briefs/w2-ap.md`

supplierPosting.ts rewrite, procurement service/routes/receiving/creditNotes/grniRoutes, inventory/cashPurchase.ts + fifoCutover.ts, reconciliation/routes.ts (delete one route).

**Owned files**

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

**Tasks (outline — full text in the brief)**

  - **receiving.ts — THE one path that brings stock in.** Extract `receiveGoodsTx(tx, input)` from receiveGoods (receiveGoods = ensureFifoReady + tx +
  - **Cash-settled receipts (decision P6):** `input.settledBy?: { kind: 'petty_cash_movement'|'cash_voucher_settlement', id, creditAccountCode }` —
  - **inventory/cashPurchase.ts** `recordCashPurchaseStockTx(tx, { tenantId, settledBy, lines: [{ spendLineId, inventoryItemId, qty, unit,
  - **supplierPosting.ts (FC + TX):** rewrite postSupplierBill (posting 2: Dr 2015 for stock lines matched FIFO to unbilled receipt lines of the PO
  - **procurement/service.ts createBill:** stock lines need poLineId or receiptLineId (422 STOCK_LINE_NEEDS_RECEIPT 'receive it at the dock first');
  - **procurement/routes.ts:** billLineSchema + receiptLineId?, expenseAccountCode?, notEquipment?, notEquipmentReason?; billCreateSchema + taxAuthority,
  - **creditNotes.ts:** return caps read the remaining quantity of the bill's lots.
  - **grniRoutes.ts** (wave Z registers at /procurement/grni; gate anyOf ['procurement','accounting'] from w0): GET / ?tenantId&supplierId&olderThanDays
  - **inventory/fifoCutover.ts** `ensureFifoCutover(tenantId)` / `readCutover(tenantId)`: per the FC plan PART 2 (step 0 = the former
  - **reconciliation/routes.ts:** delete POST /apply-missed-bill-variances (~365-400) — the logic now lives in fifoCutover step 0.

**Consumes**

- w1-stock: addLotTx, consumeFifoTx (supplier returns), repriceLotTx, ensureFifoReady, postGoodsReceiptTx, postClassReclassTx, postGrniOpeningTx,
  postGrniWriteOffTx, brandUsageShares/splitCents.
- w1-taxcore: computeWithholding, inputTaxCodeFor, TAX_AUTHORITY_KEYS, WHT_SECTIONS.  w1-fa-engine: assertNotEquipmentLine.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_ap`, Redis index 10**

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



## w2-ledger — Order completion and shift close: COGS by class from lots, 4110 delivery-fee leg, output tax via the one authority table

Area: foodcost (COGS) + tax (4110) in the sale formula · Test DB **`servd_test_wb_w2_ledger`** · Redis **`redis://127.0.0.1:6390/11`** (index 11) — yours alone · brief: `briefs/w2-ledger.md`

accounting/orderPosting.ts + shiftPosting.ts (W2 part). The on-account / 1115 changes come in W3 (w3-till).

**Owned files**

- `backend/src/modules/accounting/orderPosting.ts (W2)`
- `backend/src/modules/accounting/shiftPosting.ts (W2)`
- `backend/tests/deliveryFeeLedger.test.ts (new)`
- `backend/tests/cogsPosting.test.ts (new)`
- `backend/tests/auditLedgerSales.test.ts (W2: COGS/4110 expectations)`
- `backend/tests/booksLedger.test.ts (W2: COGS/4110 expectations)`
- `backend/tests/auditLedgerFollowups.test.ts (W2: COGS/4110 expectations)`
- `backend/tests/postingFailures.test.ts (W2: COGS/4110 expectations)`

**Tasks (outline — full text in the brief)**

  - **orderPosting.ts:** (FC) delete computeOrderCogsCents and the cogsForSoldLines import; postOrderCompletion resolves tenantId (order.concept.tenantId)
  - **shiftPosting.ts:** (FC) per-brand COGS (~510-525) → `lines.push(...await cogsLinesForOrders(tenantId, b.orderIds, { conceptId: b.conceptId,

**Consumes**

- w1-stock: cogsLinesForOrders. w1-taxcore: taxAuthorities.ts (OUTPUT_TAX_BY_PROVINCE, outputTaxCodeFor). w0: ACCT.DELIVERY_FEE_REVENUE, Order fee columns.


**Exposes**

```ts
// accounting/orderPosting.ts (unchanged names, new fields)
export interface SaleAccounting { /* existing */ deliveryFeeCents: number }
export interface RefundShare { /* existing */ deliveryFeeCents: number }
export { OUTPUT_TAX_BY_PROVINCE, OUTPUT_TAX_ACCOUNTS, outputTaxCodeFor } // re-exported from taxAuthorities.ts
```


**Tests — run on `servd_test_wb_w2_ledger`, Redis index 11**

`deliveryFeeLedger` (completion entry balances with Cr 4110 + the full tax; a refund takes the 4110 share; a legacy order (fee 0) posts as before; a
till sale has no fee; two companies: B's delivery order posts to B's 4110 and output account). `cogsPosting` (order.complete posts one pair per
class from the lots, packaging to 5030/1230 for a DINE-IN order too; shift close per brand per class; a pre-cut-over order falls back to the legacy
pair with memo 'pre-FIFO order'). Update the COGS/4110 expectations in auditLedgerSales, booksLedger, auditLedgerFollowups, postingFailures (W2;
w3-till edits the same files in W3 for 1115).



## w2-fa-capex — CapEx → register link, capitalisation request, WHT/input tax on CapEx, deposits, Quick buy, prepaid releases (CapEx + OpEx), cash seam

Area: assets (CapEx side) + tax (CapEx WHT/input tax) + H25 prepaid engine · Test DB **`servd_test_wb_w2_fa_capex`** · Redis **`redis://127.0.0.1:6390/12`** (index 12) — yours alone · brief: `briefs/w2-fa-capex.md`

financePlanning/capexPosting.ts + routes.ts + companyRefs.ts, accounting/prepaidReleases.ts (source-agnostic), recordCapexPaymentFromCashTx.

**Owned files**

- `backend/src/modules/financePlanning/capexPosting.ts`
- `backend/src/modules/financePlanning/routes.ts`
- `backend/src/modules/financePlanning/companyRefs.ts`
- `backend/src/modules/accounting/prepaidReleases.ts (new)`
- `backend/tests/capexAssetLink.test.ts (new)`
- `backend/tests/prepaidReleases.test.ts (new)`
- `backend/tests/booksReconcile.test.ts (W2)`
- `backend/tests/moneyBigint.test.ts (fixed-asset section only, W2)`

**Tasks (outline — full text in the brief)**

  - **capexPosting.ts:** delete capexLinkNote and the 'capex-line:' notes link — `findCapitalisedAssets` uses FixedAsset.capexLineId (status ≠ voided).
  - **accounting/prepaidReleases.ts — ONE source-agnostic engine (decision P7, critic H25-for-OpEx):** PrepaidRelease rows keyed (tenantId,
  - **financePlanning/routes.ts:** line create/patch (supplierId → `assertSupplierOfCompany(project.tenantId)` 422; treatment locked after a payment
  - **companyRefs.ts:** `assertSupplierOfCompany(tenantId, supplierId)` (422 SUPPLIER_NOT_IN_COMPANY; a null project company → 422 PROJECT_HAS_NO_COMPANY).

**Consumes**

- w1-fa-engine: createRequest/applyEvent, ASSET_CLASS_DEFAULTS/getAssetClasses, postAcquisition, nextAssetTag, findOrCreatePool.
- w1-taxcore: computeWithholding, defaultSectionForCapex, inputTaxCodeFor.  w0: liveRevision(…, tx), keepLiveDate, lateDatingFor, PrepaidRelease model, CloseCheck.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_fa_capex`, Redis index 12**

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



## w2-taxbooks — Sales-tax return for H8-H13 + statutory filters; OpEx with vendor, input tax by authority, WHT, prepaid treatment

Area: tax (return) + people (return filters) + tax (OpEx input tax / WHT / prepaid) · Test DB **`servd_test_wb_w2_taxbooks`** · Redis **`redis://127.0.0.1:6390/13`** (index 13) — yours alone · brief: `briefs/w2-taxbooks.md`

accounting/salesTaxReturn.ts, opex/posting.ts + routes.ts + categoryAccounts.ts.

**Owned files**

- `backend/src/modules/accounting/salesTaxReturn.ts`
- `backend/src/modules/opex/posting.ts`
- `backend/src/modules/opex/routes.ts`
- `backend/src/modules/opex/categoryAccounts.ts`
- `backend/tests/salesTaxReturnH8H13.test.ts (new)`
- `backend/tests/opexTaxWht.test.ts (new)`
- `backend/tests/opexPrepaid.test.ts (new)`
- `backend/tests/opexAccounts.test.ts`
- `backend/tests/taxPayments.test.ts (W2: sales-tax-return / payment cases; w1-taxcore had it in W1) — auditLedgerSales / auditLedgerFollowups also hit the return but are w2-ledger's this wave: send patch notes`

**Tasks (outline — full text in the brief)**

  - **salesTaxReturn.ts:** import + re-export AUTHORITIES / AuthorityKey from accounting/taxAuthorities.ts (one table); ORDER_FOR_RETURN + deliveryFeeCents
  - **opex/posting.ts:** syncOpexPaymentPosting builds Dr <expense code> (actual + wht − inputTax, conceptId) / Dr inputTaxCodeFor(authority) inputTax /
  - **opex/routes.ts:** line create/patch: supplierId (the Supplier's tenantId must equal the CATEGORY's company — 422 SUPPLIER_NOT_IN_COMPANY; supplierId
  - **Equipment guard:** the payment's line name/notes through `assertNotEquipmentLine` → 422 USE_CAPEX (override admin/finance + flag

**Consumes**

- w1-taxcore: AUTHORITIES, inputTaxCodeFor, computeWithholding, customerWithheldAvailable. w1-fa-engine: assertNotEquipmentLine. w0: OpexLine/OpexPayment columns.


**Exposes**

```ts
// accounting/salesTaxReturn.ts — same exports; new fields on the return: byAuthority[].withheldByCustomersCents, customerWithheldSetOffForPeriodCents,
// netAfterWithheldCents; byRate supply classes 'delivery_charge' | 'deposit_forfeit'; deliveryFeesCents; taxableValueByConceptCents[].deliveryFeeCents
// opex/posting.ts
export function syncOpexPaymentPosting(paymentId: string, o?: { tx?: Tx; postedBy?: string }): Promise<SyncResult>
```


**Tests — run on `servd_test_wb_w2_taxbooks`, Redis index 13**

`salesTaxReturnH8H13` (delivery_charge and deposit_forfeit rows; withheldByCustomers nets SRB; B's 1335 absent from A; statutory payments not in the
return; reclass not in 'withheld'; SUPPLY_ORDER sort; fallback uses taxCents − feeTax). `opexTaxWht` (SRB-taxed security invoice 110,000 with
10,000 SRB input, s.153(1)(b) filer 9% → WHT 9,000, cash 101,000; entry Dr 6xxx 100,000 / Dr 1322 10,000 / Cr bank 101,000 / Cr 2040 9,000; edit
reposts @2; rent s.155; exempt vendor → 0; switch off → 0; section without vendor → 422; payroll category skipped; equipment line → 422 USE_CAPEX;
budget uses the expense; two companies: B's supplier on A's line → 422, B patching A's payment → 404, A's WHT in A's 2040 only, wht-quote B → 404).
`opexPrepaid` (prepaid payment posts Dr 1310 and needs coverage; deposit → 422). Update opexAccounts (capex cases unchanged).



## w2-oa-recv — On-account clients, cards, exposure, statements, bad-debt write-offs; sales tax withheld by clients

Area: onaccount (receivables) + tax (H13 customer withholding) · Test DB **`servd_test_wb_w2_oa_recv`** · Redis **`redis://127.0.0.1:6390/14`** (index 14) — yours alone · brief: `briefs/w2-oa-recv.md`

receivables/routes.ts, onAccount.ts (exposure / chargeable / charge / charge refund), customerAccounts.ts, statements.ts, writeOffs.ts, onAccountDaily worker.

**Owned files**

- `backend/src/modules/receivables/routes.ts`
- `backend/src/modules/receivables/onAccount.ts (new)`
- `backend/src/modules/receivables/customerAccounts.ts (new)`
- `backend/src/modules/receivables/statements.ts (new)`
- `backend/src/modules/receivables/writeOffs.ts (new)`
- `backend/src/workers/onAccountDaily.ts (new)`
- `backend/tests/onAccountClients.test.ts (new)`
- `backend/tests/onAccountExposure.test.ts (new)`
- `backend/tests/onAccountStatements.test.ts (new)`
- `backend/tests/badDebtWriteOff.test.ts (new)`
- `backend/tests/receivablesSalesTaxWithheld.test.ts (new)`
- `backend/tests/receivablesCredit.test.ts`

**Tasks (outline — full text in the brief)**

  - **receivables/routes.ts:** EXPORT the private helpers (lockInvoice, restatus, nextNumber (prefix AR-ST- for statements), withNumberRetry,
  - **H13 (TX):** the withholding route body gains kind 'income_tax' (default, today's) | 'sales_tax' → ReceivablePayment method **'st_withheld'**
  - **Recovery reversal (critic):** reversing a payment that carries writeOffId also decrements ReceivableWriteOff.recoveredCents and restores the
  - **receivables/onAccount.ts (used by the till in W3):** `CHARGE_ERRORS`; `lockAccountTx(tx, id)` (SELECT … FOR UPDATE); `exposureOfTx(db, accountId)` →
  - **customerAccounts.ts** (wave Z registers at /accounting/customer-accounts; '/accounting' gate): list/create/get/patch per the OA plan routes;
  - **statements.ts:** issueStatementTx (lockAccountTx then claim unbilled charges with chargedAt ≤ periodTo end of PKT day **whose sale is BOOKED** —
  - **writeOffs.ts:** request (WRITE_OFF_REQUESTERS admin/owner/management/finance; amount ≤ balanceOf; reason 10-500; 1-5 evidence files via
  - **workers/onAccountDaily.ts** (09:20 PKT per active company; wave Z starts it): one 'on_account_overdue' flag per overdue statement/invoice

**Consumes**

- w0: CustomerAccount* models, ReceivableWriteOff*, ReceivableInvoice/Payment columns, lib/onAccountCard.ts, lib/evidenceFile.ts, ACCT.BAD_DEBTS /
  ST_WITHHELD_BY_CUSTOMERS, assertTemplateAccounts. w1-taxcore: taxAuthorities (outputTaxCodeFor, authorityOfOutputCode). existing: assertNotSelfApproval.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_oa_recv`, Redis index 14**

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



## w2-dlv-cod — COD with the rider (H5): one COD status definition, rider debt (own and fleet riders), custody worker, reports

Area: delivery (COD custody) + tax/onaccount report rows · Test DB **`servd_test_wb_w2_dlv_cod`** · Redis **`redis://127.0.0.1:6390/15`** (index 15) — yours alone · brief: `briefs/w2-dlv-cod.md`

accounting/codPosting.ts, lib/cod.ts, reconciliation/codRoutes.ts, pos/routes.ts, workers/codCustody.ts, reports/service.ts.

**Owned files**

- `backend/src/modules/accounting/codPosting.ts (new)`
- `backend/src/lib/cod.ts (new)`
- `backend/src/modules/reconciliation/codRoutes.ts (w0 stub → fill)`
- `backend/src/modules/pos/routes.ts`
- `backend/src/workers/codCustody.ts (new)`
- `backend/src/modules/reports/service.ts`
- `backend/tests/codRiderDebt.test.ts (new)`
- `backend/tests/codCustody.test.ts (new)`
- `backend/tests/raastReports.test.ts`
- `backend/tests/resimWallet.test.ts (W2: salesByTender / cod-due cases only) — booksReconcile (w2-fa-capex) and cashControls (w2-cash-ledger) also hit salesByTender / cod-due but belong to those agents this wave: send patch notes`

**Tasks (outline — full text in the brief)**

  - **lib/cod.ts — ONE definition** read by /pos/cod-due, /reconciliation/cod, salesByTender and the custody worker: `COD_PAY_IN_HOURS = 12`,
  - **accounting/codPosting.ts:** `bookCodRiderDebt({ paymentId, actorId, reason, legacy? })` in $transaction + lockOrderTx with the claim on
  - **Fleet rider of another company (H30 contract):** an IntercompanyTransfer via `postSystemTransferTx` (serviceClient tx; source 'cod', sourceRef
  - **reconciliation/codRoutes.ts** (mounted at /reconciliation/cod by w0): GET /?status=with_rider|overdue|rider_owes (FINANCE_TEAM + reconciliation
  - **pos/routes.ts:** GET /cod-due imports COD_PAY_IN_HOURS + codStatusOf; rows add riderOwes {at, byName} | null and status; **the payout category zod
  - **workers/codCustody.ts** (every 30 min, loop per company; wave Z starts it): flagException 'cod_cash_overdue' per delivery COD Payment past
  - **reports/service.ts (merged):** salesByTender 'cod_not_collected' → 'cod_rider_owes' (from Payment.codRiderDebtAt via codStatusOf); rename

**Consumes**

- w1-ic: postSystemTransferTx, reverseSystemTransfer, isMemberOfBoth (lib/companyPairs.ts). w0: Payment cod columns, ACCT.RIDER_COD_RECEIVABLE, reverseJournalEntry.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_dlv_cod`, Redis index 15**

`codRiderDebt` (two companies: B finance → 404 on A's payment; own rider posts Dr 1351/Cr 1010 in A under 'cod.rider_debt:<paymentId>', replay no-op;
refuses a POS order, a paid row, a pickup row (at_counter), an order delivered without a code, a missing order.complete, cashier/foh roles (403), a
role without the reconciliation module (403); legacy:true by finance with reason passes, by management → 403; fleet rider of B on A's order: a
finance user of A only → 403, of A and B → an IntercompanyTransfer source 'cod' in both books; reverseCodRiderDebtTx posts
'cod.rider_debt.reversal:<paymentId>'; salesByTender shows the rider-owes row, deliveryFees and on_account ordering). `codCustody` (flags per
company only for its own overdue delivery COD; no duplicate on re-run; pickup cash never flagged; on-road overdue flag). Update `raastReports`
(cod.notCollected* → cod.riderOwes*) and any cod-due / salesByTender suite.



## w2-cash-ledger — Petty cash on the books: 1011, sources incl. Garibsons/safe/bank/till, returns, spends with expense lines, counts, history backfill, tie-out

Area: cash (petty cash in the ledger) + delivery (trustops OTP route) · Test DB **`servd_test_wb_w2_cash_ledger`** · Redis **`redis://127.0.0.1:6390/16`** (index 16) — yours alone · brief: `briefs/w2-cash-ledger.md`

accounting/pettyCashPosting.ts, trustops/pettyCash.ts + routes.ts, expenseCategories.ts, pos/drawerToBox.ts, reconciliation/pettyCashBackfillRoutes.ts, petty-cash admin page + shared editors.

**Owned files**

- `backend/src/modules/accounting/pettyCashPosting.ts (new)`
- `backend/src/modules/trustops/pettyCash.ts (W2)`
- `backend/src/modules/trustops/routes.ts`
- `backend/src/modules/accounting/expenseCategories.ts`
- `backend/src/modules/pos/drawerToBox.ts (new)`
- `backend/src/modules/reconciliation/pettyCashBackfillRoutes.ts (w0 stub → fill)`
- `frontend/admin/src/app/finance/petty-cash/page.tsx`
- `frontend/admin/src/app/finance/petty-cash/TopUpModal.tsx (new)`
- `frontend/admin/src/app/finance/petty-cash/SpendModal.tsx (new)`
- `frontend/admin/src/app/finance/petty-cash/ReturnModal.tsx (new)`
- `frontend/admin/src/app/finance/petty-cash/TieOutBanner.tsx (new)`
- `frontend/admin/src/components/finance/SpendLinesEditor.tsx (new, W2)`
- `frontend/admin/src/components/finance/ReceiptUploader.tsx (new)`
- `frontend/admin/src/lib/photoPrep.ts (new)`
- `backend/tests/pettyCashLedger.test.ts (new)`
- `backend/tests/cashControls.test.ts (W2)`
- `backend/tests/sepTrustops.test.ts`
- `backend/tests/wave3Finance.test.ts (W2: charts carry 1011)`
- `backend/tests/integrationPass1.test.ts (W2: top-up source only)`

**Tasks (outline — full text in the brief)**

  - **accounting/pettyCashPosting.ts — the ONE poster:** `postPettyCashMovementTx(tx, movementId, opts?)` builds the entry purely from the stored movement
  - top-up: Dr 1011 / Cr movement.accountCode — **garibsons → 2210 (H1, ONE constant FUNDING_ACCOUNT.garibsons = ACCT.DUE_TO_GARIBSONS)**; safe → 1010;
  - **till (critic — never a 'drop', never via 1010):** the top-up tx calls `recordDrawerToBoxTx` (pos/drawerToBox.ts, below) which writes a
  - return (new movement type 'return'): Dr 1010 | bank code | 2210 / Cr 1011.
  - spend: expense lines Dr each line.accountCode (6xxx) with conceptId = line ?? box.conceptId / Cr 1011 (5010/5020/5030 only on HISTORY-backfill
  - reconcile (count): short Dr 8010 / Cr 1011, over Dr 1011 / Cr 8010, zero → nothing.
  - **trustops/pettyCash.ts:** writeMovementTx loads the box (tenantId required), stamps tenantId/source/accountCode/bankAccountId/shiftId/cashMovementId/
  - **pos/drawerToBox.ts:** `recordDrawerToBoxTx(tx, { shiftId, tenantId, amountCents, reason, createdById })` → { cashMovementId }: assertShiftOf
  - **expenseCategories.ts:** PAYOUT_CATEGORIES stays ONE list with `kind`: the existing 8 'expense'; + office 6170, courier 6175, staff_welfare 6180, phone
  - **trustops/routes.ts (CA + DL):** every petty-cash route of the cash plan: box create (openingSource garibsons default | safe | bank | till), POST
  - **GET /petty-cash/boxes?mine=1** (ALL_STAFF: boxes where custodianId = me in write scope; no movements, no bytes — critic: the custodian's box picker).
  - **reconciliation/pettyCashBackfillRoutes.ts** (mounted at /reconciliation/backfill-petty-cash by w0 — critic: backfills live under /reconciliation):
  - **Admin (petty-cash page + shared components):** lib/photoPrep.ts (preparePhoto/kb/blob-url moved from cash-vouchers/photo.ts — leave that file

**Consumes**

- w0: PettyCashMovement/SpendLine/attachments schema, ACCT.PETTY_CASH/DUE_TO_GARIBSONS/CASH_ADVANCES/CASH_DRAWER, lib/evidenceFile.ts, placeAndPost /
  withBackfillSlot exports, ledgerBalancesByCode. w1-fa-engine: assertNotEquipmentLine. existing: moneyAccountCode, createPaymentTx, drawerExpectation, assertShiftOf.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_cash_ledger`, Redis index 16**

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



## w2-close — ONE period-close checklist with CEO override, fiscal year + virtual roll-forward, statements/report categorisation fixes

Area: people (close, year end) + FA/TX/CA/FC report changes · Test DB **`servd_test_wb_w2_close`** · Redis **`redis://127.0.0.1:6390/17`** (index 17) — yours alone · brief: `briefs/w2-close.md`

accounting/closeChecks.ts, fiscalYear.ts (db helpers), reports.ts, accounting/routes.ts, lib/labour.ts, tenants/routes.ts (FY PATCH) + close/BS/TB admin pages.

**Owned files**

- `backend/src/modules/accounting/closeChecks.ts (new)`
- `backend/src/modules/accounting/fiscalYear.ts (extend)`
- `backend/src/modules/accounting/reports.ts`
- `backend/src/modules/accounting/routes.ts`
- `backend/src/lib/labour.ts`
- `backend/src/modules/tenants/routes.ts (W2: fiscalYearEndMonth only)`
- `frontend/admin/src/app/accounting/period-close/page.tsx`
- `frontend/admin/src/app/accounting/period-close/README.md`
- `frontend/admin/src/app/accounting/balance-sheet/page.tsx`
- `frontend/admin/src/app/accounting/trial-balance/page.tsx`
- `backend/tests/periodCloseChecklist.test.ts (new)`
- `backend/tests/fiscalYearReports.test.ts (new)`
- `backend/tests/cashFlowCategories.test.ts (new)`
- `backend/tests/manualJournalControlled.test.ts (new)`
- `backend/tests/auditAccounting.test.ts`
- `backend/tests/raastRecon.test.ts (W2: period-close fixtures only)`

**Tasks (outline — full text in the brief)**

  - **closeChecks.ts — ONE checklist.** Core checks: 'raast' (block; raastOpenThrough), 'open_tills' (block; open shifts openedAt ≤ newLock of the
  - **fiscalYear.ts:** add `fiscalYearEndMonthOf(db, tenantId)`, `fiscalYearsFor(db, tenantIds, at)`; FY computed RELATIVE TO the report's asOf (critic).
  - **reports.ts:** balanceSheet: per company P&L before its FY start = 'Retained earnings b/f', the rest to asOf = 'Profit for the year to date'
  - **lib/labour.ts:** the revenue denominator excludes 42xx (4110 delivery fees stay — they are sales).
  - **accounting/routes.ts:** GET /period-close?lockedThrough → existing fields + raastUnmatched (compat) + checks + months + isYearEnd + fiscalYear
  - **(FA) POST /journal:** a line on a fixed_asset-controlled code needs `registerOverride { reason ≥ 10 }` → postJournalEntry controlledOverride (else the
  - **tenants/routes.ts (W2 part only):** PATCH /:id fiscalYearEndMonth int 1-12 (ADMIN_ONLY, memberTenantIds, foreign 404); once any close has spanned a
  - **Admin:** period-close page (checklist chips: green clear / red block / amber warn via tokens; deep links + fix buttons (fix.path POST); CEO override

**Consumes**

- w1: hrCloseChecks (w1-hr), statutoryCloseChecks (w1-taxcore), intercompanyCloseChecks (w1-ic), fixedAssetCloseChecks (w1-fa-engine),
  cardPayoutCloseChecks (w1-recon). w0: closeCheckTypes, fiscalYear (pure), PeriodLock columns, controlledOverride.


**Exposes**

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


**Tests — run on `servd_test_wb_w2_close`, Redis index 17**

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



## Gate after W2

Run the gate steps above (section 'Gates between waves'), with the personal-review list 'after W2'; then launch the next wave in ONE message.


---

# W3 — 8 agents in parallel

| id | area | DB | Redis |
|---|---|---|---|
| w3-till | onaccount (till + ledger) + tax / delivery / Raast-void hooks at the till | `servd_test_wb_w3_till` | 6390/18 |
| w3-stockdocs | foodcost (stock documents: counts, waste, prep, transfers, item edits) | `servd_test_wb_w3_stockdocs` | 6390/19 |
| w3-recipes | foodcost (recipes: packaging on every dish, modifier recipes, costing) | `servd_test_wb_w3_recipes` | 6390/20 |
| w3-fc-report | foodcost (the variance report, its API, email, hub gauge, management KPI) | `servd_test_wb_w3_fc_report` | 6390/21 |
| w3-dlv-return | delivery (Emergency overrides: code to the rider, food came back) | `servd_test_wb_w3_dlv_return` | 6390/22 |
| w3-cash-requests | cash (cash requests replace vouchers; receipts book the expense; stock + capex lines) | `servd_test_wb_w3_cash_requests` | 6390/23 |
| w3-fa-api | assets (API, reports, automatic monthly worker) | `servd_test_wb_w3_fa_api` | 6390/24 |
| w3-admin-finance | admin UI — tax, reconciliation (card payouts, COD, backfill), operations config, OpEx, gift cards, delivery zones | — (ui) | — |


## w3-till — On-account tender at the till, till-clearing contra 1115, Z-report, delivery-fee unwind, Raast-void exclusions, COD rider-debt reversal

Area: onaccount (till + ledger) + tax / delivery / Raast-void hooks at the till · Test DB **`servd_test_wb_w3_till`** · Redis **`redis://127.0.0.1:6390/18`** (index 18) — yours alone · brief: `briefs/w3-till.md`

pos/service.ts (all non-FC changes), pos/onAccountTender.ts + onAccountRoutes.ts, orderPosting.ts + shiftPosting.ts (OA part), accounting/tillClearing.ts + its worker.

**Owned files**

- `backend/src/modules/pos/service.ts (W3: everything except the FC changes w2-sale already landed)`
- `backend/src/modules/pos/onAccountTender.ts (new)`
- `backend/src/modules/pos/onAccountRoutes.ts (new)`
- `backend/src/modules/accounting/orderPosting.ts (W3: on-account + 1115 only)`
- `backend/src/modules/accounting/shiftPosting.ts (W3: on-account + 1115 only)`
- `backend/src/modules/accounting/tillClearing.ts (new)`
- `backend/src/workers/tillClearingSweep.ts (new)`
- `backend/tests/onAccountTill.test.ts (new)`
- `backend/tests/onAccountLedger.test.ts (new)`
- `backend/tests/tillClearing.test.ts (new)`
- `backend/tests/tillHooksWaveB.test.ts (new: 4110 unwind, Raast-void exclusions, COD settle reversal)`
- `backend/src/modules/pos/boxGivenRoutes.ts (new)`
- `backend/tests/boxGiven.test.ts (new)`
- `backend/tests/auditLedgerFollowups.test.ts (W3: 1110 → 1115 till-clearing assertions)`
- `backend/tests/auditLedgerSales.test.ts (W3: same)`
- `backend/tests/booksLedger.test.ts (W3: same)`
- `backend/tests/auditMoneyFollowups.test.ts`
- `backend/tests/raastRefund.test.ts`
- `backend/tests/raastLedger.test.ts`
- `backend/tests/postingFailures.test.ts (W3: same)`
- `backend/tests/baseLayers.test.ts (W3: till-clearing assertions only)`

**Tasks (outline — full text in the brief)**

  - **On-account at the till (owner: corporate clients with a credit limit and a QR card the cashier scans; no manager approval per bill):**
  - **pos/service.ts — export, no behaviour change:** applyCoverageTx, afterTillSale, repriceForTenderTx, coveredCents, assertTakesMoney, paymentKeyOf,
  - **pos/onAccountTender.ts:** `lookupCardForOrder({ orderId, code, actor })` — the order from write scope (404 foreign); the card found by
  - **pos/onAccountRoutes.ts** (a second plugin wave Z registers at '/pos'; /pos is ungated): POST /pos/on-account/lookup {orderId uuid, code ≤ 40}
  - **Refunds (pos/service.ts):** refundOrder for an on_account payment: shiftId null and refundDrawerOf's cash rule skipped; **call
  - **Till clearing contra 1115 (pos/service.ts):** BASE_MONEY_ACCOUNTS += ACCT.TILL_CLEARING; ~3092 match `code IN TILL_CLEARING_CODES` (1115 +
  - **Z-report:** getZReport gains onAccountSales / onAccountCount / onAccountByClient (inside totalSales).
  - **orderPosting.ts (OA, W3 part):** buildSaleLines on_account block after Raast and before the 1030 rest: Σ paid on_account rows capped at `left` →
  - **shiftPosting.ts (OA, W3 part):** ShiftSales.onAccount { cents, byAccount }; in summariseShiftSales' home-drawer loop `else if (p.method ===
  - **accounting/tillClearing.ts + workers/tillClearingSweep.ts (critic — one-time cut-over, then reversals only):**
  - **Tax (pos/service.ts):** TenderPricedOrder Pick + 'deliveryFeeCents'; tenderPriceOf passes it; repriceForTenderTx writes deliveryFeeTaxCents; the
  - **Raast "void, never booked" (pos/service.ts):** refundDueOf, the Z-report's cancelledPaid and the till's hand-back options exclude payments whose
  - **"Box given" (packaging rule, FINAL owner rule):** pos/boxGivenRoutes.ts (a plugin wave Z registers at '/pos'; /pos is ungated):
  - **Delivery — COD the rider owes (pos/service.ts settlePayment):** select codRiderDebtEntryId / codRiderDebtTransferId; own-rider debt: call

**Consumes**

- w0: ON_ACCOUNT_TENDER / REFUND_TENDERS (lib/tenders.ts), ACCT.TILL_CLEARING / CUSTOMER_AR / DELIVERY_FEE_REVENUE, TILL_CLEARING_CODES, ON_ACCOUNT_MEMO,
  lib/onAccountCard.ts (normalizeCardCode, hashCardCode), Payment cod columns, Order fee columns.
- w2-oa-recv: CHARGE_ERRORS, lockAccountTx, exposureOfTx, assertChargeableTx, recordChargeTx, applyChargeRefundTx, flagRevokedCardUse.
- w1-taxsales: fiscal payload buyer = the client (customerAccountCharge read), paymentLabelOf. w1-recon: RaastReceipt 'voided'. w2-dlv-cod:
  reverseCodRiderDebtTx / reverseCodRiderDebtAfterCommit. w2-ledger: orderPosting/shiftPosting COGS + 4110 (keep).


**Exposes**

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


**Tests — run on `servd_test_wb_w3_till`, Redis index 18**

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



## w3-stockdocs — Counts (spot + opening), waste, prep batches, transfers and item edits on FIFO lots; shortfall flags

Area: foodcost (stock documents: counts, waste, prep, transfers, item edits) · Test DB **`servd_test_wb_w3_stockdocs`** · Redis **`redis://127.0.0.1:6390/19`** (index 19) — yours alone · brief: `briefs/w3-stockdocs.md`

crosschecks/routes.ts + countPosting.ts, inventory/routes.ts, stockTransfers/routes.ts, workers/shrinkageTrend.ts.

**Owned files**

- `backend/src/modules/crosschecks/routes.ts`
- `backend/src/modules/crosschecks/countPosting.ts (becomes a re-export)`
- `backend/src/modules/inventory/routes.ts`
- `backend/src/modules/stockTransfers/routes.ts`
- `backend/src/workers/shrinkageTrend.ts`
- `backend/tests/spotCounts.test.ts (new)`
- `backend/tests/openingCounts.test.ts (new)`
- `backend/tests/wasteFifo.test.ts (new)`
- `backend/tests/prepBatchFifo.test.ts (new)`
- `backend/tests/stockTransferReceive.test.ts (new)`
- `backend/tests/wasteAnalyticsScope.test.ts (new)`
- `backend/tests/itemCategoryReclass.test.ts (new)`
- `backend/tests/auditKitchen.test.ts`
- `backend/tests/resimKitchen.test.ts`
- `backend/tests/stockCounts.test.ts`
- `backend/tests/sepTrustops.test.ts (stock cases only)`
- `backend/tests/receiving.test.ts (W3: /crosschecks/receiving + locationId; w2-ap had it in W2) — adjust only what FIFO changes; postingFailures (w3-till) and wave3Kitchen / wave3Gates (w3-fc-report) also exercise these routes but belong to those agents this wave: send patch notes`

**Tasks (outline — full text in the brief)**

  - **crosschecks/routes.ts:**
  - POST /crosschecks/receiving: body gains `locationId?` and passes it to receiveGoods (w2-ap validates it: 422 LOCATION_NOT_IN_COMPANY).
  - **Counts** POST /crosschecks/physical-counts { kind: 'spot'|'opening' = 'spot', locationId?, lines [{ inventoryItemId, physicalQty, reason?,
  - GET /crosschecks/physical-counts?kind&from&to (now with lines, values and ledger status); GET /crosschecks/physical-counts/:id (404 foreign);
  - **Prep batches** POST /crosschecks/prep-batches + `locationId?`: a sub-recipe batch stays a yield record only (sale-time explosion already
  - **crosschecks/countPosting.ts:** becomes `export { postStockCount } from '../accounting/inventoryPosting.js'` (+ any type it exported) so existing
  - **inventory/routes.ts:**
  - POST /inventory/:id/waste { quantity, unit, reason, photoUrl?, notes?, conceptId?, locationId? }: brand through `assertConceptOwned(req, id,
  - POST/PATCH /inventory: `category` is `z.enum(INVENTORY_CATEGORIES)` (400 otherwise); a class-crossing change on an item with stock posts
  - **Company-less items (critic):** every stock write refuses an item with no company (422 ITEM_HAS_NO_COMPANY — enforced in stockLedger; surface
  - GET /inventory/waste-analytics: view-aware company scope (empty scope denies), company-less items excluded, costs hidden for floor roles.
  - GET /inventory list/detail: `unitCostCents` is the FIFO head (w1-stock keeps it fresh); add `onHandValueCents` (Σ open lot value) for
  - **stockTransfers/routes.ts** PATCH /:id/receive { receivedQuantity, shortfallReason? }: 422 OVER_RECEIVED (above sent); a shortfall needs a reason
  - **workers/shrinkageTrend.ts:** per company (existing loop), a nightly 'stock_shortfall' flag per item from Σ shortfallQty of its sale movements in

**Consumes**

- w1-stock: lockItemsTx, addLotTx, consumeFifoTx, latestPurchaseCostCents, ensureFifoReady; inventoryPosting postStockCount / postPrepDraw /
  postWasteLog / postItemReclassTx. w2-ap: receiveGoods(locationId). w0: lib/inventoryClass.ts, lib/savepoint.ts, PhysicalCount/PrepBatch/WasteLog
  columns, exception kinds stock_shortfall / stock_unrecorded.


**Exposes**

```ts
// crosschecks/countPosting.ts
export { postStockCount } from '../accounting/inventoryPosting.js'
// routes (wave Z: no new registration — same plugins)
// POST /crosschecks/physical-counts → 201 { count, lines, ledger: { posted: boolean; entryId?: string; error?: string } }
// GET  /crosschecks/physical-counts/suggested?n&locationId → { items: Array<{ id, name, unit, onHandQty, onHandValueCents?: number }> }
```


**Tests — run on `servd_test_wb_w3_stockdocs`, Redis index 19**

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



## w3-recipes — Recipe Packaging section on every dish (used by order type / brand vessel / Box given), brand service vessel, modifier recipes, costing on real packaging

Area: foodcost (recipes: packaging on every dish, modifier recipes, costing) · Test DB **`servd_test_wb_w3_recipes`** · Redis **`redis://127.0.0.1:6390/20`** (index 20) — yours alone · brief: `briefs/w3-recipes.md`

recipes/routes.ts (+ par-sheet if it assumes every line is food), recipe admin pages, KitchenRecipe, modifiers page.

**Owned files**

- `backend/src/modules/recipes/routes.ts`
- `backend/src/modules/recipes/README.md`
- `backend/src/modules/par-sheet/routes.ts (only if packaging lines break it)`
- `frontend/admin/src/app/accounting/recipes/RecipeForm.tsx`
- `frontend/admin/src/app/accounting/recipes/page.tsx`
- `frontend/admin/src/app/accounting/recipes/[id]/page.tsx`
- `frontend/admin/src/app/accounting/recipes/KitchenRecipe.tsx`
- `frontend/admin/src/app/configuration/modifiers/page.tsx`
- `backend/src/modules/concepts/routes.ts (W3: serviceVessel on create / PATCH only)`
- `backend/src/modules/concepts/README.md`
- `backend/src/modules/tenants/routes.ts (W3: serviceVessel on the company-create first brand only)`
- `backend/tests/recipePackaging.test.ts (new)`
- `backend/tests/modifierRecipes.test.ts (new)`
- `backend/tests/serviceVessel.test.ts (new)`
- existing recipe suites (grep tests/ for "'/recipes" — except wave3Kitchen / wave3Gates, which are w3-fc-report's: send a patch note)

**Tasks (outline — full text in the brief)**

  - **THE packaging rule (FINAL owner rule — see the common brief):** every PLATE recipe ALWAYS has an optional Packaging section (all brands).
  - **recipes/routes.ts:**
  - DELETE the GET /recipes/food-cost handler (~1356-1495) and the imports only it used — the path now answers 404 (the report lives at
  - ingredientSchema gains `section: z.enum(['ingredients','packaging']).default('ingredients')`. Validation (one helper used by create, update,
  - recipeShape: `packagingPct` dropped from input (ignored if sent, never written — the column is retired); `qFactorPct` unchanged; `modifierId?`.
  - **Packaging warning (not a block):** a plate recipe of a brand whose serviceVessel is 'packaging' with no packaging line returns a
  - **Modifier recipes** (RecipeKind 'modifier', w0 enum): `kind: 'modifier'` + `modifierId`, no menuItemId, no packaging; one recipe per modifier
  - **Costing** (GET /:id/costing ~711-900, POST /costing-preview ~598, GET /by-item/:menuItemId ~903 — critic): read the w2-sale `RecipeCost`:
  - **Brand service vessel (concepts/routes.ts + tenants/routes.ts, W3 parts only):** POST /concepts requires `serviceVessel: z.enum(['plate',
  - par-sheet/routes.ts: if it explodes recipes into prep quantities, skip packaging-section lines (packaging is not prepped). Touch nothing else.
  - recipes/README.md: the packaging rule, sections, modifier recipes, costing fields.
  - **Admin:** RecipeForm.tsx — a Packaging section on every plate recipe (item picker limited to packaging-class items; NO per-line order-type

**Consumes**

- w2-sale: lib/recipeCost.ts (RecipeCost.stockByClass / packagingCents / standardCents / qCents, packagingApplies). w0: RecipeIngredient.section,
  Recipe.modifierId, RecipeKind 'modifier', lib/inventoryClass.ts costClassOf.


**Exposes**

```ts
// GET /recipes/:id/costing (and POST /recipes/costing-preview) response additions
{ stockByClass: { food: number; beverage: number; packaging: number }; packagingCents: number; standardCents: number; qCents: number;
  targetMcCents: { dine_in: number; takeout: number; delivery: number };
  warnings: { outsideCompany: Array<{ lineId: string; itemName: string }>; costedWhileUnapproved: boolean; noPackaging: boolean } }
// recipe error codes: PACKAGING_SECTION_ONLY, NOT_PACKAGING, PACKAGING_ON_PLATES_ONLY, ITEM_NOT_IN_COMPANY,
//   ITEM_HAS_NO_COMPANY, MODIFIER_HAS_RECIPE, MODIFIER_NOT_IN_COMPANY, NEGATIVE_QTY_NOT_ALLOWED
```


**Tests — run on `servd_test_wb_w3_recipes`, Redis index 20**

`recipePackaging` (two companies): packaging item in ingredients → 422; non-packaging item in packaging → 422; packaging on a sub-recipe → 422; approve a
a Stackd (vessel 'packaging') recipe with no packaging → saved with warning PACKAGING_MISSING, a Simmer (plate) one → no warning; costing:
target MC dine-in = plate MC for Simmer, = plate MC + packaging for Stackd; target MC takeaway/delivery = plate MC + packaging for both; qCents reported apart and never inside standardCents;
packagingPct sent → ignored; GET /recipes/food-cost → 404; A's recipe with B's packaging item → 422 ITEM_NOT_IN_COMPANY; B → 404 on A's recipe;
warnings noPackaging / outsideCompany / costedWhileUnapproved. `modifierRecipes`: create for own modifier; B's modifier → 404; cross-company attach → 422
MODIFIER_NOT_IN_COMPANY; second recipe → 409; negative qty only on modifier recipes; costing-preview and by-item include sections.
`serviceVessel` (two companies): POST /concepts without serviceVessel → 400, with 'packaging' → stored; company create without it for the first brand
→ 400; PATCH by B on A's brand → 404; PATCH writes the audit with from/to; an order line rung up before the change keeps its snapshot.



## w3-fc-report — ONE food-cost variance report (actual vs recipe at the price paid, food / drinks / packaging), API, scheduled email, admin pages

Area: foodcost (the variance report, its API, email, hub gauge, management KPI) · Test DB **`servd_test_wb_w3_fc_report`** · Redis **`redis://127.0.0.1:6390/21`** (index 21) — yours alone · brief: `briefs/w3-fc-report.md`

reports/foodCost.ts + foodCostRoutes.ts, workers/scheduledReports.ts, management/routes.ts (foodCostPct), /reports/food-cost admin, hub gauge, menu-engineering page.

**Owned files**

- `backend/src/modules/reports/foodCost.ts (new)`
- `backend/src/modules/reports/foodCostRoutes.ts (new)`
- `backend/src/workers/scheduledReports.ts`
- `backend/src/modules/management/routes.ts (W3: foodCostPct only)`
- `frontend/admin/src/app/reports/food-cost/page.tsx (new)`
- `frontend/admin/src/app/reports/food-cost/components/* (new)`
- `frontend/admin/src/app/reports/page.tsx`
- `frontend/admin/src/app/menu-engineering/[id]/page.tsx`
- `frontend/admin/src/app/accounting/food-cost/page.tsx (DELETE) + any README in that folder (delete or repoint)`
- `frontend/admin/src/app/accounting/page.tsx (W3: the food-cost gauge only)`
- `backend/tests/foodCostReport.test.ts (new)`
- `backend/tests/foodCostAccess.test.ts (new)`
- `backend/tests/scheduledFoodCost.test.ts (new)`
- `backend/tests/wave3Kitchen.test.ts`
- `backend/tests/wave3Gates.test.ts`
- management suites asserting foodCostPct (grep tests/ for foodCostPct)

**Tasks (outline — full text in the brief)**

  - **reports/foodCost.ts — the ONE engine (no second copy anywhere; the old GET /recipes/food-cost is deleted by w3-recipes):** foodCostSummary,
  - **Revenue (the denominator):** import `brandSalesRevenueCents` and `costOfSalesSplit` from accounting/reports.ts (w2-close defined them in W2 —
  - **Theoretical** = per sold line, the recipe's food + drinks plus its PACKAGING when `packagingApplies(order, line)` (w2-sale — THE seam: takeaway /
  - **Explained buckets:** comps, staff meals, waste by reason (spoilage, over_prep, expired, damaged, other, void_after_fire, cancelled_after_fire,
  - Brand view: measured rows plus usage-allocated rows (brandShares stored on the movements), labelled 'allocated'.
  - Warnings: items with no recipe, null-cost lots, sub-recipes without a yield, unapproved recipes on live items, modifiers sold with no recipe,
  - Status never green with missing data: 'no_data' | 'incomplete' | 'good' | 'warning' | 'critical'; the target % comes from the brand / company
  - Raw SQL casts sums `::bigint` then `toCents`; never `SELECT *` of a widened table.
  - `inventoryCloseChecks: CloseCheck[]` (warn, overridable — NO stocktake requirement): 'grni_stale' (receipt lines unbilled > 30 days: count,
  - **reports/foodCostRoutes.ts** (wave Z registers at '/reports/food-cost' BEFORE reportRoutes; w0 added the gate rule) — requireAuth(...FINANCE_TEAM),
  - **workers/scheduledReports.ts:** 'food_cost' → buildFoodCostEmail for the schedule's OWN company (period since lastRunAt, else the previous 7 PKT days;
  - **management/routes.ts (~92, ~107):** foodCostPct split into foodPct / drinksPct / packagingPct + costOfSalesPct on the brand-sales denominator, computed
  - **Admin:** /reports/food-cost — tabs Summary | Ingredients | Valuation | Flags; Summary: food revenue*, theoretical %*, actual %*, AvT points*, a

**Consumes**

- w1-stock: StockMovement / StockLot data, lotValuation, postFifoAlign, brandShare. w2-ap: readCutover (pre-FIFO difference, cut-over date).
  w2-sale: RecipeCost (standardCents = plate MC, packagingCents, targetMcCents per order type) + packagingApplies. w2-close: brandSalesRevenueCents + costOfSalesSplit (accounting/reports.ts — the ONE
  denominator and class split). w0: closeCheckTypes, the '/reports/food-cost' gate, module food_cost + MODULE_GRANTS.


**Exposes**

```ts
// reports/foodCost.ts
export function foodCostSummary(db: Db, a: { tenantIds: string[]; from: Date; to: Date; conceptId?: string; locationId?: string; revenueVisible: boolean }): Promise<FoodCostCompanyBlock[]>
// (brandSalesRevenueCents / costOfSalesSplit live in accounting/reports.ts — w2-close; import them, do not re-export a copy)
export const inventoryCloseChecks: CloseCheck[]
export function buildFoodCostEmail(db: Db, schedule: ScheduledReport): Promise<{ subject: string; html: string }>
// reports/foodCostRoutes.ts
export default async function foodCostRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/reports/food-cost' BEFORE reportRoutes
```


**Tests — run on `servd_test_wb_w3_fc_report`, Redis index 21**

`foodCostAccess`: every /reports/food-cost route — B → 404 on A's conceptId / inventoryItemId / tenantId; the portfolio view returns separate company
blocks; empty scope denied; foh_management 403 (no food_cost); boh_management 200 with revenueHidden and no revenue fields; finance and fnb_manager
200 with revenue; a CEO untick → 403; an 'accounting'-only role can GET the summary but cannot POST align; align is ADMIN_ONLY. `foodCostReport`:
identity theoretical + explained + unexplained + alignment == ledger cost-of-sales group per brand (open orders and shifts shown as timing); a
refunded order stays in theoretical; service charge, delivery fee and 4200 excluded from revenue; packaging counted for a Simmer takeaway / delivery
order, a Stackd dine-in order and a Simmer dine-in line marked Box given, NOT for a plain Simmer dine-in order; MC split by order type; an order at
23:30 PKT falls on the right day; zero revenue → 'no_data'; a null-cost lot → 'incomplete'; valuation ties to the GL when everything is posted;
inventoryCloseChecks warn on a stale GRNI line. `scheduledFoodCost`: emails only its own company; a NULL-company schedule → 'failed: no company';
an unknown type → 'failed…'. wave3Kitchen / wave3Gates updated to the new path, gate row and MODULE_GRANTS; management suites to the split fields.



## w3-dlv-return — Emergency overrides module: send the hand-over code to the rider, log food a rider brought back as waste, strikes on refusal

Area: delivery (Emergency overrides: code to the rider, food came back) · Test DB **`servd_test_wb_w3_dlv_return`** · Redis **`redis://127.0.0.1:6390/22`** (index 22) — yours alone · brief: `briefs/w3-dlv-return.md`

orders/returnedFood.ts, orders/routes.ts (removals + message), emergencyOverrides/{routes,service,README}, admin /emergency-overrides page.

**Owned files**

- `backend/src/modules/orders/returnedFood.ts (new)`
- `backend/src/modules/orders/routes.ts`
- `backend/src/modules/emergencyOverrides/routes.ts (new)`
- `backend/src/modules/emergencyOverrides/service.ts (new)`
- `backend/src/modules/emergencyOverrides/README.md (new)`
- `frontend/admin/src/app/emergency-overrides/page.tsx (new)`
- `backend/tests/emergencyOverrides.test.ts (new)`
- `backend/tests/foodReturned.test.ts (new)`
- `backend/tests/managerVoids.test.ts (W3: rewrite the refused-at-door cases to cancel/void)`
- `backend/tests/integrationPass1.test.ts (W3: refused-at-door cases only)`
- `backend/tests/cashControls.test.ts (W3: delete the cod-unpaid section; point to codRiderDebt.test.ts)`

**Tasks (outline — full text in the brief)**

  - **Owner rule:** a delivery completes ONLY with the customer's code (no staff "Delivered" — w1-dlv-core removed it). When the customer can't give the
  - **orders/returnedFood.ts** `returnUndeliveredOrder(orderId, { actor: { id, email, tenantId, role }, cause: 'refused'|'unreachable'|'other', reason })`:
  - Load + validate: a delivery order (422 NOT_A_DELIVERY); not delivered (409 ALREADY_DELIVERED); not completed (409 ORDER_COMPLETED_USE_REFUND);
  - `cancelOrder(orderId, { reason: 'Returned by rider — <cause>: <reason>', actor, approverId: actor.id, action: 'order.returned_by_rider',
  - After commit: the 'returned' RiderJobEvent through `recordJobEvent` (serviceClient, OUTSIDE the RLS transaction — a fleet rider belongs to another
  - **orders/routes.ts:** remove POST /:id/cod-unpaid (~325) and POST /:id/refused-at-door (~390) (paths 404); COMPLETE_ON_DELIVERY message → 'A delivery
  - **emergencyOverrides/service.ts + routes.ts** (wave Z registers at '/emergency-overrides'): guard requireAuth(...MANAGERS) + the module gate; scope
  - GET /emergency-overrides/orders → { onTheRoad: [{ orderId, ref (orderRefOf), brand, customerName, stage, rider { id, name, fleetPartner },
  - POST /orders/:id/send-code-to-rider { reason 10-300 } → `rerouteHandoverCode` (w1-dlv-core) → { ok, sentToRider, riderPhoneHint } (its 409/422
  - POST /orders/:id/send-code-to-rider/resend {} → `resendReroutedCode` (409 NOT_REROUTED / ALREADY_DELIVERED; rate limit 3 per 10 min per order).
  - POST /orders/:id/food-returned { cause, reason 5-500 } → returnUndeliveredOrder → { ok, wasteCostCents, wasteLogIds, codVoidedCents, refundDueCents,
  - README: the contract, roles, what each action books, the owner questions still open (Q1 RGM login, Q5 prepaid returned food).
  - **Admin page /emergency-overrides** (polls every 8 s): table of orders on the road; 'Send code to rider' dialog (reason required; 'one per order;

**Consumes**

- w2-sale: cancelOrder `returned` hook, wasteSoldLineTx, RETURN_WASTE_REASON. w1-dlv-core: rerouteHandoverCode, resendReroutedCode, recordJobEvent.
  w1-bans: recordStrike(tenantId). w0: Order.returnedAt/returnCause, module emergency_overrides + gate, exception kinds food_returned / delivery_code_rerouted.


**Exposes**

```ts
// orders/returnedFood.ts
export function returnUndeliveredOrder(orderId: string, a: { actor: { id: string; email: string; tenantId: string | null; role: string };
  cause: 'refused'|'unreachable'|'other'; reason: string }): Promise<{ ok: true; wasteCostCents: number; wasteLogIds: string[]; codVoidedCents: number;
  refundDueCents: number; strike: { recorded: boolean; duplicate: boolean } | null }>
// emergencyOverrides/routes.ts
export default async function emergencyOverridesRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/emergency-overrides'
```


**Tests — run on `servd_test_wb_w3_dlv_return`, Redis index 22**

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



## w3-cash-requests — Cash requests: anyone raises → HOD → director → custodian pays (advance on 1355) → holder's receipts book it; overdue → loan/director (H3)

Area: cash (cash requests replace vouchers; receipts book the expense; stock + capex lines) · Test DB **`servd_test_wb_w3_cash_requests`** · Redis **`redis://127.0.0.1:6390/23`** (index 23) — yours alone · brief: `briefs/w3-cash-requests.md`

trustops/cashVouchers.ts rework, trustops/cashRequestSettle.ts, pettyCash.ts + pettyCashPosting.ts (W3: stock + capex lines, settlement/conversion posters), cashAdvanceOverdue worker, cash-requests admin pages.

**Owned files**

- `backend/src/modules/trustops/cashVouchers.ts`
- `backend/src/modules/trustops/cashRequestSettle.ts (new)`
- `backend/src/modules/trustops/pettyCash.ts (W3: stock + capex line kinds)`
- `backend/src/modules/accounting/pettyCashPosting.ts (W3: stock/capex lines, settlement + conversion posters)`
- `backend/src/workers/cashAdvanceOverdue.ts (new)`
- `frontend/admin/src/app/finance/cash-vouchers/** (page.tsx, [id]/page.tsx, VoucherDetail.tsx, VoucherForm.tsx, VoucherPrint.tsx, data.ts, photo.ts, ui.tsx, SettlePanel.tsx (new), ConvertPanel.tsx (new))`
- `frontend/admin/src/components/finance/SpendLinesEditor.tsx (W3: stock + capex line kinds)`
- `frontend/admin/src/components/finance/ReceiptUploader.tsx (W3, if needed)`
- `backend/tests/cashVouchers.test.ts (rewritten for cash requests)`
- `backend/tests/cashRequestSettle.test.ts (new)`
- `backend/tests/cashAdvanceOverdue.test.ts (new)`
- `backend/tests/pettyCashStockCapexLines.test.ts (new)`

**Tasks (outline — full text in the brief)**

  - **Flow (owner, replaces the voucher flow):** anyone raises → HOD signs → director (the CEO, role admin) approves → Jamil sb (the box custodian) PAYS
  - **trustops/cashVouchers.ts (rework; header rewritten):**
  - Raise: requireAuth(ALL_STAFF), binds to activeTenantId; { amountCents (zInt4Cents > 0), purpose, voucherDate?, conceptId?, department?,
  - List/read scoping: keepers (CASH_KEEPERS) everything in read scope; others only rows they raised, hold, may sign as HOD, or approved-or-later on a box
  - **HOD (critic — HR's rule, no second hierarchy):** sign-hod allowed for a cash keeper OR the holder's direct manager login
  - approve: ADMIN_ONLY, 409 SAME_SIGNER kept (the director is never the HOD signer); reject from draft (HOD-eligible) or hod_signed (CEO) with a
  - **POST /:id/pay { boxId? }** (replaces /disburse): the custodian of the box or a keeper (only a keeper may change a box already set; default = the
  - Remove POST /:id/photo and /:id/disburse; add GET /:id/attachments/:aid (sendEvidence; legacy 'signed_voucher' photos still readable).
  - Legacy disbursed rows with no holder (payeeUserId null): shown as 'needs review' — keepers only, never flagged against preparedById, never converted
  - **trustops/cashRequestSettle.ts (child routes of cash-vouchers):** POST /:id/receipts { photo, mime } (holder or keeper; status disbursed; ≤ 20 per
  - **stock lines → `recordCashPurchaseStockTx(tx, { settledBy: { kind: 'cash_voucher_settlement', id, creditAccountCode: '1355' }, … })`, capex lines
  - **pettyCash.ts + pettyCashPosting.ts (W3 additions to w2-cash-ledger's files):** line kinds 'stock' and 'capex' now work for BOTH a direct box spend
  - **workers/cashAdvanceOverdue.ts (H3 — the worker auto-converts):** daily 09:10 PKT, loop over companies that HAVE overdue requests (not only
  - **Admin (/finance/cash-vouchers/** + shared editors):** relabel to 'Cash requests'; '+ Request cash' for every login; views My requests / Waiting for

**Consumes**

- w2-cash-ledger: recordPettyCashSpendTx / recordPettyCashTopupTx, resolveSpendLinesTx, postPettyCashMovementTx, FUNDING_ACCOUNT, GET boxes?mine=1,
  SpendLinesEditor / ReceiptUploader / lib/photoPrep. w2-ap: recordCashPurchaseStockTx. w2-fa-capex: recordCapexPaymentFromCashTx.
  w1-hr: directManagerUserIdOf, teamUserIdsUnder, createLoanFromCashAdvanceTx. w1-fa-engine: assertNotEquipmentLine. w0: lib/evidenceFile.ts,
  CashVoucher / Settlement / SpendLine schema, ACCT.CASH_ADVANCES / DIRECTOR_CURRENT / STAFF_LOANS / PETTY_CASH, OperationsConfig.cashAdvanceSettleDays.


**Exposes**

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


**Tests — run on `servd_test_wb_w3_cash_requests`, Redis index 23**

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



## w3-fa-api — Fixed-asset API: register, requests (finance asks, CEO approves), pools and counts, classes/policy, reports incl. tax; the depreciation worker

Area: assets (API, reports, automatic monthly worker) · Test DB **`servd_test_wb_w3_fa_api`** · Redis **`redis://127.0.0.1:6390/24`** (index 24) — yours alone · brief: `briefs/w3-fa-api.md`

fixedAssets/routes.ts + requests.ts + pools.routes.ts + reports.ts + README, workers/depreciation.ts; removes the deprecated aliases and the hand-add route.

**Owned files**

- `backend/src/modules/fixedAssets/routes.ts`
- `backend/src/modules/fixedAssets/requests.ts (new, registered inside routes.ts)`
- `backend/src/modules/fixedAssets/pools.routes.ts (new, registered inside routes.ts)`
- `backend/src/modules/fixedAssets/reports.ts (new)`
- `backend/src/modules/fixedAssets/README.md (new)`
- `backend/src/modules/fixedAssets/service.ts (W3: delete the deprecated runDepreciation / ASSET_CATEGORIES aliases only)`
- `backend/src/workers/depreciation.ts (new)`
- `backend/.sim/books/fin403.ts`
- `backend/.sim/ui-r2/verify/zzverify_ui_3.test.ts`
- `backend/tests/fixedAssetsCompany.test.ts (new)`
- `backend/tests/fixedAssetsReports.test.ts (new)`
- `backend/tests/fixedAssetsRls.test.ts (new)`
- `backend/tests/fixedAssetsRun.test.ts (W3: worker cases)`
- `backend/tests/wave3Finance.test.ts (W3: fixed-asset cases)`
- `backend/tests/sepFinance.test.ts (W3: fixed-asset cases)`

**Tasks (outline — full text in the brief)**

  - **Owner rules:** depreciation is AUTOMATIC monthly (no switch); no threshold; smallwares pooled per outlet/type (24 months), big items individual;
  - **Routes** (all under '/accounting/fixed-assets', the existing plugin; module gate 'accounting' — do NOT add gate rules or ModulePage.roles — critic).
  - GET / (READERS, read scope; asOf, status, classKey, conceptId, locationId, poolId, kind, format=csv): rows with tenantId, companyName, cost,
  - POST / → 422 USE_CAPEX ('Equipment goes on the register only through CapEx (Finance → Project tracker or Quick buy)') — handler removed.
  - POST /depreciate { throughPeriod 'YYYY-MM' } (FA_WRITERS; 'charge now / catch up' for the ACTIVE company): chargeThrough → which company it charged;
  - **Requests (requests.ts):** POST /:id/requests { kind: disposal|impairment|change_estimate|void|undispose|transfer, effectiveDate, reason ≥ 10, payload }
  - **Pools (pools.routes.ts):** GET /pools?locationId&conceptId&typeKey (units on hand, layers, NBV, last count); POST /pools/:poolId/requests { kind:
  - Classes / policy: GET /classes (READERS); PATCH /classes/:id (APPROVER; label, defaultLifeMonths, taxRateBp, taxInitialAllowanceBp, pooled, isActive
  - **Reports (reports.ts):** /reports/schedule?from&to&groupBy=class|brand|location|pool|asset, /reports/roll-forward?from&to, /reports/nbv?asOf&groupBy,
  - **workers/depreciation.ts:** `startDepreciationWorker()` — node-cron '20 3 * * *' Asia/Karachi, in-process running guard, serviceClient;
  - **Clean-up:** delete the deprecated `runDepreciation` / `ASSET_CATEGORIES` aliases w1-fa-engine kept (grep: no importer may remain — financePlanning

**Consumes**

- w1-fa-engine: classes / schedule / service / events / pools / tax / closeCheck exports. w2-fa-capex: releasePrepaidThrough, assertSupplierOfCompany,
  capex lookups. w0: ledgerBalancesByCode asOf, FixedAsset* schema, taxYearOf.


**Exposes**

```ts
// workers/depreciation.ts
export function startDepreciationWorker(): void
export function runDepreciationOnce(now?: Date): Promise<Array<{ tenantId: string; charged: number; failed: number }>>
// fixedAssets/reports.ts
export function fixedAssetTieOut(db: Db, tenantIds: string[], asOf?: Date): Promise<Array<{ tenantId: string; byClass: Array<{ classKey: string; costDiffCents: number; accumDiffCents: number }>; legacy1590Cents: number; ok: boolean }>>
// (wave Z /health: fixedAssets = fixedAssetTieOut + the last FixedAssetRun per company)
```


**Tests — run on `servd_test_wb_w3_fa_api`, Redis index 24**

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



## w3-admin-finance — Admin finance pages: sales-tax return (H8-H13 rows, withholding rates/register), card payouts, COD tab, petty-cash history backfill, OpEx tax/WHT, gift-card breakage, settings

Area: admin UI — tax, reconciliation (card payouts, COD, backfill), operations config, OpEx, gift cards, delivery zones · UI agent — no database, no tests to run · brief: `briefs/w3-admin-finance.md`

UI only — reconciliation page + tabs, sales-tax-return pages, OpEx page, gift cards, delivery zones, operations config.

**Owned files**

- `frontend/admin/src/app/reconciliation/page.tsx`
- `frontend/admin/src/app/reconciliation/CardPayouts.tsx (new)`
- `frontend/admin/src/app/reconciliation/CodTab.tsx (new)`
- `frontend/admin/src/app/reconciliation/BackfillUnposted.tsx`
- `frontend/admin/src/app/reconciliation/README.md`
- `frontend/admin/src/app/reconciliation/MissedBillVariances.tsx (DELETE)`
- `frontend/admin/src/app/accounting/sales-tax-return/page.tsx`
- `frontend/admin/src/app/accounting/sales-tax-return/README.md`
- `frontend/admin/src/app/accounting/sales-tax-return/WithholdingRates.tsx (new)`
- `frontend/admin/src/app/accounting/sales-tax-return/WithholdingRegister.tsx (new)`
- `frontend/admin/src/app/finance/opex/page.tsx`
- `frontend/admin/src/app/gift-cards/page.tsx`
- `frontend/admin/src/app/configuration/delivery-zones/page.tsx`
- `frontend/admin/src/app/configuration/operations/page.tsx`

**Tasks (outline — full text in the brief)**

  - 1. **Sales tax return page:** new rows Delivery charges, No-show deposits kept, per authority 'Withheld by customers (1335)' and 'Net after withholding';
  - 2. **Reconciliation:** CardPayouts.tsx — settings card (payout bank via BankAccountSelect, MDR %, tax on fee %, lag days, tolerance, unit), settlements
  - 3. **OpEx page:** line form — Vendor picker (GET /procurement/suppliers?view=picker&categoryId=…, 'Add in Procurement' link when canOpenPath), WHT
  - 4. **Gift cards:** the void dialog offers 'Keep the money (breakage — other income, no sales tax)' for sold cards to admin only (the API decides —
  - 5. **Delivery zones:** fee label 'Fee (before GST)' + helper 'GST is added at checkout at the brand's rate: 15 % cash, 8 % card or Raast'.
  - 6. **Operations config:** the withholding % input becomes a link to Accounting → Sales tax return → Withholding rates (the on/off switch stays);

**Consumes**

- w1-taxcore withholding routes; w1-recon card payout routes; w2-dlv-cod codRoutes; w2-cash-ledger backfill route; w2-taxbooks OpEx routes + wht-quote;
  w1-taxsales gift-card routes; w1-taxcore (W1) already dropped withholdingTaxPct from PATCH /setup/operations-config and added cashAdvanceSettleDays
  (1-365) — the page must not send withholdingTaxPct.


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. Run `npx tsc --noEmit -p .` in frontend/admin and make your files clean. Manual checklist for the orchestrator's screenshots: the
return page with the new rows as finance; withholding rates read-only for management; card payout confirm flow; COD tab as finance; petty-cash
history dry run as the CEO; OpEx mark-paid with WHT quote; gift-card breakage option visible only to the CEO; phone width without horizontal scroll.



## Gate after W3

Run the gate steps above (section 'Gates between waves'), with the personal-review list 'after W3'; then launch the next wave in ONE message.


---

# W4 — 8 agents in parallel

| id | area | DB | Redis |
|---|---|---|---|
| w4-integration | all areas — cross-cutting backend glue | `servd_test_wb_w4_integration` | 6390/26 |
| w4-admin-fa | admin UI — fixed assets, CapEx, Investment | — (ui) | — |
| w4-admin-stock | admin UI — stock documents, procurement bills, GRNI | — (ui) | — |
| w4-admin-delivery | admin UI — dispatch, riders, complaints/appeals, COD pay-in | — (ui) | — |
| w4-apps | tablet + rider apps (Expo + web rider) | — (ui) | — |
| w4-customer | customer surfaces — storefront, mobile, tablet receipt | — (ui) | — |
| w4-admin-oa | admin UI — on-account at the till, clients, statements, write-offs, order page | — (ui) | — |
| w4-docs | all areas — runbooks and READMEs | — (docs) | — |


## w4-integration — Approvals inbox providers, REPOSTERS for every new posting, company-merge for every new table, chart/setup guards

Area: all areas — cross-cutting backend glue · Test DB **`servd_test_wb_w4_integration`** · Redis **`redis://127.0.0.1:6390/26`** (index 26) — yours alone · brief: `briefs/w4-integration.md`

approvals/providers.ts + README + approvalsInbox test, reconciliation/backfillOrders.ts REPOSTERS + sweeps, tenants/routes.ts merge, setup/routes.ts guards.

**Owned files**

- `backend/src/modules/approvals/providers.ts`
- `backend/src/modules/approvals/README.md`
- `backend/tests/approvalsInbox.test.ts`
- `backend/src/modules/reconciliation/backfillOrders.ts`
- `backend/src/modules/tenants/routes.ts (W4: merge only)`
- `backend/src/modules/setup/routes.ts (W4: chart-of-accounts guards only — w1-taxcore changed PATCH /setup/operations-config in W1)`
- `backend/src/modules/accounting/supplierPosting.ts (W4: drop the postWasteLog re-export once no importer remains — nothing else)`
- `backend/src/modules/crosschecks/countPosting.ts (W4: delete when no importer remains)`
- `backend/tests/repostersWaveB.test.ts (new)`
- `backend/tests/tenantMergeWaveB.test.ts (new)`
- `backend/tests/fixedAssetsMerge.test.ts (new)`
- `backend/tests/setupChartGuards.test.ts (new)`
- existing suites covering these files (grep tests/ for 'REPOSTERS', 'backfill-unposted', '/tenants/merge' or the merge route, '/setup/chart-of-accounts', '/setup/operations-config', '/approvals')

**Tasks (outline — full text in the brief)**

  - **approvals/providers.ts (+ README rows; one inbox — every button calls the module's EXISTING route, whose own guard decides; never a second engine):**
  - fixed_asset_request — module accounting, ADMIN_ONLY, reads GET /accounting/fixed-assets/requests?status=pending, approve/reject → that module's
  - intercompany_transfer — accounting, ADMIN_ONLY; disabledReason when the CEO is not a member of BOTH companies.
  - on_account_client — accounting, ADMIN_ONLY, GET /accounting/customer-accounts?pending=1 (new clients and requested limit increases).
  - bad_debt — accounting, ADMIN_ONLY, GET /accounting/receivables/write-offs?status=requested; NO requester-based disabledReason (the CEO is exempt from
  - raast_void — reconciliation, ADMIN_ONLY, GET /reconciliation/raast/receipts?voidRequested=1.
  - grni_writeoff — procurement | accounting, ADMIN_ONLY, GET /procurement/grni?writeOffRequested=1.
  - cash_request_hod — no module, approverRoles null, GET /trustops/cash-vouchers?view=hod, sign / reject (the route decides who may sign).
  - cash_voucher — relabelled 'Cash requests', title `${number} — ${payeeName} — PKR …`, facts per the cash plan (holder, purpose, brand, box, HOD
  - recipe provider (~212-218): derive a MODIFIER recipe's company via modifier → group → menu item → concept (FC critic).
  - Counts (/approvals/counts) include every new type per company.
  - **reconciliation/backfillOrders.ts — the merged REPOSTERS (all areas):**
  - `RefusedPostingKind += 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire' | 'ic.fleet_charge' |
  - FA 'fixed_asset.depreciation' (entityType FixedAsset, flag sourceId = entityId = assetId; post() ignores opts dates and calls
  - FC 'inventory.prep_draw' { entityType 'PrepBatch', nothingToPost { 'batch_not_found', 'zero_value', 'not_ad_hoc' }, post → postPrepDraw };
  - TX 'giftcard.expire' { entityType 'GiftCard', multiPost: true, nothingOwed unless card.breakagePendingAt is set, post → expireOneGiftCard }.
  - PP 'ic.fleet_charge' { entityType 'FleetCharge', entityId '<agreementId>:<YYYY-MM>', nothingOwed when the IntercompanyTransfer with sourceRef
  - DL 'cod.rider_debt.reversal' { entity Payment, post → reverseCodRiderDebt(paymentId), nothingToPost when the debt entry is missing or already reversed }.
  - OA 'ledger.till_clearing_split' { entityType 'Tenant', flag sourceId = tenantId, post → sweepTillClearing(tenantId, { mode: 'daily' }) } (the real
  - Petty cash / cash requests post inside their own transactions (no flags) — no reposter needed; confirm by grep and say so.
  - **tenants/routes.ts — company merge (inside the existing merge tx), every new company table:** FA (rename colliding assetTags with '-<srcSlug>',
  - **setup/routes.ts:** PATCH /setup/chart-of-accounts/:id refuses isActive:false on a REQUIRED code, on a controlled account (422 ACCOUNT_CONTROLLED),

**Consumes**

- Every W1-W3 exporter named above: chargeAssetThrough (w1-fa-engine), releaseSourceThrough (w2-fa-capex), postPrepDraw / postWasteLog / postStockCount
  (w1-stock), VOID_WASTE_REASONS (w2-sale), expireOneGiftCard (w1-taxsales), chargeFleetMonth + isMemberOfBoth (w1-ic), reverseCodRiderDebt (w2-dlv-cod),
  sweepTillClearing (w3-till); the module routes each provider calls. w0: APPROVAL_TYPES, REQUIRED, REGISTER_CONTROLLED_CODES.


**Exposes**

```ts
// reconciliation/backfillOrders.ts
export type RefusedPostingKind = /* existing */ | 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire'
  | 'ic.fleet_charge' | 'cod.rider_debt.reversal' | 'ledger.till_clearing_split'
export interface Reposter { /* existing */ multiPost?: boolean }
```


**Tests — run on `servd_test_wb_w4_integration`, Redis index 26**

`repostersWaveB`: for each new kind, a refused posting (closed period or deactivated account) is flagged, then the reposter posts it once (late-dated
per owner decision 6) and a second run finds nothing; gift-card '@n' entries reposted with multiPost; the fleet reposter refuses an operator of one
company; B's flags are untouched by A's run. `approvalsInbox` (updated): each new type appears for A's CEO only for A's rows, counts per company,
actions call the module routes (a finance user never sees Approve), cash_voucher labelled 'Cash requests' with Approve disabled for the HOD signer,
cash_request_hod visible to the holder's line manager, the recipe provider resolves a modifier recipe's company. `tenantMergeWaveB` + `fixedAssetsMerge`:
assets, events, pools, classes, tax years move (colliding tags suffixed; the worker keeps charging in the destination; recapitalisation → 409), lots /
movements / GRNI matches, card settlements, clients / cards / charges / write-offs, settlements / spend lines, strikes all move; a company with
inter-company activity → 422 MERGE_HAS_INTERCOMPANY. `setupChartGuards`: deactivating 2210 (REQUIRED), a controlled due-from, or 1510 while its
class is active → 422; renaming works (operations-config is covered by w1-taxcore's operationsConfigWaveB test).



## w4-admin-fa — Admin: fixed-asset register v2 (tabs, requests, pools, reports, classes) and CapEx capitalisation / Quick buy / WHT / deposits

Area: admin UI — fixed assets, CapEx, Investment · UI agent — no database, no tests to run · brief: `briefs/w4-admin-fa.md`

UI only — accounting/fixed-assets/**, components/fixedAssets/**, finance/capex, finance/capital-ledger, accounting hub ledger link + README.

**Owned files**

- `frontend/admin/src/app/accounting/fixed-assets/page.tsx`
- `frontend/admin/src/app/accounting/fixed-assets/[id]/page.tsx (new)`
- `frontend/admin/src/app/accounting/fixed-assets/pools/page.tsx (new)`
- `frontend/admin/src/app/accounting/fixed-assets/requests/page.tsx (new)`
- `frontend/admin/src/app/accounting/fixed-assets/reports/page.tsx (new)`
- `frontend/admin/src/app/accounting/fixed-assets/classes/page.tsx (new)`
- `frontend/admin/src/components/fixedAssets/** (new: shared tabs, request forms, schedule table)`
- `frontend/admin/src/app/finance/capex/page.tsx`
- `frontend/admin/src/app/finance/capital-ledger/page.tsx`
- `frontend/admin/src/app/accounting/page.tsx (W4: LEDGER_LINKS gains Fixed assets)`
- `frontend/admin/src/app/accounting/README.md`

**Tasks (outline — full text in the brief)**

  - **Fixed assets (Finance → Accounting → Fixed assets, the EXISTING page upgraded in place):** tabs Register | Smallwares | Requests | Reports | Classes &
  - Register: company column + per-company totals in All-companies view; filters (class, brand, location, status, as-of date); CSV; a 'Last run' strip
  - [id] page: past + forecast schedule, events timeline, edit form for descriptive fields only, request forms (dispose — sale/scrap/lost/stolen with
  - Pools page: pools per outlet / brand / type with units, NBV, layers and last count; record a count (also fnb_manager); write-off (breakage/loss) and
  - Requests page: the module's queue (pending / applied / rejected), CEO actions.
  - Reports page: schedule, roll-forward, NBV as-of, tie-out (red mismatch, green ok), 1340 advances, tax + deferred tax (freeze for the CEO).
  - Classes page: lives, tax rates, pooled flag, and policy (alert days, deferred tax rate, tag prefix) — CEO edits, others read.
  - Every class list and default life comes from GET /accounting/fixed-assets/lookups — delete the local DEFAULT_LIFE (~35) and any local list.
  - **CapEx (finance/capex/page.tsx):** CapitalisePanel → 'Prepare for the register': class list from the response's assetClasses (delete the local list
  - **Investment page (capital-ledger):** 'On the books as assets' excludes disposed / voided, with the disposed figure apart; no 'put on register' from
  - **accounting/page.tsx:** LEDGER_LINKS gains 'Fixed assets' (keep w3-fc-report's gauge as it is). accounting/README.md: the new pages.

**Consumes**

- w3-fa-api routes (fixed-assets, requests, pools, reports, classes, policy, lookups); w2-fa-capex CapEx routes (capitalise, quick-buy, deposit-return,
  reclass-deposit, orphans, lookups.suppliers / pools / assetClasses, WHT fields).


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Screenshot checklist for wave Z: register as finance and as
fnb_manager (no write controls but count); an asset page with a pending disposal (CEO sees approve); Quick buy; a capitalisation 'Send to CEO'; reports
tie-out; phone width.



## w4-admin-stock — Admin: counts (spot / opening / suggested / history), waste with brand + outlet, prep, sourcing classes, receiving, bills on receipts with tax/WHT, GRNI page

Area: admin UI — stock documents, procurement bills, GRNI · UI agent — no database, no tests to run · brief: `briefs/w4-admin-stock.md`

UI only — inventory pages, sourcing, procurement (bill form, receiving, new GRNI page).

**Owned files**

- `frontend/admin/src/app/inventory/count/page.tsx`
- `frontend/admin/src/app/inventory/count/history/page.tsx (new)`
- `frontend/admin/src/app/inventory/page.tsx`
- `frontend/admin/src/app/inventory/prep/page.tsx`
- `frontend/admin/src/app/sourcing/page.tsx`
- `frontend/admin/src/app/procurement/receiving/page.tsx`
- `frontend/admin/src/app/procurement/page.tsx`
- `frontend/admin/src/app/procurement/grni/page.tsx (new)`
- `frontend/admin/src/app/marketing/brands/page.tsx (service vessel field only)`
- `frontend/admin/src/app/onboarding/page.tsx (service vessel field only)`

**Tasks (outline — full text in the brief)**

  - **Count page:** Spot | Opening picker (Opening shown only when the API says the user may — finance / CEO / management); 'Suggest a spot count'
  - **Inventory page:** waste drawer gains brand (GET /concepts?view=picker limited to the item's company) and outlet pickers; category select incl.
  - **Prep page:** outlet picker; ad-hoc batch shows 'draws from stock at the price paid'.
  - **Sourcing:** the category becomes a select incl. Drinks and Packaging, each labelled with its stock account.
  - **Receiving page:** outlet picker and the note 'booked to Goods received not invoiced until the bill arrives'.
  - **Procurement bill form:** each line is either a stock item ('Fill from PO' sends poLineId + inventoryItemId; 'Fill from receipt' uses GET
  - **New /procurement/grni page:** open received-not-billed lines (supplier, item, received − billed, value, age, stale > 30 days badge), pending
  - **Brand primary service vessel (packaging rule, FINAL owner rule):** Marketing → Brands create + edit and the onboarding company/brand create

**Consumes**

- w3-recipes (concepts / tenants serviceVessel); w3-stockdocs routes (counts, suggested, history, waste, prep, item PATCH, transfers); w2-ap routes (bills, suppliers, GRNI, receiving).


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Screenshot checklist: count page (spot + suggested) as boh, opening
as finance; waste drawer with brand/outlet; bill form with a receipt-filled stock line and an expense line; GRNI page as finance (ask) and as CEO
(approve); inventory 'Purchase order' button; brand create with the vessel choice (refused without it).



## w4-admin-delivery — Admin: no staff 'Delivered' anywhere — 'Enter customer's code'; ban appeals in Complaints; COD pay-in grouped by rider

Area: admin UI — dispatch, riders, complaints/appeals, COD pay-in · UI agent — no database, no tests to run · brief: `briefs/w4-admin-delivery.md`

UI only — dispatch, riders, complaints pages and the till's DrawerPanels.

**Owned files**

- `frontend/admin/src/app/dispatch/page.tsx`
- `frontend/admin/src/app/riders/page.tsx`
- `frontend/admin/src/app/complaints/page.tsx`
- `frontend/admin/src/app/pos/shift/DrawerPanels.tsx`

**Tasks (outline — full text in the brief)**

  - **Dispatch + Riders pages:** remove every 'Delivered' button / deliverGate; add 'Enter customer's code' (POST /trustops/orders/:id/verify-otp — shows
  - **Complaints page:** a 'Ban appeals' filter (?kind=ban_appeal); each appeal card shows the customer's reason and message, the ban (when, auto or
  - **DrawerPanels (CodPayInPanel):** group rows by rider; badges 'Overdue' (amber) and 'Owed by rider' (red) from the API's status; pickup cash orders

**Consumes**

- w1-dlv-core (verify-otp messages, reroute fields on dispatch rows), w1-bans (complaints kind filter, lift / release-contact), w2-dlv-cod (cod-due status, riderOwes).


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Checklist: Dispatch has no Delivered button; the code entry
locks after the attempts; boh_management sees the Emergency overrides link on a locked order, a cashier does not; an appeal card with the three actions.



## w4-apps — Tablet Emergency overrides tab and code-only dispatch; rider apps: rerouted-code banner, 'Problem at the door', cash-held reminder

Area: tablet + rider apps (Expo + web rider) · UI agent — no database, no tests to run · brief: `briefs/w4-apps.md`

UI only — tablet overrides/dispatch/_layout, rider/** (Expo), storefront /rider web pages + riderApi, docs/rider-app.md.

**Owned files**

- `tablet/app/(staff)/overrides.tsx (new)`
- `tablet/app/(staff)/_layout.tsx`
- `tablet/app/(staff)/dispatch.tsx`
- `rider/src/lib/types.ts`
- `rider/src/lib/api.ts (only if a new endpoint needs a helper)`
- `rider/app/(rider)/job/** `
- `rider/src/components/JobCard.tsx`
- `rider/src/components/ShiftToggle.tsx`
- `frontend/storefront/src/lib/riderApi.ts`
- `frontend/storefront/src/app/rider/jobs/page.tsx`
- `frontend/storefront/src/app/rider/jobs/[orderId]/page.tsx`
- `docs/rider-app.md`
- `tablet/app/(staff)/floor.tsx (Box given only — if it shows a table's order lines)`

**Tasks (outline — full text in the brief)**

  - **Tablet:** a new Overrides tab (NAV_MODULES ['emergency_overrides']) with the same list and the two actions as the admin page (send code to the
  - **Rider apps (Expo `rider/` and web servd.pk/rider):** Job type gains `handover { rerouted, reroutedAt, code, whatsappSent }` and `doorProblem { kind,
  - **Tablet floor (Box given):** if floor.tsx shows a dine-in table's order lines, add the same 'Box given' toggle as the till (POST
  - **docs/rider-app.md:** rewrite the hand-over code section (code only; reroute; door problems; returned food) and the endpoint table.

**Consumes**

- w1-dlv-core rider routes (handover, doorProblem, door-problem, cashHeldCents); w3-dlv-return emergency-overrides routes (tablet tab).


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. Run `npx tsc --noEmit -p .` in tablet/, rider/ and frontend/storefront and make your files clean. Checklist: rider web job page
with a rerouted code; the door-problem sheet; tablet Overrides tab gated by the module.



## w4-customer — Customers: delivery fee + one GST row (incl. delivery), blocked-account notice with appeal, tracker hides a rerouted code; mobile checkout on the server quote

Area: customer surfaces — storefront, mobile, tablet receipt · UI agent — no database, no tests to run · brief: `briefs/w4-customer.md`

UI only — storefront checkout / tracker / account / auth / reserve / group order, BlockedNotice, mobile checkout / order / login / account, tablet printer.

**Owned files**

- `frontend/storefront/src/app/[concept]/checkout/page.tsx`
- `frontend/storefront/src/app/[concept]/checkout/README.md`
- `frontend/storefront/src/app/[concept]/order/[id]/page.tsx`
- `frontend/storefront/src/app/account/page.tsx`
- `frontend/storefront/src/components/auth/LoginForm.tsx`
- `frontend/storefront/src/components/auth/SignupForm.tsx`
- `frontend/storefront/src/components/account/BlockedNotice.tsx (new)`
- `frontend/storefront/src/app/reserve/page.tsx`
- `frontend/storefront/src/app/reserve/[slug]/page.tsx`
- `frontend/storefront/src/app/group-order/page.tsx`
- `frontend/storefront/src/app/group-order/[code]/page.tsx`
- `mobile/app/[concept]/checkout.tsx`
- `mobile/app/order/[id].tsx`
- `mobile/app/login.tsx`
- `mobile/app/(tabs)/account.tsx`
- `tablet/src/lib/printer.ts`

**Tasks (outline — full text in the brief)**

  - **Storefront checkout:** the Quote type adds itemTaxCents and deliveryFeeTaxCents; rows Subtotal / GST (taxCents, sub-label 'incl. PKR x on
  - **BlockedNotice (new):** reads GET /storefront/account/blocks; copy 'Your account can't order from <brands> right now. If this number or email is new
  - **Order tracker:** the Delivery row (fee) and GST sub-label; when handoverRerouted, the code is replaced by 'Your rider has the code for this order'.
  - **Mobile:** checkout uses GET /storefront/quote (no local 17 %), sends the real checkout body (createDirectOrderSchema: conceptSlug, type,
  - **Tablet printer.ts:** ReceiptOrder.deliveryFeeCents? and totalLine('Delivery', …) before Tax.

**Consumes**

- w1-taxsales (quote / checkout / order fields), w1-bans (GET /storefront/account/blocks, POST /storefront/account/ban-appeals, BANNED details),
  w1-dlv-core (tracker handoverRerouted).


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. `npx tsc --noEmit -p .` in frontend/storefront, mobile and tablet clean for your files. Checklist: checkout with a delivery fee
on servd.pk and one brand host; the blocked notice + appeal; tracker with a rerouted code; mobile checkout pickup-only.



## w4-admin-oa — Admin: 'On account' at the till (scan the client's QR card), client pages + card print, statements, bad-debt write-off, order page fee/tender rows

Area: admin UI — on-account at the till, clients, statements, write-offs, order page · UI agent — no database, no tests to run · brief: `briefs/w4-admin-oa.md`

UI only — components/pos/**, refunds, pos shift Z-report, lib/api.ts, receivables pages, clients pages, card print, write-off dialog, orders/[id].

**Owned files**

- `frontend/admin/src/components/pos/PaymentModal.tsx`
- `frontend/admin/src/components/pos/OnAccountPanel.tsx (new)`
- `frontend/admin/src/components/pos/tillApi.ts`
- `frontend/admin/src/app/refunds/RefundOptions.tsx`
- `frontend/admin/src/app/refunds/refundEngine.ts`
- `frontend/admin/src/app/pos/shift/page.tsx`
- `frontend/admin/src/lib/api.ts`
- `frontend/admin/src/app/accounting/receivables/page.tsx`
- `frontend/admin/src/app/accounting/receivables/clients/page.tsx (new)`
- `frontend/admin/src/app/accounting/receivables/clients/[id]/page.tsx (new)`
- `frontend/admin/src/components/finance/OnAccountCardPrint.tsx (new)`
- `frontend/admin/src/components/finance/WriteOffDialog.tsx (new)`
- `frontend/admin/src/app/orders/[id]/page.tsx`
- `frontend/admin/src/components/pos/PosCart.tsx (Box given only)`
- admin READMEs for pos, refunds and receivables (the folders above)

**Tasks (outline — full text in the brief)**

  - **Till:** PaymentModal gains 'On account' (hint 'Client card'), disabled offline and for a part-paid or tipped bill; picking it shows OnAccountPanel:
  - **Clients (new pages under Receivables):** list (status chips, limit, exposure progress bar, available, overdue badge, unbilled), 'New client' form
  - **OnAccountCardPrint:** credit-card-size print layout with the existing `qrcode` package (QRCode.toDataURL(code, { errorCorrectionLevel: 'M' })),
  - **Receivables page:** statements in the list (kind badge 'Statement', period); status 'written_off'; a 'Write off' action on outstanding rows
  - **"Box given" (packaging rule, FINAL owner rule):** on a DINE-IN order, each line whose serviceVessel is 'plate' (null = plate) shows a small
  - **orders/[id] page:** a 'Delivery fee' row and the GST sub-label '(incl. PKR x on delivery)'; the on_account tender label (client name + OA number)

**Consumes**

- w3-till (/pos/on-account/*), w2-oa-recv (customer-accounts, statements, write-offs, receivables withholding), w1-taxsales (order fee fields, receipt labels).


**Exposes**
(UI only — none)

**Checks**

UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Screenshot checklist: Box given on a Simmer dine-in line (on,
then undo), absent on a takeaway line; scan → over-limit refusal → successful charge →
done screen; Z-report row; refund screen option; client create (pending) → CEO approve in the inbox → card print → statement issue → payment →
write-off request → CEO approve.



## w4-docs — Runbooks for finance, the CEO, cashiers and IT; module READMEs; the D1/D3 spec amendment

Area: all areas — runbooks and READMEs · Docs agent — no database, no tests to run · brief: `briefs/w4-docs.md`

docs/*.md (new + updated), backend module READMEs not owned by another agent, workers/README.md, .handoff/fixes/D1D3-spec.md amendment.

**Owned files**

- `docs/fixed-assets.md (new)`
- `docs/food-cost.md (new)`
- `docs/cash-requests-and-petty-cash.md (new)`
- `docs/on-account.md (new)`
- `docs/emergency-overrides.md (new)`
- `docs/raast.md`
- `docs/TAX_SETUP.md`
- `docs/pos-connector-api.md`
- `backend/src/workers/README.md`
- `backend/src/modules/accounting/README.md`
- `backend/src/modules/inventory/README.md`
- `backend/src/modules/procurement/README.md`
- `backend/src/modules/orders/README.md`
- `backend/src/modules/pos/README.md`
- `backend/src/modules/dispatch/README.md`
- `backend/src/modules/rider/README.md`
- `backend/src/modules/riders/README.md`
- `backend/src/modules/complaints/README.md`
- `backend/src/modules/crm/README.md`
- `backend/src/modules/storefront/README.md`
- `backend/src/modules/reports/README.md`
- `backend/src/modules/invoices/README.md`
- `backend/src/adapters/whatsapp/README.md`
- `backend/src/connectors/README.md`
- `backend/src/lib/README.md`
- `backend/src/modules/README.md`
- `.handoff/fixes/D1D3-spec.md (amendment section only)`

**Tasks (outline — full text in the brief)**

  - **docs/fixed-assets.md** (finance + CEO): buying through CapEx and Quick buy (bills refuse equipment); capitalisation approval; smallwares pools,
  - **docs/food-cost.md** (CEO, finance, F&B manager, chefs): FIFO lots (H16), the PACKAGING RULE (owner, 2026-10-13, final: every dish has a Packaging
  - **docs/cash-requests-and-petty-cash.md** (everyone / Jamil sb / finance): raising, HOD, director, paying (advance), receipts, change, overdue (H3/H4),
  - **docs/on-account.md** (finance, cashiers, the CEO): clients, limits, approvals, QR cards, charging at the till, statements (not tax invoices — H14),
  - **docs/emergency-overrides.md** (RGM / chef / F&B manager): code-only delivery, sending the code to the rider, food came back, strikes and blocks per
  - **docs/raast.md:** 'void, never booked' (CEO only) and contra 1115; wrong-brand QR unchanged. **docs/TAX_SETUP.md:** delivery GST (H9), kept deposits
  - **docs/pos-connector-api.md:** a dated '2026-10-14 — delivery charge taxed (backward compatible)' paragraph (the DELIVERY-CHARGE line,
  - **READMEs** (the ones you own): each module's new routes, postings and rules in its existing style; workers/README.md lists depreciation (03:20),
  - **.handoff/fixes/D1D3-spec.md:** an amendment section — 2100-2149 reserved for head-office due-to, 2150-2199 inter-company due-to, 6990 the one

**Consumes**
- Everything merged in W1-W3 (read the code).

**Exposes**
(docs only — none)

**Checks**

Docs agent — no tests. Check `grep -n` that every identity string integrationPass2Books.test.ts reads from docs/pos-connector-api.md is still present.



## Wave Z — the orchestrator alone (after W4)

1. **backend/src/index.ts registrations** (+ any extra snippet agents reported): foodCostRoutes at '/reports/food-cost' BEFORE reportRoutes;
   grniRoutes '/procurement/grni'; withholdingRoutes '/accounting/withholding'; statutoryRoutes '/accounting/statutory'; intercompanyRoutes
   '/accounting/intercompany'; customerAccountRoutes '/accounting/customer-accounts'; posOnAccountRoutes '/pos' (second plugin); posBoxGivenRoutes '/pos' (third plugin); emergencyOverridesRoutes
   '/emergency-overrides'; banAppealRoutes '/storefront'. (fixedAssets requests/pools plugins register inside fixedAssets/routes.ts; the reconciliation
   child plugins inside reconciliation/routes.ts.) Check each path against its GATED_PREFIXES rule.
2. **Workers** (inside workersEnabled): startDepreciationWorker (03:20 PKT), startIntercompanyFleetWorker (03:40), startTillClearingSweepWorker (03:10),
   startCashAdvanceOverdueWorker (09:10), startOnAccountDailyWorker (09:20), startCodCustodyWorker (every 30 min); comment on startGiftCardExpiryWorker
   ('posts breakage').
3. **Boot** (per company, after ensureChartOfAccounts, each in its own try/catch, logged): ensureAssetClasses + reclassLegacyAccumulated;
   ensureFifoCutover (before listen); sweepTillClearing({ mode: 'cutover' }) once (Setting marker); applyModuleGrants already runs (MODULE_GRANTS
   now includes food_cost + emergency_overrides).
4. **/health:** fixedAssets (fixedAssetTieOut + last FixedAssetRun per company), fifoCutover (every company cut over; company-less items with stock
   listed), pettyCash tie-out (floats vs 1011, advances vs 1355), chartTemplateTypes, tillClearing (marker + open till_clearing_unexpected), statutory
   reclass pending (warn), cardPayouts unsettled (warn).
5. **CLOSE_CHECKS:** add prepaidCloseChecks (w2-fa-capex) and inventoryCloseChecks (w3-fc-report) to the array w2-close built.
6. Apply every remaining patch note; replace the two W1 'guarded' dynamic imports of files that only arrived in W2 (lib/stockLedger.ts →
   inventory/fifoCutover.js ensureFifoCutover; fixedAssets/events.ts → financePlanning/capexPosting.js capexAdvancesForLine) with plain typed
   `await import('<literal path>')` calls (keep them dynamic — the static form would be an import cycle) and confirm tsc still passes; grep that the
   deprecated aliases (runDepreciation, ASSET_CATEGORIES, the postWasteLog / postStockCount re-exports,
   readers of the retired Recipe.packagingPct column (management's new packagingPct KPI field is fine), servedWhen, plateWearPct, '/recipes/food-cost', '/dispatch/orders/:id/delivered', '/orders/:id/cod-unpaid',
   '/orders/:id/refused-at-door', '/trustops/orders/:id/otp', '/apply-missed-bill-variances', 'disburse') are gone everywhere (backend, admin,
   tablet, rider, storefront, mobile, tests, .sim).
7. **CLAUDE.md** — the sections listed in shared-files.md §A (Fixed assets v2; Food cost and stock incl. THE packaging rule; Tax decisions H8-H13;
   People, close and inter-company; Cash requests + petty cash in the ledger (replaces "Cash vouchers"); Delivery code-only + Emergency overrides
   (rewrite BOTH Own-fleet bullets); On-account clients, bad debts, Raast void + the rollback caveat; amend the Raast "Tenders" bullet; rewrite the
   BOOKS-06 sentence about postSupplierBill; remove C1/C2/C5, G1-G14, F*, K* from "Pending owner/CA decisions" and record the H1-H30 defaults in force;
   add TODO(asset-sale-tax)).
8. **Full verification:** the whole backend suite on one fresh DB (serial, as vitest is configured), then the RLS suites with RLS_ENFORCE=1;
   `npx tsc --noEmit -p .` in backend, frontend/admin, frontend/storefront, tablet, mobile, rider; `next build` for admin and storefront (never next to
   a dev server — they share .next); screenshots per the UI agents' checklists (admin at phone width too); repeat the wave-0 migration dry run with the
   final schema.
9. **Ship:** commit + push to main; CI builds the three images; the webhook deploys; check https://api.servd.pk/health on the box (fixedAssets,
   fifoCutover, pettyCash, tillClearing). **Rollback caveat:** once an on_account payment or a voided Raast receipt exists, the API image must not roll
   back below this release (an older Prisma client throws on the new enum values); the WhatsApp / SMTP key caveat stands as before.
10. **Go-live worklist for the owner:** recipes in production without a packaging line (the recipes list filter 'No packaging') — the F&B manager
    adds them; the WHT rate table (placeholders until finance confirms the Finance Act rates; withholding stays OFF per company until switched on);
    card-payout settings per company; the CEO's FIFO alignment (dry run first); the petty-cash history backfill (dry run first).


## Follow-ups (separate tasks — NOT built in wave B; spawn them as suggestions after wave Z)

- 'petty_cash' as a payment source for OpEx / CapEx / HR loans (moneyAccountCode option + recordPettyCashSpendTx) — CA critic 13 (assumption recorded).
- The manager vs FINANCIALS_VIEWERS / ModulePage.roles access mismatch — FA critic 9 (raised, not changed here).
- Per-outlet stock pools (owner: the NEXT build) — lots, waste, counts and receipts already carry locationId.
- Moving the remaining route reads from serviceClient to the RLS client (the RLS read-client switch).
- TODO(asset-sale-tax): sales tax on fixed-asset disposal proceeds.
- Card payouts per Keenu MID (CardSettlement.unit 'brand' / 'terminal') once the owner confirms how many MIDs each company has.
- D1 head office (ranges 1400-1449 / 2100-2149 / 6200-6249 reserved; 6990 shared; source 'ho_recharge').
- Mobile delivery with a pin picker (expo-location) — mobile is pickup-only until then.


## Owner / accountant questions — each is BUILT on the default shown; one switch point each

| # | Question | Default built |
|---|---|---|
| P | Packaging (FINAL owner rule): takeaway/delivery use the recipe's packaging; a packaging-vessel brand (Stackd) uses it on every order; dine-in at a plate brand only when staff tap "Box given". | Built (decision P1). Brand create requires the service vessel. |
| Q1 | EOBI / SESSI / salary-tax challans: finance's tax-payments register, HR form retired? | Retired; finance records them (confirm before W1) |
| IC-Q2 | Shared-fleet charge basis | CEO-set rate per trip (FleetRate) |
| IC-Q3 | Fleet charge: cost recovery (no tax) or taxable revenue? | Cost recovery, Cr 6990 |
| IC-Q4 | Inter-company settlements: finance prepares, CEO approves? | Yes (approvals type intercompany_transfer) |
| IC-Q5 | TenantContribution: post monthly or planning only? | Planning only (not posted) |
| DL-Q1 | Is the RGM foh_management? | Yes — foh_management gets Emergency overrides |
| DL-Q2/Q3 | Reroute sends a NEW code; also shown in the rider app? | New code; shown in the app as a fallback |
| DL-Q4 | Customer unreachable: strike? | No strike (only refusals) |
| DL-Q5 | Prepaid online order whose food came back | The manager decides through the existing cancelled-ticket hand-back |
| DL-Q6/Q7 | Lifting a ban keeps strikes? Recycled number freed? | Keep strikes; release-contact frees the number |
| DL-Q8 | Riders on servd payroll? | No — COD owed sits on 1351, recovered at the till |
| DL-Q9 | Blocked customer can still sign in? | Yes, with the notice and the appeal |
| OA | GST rate on account; who approves clients and limit increases; block or warn when overdue; loyalty earn; CEO-raised write-off | Cash rate; the CEO; block; no earn; applies at once |
| FA | Should EVERY capitalisation (incl. smallwares Quick buys) need the CEO? | Yes — finance prepares, the CEO approves |
| TX | One Keenu MID per company or per brand? | Per company (unit 'company') |
| TX | WHT rates (Finance Act) | Placeholder table, withholding OFF until finance switches it on per company |
| TX | Fiscal vendor: DELIVERY-CHARGE line and on_account (PaymentMode cash) accepted? | Built; confirm with the POS vendor before go-live |
| FC-(c) | Stock cooked before its delivery is entered | Settled against the next lot within 7 days (shortfall settle) |
| FC-(d) | Items on no recipe (oil, salt) | 'Issue on receipt' per item (off by default) |
| FC-(e) | Who may enter opening stock (posted to equity) | finance, CEO, management |
| Hasnain | FIFO cut-over alignment difference: 3020 (prior period) or 5050? | 3020, shown on its own line |
| Hasnain | H1-H30 | In force as listed in every brief; each one is a single switch point |
