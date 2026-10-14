# Wave B builder brief — w3-cash-requests: Cash requests: anyone raises → HOD → director → custodian pays (advance on 1355) → holder's receipts book it; overdue → loan/director (H3)

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **cash (cash requests replace vouchers; receipts book the expense; stock + capex lines)** · Test DB **`servd_test_wb_w3_cash_requests`** · Redis **`redis://127.0.0.1:6390/23`** (index 23) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

trustops/cashVouchers.ts rework, trustops/cashRequestSettle.ts, pettyCash.ts + pettyCashPosting.ts (W3: stock + capex lines, settlement/conversion posters), cashAdvanceOverdue worker, cash-requests admin pages.

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

## Read first

- plan_cash.json: summary 2, postings (cashvoucher.*), routes (cash-vouchers), build_split B + D
- critic_cash_delivery_onaccount_1.json: violations 2 (one stock-in contract), 4 (HOD = HR's rule, no hr/reportingLine.ts), 5 (H3 worker auto-converts), 9 (legacy holders), 10 (custodian box picker), 11 (HOD provider), 15 (hygiene)
- critic_assets_foodcost_0.json violation 2 (cash-bought equipment only through the cash-request seam)

## What to build

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

## Contracts you consume (already on disk when you start)

- w2-cash-ledger: recordPettyCashSpendTx / recordPettyCashTopupTx, resolveSpendLinesTx, postPettyCashMovementTx, FUNDING_ACCOUNT, GET boxes?mine=1,
  SpendLinesEditor / ReceiptUploader / lib/photoPrep. w2-ap: recordCashPurchaseStockTx. w2-fa-capex: recordCapexPaymentFromCashTx.
  w1-hr: directManagerUserIdOf, teamUserIdsUnder, createLoanFromCashAdvanceTx. w1-fa-engine: assertNotEquipmentLine. w0: lib/evidenceFile.ts,
  CashVoucher / Settlement / SpendLine schema, ACCT.CASH_ADVANCES / DIRECTOR_CURRENT / STAFF_LOANS / PETTY_CASH, OperationsConfig.cashAdvanceSettleDays.


## Contracts you expose (later waves code against these — keep the names and signatures)

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


## Tests

Your database: `servd_test_wb_w3_cash_requests`. Your Redis: `redis://127.0.0.1:6390/23`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_cash_requests REDIS_URL=redis://127.0.0.1:6390/23 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_cash_requests REDIS_URL=redis://127.0.0.1:6390/23 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
