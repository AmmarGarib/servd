# Wave B builder brief — w2-close: ONE period-close checklist with CEO override, fiscal year + virtual roll-forward, statements/report categorisation fixes

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **people (close, year end) + FA/TX/CA/FC report changes** · Test DB **`servd_test_wb_w2_close`** · Redis **`redis://127.0.0.1:6390/17`** (index 17) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

accounting/closeChecks.ts, fiscalYear.ts (db helpers), reports.ts, accounting/routes.ts, lib/labour.ts, tenants/routes.ts (FY PATCH) + close/BS/TB admin pages.

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

## Read first

- plan_people.json: summary 3, routes (period-close, fiscal-year, TB/BS), build_split C, assumptions OWNER QUESTION 6-7
- critic_tax_people_1.json: missing (posting_failed by doc date, FY guard, FY relative to asOf), code_facts (closeWithUnmatchedRaast today)
- plan_assets.json shared_file_changes (accounting/routes.ts POST /journal, reports.ts categorise); critic_assets_foodcost_0.json violation 7 (cash flow)
- plan_tax.json routes POST /period-close; critic_tax_people_0.json (42xx other income)
- plan_cash.json shared_file_changes reports.ts (CASH_ACCOUNT_CODES)
- critic_assets_foodcost_1.json missing 'Brand P&L and management dashboards label all 5xxx as foodCostPct'

## What to build

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

## Contracts you consume (already on disk when you start)

- w1: hrCloseChecks (w1-hr), statutoryCloseChecks (w1-taxcore), intercompanyCloseChecks (w1-ic), fixedAssetCloseChecks (w1-fa-engine),
  cardPayoutCloseChecks (w1-recon). w0: closeCheckTypes, fiscalYear (pure), PeriodLock columns, controlledOverride.


## Contracts you expose (later waves code against these — keep the names and signatures)

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


## Tests

Your database: `servd_test_wb_w2_close`. Your Redis: `redis://127.0.0.1:6390/17`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_close REDIS_URL=redis://127.0.0.1:6390/17 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_close REDIS_URL=redis://127.0.0.1:6390/17 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
