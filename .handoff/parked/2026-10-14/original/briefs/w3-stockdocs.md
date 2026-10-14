# Wave B builder brief — w3-stockdocs: Counts (spot + opening), waste, prep batches, transfers and item edits on FIFO lots; shortfall flags

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **foodcost (stock documents: counts, waste, prep, transfers, item edits)** · Test DB **`servd_test_wb_w3_stockdocs`** · Redis **`redis://127.0.0.1:6390/19`** (index 19) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

crosschecks/routes.ts + countPosting.ts, inventory/routes.ts, stockTransfers/routes.ts, workers/shrinkageTrend.ts.

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

## Read first

- plan_foodcost.json: COUNTS / WASTE / PREP paragraphs of summary, postings 6-12 + 14 + 16, routes (counts, prep, waste, inventory PATCH, waste-analytics, transfers), build_split C (crosschecks / inventory / stockTransfers / shrinkageTrend)
- critic_assets_foodcost_1.json: violations 4 (company-less), 9 (keep COST_FROM_DELIVERIES / costSource names), 13 (opening counts: finance/CEO/management; cost defaults to the latest purchase price)

## What to build

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

## Contracts you consume (already on disk when you start)

- w1-stock: lockItemsTx, addLotTx, consumeFifoTx, latestPurchaseCostCents, ensureFifoReady; inventoryPosting postStockCount / postPrepDraw /
  postWasteLog / postItemReclassTx. w2-ap: receiveGoods(locationId). w0: lib/inventoryClass.ts, lib/savepoint.ts, PhysicalCount/PrepBatch/WasteLog
  columns, exception kinds stock_shortfall / stock_unrecorded.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// crosschecks/countPosting.ts
export { postStockCount } from '../accounting/inventoryPosting.js'
// routes (wave Z: no new registration — same plugins)
// POST /crosschecks/physical-counts → 201 { count, lines, ledger: { posted: boolean; entryId?: string; error?: string } }
// GET  /crosschecks/physical-counts/suggested?n&locationId → { items: Array<{ id, name, unit, onHandQty, onHandValueCents?: number }> }
```


## Tests

Your database: `servd_test_wb_w3_stockdocs`. Your Redis: `redis://127.0.0.1:6390/19`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_stockdocs REDIS_URL=redis://127.0.0.1:6390/19 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_stockdocs REDIS_URL=redis://127.0.0.1:6390/19 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
