# Wave B builder brief — w2-fa-capex: CapEx → register link, capitalisation request, WHT/input tax on CapEx, deposits, Quick buy, prepaid releases (CapEx + OpEx), cash seam

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **assets (CapEx side) + tax (CapEx WHT/input tax) + H25 prepaid engine** · Test DB **`servd_test_wb_w2_fa_capex`** · Redis **`redis://127.0.0.1:6390/12`** (index 12) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

financePlanning/capexPosting.ts + routes.ts + companyRefs.ts, accounting/prepaidReleases.ts (source-agnostic), recordCapexPaymentFromCashTx.

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

- `backend/src/modules/financePlanning/capexPosting.ts`
- `backend/src/modules/financePlanning/routes.ts`
- `backend/src/modules/financePlanning/companyRefs.ts`
- `backend/src/modules/accounting/prepaidReleases.ts (new)`
- `backend/tests/capexAssetLink.test.ts (new)`
- `backend/tests/prepaidReleases.test.ts (new)`
- `backend/tests/booksReconcile.test.ts (W2)`
- `backend/tests/moneyBigint.test.ts (fixed-asset section only, W2)`

## Read first

- plan_assets.json: summary 1-3, postings CAPITALISE / CAPEX INSTALMENT / CASH-REQUEST ADVANCE / PREPAID / DEPOSIT / ORPHAN, routes (CapEx), build_split C
- plan_tax.json: CONTRACT for the FA/CapEx area
- critic_assets_foodcost_0.json (all CapEx items: treatment, Quick buy bank only, capexPosting fixes, line lock, coverage, ids, H25 OpEx)
- critic_tax_people_0.json violation 6 (CapEx WHT via the one resolver; authority not code)

## What to build

**capexPosting.ts:** delete capexLinkNote and the 'capex-line:' notes link — `findCapitalisedAssets` uses FixedAsset.capexLineId (status ≠ voided).
`capexAdvancesForLine(tenantId, lineId, db)` reads each payment's live entry through `liveRevision(…, tx)` (critic: liveRevisionsFor ignored the
tx — Quick buy's in-tx capitalisation must see the payment it just posted). `payableCodeForLine` (2012, or 2010 for legacy lines whose acquire
credited 2010) applies whether or not a live entry exists. TREATMENT_OF_CODE += {1360: deposit, 2012: capital}; the 'live money credit' is the
credit line that is NOT 2040. `capexTreatmentOf(line, projectType)`: **the line's treatment is the ONLY override** (remove the payment-level
`treatment` body field in routes.ts:~536 and opts.treatment); architect/design/project-consultant fees → capital on kitchen_buildout/refurb/
expansion/new_brand (H26); broker/legal → expense (6110); security/refundable deposit → deposit (1360); rent advance → prepaid (1310).
`syncCapexPaymentPosting` (syncSourcePosting 'capex.payment:<paymentId>', keepLiveDate when appropriate): WHT via **lib/withholding.ts
computeWithholding** with section = line.whtSection ?? supplier.defaultWhtSection ?? defaultSectionForCapex(treatment, projectType), base = gross −
input tax, exemption = the SUPPLIER's certificate (no per-payment exemption ref) + whtOverrideReason; fixed into whtCents/whtSection/whtRateBps/
filerStatus when first marked paid and recomputed from the fixed whtRateBps when the amount is edited; WHT never on deposits; 0 while the
company's withholding is off (opexAccounts' capex cases must keep passing). Input tax via `inputTaxCodeFor(line.inputTaxAuthority)` (never a free
code). Lines by treatment exactly as the FA plan (capital Dr 1340 / Cr money net / Cr 2040; after capitalisation Dr payableCodeForLine; prepaid Dr
1310; deposit Dr 1360 gross; expense Dr 6110). Guards 409 ADVANCE_APPLIED_TO_ASSET / PREPAID_RELEASING / DEPOSIT_RECLASSED; new prepaid payments
need coversFrom + coversMonths (422 PREPAID_TERM_REQUIRED) — legacy rows without coverage are flagged capex_prepaid_unscheduled by the worker.
`prepareCapitalisation(input, actor)` → fixedAssets/events.createRequest('capitalise') — EVERY capitalisation goes to the CEO (owner question
listed; today's ADMIN_ONLY control kept); the CEO's own preparation applies at once. `capexLedgerState` keyed on capexLineId, excludes
disposed/voided (M-04), adds disposedCents, whtCents, releasedCents, depositHeldCents. **Cash seam:** `recordCapexPaymentFromCashTx(tx, {
tenantId, lineId, spendLineId, amountCents, paidAt, creditCode, actorId })` creates a CapexPayment (source 'cash', paid) and posts
'capex.payment:<paymentId>' Dr 1340 / Cr creditCode (1011 for a box spend, 1355 for a cash-request settlement), no WHT; the project's company must
equal tenantId (else 422) and must exist (422 PROJECT_HAS_NO_COMPANY); the one-time guard is PettyCashSpendLine (tenantId, capexPaymentId)
(the caller writes it).
**accounting/prepaidReleases.ts — ONE source-agnostic engine (decision P7, critic H25-for-OpEx):** PrepaidRelease rows keyed (tenantId,
sourceType, sourceId, period); `releasePrepaidThrough(tenantId, throughPeriod, opts)` loops sources: 'capex_payment' (treatment prepaid: Dr 6010
(project.conceptId; null = shared) / Cr 1310) and 'opex_payment' (OpexPayment.treatment 'prepaid': Dr the category's expense code (line conceptId) /
Cr 1310 — the 1310 debit at payment is posted by w2-taxbooks); straight line over coversMonths from coversFrom (floor, remainder in the last
month); key 'prepaid.release:<sourceType>:<sourceId>:<YYYY-MM>' via syncSourcePosting with keepLiveDate + lateDatingFor (postedPeriod); never past
the source's live 1310 debit; refusal → flagPostingFailed (sourceType 'prepaid.release', entityType CapexPayment|OpexPayment, sourceId = payment id).
`releaseSourceThrough(sourceType, sourceId, period, opts)` for the reposter. `prepaidCloseChecks: CloseCheck[]` ('prepaid_release' block when a
completed month is unreleased; fix = run the release). Deposit return / reclass / orphan reverse functions live in capexPosting.ts.
**financePlanning/routes.ts:** line create/patch (supplierId → `assertSupplierOfCompany(project.tenantId)` 422; treatment locked after a payment
posts 409 TREATMENT_LOCKED; inputTaxCents + inputTaxAuthority; whtSection); **lock a capitalised or pending line** — PATCH line quantity /
unitCostCents / negotiatedCents / delivery & installed dates and the quote-winner route (~480-505) → 409 LINE_CAPITALISED (void and recapitalise);
payment create/patch (coversFrom/coversMonths, whtOverrideReason; no treatment field); DELETE line/project → 409 LINE_HAS_POSTINGS /
PROJECT_HAS_POSTINGS; capitalise route (~683-723) FA_WRITERS ['admin','owner','management','finance'] with body {classKey, inServiceAt?,
usefulLifeMonths?, salvageCents?, name?, locationId? (NEW field — assertLocationOfCompany), pool {typeKey, conceptId?}, costCents?} → 202 pending
(non-CEO) / 201 applied (CEO); errors per the FA plan. **Quick buy POST /finance/capex/quick-buy — BANK ONLY** (critic: no cash → 1010; cash
equipment comes only through the cash-request / petty-cash capex line): standing project per location (projectType 'equipment_only', isStanding,
the ACTIVE company); resolve EVERY client id to the active company (locationId, conceptId, supplierId, bankAccountId, pool conceptId → 422); one tx:
standing project → line (delivered today) → payment (posts) → capitalise request (applied for the CEO). Deposit-return, reclass-deposit (dry run
first), orphan reverse routes. GET /finance/capex(+/:id) add assetClasses, lookups.suppliers (system suppliers excluded), lookups.pools,
per-line capitalisation {assetIds, pendingEventId}, per-payment whtCents/releasedCents, books.disposedCents. Remove the ASSET_CATEGORIES imports
(use fixedAssets/classes.ts).
**companyRefs.ts:** `assertSupplierOfCompany(tenantId, supplierId)` (422 SUPPLIER_NOT_IN_COMPANY; a null project company → 422 PROJECT_HAS_NO_COMPANY).

## Contracts you consume (already on disk when you start)

- w1-fa-engine: createRequest/applyEvent, ASSET_CLASS_DEFAULTS/getAssetClasses, postAcquisition, nextAssetTag, findOrCreatePool.
- w1-taxcore: computeWithholding, defaultSectionForCapex, inputTaxCodeFor.  w0: liveRevision(…, tx), keepLiveDate, lateDatingFor, PrepaidRelease model, CloseCheck.


## Contracts you expose (later waves code against these — keep the names and signatures)

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


## Tests

Your database: `servd_test_wb_w2_fa_capex`. Your Redis: `redis://127.0.0.1:6390/12`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_fa_capex REDIS_URL=redis://127.0.0.1:6390/12 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_fa_capex REDIS_URL=redis://127.0.0.1:6390/12 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
