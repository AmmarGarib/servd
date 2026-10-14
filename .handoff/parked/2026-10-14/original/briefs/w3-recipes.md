# Wave B builder brief — w3-recipes: Recipe Packaging section on every dish (used by order type / brand vessel / Box given), brand service vessel, modifier recipes, costing on real packaging

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **foodcost (recipes: packaging on every dish, modifier recipes, costing)** · Test DB **`servd_test_wb_w3_recipes`** · Redis **`redis://127.0.0.1:6390/20`** (index 20) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

recipes/routes.ts (+ par-sheet if it assumes every line is food), recipe admin pages, KitchenRecipe, modifiers page.

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

- `backend/src/modules/recipes/routes.ts`
- `backend/src/modules/recipes/README.md`
- `backend/src/modules/par-sheet/routes.ts (only if packaging lines break it)`
- `frontend/admin/src/app/accounting/recipes/RecipeForm.tsx`
- `frontend/admin/src/app/accounting/recipes/page.tsx`
- `frontend/admin/src/app/accounting/recipes/[id]/page.tsx`
- `frontend/admin/src/app/accounting/recipes/KitchenRecipe.tsx`
- `frontend/admin/src/app/configuration/modifiers/page.tsx`
- `backend/src/modules/concepts/routes.ts (W3: serviceVessel on create / PATCH only)`
- `backend/src/modules/concepts/README.md`
- `backend/src/modules/tenants/routes.ts (W3: serviceVessel on the company-create first brand only)`
- `backend/tests/recipePackaging.test.ts (new)`
- `backend/tests/modifierRecipes.test.ts (new)`
- `backend/tests/serviceVessel.test.ts (new)`
- existing recipe suites (grep tests/ for "'/recipes" — except wave3Kitchen / wave3Gates, which are w3-fc-report's: send a patch note)

## Read first

- plan_foodcost.json: RECIPES paragraph of summary, routes (recipes), build_split D + the recipe part of G
- critic_assets_foodcost_1.json: violations 1 (no plate wear; Q factor is the one allowance), 6 (RecipeKind 'modifier'), 11 (costing-preview, by-item, KitchenRecipe)
- schema-merged.prisma.md decision P1 + §3.22 (the FINAL owner packaging rule: order type + brand service vessel + 'box given'; no plateWearPct, no servedWhen)

## What to build

**THE packaging rule (FINAL owner rule — see the common brief):** every PLATE recipe ALWAYS has an optional Packaging section (all brands).
Whether a sale uses it is decided at the sale (w2-sale `packagingApplies`): takeaway/delivery → yes; a brand whose primary service vessel is
'packaging' (Stackd) → yes on every order; dine-in at a plate brand → only when staff tap "Box given". So a recipe CAN be approved without
packaging (a dine-in-only plate brand is valid); costing shows plate MC (food + drinks) AND target MC per order type (dine-in / takeaway /
delivery) = plate MC + packaging where it applies for that brand. A packaging-vessel brand's recipe with NO packaging line → a warning
('Stackd serves in packaging — add the vessel') on the recipe and in the report, never a block. NO servedWhen per line, NO plate-wear %
(the existing `qFactorPct` is the ONLY pricing allowance: plate wear, garnish, oil — pricing only, never stock, never posted).
**recipes/routes.ts:**
- DELETE the GET /recipes/food-cost handler (~1356-1495) and the imports only it used — the path now answers 404 (the report lives at
  /reports/food-cost, w3-fc-report; w0 added the admin redirect).
- ingredientSchema gains `section: z.enum(['ingredients','packaging']).default('ingredients')`. Validation (one helper used by create, update,
  PUT and costing-preview): a packaging-class item (`costClassOf(item.category) === 'packaging'`) in 'ingredients' → 422 PACKAGING_SECTION_ONLY;
  a non-packaging item in 'packaging' → 422 NOT_PACKAGING; a packaging section on a component (sub-recipe) or a modifier recipe → 422
  PACKAGING_ON_PLATES_ONLY; an item not of the recipe's company (plate → its brand's company; modifier → modifier → group → menu item → brand) →
  422 ITEM_NOT_IN_COMPANY; a company-less item → 422 ITEM_HAS_NO_COMPANY.
  Legacy rows (verifier): migration backfill 15 moves packaging-class items to 'packaging' on PLATE recipes only, so a sub-recipe that already
  holds a packaging-class item in 'ingredients' must stay editable — validate only NEW or CHANGED lines (an untouched legacy line passes, with a
  'packaging item in a sub-recipe' warning), never refuse the whole save because of a line the user did not touch.
- recipeShape: `packagingPct` dropped from input (ignored if sent, never written — the column is retired); `qFactorPct` unchanged; `modifierId?`.
- **Packaging warning (not a block):** a plate recipe of a brand whose serviceVessel is 'packaging' with no packaging line returns a
  `warnings: ['PACKAGING_MISSING']` on save/approve and in costing-preview; plate brands get no warning (dine-in-only dishes are valid).
- **Modifier recipes** (RecipeKind 'modifier', w0 enum): `kind: 'modifier'` + `modifierId`, no menuItemId, no packaging; one recipe per modifier
  (409 MODIFIER_HAS_RECIPE); the modifier → group → menu item → brand chain must be in CREATE scope (foreign → 404; a cross-company attach → 422
  MODIFIER_NOT_IN_COMPANY); negative quantities ('removes', e.g. "no cheese") ONLY on modifier recipes (422 NEGATIVE_QTY_NOT_ALLOWED elsewhere —
  the consumption clamps at zero per line, w2-sale). Adjust the superRefine and every list filter that assumed kind ∈ {plate, component}.
- **Costing** (GET /:id/costing ~711-900, POST /costing-preview ~598, GET /by-item/:menuItemId ~903 — critic): read the w2-sale `RecipeCost`:
  `stockByClass` { food, beverage, packaging }, `packagingCents`, `standardCents` (= food + drinks = the plate MC), `targetMcCents` { dine_in,
  takeout, delivery } (plate MC + packaging where it applies to that order type for the brand's vessel), `qCents` (Q factor allowance).
  plateCostCents = standardCents; break-even and target price use the brand's main order type's target MC (dine_in for a plate brand, which
  equals plate MC; any order type for a packaging brand) + qCents where the formula used the Q factor — the `packagingFactor` (packagingPct) is
  gone; profitability per order type uses the real packaging lines. Detail and list return
  `warnings`: outsideCompany[] (lines whose item is another company's), costedWhileUnapproved (status ≠ production on a live menu item), noPackaging
  (a plate recipe of a PACKAGING-vessel brand with no packaging line; false for plate brands). by-item returns lines grouped by section so the
  kitchen sees what to pack in.
- **Brand service vessel (concepts/routes.ts + tenants/routes.ts, W3 parts only):** POST /concepts requires `serviceVessel: z.enum(['plate',
  'packaging'])` (no default on the API — 400 when missing; the owner wants the choice made at brand creation); PATCH /concepts/:id accepts it
  (write scope, foreign → 404), audited 'concept.service_vessel' with from/to; the company-create route that makes the first brand (tenants/routes.ts
  ~447 / ~481) requires it for that brand too. GET responses include it. A change applies to lines rung up from then on (OrderItem.serviceVessel
  snapshot, w2-sale) — say so in the audit note. concepts/README.md: one paragraph.
- par-sheet/routes.ts: if it explodes recipes into prep quantities, skip packaging-section lines (packaging is not prepped). Touch nothing else.
- recipes/README.md: the packaging rule, sections, modifier recipes, costing fields.
**Admin:** RecipeForm.tsx — a Packaging section on every plate recipe (item picker limited to packaging-class items; NO per-line order-type
choice; helper text 'Used on takeaway and delivery, on every order at a brand that serves in packaging, and on dine-in when staff tap Box
given'); the packaging % field removed; Q factor relabelled 'Q factor — pricing allowance (plate wear, garnish, oil); not stock'; warnings as
banners (outside company and costed while unapproved — red; no packaging at a packaging brand — amber, Approve stays enabled); modifier mode (menu
item → modifier group → modifier pickers; negative quantity allowed with the label 'removes'). recipes/page.tsx — a 'No packaging' badge (amber,
packaging brands only) and a filter. [id]/page.tsx — cost breakdown Food / Drinks / Packaging, plate MC, and target MC for Dine-in / Takeaway /
Delivery (from targetMcCents), with the Q allowance on its own line labelled 'in menu pricing, not stock'. KitchenRecipe.tsx — shows the Packaging section ('Pack in'). configuration/modifiers/page.tsx — an 'Ingredients' action
per modifier opening (or creating) its recipe. Tokens only; plain English; phone width.

## Contracts you consume (already on disk when you start)

- w2-sale: lib/recipeCost.ts (RecipeCost.stockByClass / packagingCents / standardCents / qCents, packagingApplies). w0: RecipeIngredient.section,
  Recipe.modifierId, RecipeKind 'modifier', lib/inventoryClass.ts costClassOf.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// GET /recipes/:id/costing (and POST /recipes/costing-preview) response additions
{ stockByClass: { food: number; beverage: number; packaging: number }; packagingCents: number; standardCents: number; qCents: number;
  targetMcCents: { dine_in: number; takeout: number; delivery: number };
  warnings: { outsideCompany: Array<{ lineId: string; itemName: string }>; costedWhileUnapproved: boolean; noPackaging: boolean } }
// recipe error codes: PACKAGING_SECTION_ONLY, NOT_PACKAGING, PACKAGING_ON_PLATES_ONLY, ITEM_NOT_IN_COMPANY,
//   ITEM_HAS_NO_COMPANY, MODIFIER_HAS_RECIPE, MODIFIER_NOT_IN_COMPANY, NEGATIVE_QTY_NOT_ALLOWED
```


## Tests

Your database: `servd_test_wb_w3_recipes`. Your Redis: `redis://127.0.0.1:6390/20`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_recipes REDIS_URL=redis://127.0.0.1:6390/20 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`recipePackaging` (two companies): packaging item in ingredients → 422; non-packaging item in packaging → 422; packaging on a sub-recipe → 422; approve a
a Stackd (vessel 'packaging') recipe with no packaging → saved with warning PACKAGING_MISSING, a Simmer (plate) one → no warning; costing:
target MC dine-in = plate MC for Simmer, = plate MC + packaging for Stackd; target MC takeaway/delivery = plate MC + packaging for both; qCents reported apart and never inside standardCents;
packagingPct sent → ignored; GET /recipes/food-cost → 404; A's recipe with B's packaging item → 422 ITEM_NOT_IN_COMPANY; B → 404 on A's recipe;
warnings noPackaging / outsideCompany / costedWhileUnapproved. `modifierRecipes`: create for own modifier; B's modifier → 404; cross-company attach → 422
MODIFIER_NOT_IN_COMPANY; second recipe → 409; negative qty only on modifier recipes; costing-preview and by-item include sections.
`serviceVessel` (two companies): POST /concepts without serviceVessel → 400, with 'packaging' → stored; company create without it for the first brand
→ 400; PATCH by B on A's brand → 404; PATCH writes the audit with from/to; an order line rung up before the change keeps its snapshot.



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_recipes REDIS_URL=redis://127.0.0.1:6390/20 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
