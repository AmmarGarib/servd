# Wave B builder brief — w3-dlv-return: Emergency overrides module: send the hand-over code to the rider, log food a rider brought back as waste, strikes on refusal

Repo `/home/user/servd` — backend = Fastify + Prisma in `backend/`, admin = Next.js in `frontend/admin/`, storefront in
`frontend/storefront/`, `tablet/`, `mobile/`, `rider/` Expo apps. Read `/home/user/servd/CLAUDE.md` first: it applies in full.
Wave: **W3** · Area: **delivery (Emergency overrides: code to the rider, food came back)** · Test DB **`servd_test_wb_w3_dlv_return`** · Redis **`redis://127.0.0.1:6390/22`** (index 22) — yours alone
Design inputs (read the parts named below): `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/plan_<area>.json` (area plans), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/dump/critic_*.json` (critic corrections —
already folded into this brief), `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/schema-merged.prisma.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/chart-merged.md`, `/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/shared-files.md`,
`/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB/build-waves.md`. Where this brief and an area plan differ, THIS BRIEF wins (it carries the critic corrections and the
cross-area merges). Line numbers quoted from plans may have drifted: find the code by name.

## Your job in one line

orders/returnedFood.ts, orders/routes.ts (removals + message), emergencyOverrides/{routes,service,README}, admin /emergency-overrides page.

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

- `backend/src/modules/orders/returnedFood.ts (new)`
- `backend/src/modules/orders/routes.ts`
- `backend/src/modules/emergencyOverrides/routes.ts (new)`
- `backend/src/modules/emergencyOverrides/service.ts (new)`
- `backend/src/modules/emergencyOverrides/README.md (new)`
- `frontend/admin/src/app/emergency-overrides/page.tsx (new)`
- `backend/tests/emergencyOverrides.test.ts (new)`
- `backend/tests/foodReturned.test.ts (new)`
- `backend/tests/managerVoids.test.ts (W3: rewrite the refused-at-door cases to cancel/void)`
- `backend/tests/integrationPass1.test.ts (W3: refused-at-door cases only)`
- `backend/tests/cashControls.test.ts (W3: delete the cod-unpaid section; point to codRiderDebt.test.ts)`

## Read first

- plan_delivery.json: summary, postings (food returned), routes (emergency-overrides, removed routes), build_split A (emergencyOverrides) + B (returnedFood) + E (page)
- critic_cash_delivery_onaccount_0.json: violations 1 (paid tenders accepted, pickedUpAt, order's company audit, serviceClient job event, till manager approval), 2 (roles), 4 (no Delivered buttons), Q4 (unreachable = no strike)

## What to build

**Owner rule:** a delivery completes ONLY with the customer's code (no staff "Delivered" — w1-dlv-core removed it). When the customer can't give the
code, a manager SENDS the code to the rider's WhatsApp; when the food comes back (refused, unpaid, unreachable) the RGM / chef / F&B manager logs it
here and it is booked as food WASTE. Both actions live in the new "Emergency overrides" section (module `emergency_overrides`: boh_management,
fnb_manager, foh_management (RGM) + management/admin through ALL_MODULES — w0 set the defaults and the '/emergency-overrides' gate).
**orders/returnedFood.ts** `returnUndeliveredOrder(orderId, { actor: { id, email, tenantId, role }, cause: 'refused'|'unreachable'|'other', reason })`:
- Load + validate: a delivery order (422 NOT_A_DELIVERY); not delivered (409 ALREADY_DELIVERED); not completed (409 ORDER_COMPLETED_USE_REFUND);
  an active, picked-up order (app jobs need `pickedUpAt` — 409 NOT_PICKED_UP; 409 ORDER_NOT_ACTIVE otherwise); a rider set (422 NO_RIDER); no active
  terminal charge (409 TERMINAL_CHARGE_ACTIVE). **Paid tenders are ACCEPTED (critic):** the food is wasted either way; any money paid stays for the
  EXISTING cancelled-ticket hand-back (refundOrder → refundDueOnCancelledTicket) — the response returns `refundDueCents` so the manager sees it.
  For a till-channel ('pos') order run the existing `requireManagerApproval` so the approver is recorded like every other void.
- `cancelOrder(orderId, { reason: 'Returned by rider — <cause>: <reason>', actor, approverId: actor.id, action: 'order.returned_by_rider',
  onlyFrom: [the on-the-road statuses], returned: { cause, actorId: actor.id, run } })` (w2-sale hook). `run(tx)` inside the cancel transaction: for
  each non-voided FIRED line `wasteSoldLineTx(tx, { orderId, tenantId, line, wasteReason: RETURN_WASTE_REASON, actorId, conceptId })` (stock stays
  out; Dr 5040 / Cr 1210|1220|1230 by class incl. packaging, key 'pos.void_waste:<orderItemId>'); claim the PENDING COD cash payments → 'failed'
  with gatewayMeta.voided { reason: 'returned_undelivered', at, by } (no fiscal document — the order never completed; pre-bills are cancelled by
  cancelOrder); set Order.returnedAt + returnCause. Returns { wasteLogIds, wasteCostCents, codVoidedCents, postingErrors }.
- After commit: the 'returned' RiderJobEvent through `recordJobEvent` (serviceClient, OUTSIDE the RLS transaction — a fleet rider belongs to another
  company) with actorId; flagPostingFailed per line whose waste posting was refused (same metadata as voidOrderItem); flagException 'food_returned'
  in the ORDER's company with amountCents = the waste cost; `recordStrike({ customerId, kind: 'cod_refused', sourceType: 'order', sourceId, severity:
  1, reason, recordedById, tenantId: order's company })` ONLY when cause === 'refused' (owner default Q4: unreachable is no strike). A replay → 409
  (the claim is already cancelled), no second waste or strike.
**orders/routes.ts:** remove POST /:id/cod-unpaid (~325) and POST /:id/refused-at-door (~390) (paths 404); COMPLETE_ON_DELIVERY message → 'A delivery
completes only with the customer's code — the rider enters it in the rider app. If the customer can't give it, a manager can send it to the rider
(Emergency overrides).'; comment ~274 updated.
**emergencyOverrides/service.ts + routes.ts** (wave Z registers at '/emergency-overrides'): guard requireAuth(...MANAGERS) + the module gate; scope
through the order's concept (`scopeTenantWhere` on concept.tenantId: read for lists, write for actions; foreign → 404).
- GET /emergency-overrides/orders → { onTheRoad: [{ orderId, ref (orderRefOf), brand, customerName, stage, rider { id, name, fleetPartner },
  cashToCollectCents, codeLocked, rerouted, doorProblem, minutesOut }], recent: [RiderJobEvent code_rerouted | returned of the last 14 days with
  actor, rider, reason] }. A fleet partner's rider appears only on the client company's own orders.
- POST /orders/:id/send-code-to-rider { reason 10-300 } → `rerouteHandoverCode` (w1-dlv-core) → { ok, sentToRider, riderPhoneHint } (its 409/422
  codes pass through: NOT_A_DELIVERY, ALREADY_DELIVERED, NOT_READY, NO_RIDER, NOT_PICKED_UP, ALREADY_REROUTED, RIDER_HAS_NO_PHONE, ORDER_CHANGED).
- POST /orders/:id/send-code-to-rider/resend {} → `resendReroutedCode` (409 NOT_REROUTED / ALREADY_DELIVERED; rate limit 3 per 10 min per order).
- POST /orders/:id/food-returned { cause, reason 5-500 } → returnUndeliveredOrder → { ok, wasteCostCents, wasteLogIds, codVoidedCents, refundDueCents,
  strike: { recorded, duplicate } | null }.
- README: the contract, roles, what each action books, the owner questions still open (Q1 RGM login, Q5 prepaid returned food).
**Admin page /emergency-overrides** (polls every 8 s): table of orders on the road; 'Send code to rider' dialog (reason required; 'one per order;
reviewed'); 'Food came back' dialog (cause radio: 'Refused or would not pay — records a strike' / 'Could not reach the customer' / 'Our mistake or
other'; reason; a preview of the lines that will be booked as waste and of the COD that will be voided; after success shows refundDueCents with a
link to the order's hand-back when > 0); recent-overrides log; every error code in words. Tokens only, no emoji.

## Contracts you consume (already on disk when you start)

- w2-sale: cancelOrder `returned` hook, wasteSoldLineTx, RETURN_WASTE_REASON. w1-dlv-core: rerouteHandoverCode, resendReroutedCode, recordJobEvent.
  w1-bans: recordStrike(tenantId). w0: Order.returnedAt/returnCause, module emergency_overrides + gate, exception kinds food_returned / delivery_code_rerouted.


## Contracts you expose (later waves code against these — keep the names and signatures)

```ts
// orders/returnedFood.ts
export function returnUndeliveredOrder(orderId: string, a: { actor: { id: string; email: string; tenantId: string | null; role: string };
  cause: 'refused'|'unreachable'|'other'; reason: string }): Promise<{ ok: true; wasteCostCents: number; wasteLogIds: string[]; codVoidedCents: number;
  refundDueCents: number; strike: { recorded: boolean; duplicate: boolean } | null }>
// emergencyOverrides/routes.ts
export default async function emergencyOverridesRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/emergency-overrides'
```


## Tests

Your database: `servd_test_wb_w3_dlv_return`. Your Redis: `redis://127.0.0.1:6390/22`. Command (from `backend/`, your files only):

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_dlv_return REDIS_URL=redis://127.0.0.1:6390/22 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run tests/<file>.test.ts …
```

`emergencyOverrides` (two companies): B → 404 on A's order for list, send-code and food-returned; roles: cashier and owner → 403, boh_management,
fnb_manager, foh_management and management → 200 (a CEO untick of the module → 403); reroute once per order (second → 409), the code rotates (the old
code is refused in the rider app), attempts reset with the snapshot kept, the event carries actorId, the exception lands in A, WhatsApp mocked to the
rider's phone; assignRider to another rider → 409; a fleet rider of B carrying A's order: A's manager can reroute, B's cannot see it. `foodReturned`:
order 'cancelled' with returnedAt/returnCause; one WasteLog per line with reason returned_food; Dr 5040 / Cr 1210 (Cr 1230 for the packaging) in A
under 'pos.void_waste:<lineId>'; stock NOT restored; the COD row 'failed'; no FiscalDocument; pre-bills cancelled; a paid card order is accepted and
returns refundDueCents (the hand-back pays it later); a strike with tenantId A only for 'refused'; replay → 409 with no second waste or strike;
completed → 409; delivered → 409; not picked up → 409; a locked period → the cancel stands and posting_failed is flagged; the generic cancel of a
picked-up delivery → 409 USE_EMERGENCY_OVERRIDE (w2-sale). The old routes (/cod-unpaid, /refused-at-door) → 404. Rewrite the managerVoids /
integrationPass1 cases that used refused-at-door; delete the cod-unpaid section of cashControls.



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
   `DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servd_test_wb_w3_dlv_return REDIS_URL=redis://127.0.0.1:6390/22 JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only SERVD_SECRET_KEY=$(node -e "console.log(Buffer.alloc(32,7).toString('base64'))") NODE_ENV=test npx vitest run <files>`
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
