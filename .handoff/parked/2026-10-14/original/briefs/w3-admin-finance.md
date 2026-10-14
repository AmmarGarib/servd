# Wave B builder brief — w3-admin-finance: Admin finance pages: sales-tax return (H8-H13 rows, withholding rates/register), card payouts, COD tab, petty-cash history backfill, OpEx tax/WHT, gift-card breakage, settings

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **admin UI — tax, reconciliation (card payouts, COD, backfill), operations config, OpEx, gift cards, delivery zones** · UI agent — no database, no tests to run
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

UI only — reconciliation page + tabs, sales-tax-return pages, OpEx page, gift cards, delivery zones, operations config.

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

## Read first

- plan_tax.json: build_split T6-admin-ui, routes (withholding, card payouts, opex wht-quote, gift cards)
- plan_delivery.json: build_split E (CodTab only); plan_cash.json: critic 7 (history backfill UI lives in BackfillUnposted.tsx); plan_people.json: statutory rows filtered on the return
- the backend route files on disk: accounting/withholdingRoutes.ts, reconciliation/cardPayoutRoutes.ts + codRoutes.ts + pettyCashBackfillRoutes.ts, opex/routes.ts, giftCards/routes.ts, setup/routes.ts

## What to build

1. **Sales tax return page:** new rows Delivery charges, No-show deposits kept, per authority 'Withheld by customers (1335)' and 'Net after withholding';
   statutory challans (salary tax / EOBI / SESSI) are NOT listed among the return's payments (they live on Accounting → Statutory payments); the
   record-payment dialog gains 'Withheld by customers set off' (shows the available amount from the API; 422 NO_WITHHELD_SET_OFF in words). Tabs
   'Withholding rates' (WithholdingRates.tsx — editable for admin/finance via PUT /accounting/withholding/rates, read-only otherwise by the API's
   capability flag) and 'Withholding register' (WithholdingRegister.tsx — table + CSV link). README.
2. **Reconciliation:** CardPayouts.tsx — settings card (payout bank via BankAccountSelect, MDR %, tax on fee %, lag days, tolerance, unit), settlements
   list, unsettled card days, Re-run, Undo for approvers; mount it in page.tsx with a 'Card payout' chip on matched lines and a 'Card payout?' action on
   unmatched credits of the payout bank (suggestions → Confirm; 409 USE_CARD_PAYOUT_CONFIRM / CARD_PAYOUT_LINE in words). CodTab.tsx — COD with
   rider / overdue / owed by rider (GET /reconciliation/cod?status=…) with 'Book as owed by rider' (reason; finance) and the legacy option when the
   API offers it. BackfillUnposted.tsx — a 'Petty-cash history' section (CEO): dry run table (per company historic top-up source pick, Garibsons or
   Safe, with the resulting 1010 balance and a warning when it goes negative), picks for needs_category / needs_review, then Post (POST
   /reconciliation/backfill-petty-cash; 409 BACKFILL_RUNNING). Remove the MissedBillVariances mount and delete MissedBillVariances.tsx (its route is
   gone). README.
3. **OpEx page:** line form — Vendor picker (GET /procurement/suppliers?view=picker&categoryId=…, 'Add in Procurement' link when canOpenPath), WHT
   section, usual tax authority, prepaid term (coversFrom / coversMonths) for rent advances; mark-paid form — invoice amount (incl. sales tax), sales
   tax + 'Charged by', WHT from /opex/wht-quote (rate, filer chip, amber 'Check ATL status' when needsAtlCheck), cash paid, override + reason;
   BankAccountSelect; equipment refusal (422 USE_CAPEX) explained with a link to CapEx Quick buy.
4. **Gift cards:** the void dialog offers 'Keep the money (breakage — other income, no sales tax)' for sold cards to admin only (the API decides —
   show what it allows); the drawer shows breakage amount/date and 'held' when the issue was never booked; the books check shows breakage.
5. **Delivery zones:** fee label 'Fee (before GST)' + helper 'GST is added at checkout at the brand's rate: 15 % cash, 8 % card or Raast'.
6. **Operations config:** the withholding % input becomes a link to Accounting → Sales tax return → Withholding rates (the on/off switch stays);
   a 'Cash requests: receipts due within (days)' field (cashAdvanceSettleDays 1-365).
All pages: tokens only, money typed in rupees, server figures shown as given (no tax maths in the browser), every error code in words, phone width.

## Contracts you consume (already on disk when you start)

- w1-taxcore withholding routes; w1-recon card payout routes; w2-dlv-cod codRoutes; w2-cash-ledger backfill route; w2-taxbooks OpEx routes + wht-quote;
  w1-taxsales gift-card routes; w1-taxcore (W1) already dropped withholdingTaxPct from PATCH /setup/operations-config and added cashAdvanceSettleDays
  (1-365) — the page must not send withholdingTaxPct.


## Contracts you expose (later waves code against these — keep the names and signatures)
(UI only — none)

## Checks

UI agent — no tests. Run `npx tsc --noEmit -p .` in frontend/admin and make your files clean. Manual checklist for the orchestrator's screenshots: the
return page with the new rows as finance; withholding rates read-only for management; card payout confirm flow; COD tab as finance; petty-cash
history dry run as the CEO; OpEx mark-paid with WHT quote; gift-card breakage option visible only to the CEO; phone width without horizontal scroll.


## Rules for this UI agent (CLAUDE.md applies in full)

1. **Ownership.** Edit ONLY the files listed under "You own". Backend files and every file another agent owns: put the exact snippet in your
   report ("patch notes"). The API contract is the one in this brief and in the backend agents' files already on disk (read them: route
   files, zod schemas, response shapes). If the API on disk differs from this brief, follow the API on disk and report the difference.
2. **Admin:** tokens only (`var(--erp-*)`, `rgb(var(--x-rgb) / a)`, `color-mix(in srgb, <token> 10%, transparent)`, `s-badge-*`,
   `text-success`); purple = actions/identity, green = state/good news (switches on, selected chips, progress, paid/on-target), red = bad;
   never hard-code a colour or append hex alpha; no emoji structural icons; money typed in RUPEES and converted to paisa; plain English;
   works at phone width with no horizontal scroll; every error code the API returns is shown in words; never a local role list — use
   `lib/roles.ts` or the capability flags the API returns (canApprove, canVoid …); pages call only paths their module can open
   (`canOpenPath`).
3. **Storefront / mobile / tablet / rider:** servd pages use `--servd-*` tokens (white, green #87c540 primary with deep-purple text,
   purple #6a0dad secondary); brand pages keep their own palettes; brand names through `formatBrandName()`; no emoji on storefront or the
   web rider; SVG or text labels only.
4. **No builds, no dev servers, no tests to run, no commits.** Run `npx tsc --noEmit -p .` in each app you touched and make YOUR files clean
   (report errors in files you do not own). The orchestrator runs the builds and screenshots in wave Z.


## Report format (your final message is the return value — no separate report file)

1. Files created / changed / deleted (paths).
2. Routes added/changed: method, path, guard (roles), module gate, scope mode, body, responses, error codes.
3. Postings: Dr/Cr, `sourceType:sourceId`, company source, date rule, where it runs (which transaction).
4. Contracts you EXPOSE (exact TypeScript signatures, file paths) — later waves code against these.
5. Tests: files written/updated, the exact command run, pass/fail counts; failures you believe belong to another agent's in-flight work.
6. `tsc` result for your files.
7. Patch notes: exact snippets for files you do not own (orchestrator or the next owner applies them).
8. Deviations from this brief and why; owner/accountant questions still open (with the default you built); anything still wrong.
