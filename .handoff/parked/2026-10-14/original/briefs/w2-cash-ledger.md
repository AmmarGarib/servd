# Wave B builder brief — w2-cash-ledger: Petty cash on the books: 1011, sources incl. Garibsons/safe/bank/till, returns, spends with expense lines, counts, history backfill, tie-out

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **cash (petty cash in the ledger) + delivery (trustops OTP route)** · Test DB **`servd_test_wb_w2_cash_ledger`** · Redis **`redis://127.0.0.1:6390/16`** (index 16) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

accounting/pettyCashPosting.ts, trustops/pettyCash.ts + routes.ts, expenseCategories.ts, pos/drawerToBox.ts, reconciliation/pettyCashBackfillRoutes.ts, petty-cash admin page + shared editors.

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

## Read first

- plan_cash.json: summary 1, 3, 4; postings (pettycash.*), routes (petty-cash), shared_file_changes, build_split A + C
- critic_cash_delivery_onaccount_1.json: violations 1 (till drop), 2 (stock contract — W3 does stock), 6 (locationId), 7 (backfill under /reconciliation); missing (custodian boxes, lock box in backfill, bytes, re-stamp)
- plan_delivery.json: removes 'GET /trustops/orders/:id/otp', routes verify-otp message

## What to build

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

## Contracts you consume (already on disk when you start)

- w0: PettyCashMovement/SpendLine/attachments schema, ACCT.PETTY_CASH/DUE_TO_GARIBSONS/CASH_ADVANCES/CASH_DRAWER, lib/evidenceFile.ts, placeAndPost /
  withBackfillSlot exports, ledgerBalancesByCode. w1-fa-engine: assertNotEquipmentLine. existing: moneyAccountCode, createPaymentTx, drawerExpectation, assertShiftOf.


## Contracts you expose (later waves code against these — keep the names and signatures)

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


## Tests

Your database: `servd_test_wb_w2_cash_ledger`. Your Redis: `redis://127.0.0.1:6390/16`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_cash_ledger REDIS_URL=redis://127.0.0.1:6390/16 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_cash_ledger REDIS_URL=redis://127.0.0.1:6390/16 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
