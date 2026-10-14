# Wave B builder brief — w4-integration: Approvals inbox providers, REPOSTERS for every new posting, company-merge for every new table, chart/setup guards

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W4** · Area: **all areas — cross-cutting backend glue** · Test DB **`servd_test_wb_w4_integration`** · Redis **`redis://127.0.0.1:6390/26`** (index 26) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

approvals/providers.ts + README + approvalsInbox test, reconciliation/backfillOrders.ts REPOSTERS + sweeps, tenants/routes.ts merge, setup/routes.ts guards.

W1-W3 are merged: code against the API and helpers as they are ON DISK (read the files). Nothing after you edits your files except the orchestrator in wave Z.


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

## Read first

- shared-files.md §A backfillOrders.ts (the merged REPOSTERS list), §B approvals/providers.ts, tenants/routes.ts (W4 part), setup/routes.ts
- plan_*.json shared_file_changes for approvals/providers.ts, backfillOrders.ts, tenants/routes.ts, setup/routes.ts (every area)
- critic_tax_people_0.json violation 3 (multiPost reposter), critic_cash_delivery_onaccount_2.json violations 4, 5, 7 (assertNotSelfApproval, delegable false, till-clearing reposter shape), critic_assets_foodcost_0.json violation 8 (FA reposters), critic_assets_foodcost_1.json violations 5 (GRNI provider), 8 (restore-failure sweep), critic_tax_people_1.json violation 5 (fleet reposter)

## What to build

**approvals/providers.ts (+ README rows; one inbox — every button calls the module's EXISTING route, whose own guard decides; never a second engine):**
each provider reads its module's queue AS THE CALLER; `delegable: false` unless noted.
- fixed_asset_request — module accounting, ADMIN_ONLY, reads GET /accounting/fixed-assets/requests?status=pending, approve/reject → that module's
  routes. (README: replace the 'capex posting not in the inbox' note.)
- intercompany_transfer — accounting, ADMIN_ONLY; disabledReason when the CEO is not a member of BOTH companies.
- on_account_client — accounting, ADMIN_ONLY, GET /accounting/customer-accounts?pending=1 (new clients and requested limit increases).
- bad_debt — accounting, ADMIN_ONLY, GET /accounting/receivables/write-offs?status=requested; NO requester-based disabledReason (the CEO is exempt from
  self-approval — decision 27; the route's assertNotSelfApproval decides).
- raast_void — reconciliation, ADMIN_ONLY, GET /reconciliation/raast/receipts?voidRequested=1.
- grni_writeoff — procurement | accounting, ADMIN_ONLY, GET /procurement/grni?writeOffRequested=1.
- cash_request_hod — no module, approverRoles null, GET /trustops/cash-vouchers?view=hod, sign / reject (the route decides who may sign).
- cash_voucher — relabelled 'Cash requests', title `${number} — ${payeeName} — PKR …`, facts per the cash plan (holder, purpose, brand, box, HOD
  signer), delegable kept true; Approve disabled for the HOD signer (SAME_SIGNER).
- recipe provider (~212-218): derive a MODIFIER recipe's company via modifier → group → menu item → concept (FC critic).
- Counts (/approvals/counts) include every new type per company.
**reconciliation/backfillOrders.ts — the merged REPOSTERS (all areas):**
- `RefusedPostingKind += 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire' | 'ic.fleet_charge' |
  'cod.rider_debt.reversal' | 'ledger.till_clearing_split'`; the Reposter interface gains `multiPost?: boolean` (skips the exact-reference "Already on
  the books" check and decides nothingOwed in load() — TX critic: '@n' gift-card entries).
- FA 'fixed_asset.depreciation' (entityType FixedAsset, flag sourceId = entityId = assetId; post() ignores opts dates and calls
  `chargeAssetThrough(assetId, lastCompletedPeriod, opts)` which late-dates per month); 'prepaid.release' (entity CapexPayment | OpexPayment by
  sourceType; sourceId = payment id; post → `releaseSourceThrough`).
- FC 'inventory.prep_draw' { entityType 'PrepBatch', nothingToPost { 'batch_not_found', 'zero_value', 'not_ad_hoc' }, post → postPrepDraw };
  'inventory.waste' and 'pos.void_waste' value from the STORED WasteLog.estimatedCostCents, logs found by WasteLog.orderItemId (not notes),
  'pos.void_waste' reason filter IN VOID_WASTE_REASONS (void_after_fire, cancelled_after_fire, returned_food); 'inventory.count' from the stored
  PhysicalCountLine.valueCents; repoint the postWasteLog / postStockCount imports to accounting/inventoryPosting.ts (then drop the old re-exports in
  supplierPosting.ts / countPosting.ts if nothing else imports them). unflaggedMisses += ad-hoc prep batches with no 'inventory.prep_draw:' entry,
  and cancelled orders with net-out sale rows but no return/waste rows (the restore-failure sweep — flag 'stock_restore_failed').
- TX 'giftcard.expire' { entityType 'GiftCard', multiPost: true, nothingOwed unless card.breakagePendingAt is set, post → expireOneGiftCard }.
- PP 'ic.fleet_charge' { entityType 'FleetCharge', entityId '<agreementId>:<YYYY-MM>', nothingOwed when the IntercompanyTransfer with sourceRef
  'fleet:<…>' is posted; post() refuses unless the operator belongs to BOTH companies (else nothingOwed + 'ask the CEO to Charge now'); re-derives
  the first day open in BOTH companies → chargeFleetMonth }.
- DL 'cod.rider_debt.reversal' { entity Payment, post → reverseCodRiderDebt(paymentId), nothingToPost when the debt entry is missing or already reversed }.
- OA 'ledger.till_clearing_split' { entityType 'Tenant', flag sourceId = tenantId, post → sweepTillClearing(tenantId, { mode: 'daily' }) } (the real
  Reposter shape: load → RefusedDoc.post).
- Petty cash / cash requests post inside their own transactions (no flags) — no reposter needed; confirm by grep and say so.
**tenants/routes.ts — company merge (inside the existing merge tx), every new company table:** FA (rename colliding assetTags with '-<srcSlug>',
merge FixedAssetClass by key (repoint fixed_assets / fixed_asset_* rows to the destination class id), repoint fixed_asset_events / pools /
tax_years / runs / depreciation, prepaid_releases); FC (stock_lots, stock_movements, grni_matches; goods_receipts.tenantId; waste_logs.tenantId);
TX (card_settlements / card_settlement_days); OA (customer_accounts (renumber colliding OA-numbers), customer_account_cards, customer_account_charges,
receivable_write_offs / attachments); CA (cash_voucher_settlements, petty_cash_spend_lines, petty_cash_movements.tenantId); DL
(customer_strikes.tenantId, customer_bans.tenantId). PP: refuse 422 MERGE_HAS_INTERCOMPANY when either company has 'intercompany'-controlled accounts
with lines, or any intercompany_transfers / fleet_rates row. Fiscal-year end month: refuse 422 FY_END_MISMATCH when the two companies differ and both
have a year-end close.
**setup/routes.ts:** PATCH /setup/chart-of-accounts/:id refuses isActive:false on a REQUIRED code, on a controlled account (422 ACCOUNT_CONTROLLED),
or on the cost / accumulated code of an active FixedAssetClass (422 ACCOUNT_IN_USE); renames allowed; POST never sets controlledBy.
(PATCH /setup/operations-config — withholdingTaxPct dropped, cashAdvanceSettleDays added — was done by w1-taxcore in W1; leave it as it is.)

## Contracts you consume (already on disk when you start)

- Every W1-W3 exporter named above: chargeAssetThrough (w1-fa-engine), releaseSourceThrough (w2-fa-capex), postPrepDraw / postWasteLog / postStockCount
  (w1-stock), VOID_WASTE_REASONS (w2-sale), expireOneGiftCard (w1-taxsales), chargeFleetMonth + isMemberOfBoth (w1-ic), reverseCodRiderDebt (w2-dlv-cod),
  sweepTillClearing (w3-till); the module routes each provider calls. w0: APPROVAL_TYPES, REQUIRED, REGISTER_CONTROLLED_CODES.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// reconciliation/backfillOrders.ts
export type RefusedPostingKind = /* existing */ | 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire'
  | 'ic.fleet_charge' | 'cod.rider_debt.reversal' | 'ledger.till_clearing_split'
export interface Reposter { /* existing */ multiPost?: boolean }
```


## Tests

Your database: `servd_test_wb_w4_integration`. Your Redis: `redis://127.0.0.1:6390/26`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w4_integration REDIS_URL=redis://127.0.0.1:6390/26 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`repostersWaveB`: for each new kind, a refused posting (closed period or deactivated account) is flagged, then the reposter posts it once (late-dated
per owner decision 6) and a second run finds nothing; gift-card '@n' entries reposted with multiPost; the fleet reposter refuses an operator of one
company; B's flags are untouched by A's run. `approvalsInbox` (updated): each new type appears for A's CEO only for A's rows, counts per company,
actions call the module routes (a finance user never sees Approve), cash_voucher labelled 'Cash requests' with Approve disabled for the HOD signer,
cash_request_hod visible to the holder's line manager, the recipe provider resolves a modifier recipe's company. `tenantMergeWaveB` + `fixedAssetsMerge`:
assets, events, pools, classes, tax years move (colliding tags suffixed; the worker keeps charging in the destination; recapitalisation → 409), lots /
movements / GRNI matches, card settlements, clients / cards / charges / write-offs, settlements / spend lines, strikes all move; a company with
inter-company activity → 422 MERGE_HAS_INTERCOMPANY. `setupChartGuards`: deactivating 2210 (REQUIRED), a controlled due-from, or 1510 while its
class is active → 422; renaming works (operations-config is covered by w1-taxcore's operationsConfigWaveB test).



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w4_integration REDIS_URL=redis://127.0.0.1:6390/26 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
