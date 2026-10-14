# Wave B builder brief — w4-docs: Runbooks for finance, the CEO, cashiers and IT; module READMEs; the D1/D3 spec amendment

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W4** · Area: **all areas — runbooks and READMEs** · Docs agent — no database, no tests to run
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

docs/*.md (new + updated), backend module READMEs not owned by another agent, workers/README.md, .handoff/fixes/D1D3-spec.md amendment.

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

- `docs/fixed-assets.md (new)`
- `docs/food-cost.md (new)`
- `docs/cash-requests-and-petty-cash.md (new)`
- `docs/on-account.md (new)`
- `docs/emergency-overrides.md (new)`
- `docs/raast.md`
- `docs/TAX_SETUP.md`
- `docs/pos-connector-api.md`
- `backend/src/workers/README.md`
- `backend/src/modules/accounting/README.md`
- `backend/src/modules/inventory/README.md`
- `backend/src/modules/procurement/README.md`
- `backend/src/modules/orders/README.md`
- `backend/src/modules/pos/README.md`
- `backend/src/modules/dispatch/README.md`
- `backend/src/modules/rider/README.md`
- `backend/src/modules/riders/README.md`
- `backend/src/modules/complaints/README.md`
- `backend/src/modules/crm/README.md`
- `backend/src/modules/storefront/README.md`
- `backend/src/modules/reports/README.md`
- `backend/src/modules/invoices/README.md`
- `backend/src/adapters/whatsapp/README.md`
- `backend/src/connectors/README.md`
- `backend/src/lib/README.md`
- `backend/src/modules/README.md`
- `.handoff/fixes/D1D3-spec.md (amendment section only)`

## Read first

- every plan_*.json summary + removes + assumptions; schema-merged.prisma.md §0; chart-merged.md; this wave's build-waves.md (what was built)
- the code on disk (W1-W3 are merged when you start) — document what IS there; if code and plan differ, the code wins and you note it

## What to build

Write for the reader named in each doc; plain English; no emoji; dated 2026-10-14; never put a secret, a card code or a phone number in a doc.
- **docs/fixed-assets.md** (finance + CEO): buying through CapEx and Quick buy (bills refuse equipment); capitalisation approval; smallwares pools,
  counts and write-offs; the automatic monthly run and late months; period close; disposals and approvals; the 1340 advances report; tie-out; tax-year
  freeze; deferred tax report; rent prepayments and deposits (H25).
- **docs/food-cost.md** (CEO, finance, F&B manager, chefs): FIFO lots (H16), the PACKAGING RULE (owner, 2026-10-13, final: every dish has a Packaging
  section; it counts on takeaway and delivery, on every order at a brand whose primary service vessel is packaging (Stackd), and on dine-in at a
  plate brand only when staff tap "Box given"; the brand's vessel is chosen when the brand is created; target MC per order type; the Q factor is
  the only pricing allowance), receiving + GRNI (H17), cash food buys through receiving, waste /
  returned food / remakes, spot and opening counts (H19), brand-less splits (H20), issue on receipt, the variance report and what each bucket means,
  the cut-over and the alignment line, per-outlet stock is the next build.
- **docs/cash-requests-and-petty-cash.md** (everyone / Jamil sb / finance): raising, HOD, director, paying (advance), receipts, change, overdue (H3/H4),
  top-ups from the Garibsons cashier (H1, 2210), the safe, a bank, a till; returns; counts; the tie-out; the history backfill.
- **docs/on-account.md** (finance, cashiers, the CEO): clients, limits, approvals, QR cards, charging at the till, statements (not tax invoices — H14),
  payments, client withholding (H13), bad-debt write-off (H15, CEO approves every one), till clearing 1115.
- **docs/emergency-overrides.md** (RGM / chef / F&B manager): code-only delivery, sending the code to the rider, food came back, strikes and blocks per
  company, ban appeals.
- **docs/raast.md:** 'void, never booked' (CEO only) and contra 1115; wrong-brand QR unchanged. **docs/TAX_SETUP.md:** delivery GST (H9), kept deposits
  (H10), breakage (H11), card payouts (H12), input tax by authority (H8), WHT rates + register, customer withholding (H13), statutory payments (H7).
  **docs/pos-connector-api.md:** a dated '2026-10-14 — delivery charge taxed (backward compatible)' paragraph (the DELIVERY-CHARGE line,
  totals.deliveryChargeCents 0 for these sales, legacy unchanged, version stays 1) + the on_account tender (PaymentMode cash) — KEEP every existing
  identity string backend/tests/integrationPass2Books.test.ts asserts.
- **READMEs** (the ones you own): each module's new routes, postings and rules in its existing style; workers/README.md lists depreciation (03:20),
  intercompanyFleet (03:40), tillClearingSweep (03:10), cashAdvanceOverdue (09:10), onAccountDaily (09:20), codCustody (every 30 min) and the
  giftCardExpiry breakage note.
- **.handoff/fixes/D1D3-spec.md:** an amendment section — 2100-2149 reserved for head-office due-to, 2150-2199 inter-company due-to, 6990 the one
  recovery account shared with inter-company fleet charges, Account.controlledBy 'head_office' already exists, the transfer source CHECK must add
  'ho_recharge' when D1 lands.

## Contracts you consume (already on disk when you start)
- Everything merged in W1-W3 (read the code).

## Contracts you expose (later waves code against these — keep the names and signatures)
(docs only — none)

## Checks

Docs agent — no tests. Check `grep -n` that every identity string integrationPass2Books.test.ts reads from docs/pos-connector-api.md is still present.


## Rules for this docs agent (CLAUDE.md applies in full)

1. **Ownership.** Edit ONLY the files listed under "You own". If a code comment or another agent's README is wrong, say so in your report.
2. Document what the code on disk DOES (W1-W3 are merged when you start); where code and plan differ, the code wins — note the difference.
3. Plain English, no emoji, no secrets, no card codes, no real phone numbers, no customer data. Brand names: Stackd, Simmer, Flipd.
4. No builds, no tests, no commits.


## Report format (your final message is the return value — no separate report file)

1. Files created / changed / deleted (paths).
2. Routes added/changed: method, path, guard (roles), module gate, scope mode, body, responses, error codes.
3. Postings: Dr/Cr, `sourceType:sourceId`, company source, date rule, where it runs (which transaction).
4. Contracts you EXPOSE (exact TypeScript signatures, file paths) — later waves code against these.
5. Tests: files written/updated, the exact command run, pass/fail counts; failures you believe belong to another agent's in-flight work.
6. `tsc` result for your files.
7. Patch notes: exact snippets for files you do not own (orchestrator or the next owner applies them).
8. Deviations from this brief and why; owner/accountant questions still open (with the default you built); anything still wrong.
