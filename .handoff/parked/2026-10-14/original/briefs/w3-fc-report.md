# Wave B builder brief — w3-fc-report: ONE food-cost variance report (actual vs recipe at the price paid, food / drinks / packaging), API, scheduled email, admin pages

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **foodcost (the variance report, its API, email, hub gauge, management KPI)** · Test DB **`servd_test_wb_w3_fc_report`** · Redis **`redis://127.0.0.1:6390/21`** (index 21) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

reports/foodCost.ts + foodCostRoutes.ts, workers/scheduledReports.ts, management/routes.ts (foodCostPct), /reports/food-cost admin, hub gauge, menu-engineering page.

W1 and W2 are merged: code against their contracts as they are ON DISK (read the files). Files you own may change hands in W4 (shared-files.md).


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

## Read first

- plan_foodcost.json: summary REPORT paragraph, routes (REPORT block), build_split E + F
- critic_assets_foodcost_1.json: violations 1 (Q only), 12 (food / drinks / packaging split, brand-sales denominator), 14 (alignment line), 15 (null-company schedule)
- critic_tax_people_0.json violation 10 (42xx other income out of sales KPIs)

## What to build

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

## Contracts you consume (already on disk when you start)

- w1-stock: StockMovement / StockLot data, lotValuation, postFifoAlign, brandShare. w2-ap: readCutover (pre-FIFO difference, cut-over date).
  w2-sale: RecipeCost (standardCents = plate MC, packagingCents, targetMcCents per order type) + packagingApplies. w2-close: brandSalesRevenueCents + costOfSalesSplit (accounting/reports.ts — the ONE
  denominator and class split). w0: closeCheckTypes, the '/reports/food-cost' gate, module food_cost + MODULE_GRANTS.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// reports/foodCost.ts
export function foodCostSummary(db: Db, a: { tenantIds: string[]; from: Date; to: Date; conceptId?: string; locationId?: string; revenueVisible: boolean }): Promise<FoodCostCompanyBlock[]>
// (brandSalesRevenueCents / costOfSalesSplit live in accounting/reports.ts — w2-close; import them, do not re-export a copy)
export const inventoryCloseChecks: CloseCheck[]
export function buildFoodCostEmail(db: Db, schedule: ScheduledReport): Promise<{ subject: string; html: string }>
// reports/foodCostRoutes.ts
export default async function foodCostRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/reports/food-cost' BEFORE reportRoutes
```


## Tests

Your database: `servd_test_wb_w3_fc_report`. Your Redis: `redis://127.0.0.1:6390/21`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_fc_report REDIS_URL=redis://127.0.0.1:6390/21 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`foodCostAccess`: every /reports/food-cost route — B → 404 on A's conceptId / inventoryItemId / tenantId; the portfolio view returns separate company
blocks; empty scope denied; foh_management 403 (no food_cost); boh_management 200 with revenueHidden and no revenue fields; finance and fnb_manager
200 with revenue; a CEO untick → 403; an 'accounting'-only role can GET the summary but cannot POST align; align is ADMIN_ONLY. `foodCostReport`:
identity theoretical + explained + unexplained + alignment == ledger cost-of-sales group per brand (open orders and shifts shown as timing); a
refunded order stays in theoretical; service charge, delivery fee and 4200 excluded from revenue; packaging counted for a Simmer takeaway / delivery
order, a Stackd dine-in order and a Simmer dine-in line marked Box given, NOT for a plain Simmer dine-in order; MC split by order type; an order at
23:30 PKT falls on the right day; zero revenue → 'no_data'; a null-cost lot → 'incomplete'; valuation ties to the GL when everything is posted;
inventoryCloseChecks warn on a stale GRNI line. `scheduledFoodCost`: emails only its own company; a NULL-company schedule → 'failed: no company';
an unknown type → 'failed…'. wave3Kitchen / wave3Gates updated to the new path, gate row and MODULE_GRANTS; management suites to the split fields.



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_fc_report REDIS_URL=redis://127.0.0.1:6390/21 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
