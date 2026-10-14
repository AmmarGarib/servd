# Wave B builder brief — w2-sale: Recipe explosion with packaging by order type + brand vessel + Box given, per-line FIFO depletion, cancel/void/return semantics, orders/service.ts

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W2** · Area: **foodcost (sale side) + delivery/tax hooks in orders** · Test DB **`servd_test_wb_w2_sale`** · Redis **`redis://127.0.0.1:6390/9`** (index 9) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

lib/recipeCost.ts, orders/stock.ts, inventory/voidWaste.ts, orders/service.ts (all merged), pos/service.ts (FC part).

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

- `backend/src/lib/recipeCost.ts`
- `backend/src/modules/orders/stock.ts (new)`
- `backend/src/modules/orders/service.ts`
- `backend/src/modules/inventory/voidWaste.ts`
- `backend/src/modules/pos/service.ts (FC part only — W2)`
- `backend/tests/orderStock.test.ts (new)`
- `backend/tests/packagingDepletion.test.ts (new)`
- `backend/tests/modifierStock.test.ts (new)`
- `backend/tests/cancelReturnedHook.test.ts (new)`
- `backend/tests/recipeCost.test.ts`
- `backend/tests/integrationPass2Orders.test.ts`
- `backend/tests/auditTillShift.test.ts`
- `backend/tests/auditOrdersFollowup.test.ts`
- `backend/tests/managerVoids.test.ts (FC void parts, W2)`
- `backend/tests/resimTill.test.ts (W2: the void_after_fire / stock.sale_deplete / Cr 1210 cases — verifier: unowned otherwise)`
- `backend/tests/auditOrdersRefund.test.ts (W2: the deductInventoryForOrder / cancel restore cases only)`

## Read first

- plan_foodcost.json: summary SALES, extends_existing (recipeCost, orders/service, voidWaste, pos/service), shared_file_changes orders/service + pos/service, build_split A
- plan_delivery.json: shared_file_changes orders/service.ts (inCancelTx hook); plan_tax.json: shared_file_changes orders/service.ts
- critic_assets_foodcost_1.json: returned food (no auto-waste after pick-up), KDS recall remake, restore failure flag, RecipeKind 'modifier', company-less stock
- critic_cash_delivery_onaccount_0.json: cancelOrder audits in the order's company

## What to build

**THE packaging rule (decision P1 — FINAL owner rule, see the common brief):** a sold line consumes its dish's Packaging section ONLY when
`packagingApplies(order, line)` is true: takeaway / delivery (every off-premise fulfilment) → true; else the line's snapshotted brand service
vessel (OrderItem.serviceVessel, copied from Concept.serviceVessel at ring-up) is 'packaging' → true; else (dine-in at a plate brand) → true only
when OrderItem.boxGiven. This is THE one seam. `markBoxGiven(orderItemId, actor, { undo? })` (undo only until the order completes): the
line from write scope (foreign → 404), dine-in only (takeaway/delivery or a packaging-vessel line → 409 BOX_NOT_NEEDED, it already counts);
sets boxGiven/boxGivenAt/boxGivenById and, when the line's stock was already depleted, depletes the dish's packaging lots (FIFO, kind 'sale',
sourceType 'order_item.box_given', sourceId line.id — idempotent on the line, never twice); undo returns them to the same lots; audited
'order.box_given' / 'order.box_given_undo' in the ORDER's company. **Snapshot:** every OrderItem create in orders/service.ts (ingestOrder ~576
and the add-items paths ~1188 / ~1223) writes `serviceVessel` = the line's brand Concept.serviceVessel at that moment; a legacy line with null
reads the brand's current vessel.
**lib/recipeCost.ts (THE explosion/costing):** CostItem gains tenantId + category; recipe lines gain `section`; roots carry Recipe.modifierId/kind.
`consumptionForSoldLines(lines, db, { tenantId, fulfilmentType })` and per-line `consumptionPerLine` → `{ need, excluded }`: dish ingredients +
sub-recipes + the dish's modifier recipes (RecipeKind 'modifier', loaded per line from OrderItemModifier.modifierId) + the dish's Packaging
section (when packagingApplies). Negative 'removes' lines only on modifier recipes, clamped ≥ 0 per ingredient per line. Foreign or company-less
items are EXCLUDED (never consumed) and reported. `RecipeCost` gains `stockByClass` {food, beverage, packaging} (all depths, ex-Q),
`packagingCents`, `standardCents` (= food + drinks, the plate MC) and `targetMcCents` { dine_in, takeout, delivery } (= standardCents +
packagingCents where packaging applies to that order type for the recipe's brand vessel — the TARGET MC; dine_in at a plate brand = standardCents), `qCents` (Recipe.qFactorPct — pricing only,
never stock, never posted). `menuItemPlateCosts` and `cogsForSoldLines` keep their signatures (menu engineering + the legacy COGS fallback).
**orders/stock.ts (bodies moved from orders/service.ts; service.ts re-exports deductInventoryForOrder / restoreInventoryForOrder):**
- `deductInventoryForOrder(orderId)`: `ensureFifoReady(tenantId)` first (outside any tx); claim through the write-once 'stock.sale_deplete' audit
  row; per line `consumeFifoTx` (clamp, kind 'sale', sourceType 'order_item.sale', sourceId line.id, conceptId, order.locationId,
  theoreticalQty); after commit one open `recipe_foreign_stock` flag per (menuItem, company); the auto-86 moved unchanged.
- `restoreInventoryForOrder(orderId, { cookedFood?, actorId, approverId })`: unfired lines → `returnToLotsTx` (exact lots); fired lines →
  `wasteSoldLineTx` reason 'cancelled_after_fire' (food that never left the kitchen). Pre-cut-over orders use the old JSON path and return
  through 'legacy_return' lots at the head cost keyed by event (`'<orderItemId>:void'` / `':cancel'` — critic: no collision).
- `returnVoidedLineStockTx(tx, { orderId, tenantId, line })`, `ensureOrderDepleted(orderId)` (outside any tx), `wasteReturnedOrder(orderId,
  actor)` (fired lines still out on an ALREADY-cancelled order, once, same keys), `packagingApplies`.
**inventory/voidWaste.ts (FC + DL merged):** `wasteSoldLineTx(tx, { orderId, tenantId, line, wasteReason, actorId, conceptId })` — relabels the
line's net-out sale rows to sale_void + waste (stock unchanged), one WasteLog per item (tenantId, conceptId, orderItemId, FIFO value in
estimatedCostCents), `postVoidWaste` by class (Cr 1210/1220/1230 — packaging included) inside the tx, key 'pos.void_waste:<orderItemId>'.
Exports `VOID_WASTE_REASONS = ['void_after_fire','cancelled_after_fire','returned_food']`, `RETURN_WASTE_REASON = 'returned_food'`; keep
`wasteVoidedFiredLineTx` as an alias. A refusal leaves the waste logs standing and is flagged after commit (existing pattern).
**orders/service.ts — every merged change (you are the only W2 owner):**
- FC: the moves above; completeOrder `await ensureOrderDepleted(orderId)` before the claim tx; ingestOrder persists `modifierId` only when that
  Modifier belongs to a non-deleted ModifierGroup of the line's menuItem (else null); depletion today is fire-and-forget → on failure flag
  'stock_restore_failed' (and cancel restore/waste after commit: flag instead of console.error — critic; w4-integration adds the sweep).
- **KDS recall (~1805-1857, ItemStatus 'recalled'):** the remake re-cooks the line → book the line's recipe as waste reason 'remake' (consumeFifoTx
  kind 'waste', a WasteLog with orderItemId, `postWasteLog` key 'inventory.waste:<wasteLogId>' — each recall its own log), never silently.
- **Cancel semantics (FC + DL):** `CancelOrderInput.cookedFood?` and `CancelOrderInput.returned?: { cause, actorId, run(tx) }`;
  `transitionOrder(…, { inCancelTx })` runs `run(tx)` right after markPreBillsCancelledTx when the claim changed, inside the cancel tx, and
  returns its result. Default cancel: unfired lines return to lots, fired lines wasted 'cancelled_after_fire' — EXCEPT a delivery order with
  `pickedUpAt` set and not delivered: the generic cancel refuses **409 USE_EMERGENCY_OVERRIDE** ('the food is with the rider; log it in Emergency
  overrides when it comes back'); only the override (w3-dlv-return, via `returned`) books 'returned_food' with the manager as actor and skips
  the default waste for those lines. cancelOrder audits with the ORDER's company (concept.tenantId), not input.actor.tenantId (critic).
- TX: ingestOrder writes `deliveryFeeCents` / `deliveryFeeTaxCents` from `opts.price` (w1-taxsales already returns them).
**pos/service.ts — FC part only in W2 (w3-till owns the file in W3):** delete restoreVoidedLineStockTx + STOCK_DEPLETE / STOCK_RESTORE /
STOCK_VOID_RESTORE (~1926-1999); the void handler (~2171-2183) calls `returnVoidedLineStockTx` (unfired) / `wasteSoldLineTx(…, 'void_after_fire')`
(fired) with the same result shape for the existing flagging; compOrder / staff meal (~2424): `await ensureOrderDepleted(order.id)` then
`estimatedCostCents = await orderStockCostCents(order.id)`. Touch nothing else in pos/service.ts.

## Contracts you consume (already on disk when you start)

- w1-stock: consumeFifoTx, returnToLotsTx, relabelToWasteTx, ensureFifoReady, lockItemsTx; cogs.orderStockCostCents; inventoryPosting.postWasteLog.
- w0: RecipeKind 'modifier', Recipe.modifierId, RecipeIngredient.section, WasteLog columns, Order fee columns, lib/savepoint.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// lib/recipeCost.ts
export function packagingApplies(order: { fulfilmentType: string }, line: { serviceVessel: 'plate' | 'packaging'; boxGiven: boolean }): boolean
export async function markBoxGiven(orderItemId: string, actor: { id: string }, opts?: { undo?: boolean }): Promise<{ boxGiven: boolean; depleted: boolean }>
export function consumptionForSoldLines(lines: SoldLine[], db: Db, o: { tenantId: string; fulfilmentType: string })
  : Promise<{ need: Map<string, { qty: number; costClass: CostClass }>; excluded: Array<{ itemId: string; reason: 'foreign'|'company_less' }> }>
export interface RecipeCost { /* existing */ stockByClass: Record<CostClass, number>; packagingCents: number; standardCents: number; qCents: number;
  targetMcCents: { dine_in: number; takeout: number; delivery: number } }   // per the brand's vessel; dine_in excludes packaging at a plate brand
// orders/stock.ts
export function deductInventoryForOrder(orderId: string): Promise<void>
export function restoreInventoryForOrder(orderId: string, o: { cookedFood?: { wasteReason: 'cancelled_after_fire'; photoUrl?: string }; actorId?: string; approverId?: string }): Promise<void>
export function returnVoidedLineStockTx(tx: Tx, a: { orderId: string; tenantId: string; line: { id: string; quantity: number } }): Promise<{ valueCents: number }>
export function ensureOrderDepleted(orderId: string): Promise<void>
export function wasteReturnedOrder(orderId: string, actor: { id: string }): Promise<{ wasteCostCents: number }>
// inventory/voidWaste.ts
export const VOID_WASTE_REASONS: readonly ['void_after_fire','cancelled_after_fire','returned_food']
export const RETURN_WASTE_REASON: 'returned_food'
export function wasteSoldLineTx(tx: Tx, a: { orderId: string; tenantId: string; line: { id: string }; wasteReason: typeof VOID_WASTE_REASONS[number];
  actorId: string | null; conceptId: string | null }): Promise<{ wasteLogIds: string[]; wasteCostCents: number; postingError?: AppError }>
// orders/service.ts
export interface CancelOrderInput { /* existing */ cookedFood?: { wasteReason: 'cancelled_after_fire'; photoUrl?: string };
  returned?: { cause: 'refused'|'unreachable'|'other'; actorId: string; run: (tx: Tx) => Promise<ReturnedTxResult> } }
export function cancelOrder(id: string, input: CancelOrderInput): Promise<{ order: Order; returned?: ReturnedTxResult }>
```


## Tests

Your database: `servd_test_wb_w2_sale`. Your Redis: `redis://127.0.0.1:6390/9`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_sale REDIS_URL=redis://127.0.0.1:6390/9 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

Single company: every path writes exactly its movements and a replay writes nothing (sale, unfired void, fired void = sale_void + waste with stock
unchanged, cancel (fired wasted, unfired returned), returned_food via the hook); FIFO draws oldest first and returns go to the same lots;
shortfall clamps + auto-86 kept; **packaging (`packagingDepletion`): a Simmer (plate) DINE-IN sale depletes NO packaging and its target MC excludes
it; the same dish takeaway or delivery depletes the packaging; a Stackd (packaging vessel) dine-in sale depletes it; "Box given" on a Simmer dine-in
line depletes it once (a second tap and a replay write nothing; undo before completion returns it to the same lots; after completion → 409); Box
given on a takeaway line → 409 BOX_NOT_NEEDED; B → 404 on A's line; changing the brand's vessel later does not change an already rung-up line
(snapshot);** modifier recipe with a negative line clamps; legacy pre-cut-over order cancels through the JSON path with
event-keyed legacy_return lots; KDS recall books 'remake' waste once per recall; generic cancel of a picked-up delivery → 409 USE_EMERGENCY_OVERRIDE;
the returned hook runs inside the cancel tx and its waste replaces the default; cancel audit row carries the order's company; staff meal cost =
lot value. Two companies: a B order whose shared sub-recipe uses A's (or a company-less) item consumes nothing of A, writes no movement under A, one
recipe_foreign_stock flag in B; consumeFifoTx with a mismatched tenant throws; a modifierId of another menu item is stored null (through ingestOrder).
Update recipeCost, integrationPass2Orders, auditTillShift, auditOrdersFollowup (stock JSON → movements) and managerVoids (fired-void waste parts).



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w2_sale REDIS_URL=redis://127.0.0.1:6390/9 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
