# Wave B builder brief — w1-bans: Strikes and bans per company, ban appeals via the help desk, complaint readers filtered

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W1** · Area: **delivery (strikes, bans, appeals)** · Test DB **`servd_test_wb_w1_bans`** · Redis **`redis://127.0.0.1:6390/6`** (index 6) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

lib/strikes.ts, crm, complaints (+ appeals), storefront banAppealRoutes, WhatsApp APPEAL, per-company ban readers everywhere.

Files you own may be edited again by a LATER wave's owner (see shared-files.md): leave clean seams and say in your report what the next owner must know.


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

## Read first

- plan_delivery.json: summary (strikes/bans/appeals), schema (CustomerStrike, OrderComplaint), routes (blocks, appeals, complaints, crm), build_split C, data_migration 1-3
- critic_cash_delivery_onaccount_0.json: violations 4, 5, 10; missing (OrderComplaint readers, release-contact, WhatsApp check at brand pick, conceptSlug resolution, cod_unpaid manual kind, lift keeps strikes)

## What to build

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

## Contracts you consume (already on disk when you start)

- w0: CustomerStrike.tenantId, OrderComplaint kind/banId/contactPhone + relation, partial uniques, migration backfill + split of legacy
  multi-company auto-bans, GATED '/complaints' + '/crm/bans/:id/(lift|release-contact)' rules.


## Contracts you expose (later waves code against these — keep the names and signatures)

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


## Tests

Your database: `servd_test_wb_w1_bans`. Your Redis: `redis://127.0.0.1:6390/6`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w1_bans REDIS_URL=redis://127.0.0.1:6390/6 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`strikesPerCompany` (2 strikes at A + 1 at B → no ban; third at A → ban tenantId A; A checkout BANNED with details, B allowed; reversing one A
strike lifts A's auto-ban only; racing promotions → one ban; a staff ban at B does not stop A's auto-ban; B's manual strike/ban on a customer of A
only → 404; marketing audience and referral check per company). `banAppeals` (blocks lists matching bans only; appeal lands on an A brand; B's
complaints list doesn't show it and B's PATCH → 404; fnb_manager (complaints, no crm) lifts through the widened gate and the appeal resolves;
second open → 409; decline then re-appeal < 30 days → 429; release-contact clears the phone on the ban AND the account; PATCH 'resolved' on an
appeal → 409; WhatsApp APPEAL creates one appeal with contactPhone = sender; GET /complaints/stats scoped; complaint follow-up never targets an
appeal). Update `sepCrm` to the column-based attribution.



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w1_bans REDIS_URL=redis://127.0.0.1:6390/6 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
