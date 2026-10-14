# Wave B builder brief — w3-till: On-account tender at the till, till-clearing contra 1115, Z-report, delivery-fee unwind, Raast-void exclusions, COD rider-debt reversal

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **onaccount (till + ledger) + tax / delivery / Raast-void hooks at the till** · Test DB **`servd_test_wb_w3_till`** · Redis **`redis://127.0.0.1:6390/18`** (index 18) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

pos/service.ts (all non-FC changes), pos/onAccountTender.ts + onAccountRoutes.ts, orderPosting.ts + shiftPosting.ts (OA part), accounting/tillClearing.ts + its worker.

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

- `backend/src/modules/pos/service.ts (W3: everything except the FC changes w2-sale already landed)`
- `backend/src/modules/pos/onAccountTender.ts (new)`
- `backend/src/modules/pos/onAccountRoutes.ts (new)`
- `backend/src/modules/accounting/orderPosting.ts (W3: on-account + 1115 only)`
- `backend/src/modules/accounting/shiftPosting.ts (W3: on-account + 1115 only)`
- `backend/src/modules/accounting/tillClearing.ts (new)`
- `backend/src/workers/tillClearingSweep.ts (new)`
- `backend/tests/onAccountTill.test.ts (new)`
- `backend/tests/onAccountLedger.test.ts (new)`
- `backend/tests/tillClearing.test.ts (new)`
- `backend/tests/tillHooksWaveB.test.ts (new: 4110 unwind, Raast-void exclusions, COD settle reversal)`
- `backend/src/modules/pos/boxGivenRoutes.ts (new)`
- `backend/tests/boxGiven.test.ts (new)`
- `backend/tests/auditLedgerFollowups.test.ts (W3: 1110 → 1115 till-clearing assertions)`
- `backend/tests/auditLedgerSales.test.ts (W3: same)`
- `backend/tests/booksLedger.test.ts (W3: same)`
- `backend/tests/auditMoneyFollowups.test.ts`
- `backend/tests/raastRefund.test.ts`
- `backend/tests/raastLedger.test.ts`
- `backend/tests/postingFailures.test.ts (W3: same)`
- `backend/tests/baseLayers.test.ts (W3: till-clearing assertions only)`

## Read first

- plan_onaccount.json: summary, postings (till sale, shift close, refund, till clearing), routes (POST /pos/on-account/*), shared_file_changes (pos/service.ts, orderPosting.ts, shiftPosting.ts), build_split A-till-ledger
- plan_tax.json: shared_file_changes pos/service.ts (TenderPricedOrder, cancelled-ticket unwind 4110)
- plan_delivery.json: shared_file_changes pos/service.ts (settlePayment rider-debt reversal)
- critic_cash_delivery_onaccount_2.json: violations 1, 2, 3, 7, 10 (coverage rule, refusals, every refund writer, one-time cut-over sweep, voided Raast exclusions)
- shared-files.md §B pos/service.ts, orderPosting.ts, shiftPosting.ts (the exact merged change lists — follow them line by line)

## What to build

You own pos/service.ts, orderPosting.ts and shiftPosting.ts in W3. w2-sale (FC void/comp hooks) and w2-ledger (COGS by class, 4110) have
ALREADY changed them: read them as they are on disk, keep those changes, and touch only what is listed here.
**On-account at the till (owner: corporate clients with a credit limit and a QR card the cashier scans; no manager approval per bill):**
- **pos/service.ts — export, no behaviour change:** applyCoverageTx, afterTillSale, repriceForTenderTx, coveredCents, assertTakesMoney, paymentKeyOf,
  idempotencyKeyReused, tillFiscal. `quoteOrderForTender(orderId, method)` accepts 'on_account' and prices it at the CASH class (tenderOf → 'cash').
  POST /pos/payments keeps refusing on_account (it is not in TILL_TENDERS — w0) — the ONLY way in is the on-account route below.
- **pos/onAccountTender.ts:** `lookupCardForOrder({ orderId, code, actor })` — the order from write scope (404 foreign); the card found by
  `hashCardCode(normalizeCardCode(code))` WITHIN the order's company only (order.concept.tenantId) → 404 ON_ACCOUNT_CARD_UNKNOWN for unknown or
  another company's card (never confirm existence); revoked → `flagRevokedCardUse(tenantId, cardId)` + 409 ON_ACCOUNT_CARD_REVOKED; returns
  { account { id, number, legalName, limitCents, exposureCents, availableCents, requiresReference }, card { id, label, hint }, quote { dueCents,
  taxRatePct }, blocked: null | { code, message } } (blocked = what assertChargeableTx would refuse, read-only).
  `chargeOrderToAccount({ orderId, shiftId, code, reference, idempotencyKey, actor })` — ONE transaction: lockOrderTx → idempotent replay (same
  key → the same payment, never a second charge) → assertNoActiveTerminalChargeTx → assertTakesMoney → not completed → nothing paid yet, no tip,
  no promo / wallet / gift card / loyalty credit, no pending check-split portion (409 ON_ACCOUNT_WHOLE_BILL) → `repriceForTenderTx(['on_account'])`
  → assert `order.taxRatePct === concept.taxRateCash` (409 ON_ACCOUNT_RATE — critic) → lockAccountTx → assertChargeableTx (block, never warn) →
  Payment { method 'on_account', status 'paid', shiftId, gatewayRef = client number, gatewayMeta { idempotencyKey, onAccount { accountId, cardId,
  number, name, reference } } } → recordChargeTx → `applyCoverageTx('till')` and REQUIRE `coverage.completedNow` (critic: the completion rule, not
  completionDoor) else 409 ON_ACCOUNT_NOT_HERE and the whole tx rolls back (delivery / pickup / online orders end up here). After commit:
  afterTillSale → completeOrder (exactly ONE fiscal sale document; tender on_account; buyer = the client — w1-taxsales payload; the cash rate). No
  manager PIN. No loyalty earn on an on-account bill (owner default). Audit 'order.on_account_charge' in the ORDER's company. Lock order: order →
  client account → invoice (never the other way).
- **pos/onAccountRoutes.ts** (a second plugin wave Z registers at '/pos'; /pos is ungated): POST /pos/on-account/lookup {orderId uuid, code ≤ 40}
  (CASHIERS, rateLimit 20/min); GET /pos/orders/:orderId/on-account/quote (CASHIERS; foreign → 404); POST /pos/orders/:orderId/on-account
  {shiftId uuid, code, reference? ≤ 80, idempotencyKey 8-100} (CASHIERS; assertShiftOf(order's company, shiftId, open) + assertDrawerOperator)
  → { payment, charge, orderCompleted, fiscal, srb }. Error codes and messages from `CHARGE_ERRORS` (w2-oa-recv), shown verbatim by the till.
- **Refunds (pos/service.ts):** refundOrder for an on_account payment: shiftId null and refundDrawerOf's cash rule skipped; **call
  `applyChargeRefundTx` inside `writeRefundTx` whenever r.method === 'on_account'** so EVERY writer of an on_account refund row reaches it
  (refundOrder, the void-on-paid-order path ~2156, the cancelled-ticket hand-back ~3378 — critic). `refundDueOf` excludes on_account (and comp).
- **Till clearing contra 1115 (pos/service.ts):** BASE_MONEY_ACCOUNTS += ACCT.TILL_CLEARING; ~3092 match `code IN TILL_CLEARING_CODES` (1115 +
  legacy 1110); ~3191 / ~3213 ACCT.CUSTOMER_AR → ACCT.TILL_CLEARING for till-clearing lines (1110 stays for real receivables).
- **Z-report:** getZReport gains onAccountSales / onAccountCount / onAccountByClient (inside totalSales).
**orderPosting.ts (OA, W3 part):** buildSaleLines on_account block after Raast and before the 1030 rest: Σ paid on_account rows capped at `left` →
Dr ACCT.CUSTOMER_AR (1110 — a real receivable) memo `${ON_ACCOUNT_MEMO} — ${conceptMemo}`; refundCreditAccount('on_account') → ACCT.CUSTOMER_AR
(memo prefixed ON_ACCOUNT_MEMO); saleBookingOf (~636) `code IN TILL_CLEARING_CODES`; hand-back (~771) Dr ACCT.TILL_CLEARING; refundDueCents excludes
on_account (like comp) and payments whose Raast receipt is 'voided'. Do not touch the COGS / 4110 changes of w2-ledger.
**shiftPosting.ts (OA, W3 part):** ShiftSales.onAccount { cents, byAccount }; in summariseShiftSales' home-drawer loop `else if (p.method ===
'on_account') addOnAccount(...)` BEFORE the card branch, and an explicit guard that THROWS for any unknown paid method (an unknown method must
never fall into 1030); the NEVER_SOLD branch skips on_account like comp; buildShiftCloseEntry: one Dr ACCT.CUSTOMER_AR line per client (memo
`${ON_ACCOUNT_MEMO} — ${number} ${name} — ${refs} ${tag}`); lines ~471 / ~474 / ~506 and postPosCardFailure ~787 → ACCT.TILL_CLEARING;
cardRefundsToBook excludes on_account; header comment.
**accounting/tillClearing.ts + workers/tillClearingSweep.ts (critic — one-time cut-over, then reversals only):**
`sweepTillClearing(tenantId, { mode: 'cutover'|'daily' })` under pg_advisory_xact_lock('till-clearing:'+tenantId). 'cutover' runs ONCE (Setting
marker `ledger.tillClearingCutoverAt:<tenantId>`): the legacy till-clearing balance sitting on 1110 (groupBy over 1110 lines EXCLUDING
'receivable.%' references and ON_ACCOUNT_MEMO memos) moves to 1115 under 'ledger.till_clearing_split:<tenantId>:<n>'. 'daily' moves ONLY
reversals of pre-cut-over till-clearing entries; any other non-AR 1110 activity (manual journals included) → flagException 'till_clearing_unexpected'
in that company, never moved automatically. A refused posting → flagPostingFailed('ledger.till_clearing_split', 'Tenant', tenantId) (w4-integration
wires the REPOSTER: post → sweepTillClearing(tenantId, { mode: 'daily' })). Worker: daily 03:10 PKT (node-cron, Asia/Karachi), serviceClient, loop
per active company, running guard, export `runTillClearingSweepOnce()` for tests. Wave Z starts the worker and runs the cut-over once at boot.
**Tax (pos/service.ts):** TenderPricedOrder Pick + 'deliveryFeeCents'; tenderPriceOf passes it; repriceForTenderTx writes deliveryFeeTaxCents; the
void-line reprice (~1870) passes deliveryFeeCents; the refund select (~3024) adds deliveryFeeCents (type completeness — till sales carry 0); the
cancelled-ticket unwind (~3125-3137) adds `add(ACCT.DELIVERY_FEE_REVENUE, b.deliveryFeeCents)` (TX critic).
**Raast "void, never booked" (pos/service.ts):** refundDueOf, the Z-report's cancelledPaid and the till's hand-back options exclude payments whose
raastReceipt.status is 'voided' (w1-recon owns the void itself).
**"Box given" (packaging rule, FINAL owner rule):** pos/boxGivenRoutes.ts (a plugin wave Z registers at '/pos'; /pos is ungated):
POST /pos/orders/:orderId/items/:itemId/box-given { undo?: boolean } (any staff of the order's company who can use the till or the floor — the
till's STAFF list; foreign order or a line not on that order → 404) → w2-sale `markBoxGiven(itemId, actor, { undo })` → { boxGiven, depleted };
409 BOX_NOT_NEEDED (takeaway / delivery / a packaging-vessel line — it already counts) and 409 ORDER_COMPLETED for an undo after completion,
both in words. Order lines already come back with every scalar column (serviceVessel, boxGiven) wherever the till / order page read them —
check the selects on that path and add the two fields where a narrow `select` drops them; the UI shows the button when the order is dine-in
and the line's vessel is 'plate' (null = a legacy line → treat as plate; the server has the last word).
**Delivery — COD the rider owes (pos/service.ts settlePayment):** select codRiderDebtEntryId / codRiderDebtTransferId; own-rider debt: call
`reverseCodRiderDebtTx(tx, { paymentId, tenantId })` right after the pending→paid claim (an AppError → after commit flagPostingFailed
'cod.rider_debt.reversal' with sourceId = paymentId); fleet-rider debt (an inter-company transfer): after commit `reverseCodRiderDebtAfterCommit
(paymentId)` (serviceClient, both companies' books; failure → the same flag). Never hold the tx across it.

## Contracts you consume (already on disk when you start)

- w0: ON_ACCOUNT_TENDER / REFUND_TENDERS (lib/tenders.ts), ACCT.TILL_CLEARING / CUSTOMER_AR / DELIVERY_FEE_REVENUE, TILL_CLEARING_CODES, ON_ACCOUNT_MEMO,
  lib/onAccountCard.ts (normalizeCardCode, hashCardCode), Payment cod columns, Order fee columns.
- w2-oa-recv: CHARGE_ERRORS, lockAccountTx, exposureOfTx, assertChargeableTx, recordChargeTx, applyChargeRefundTx, flagRevokedCardUse.
- w1-taxsales: fiscal payload buyer = the client (customerAccountCharge read), paymentLabelOf. w1-recon: RaastReceipt 'voided'. w2-dlv-cod:
  reverseCodRiderDebtTx / reverseCodRiderDebtAfterCommit. w2-ledger: orderPosting/shiftPosting COGS + 4110 (keep).


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// pos/onAccountTender.ts
export function lookupCardForOrder(a: { orderId: string; code: string; actor: StaffActor }): Promise<OnAccountLookup>
export function chargeOrderToAccount(a: { orderId: string; shiftId: string; code: string; reference?: string | null; idempotencyKey: string; actor: StaffActor })
  : Promise<{ payment: Payment; charge: CustomerAccountCharge; orderCompleted: boolean; fiscal: unknown; srb: unknown }>
// pos/onAccountRoutes.ts
export default async function posOnAccountRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: app.register(posOnAccountRoutes, { prefix: '/pos' })
// accounting/tillClearing.ts
export function sweepTillClearing(tenantId: string, o: { mode: 'cutover'|'daily' }): Promise<{ moved: number; cents: number; flagged: number }>
// workers/tillClearingSweep.ts
export function startTillClearingSweepWorker(): void
export function runTillClearingSweepOnce(now?: Date): Promise<void>
// pos/boxGivenRoutes.ts
export default async function posBoxGivenRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: app.register(posBoxGivenRoutes, { prefix: '/pos' })
// pos/service.ts (newly exported, unchanged behaviour)
export { applyCoverageTx, afterTillSale, repriceForTenderTx, coveredCents, assertTakesMoney, paymentKeyOf, idempotencyKeyReused, tillFiscal }
```


## Tests

Your database: `servd_test_wb_w3_till`. Your Redis: `redis://127.0.0.1:6390/18`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_till REDIS_URL=redis://127.0.0.1:6390/18 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`onAccountTill` (two companies): B's cashier → 404 on A's order; A's card scanned on B's order → 404 ON_ACCOUNT_CARD_UNKNOWN; the charge, the shift
close lines and the fiscal document are stamped with A; one charge completes the order once with exactly ONE fiscal sale document (tender on_account,
buyer = the client, taxRatePct = the cash rate); no PIN needed; the idempotent replay returns the same payment; two concurrent charges near the
limit → one 409 ON_ACCOUNT_OVER_LIMIT; overdue / suspended / pending / brand-not-allowed refused; reference required when the client says so; a
delivery or pickup order → 409 ON_ACCOUNT_NOT_HERE and nothing saved; a tip, a promo, a gift card or a part-paid bill → 409 ON_ACCOUNT_WHOLE_BILL; a
revoked card raises the flag once; POST /pos/payments with on_account still refused. `onAccountLedger`: shift close Dr 1110 per client, the entry
balances, the Z-report shows on-account inside total sales; a non-till dine-in bill's order.complete debits 1110; a refund to the account → Cr 1110
+ fiscal return + charge refunded + statement credited (via each refund writer incl. the void-on-paid path and the cancelled-ticket hand-back); a
refused posting saves nothing; an unknown paid method makes the shift close throw (never 1030). `tillClearing`: new till-clearing lines land on 1115;
a legacy REFUND DUE on 1110 is still found by saleBookingOf / Raast saleBookedTx / the cancelled unwind; the cut-over moves the legacy balance once,
a re-run posts nothing; the daily run skips ON ACCOUNT and receivable.* lines and flags a manual 1110 journal as till_clearing_unexpected; a locked
period flags posting_failed. `tillHooksWaveB`: cancelled-ticket unwind of a delivery order reverses 4110 too; a voided Raast receipt is excluded from
refund-due, cancelledPaid and the hand-back options; settling a COD the rider owes posts Dr 1010 / Cr 1351 in the same tx ('cod.rider_debt.reversal:
<paymentId>') and a fleet rider's debt reverses after commit in both companies; a refused reversal is flagged. `boxGiven` (two companies): B's
staff → 404 on A's line; a Simmer dine-in line → boxGiven true and its packaging depleted once (a second tap writes nothing); undo before
completion returns it; undo after completion → 409; a takeaway line or a Stackd line → 409 BOX_NOT_NEEDED. Update the listed existing suites'
till-clearing expectations 1110 → 1115 (keep 1110 for invoices and on-account) — nothing else in them.



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_till REDIS_URL=redis://127.0.0.1:6390/18 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
