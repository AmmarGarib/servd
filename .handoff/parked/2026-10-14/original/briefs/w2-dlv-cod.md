# Wave B builder brief — w2-dlv-cod: COD with the rider (H5): one COD status definition, rider debt (own and fleet riders), custody worker, reports

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **delivery (COD custody) + tax/onaccount report rows** · Test DB **`servd_test_wb_w2_dlv_cod`** · Redis **`redis://127.0.0.1:6390/15`** (index 15) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

accounting/codPosting.ts, lib/cod.ts, reconciliation/codRoutes.ts, pos/routes.ts, workers/codCustody.ts, reports/service.ts.

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

## Read first

- plan_delivery.json: summary (COD), postings (rider debt, recovered), routes (cod-due, reconciliation/cod), build_split D
- critic_cash_delivery_onaccount_0.json: violation 9 (one lib/cod.ts), missing (legacy COD path, IC for fleet riders, 1351 reserved), code_facts (pickup rows, reversal key)
- plan_tax.json / plan_onaccount.json shared_file_changes reports/service.ts

## What to build

**lib/cod.ts — ONE definition** read by /pos/cod-due, /reconciliation/cod, salesByTender and the custody worker: `COD_PAY_IN_HOURS = 12`,
`codDueWhere(scope)`, `codStatusOf(payment, order)` → 'with_rider' | 'overdue' | 'rider_owes' | **'at_counter'** (pickup/takeout cash orders — e.g.
WhatsApp 'pay at the counter' — never get a rider status, a rider debt or a rider-overdue flag; rider statuses only for fulfilmentType 'delivery'
with a riderId).
**accounting/codPosting.ts:** `bookCodRiderDebt({ paymentId, actorId, reason, legacy? })` in $transaction + lockOrderTx with the claim on
Payment.codRiderDebtAt IS NULL; preconditions: cash, pending, amount > 0, source ≠ pos, order completed, delivery with a rider, delivered with the
code (deliveryOtpVerifiedAt set) and 'order.complete:<orderId>' present in that company (409 COD_SALE_NOT_BOOKED). **Own rider** (rider.tenantId =
order company): 'cod.rider_debt:<paymentId>' Dr 1351 / Cr 1010 (conceptId both; memo names order ref, full order id and rider), codRiderDebtEntryId.
**Fleet rider of another company (H30 contract):** an IntercompanyTransfer via `postSystemTransferTx` (serviceClient tx; source 'cod', sourceRef
'cod:<paymentId>', debtor = the PROVIDER (Dr 1351 in its books), creditor = the CLIENT (Cr 1010 in its books), entry date now; codRiderDebtTransferId)
— the caller must belong to BOTH companies (`isMemberOfBoth`, else 403 NOT_IN_BOTH_COMPANIES 'a finance user of both companies books a fleet rider's
COD'). **Legacy path (critic):** COD delivered by the old manager override (deliveryOtpVerifiedAt NULL, order completed before this release) may be
booked with `legacy: true` + reason by admin/finance only — audited + flagException 'cod_cash_overdue' note. A replay → 200 {alreadyBooked: true}.
`reverseCodRiderDebtTx(tx, { paymentId, tenantId })` (own rider: reverseJournalEntry → key **'cod.rider_debt.reversal:<paymentId>'** Dr 1010 / Cr 1351 —
the real reversal shape), `reverseCodRiderDebtAfterCommit(paymentId)` (fleet rider: reverseSystemTransfer on serviceClient), and
`reverseCodRiderDebt(paymentId)` (for the reposter; nothingToPost when the debt entry/transfer is missing or already reversed). Constant
RIDER_COD_ACCOUNT = ACCT.RIDER_COD_RECEIVABLE with TODO(H5) note. w3-till wires the calls into settlePayment.
**reconciliation/codRoutes.ts** (mounted at /reconciliation/cod by w0): GET /?status=with_rider|overdue|rider_owes (FINANCE_TEAM + reconciliation
module; read scope via order.concept); POST /:paymentId/rider-debt {reason 5..500, legacy?} (admin, owner, management, finance; write scope → 404;
errors 422 NOT_CASH_ON_DELIVERY, 409 COD_ALREADY_PAID / COD_NOT_DELIVERED_WITH_CODE / COD_SALE_NOT_BOOKED, 422 NO_RIDER, 409 PERIOD_LOCKED).
**pos/routes.ts:** GET /cod-due imports COD_PAY_IN_HOURS + codStatusOf; rows add riderOwes {at, byName} | null and status; **the payout category zod
enum and GET /pos/payout-categories offer only PAYOUT_CATEGORIES of kind 'expense'** (the cogs keys are petty-cash only — CA critic; w2-cash-ledger adds
the `kind` field in expenseCategories.ts this wave: code against `c.kind !== 'cogs'` so it compiles before and after).
**workers/codCustody.ts** (every 30 min, loop per company; wave Z starts it): flagException 'cod_cash_overdue' per delivery COD Payment past
COD_PAY_IN_HOURS with no rider debt and no open flag; 'delivery_on_road_overdue' per delivery order picked up > 3 h ago, not delivered, not returned
(critic: nobody logged the food back); de-duplicated (kindsMatching); export runCodCustodyOnce.
**reports/service.ts (merged):** salesByTender 'cod_not_collected' → 'cod_rider_owes' (from Payment.codRiderDebtAt via codStatusOf); rename
cod.notCollected* → cod.riderOwes*; (TX) SALE_FIELDS + deliveryFeeCents, SalesTotals.deliveryFees (net of the refund share via refundShareOf), net
unchanged; (OA) TENDER_ORDER inserts 'on_account' after 'raast' (labels from tenderLabel).

## Contracts you consume (already on disk when you start)

- w1-ic: postSystemTransferTx, reverseSystemTransfer, isMemberOfBoth (lib/companyPairs.ts). w0: Payment cod columns, ACCT.RIDER_COD_RECEIVABLE, reverseJournalEntry.


## Contracts you expose (later waves code against these — keep the names and signatures)

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


## Tests

Your database: `servd_test_wb_w2_dlv_cod`. Your Redis: `redis://127.0.0.1:6390/15`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_dlv_cod REDIS_URL=redis://127.0.0.1:6390/15 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`codRiderDebt` (two companies: B finance → 404 on A's payment; own rider posts Dr 1351/Cr 1010 in A under 'cod.rider_debt:<paymentId>', replay no-op;
refuses a POS order, a paid row, a pickup row (at_counter), an order delivered without a code, a missing order.complete, cashier/foh roles (403), a
role without the reconciliation module (403); legacy:true by finance with reason passes, by management → 403; fleet rider of B on A's order: a
finance user of A only → 403, of A and B → an IntercompanyTransfer source 'cod' in both books; reverseCodRiderDebtTx posts
'cod.rider_debt.reversal:<paymentId>'; salesByTender shows the rider-owes row, deliveryFees and on_account ordering). `codCustody` (flags per
company only for its own overdue delivery COD; no duplicate on re-run; pickup cash never flagged; on-road overdue flag). Update `raastReports`
(cod.notCollected* → cod.riderOwes*) and any cod-due / salesByTender suite.



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_dlv_cod REDIS_URL=redis://127.0.0.1:6390/15 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
