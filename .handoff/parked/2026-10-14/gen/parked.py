"""Agents PARKED by the owner on 2026-10-13 (~23:20 UTC): "stop these 2 cleanly, keep whatever you've started in place, remind me
after finance is sorted". See ../parked/PARKED.md (binding). render.py never emits these in a wave; the resume moves each dict back into
its agents_wN.py list (they are verbatim copies of the definitions as they stood when parked). The original generator files are in
../parked/original/gen/ and the original briefs in ../parked/original/briefs/.
"""

# Stage-1 agents parked (their definitions stay in agents_w1.py because W1 briefs are frozen; render.py filters them out).
PARKED_W1_IDS = {
    "w1-dlv-core": "cancelled before it started (briefs/w1-dlv-core.md is the cancel notice; the original brief is parked/w1-dlv-core.md)",
    "w1-bans": "stopped while still reading — wrote no code (briefs/w1-bans.md left as it was; a copy is parked/w1-bans.md)",
}

PARKED = []

PARKED.append(dict(
id="w2-dlv-cod", wave="W2", area="delivery (COD custody) + tax/onaccount report rows", idx=15,
title="COD with the rider (H5): one COD status definition, rider debt (own and fleet riders), custody worker, reports",
summary="accounting/codPosting.ts, lib/cod.ts, reconciliation/codRoutes.ts, pos/routes.ts, workers/codCustody.ts, reports/service.ts.",
owns=["backend/src/modules/accounting/codPosting.ts (new)", "backend/src/lib/cod.ts (new)", "backend/src/modules/reconciliation/codRoutes.ts (w0 stub → fill)",
      "backend/src/modules/pos/routes.ts", "backend/src/workers/codCustody.ts (new)", "backend/src/modules/reports/service.ts",
      "backend/tests/codRiderDebt.test.ts (new)", "backend/tests/codCustody.test.ts (new)", "backend/tests/raastReports.test.ts",
      "backend/tests/resimWallet.test.ts (W2: salesByTender / cod-due cases only) — booksReconcile (w2-fa-capex) and cashControls (w2-cash-ledger) also hit salesByTender / cod-due but belong to those agents this wave: send patch notes"],
read=["plan_delivery.json: summary (COD), postings (rider debt, recovered), routes (cod-due, reconciliation/cod), build_split D",
      "critic_cash_delivery_onaccount_0.json: violation 9 (one lib/cod.ts), missing (legacy COD path, IC for fleet riders, 1351 reserved), code_facts (pickup rows, reversal key)",
      "plan_tax.json / plan_onaccount.json shared_file_changes reports/service.ts"],
tasks=r"""
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
""",
consumes=r"""
- w1-ic: postSystemTransferTx, reverseSystemTransfer, isMemberOfBoth (lib/companyPairs.ts). w0: Payment cod columns, ACCT.RIDER_COD_RECEIVABLE, reverseJournalEntry.
""",
exposes=r"""
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
""",
tests=r"""
`codRiderDebt` (two companies: B finance → 404 on A's payment; own rider posts Dr 1351/Cr 1010 in A under 'cod.rider_debt:<paymentId>', replay no-op;
refuses a POS order, a paid row, a pickup row (at_counter), an order delivered without a code, a missing order.complete, cashier/foh roles (403), a
role without the reconciliation module (403); legacy:true by finance with reason passes, by management → 403; fleet rider of B on A's order: a
finance user of A only → 403, of A and B → an IntercompanyTransfer source 'cod' in both books; reverseCodRiderDebtTx posts
'cod.rider_debt.reversal:<paymentId>'; salesByTender shows the rider-owes row, deliveryFees and on_account ordering). `codCustody` (flags per
company only for its own overdue delivery COD; no duplicate on re-run; pickup cash never flagged; on-road overdue flag). Update `raastReports`
(cod.notCollected* → cod.riderOwes*) and any cod-due / salesByTender suite.
""",
))

PARKED.append(dict(
id="w3-dlv-return", wave="W3", area="delivery (Emergency overrides: code to the rider, food came back)", idx=22,
title="Emergency overrides module: send the hand-over code to the rider, log food a rider brought back as waste, strikes on refusal",
summary="orders/returnedFood.ts, orders/routes.ts (removals + message), emergencyOverrides/{routes,service,README}, admin /emergency-overrides page.",
owns=["backend/src/modules/orders/returnedFood.ts (new)", "backend/src/modules/orders/routes.ts",
      "backend/src/modules/emergencyOverrides/routes.ts (new)", "backend/src/modules/emergencyOverrides/service.ts (new)",
      "backend/src/modules/emergencyOverrides/README.md (new)", "frontend/admin/src/app/emergency-overrides/page.tsx (new)",
      "backend/tests/emergencyOverrides.test.ts (new)", "backend/tests/foodReturned.test.ts (new)",
      "backend/tests/managerVoids.test.ts (W3: rewrite the refused-at-door cases to cancel/void)",
      "backend/tests/integrationPass1.test.ts (W3: refused-at-door cases only)", "backend/tests/cashControls.test.ts (W3: delete the cod-unpaid section; point to codRiderDebt.test.ts)"],
read=["plan_delivery.json: summary, postings (food returned), routes (emergency-overrides, removed routes), build_split A (emergencyOverrides) + B (returnedFood) + E (page)",
      "critic_cash_delivery_onaccount_0.json: violations 1 (paid tenders accepted, pickedUpAt, order's company audit, serviceClient job event, till manager approval), 2 (roles), 4 (no Delivered buttons), Q4 (unreachable = no strike)"],
tasks=r"""
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
""",
consumes=r"""
- w2-sale: cancelOrder `returned` hook, wasteSoldLineTx, RETURN_WASTE_REASON. w1-dlv-core: rerouteHandoverCode, resendReroutedCode, recordJobEvent.
  w1-bans: recordStrike(tenantId). w0: Order.returnedAt/returnCause, module emergency_overrides + gate, exception kinds food_returned / delivery_code_rerouted.
""",
exposes=r"""
```ts
// orders/returnedFood.ts
export function returnUndeliveredOrder(orderId: string, a: { actor: { id: string; email: string; tenantId: string | null; role: string };
  cause: 'refused'|'unreachable'|'other'; reason: string }): Promise<{ ok: true; wasteCostCents: number; wasteLogIds: string[]; codVoidedCents: number;
  refundDueCents: number; strike: { recorded: boolean; duplicate: boolean } | null }>
// emergencyOverrides/routes.ts
export default async function emergencyOverridesRoutes(fastify: FastifyInstance): Promise<void>   // wave Z: register at '/emergency-overrides'
```
""",
tests=r"""
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
""",
))

PARKED.append(dict(
id="w4-admin-delivery", wave="W4", area="admin UI — dispatch, riders, complaints/appeals, COD pay-in", idx=None,
title="Admin: no staff 'Delivered' anywhere — 'Enter customer's code'; ban appeals in Complaints; COD pay-in grouped by rider",
summary="UI only — dispatch, riders, complaints pages and the till's DrawerPanels.",
owns=["frontend/admin/src/app/dispatch/page.tsx", "frontend/admin/src/app/riders/page.tsx", "frontend/admin/src/app/complaints/page.tsx",
      "frontend/admin/src/app/pos/shift/DrawerPanels.tsx"],
read=["plan_delivery.json build_split E (minus the emergency page — w3-dlv-return; minus CodTab — w3-admin-finance; minus appRoles — w0)",
      "critic_cash_delivery_onaccount_0.json violations 4 (Enter customer's code; overrides link only when locked / door problem), 7 (appeals: MANAGERS only details, 'resolved' refused)"],
tasks=r"""
- **Dispatch + Riders pages:** remove every 'Delivered' button / deliverGate; add 'Enter customer's code' (POST /trustops/orders/:id/verify-otp — shows
  attemptsLeft; 423 locked → 'Ask a manager to send the code to the rider'). Show a link to /emergency-overrides ONLY when the code has locked or the
  rider reported a door problem, and only when canOpenPath('/emergency-overrides'). A rerouted order shows 'Code sent to the rider by <manager>'.
- **Complaints page:** a 'Ban appeals' filter (?kind=ban_appeal); each appeal card shows the customer's reason and message, the ban (when, auto or
  manual) and this company's strikes; buttons 'Lift the block' (POST /crm/bans/:id/lift), 'Release this number only' (POST
  /crm/bans/:id/release-contact { contact: 'phone' }), 'Keep the block' (PATCH status 'closed' — the customer is told); 'Resolved' is not offered on an
  appeal (the API refuses it). Appeal details only render what the API returns (managers).
- **DrawerPanels (CodPayInPanel):** group rows by rider; badges 'Overdue' (amber) and 'Owed by rider' (red) from the API's status; pickup cash orders
  show 'At the counter'.
Tokens only; no emoji; plain English; phone width.
""",
consumes=r"""
- w1-dlv-core (verify-otp messages, reroute fields on dispatch rows), w1-bans (complaints kind filter, lift / release-contact), w2-dlv-cod (cod-due status, riderOwes).
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Checklist: Dispatch has no Delivered button; the code entry
locks after the attempts; boh_management sees the Emergency overrides link on a locked order, a cashier does not; an appeal card with the three actions.
""",
))

PARKED.append(dict(
id="w4-apps", wave="W4", area="tablet + rider apps (Expo + web rider)", idx=None,
title="Tablet Emergency overrides tab and code-only dispatch; rider apps: rerouted-code banner, 'Problem at the door', cash-held reminder",
summary="UI only — tablet overrides/dispatch/_layout, rider/** (Expo), storefront /rider web pages + riderApi, docs/rider-app.md.",
owns=["tablet/app/(staff)/overrides.tsx (new)", "tablet/app/(staff)/_layout.tsx", "tablet/app/(staff)/dispatch.tsx",
      "rider/src/lib/types.ts", "rider/src/lib/api.ts (only if a new endpoint needs a helper)", "rider/app/(rider)/job/** ", "rider/src/components/JobCard.tsx",
      "rider/src/components/ShiftToggle.tsx", "frontend/storefront/src/lib/riderApi.ts", "frontend/storefront/src/app/rider/jobs/page.tsx",
      "frontend/storefront/src/app/rider/jobs/[orderId]/page.tsx", "docs/rider-app.md",
      "tablet/app/(staff)/floor.tsx (Box given only — if it shows a table's order lines)"],
read=["plan_delivery.json build_split F; routes (rider jobs handover/doorProblem, door-problem, shift cashHeldCents)",
      "critic_cash_delivery_onaccount_0.json violations 4 (tablet Delivered → Enter customer's code), Q3 (show the rerouted code in the app as a fallback)"],
tasks=r"""
- **Tablet:** a new Overrides tab (NAV_MODULES ['emergency_overrides']) with the same list and the two actions as the admin page (send code to the
  rider; food came back with cause + reason + the waste preview); Dispatch: remove Delivered, confirmDelivered and the local MANAGER_ROLES; add 'Enter
  customer's code' (verify-otp); a locked code shows 'Ask a manager: Emergency overrides'.
- **Rider apps (Expo `rider/` and web servd.pk/rider):** Job type gains `handover { rerouted, reroutedAt, code, whatsappSent }` and `doorProblem { kind,
  at } | null`; when rerouted to this rider: a banner 'A manager sent the code to your WhatsApp' with the code shown as a fallback and a 'Use this code'
  fill; the copy says take the cash first, then enter the code; a 'Problem at the door' sheet (Customer can't get the code / Customer refused or won't
  pay / Can't reach the customer) → POST /rider/jobs/:orderId/door-problem, then guidance 'Bring the food back to <outlet>; a manager logs it'; a
  locked code shows 'Call your manager — they can send the code to you'; going off shift with cashHeldCents > 0 shows a reminder (never a block);
  JobCard: a 'Code sent to you' chip. No emoji on the web rider (storefront rule); the web rider stays noindex with no servd chrome.
- **Tablet floor (Box given):** if floor.tsx shows a dine-in table's order lines, add the same 'Box given' toggle as the till (POST
  /pos/orders/:orderId/items/:itemId/box-given, undo while open; only on dine-in lines whose vessel is plate); if it shows no lines, leave it and
  say so in your report.
- **docs/rider-app.md:** rewrite the hand-over code section (code only; reroute; door problems; returned food) and the endpoint table.
""",
consumes=r"""
- w1-dlv-core rider routes (handover, doorProblem, door-problem, cashHeldCents); w3-dlv-return emergency-overrides routes (tablet tab).
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. Run `npx tsc --noEmit -p .` in tablet/, rider/ and frontend/storefront and make your files clean. Checklist: rider web job page
with a rerouted code; the door-problem sheet; tablet Overrides tab gated by the module.
""",
))


# The parts CUT from agents that stay in wave B (the full original definitions are in ../parked/original/gen/; their original briefs in
# ../parked/original/briefs/). On resume, add these back (as new agents or a new wave) — the schema and w0 libs for them are already in place.
PARKED_PARTS = {
    "w1-recon": "(W1 — brief frozen) the till-clearing contra part: WRITE_OFF_CONTRAS default '1115' and the 'Customer owes (1115 till clearing)' label "
                "in RaastTab.tsx — the orchestrator reverts the default/label to 1110 at the W1 gate (see 'Gates between waves'). The Raast void itself is KEPT.",
    "w1-taxsales": "(W1 — brief frozen) the DL parts: dropping GET /storefront/account's isBlacklisted (its replacement GET /storefront/account/blocks "
                   "was w1-bans') — kept at the W1 gate while a screen reads it; the tracker's handoverRerouted flag stays inert (nothing sets "
                   "handoverReroutedAt). Its on-account fiscal-buyer / receipt-label code stays as written (PARKED.md C).",
    "w1-ic": "(W1 — brief frozen) postSystemTransferTx's source 'cod' (COD fleet-rider debt) is an unused seam until COD custody resumes; the 'fleet' "
             "source is finance and KEPT.",
    "w2-sale": "CancelOrderInput.returned + transitionOrder inCancelTx (the Emergency-overrides hook), wasteReturnedOrder, the 409 USE_EMERGENCY_OVERRIDE "
               "refusal for a picked-up delivery order, tests/cancelReturnedHook.test.ts. ('returned_food' stays in VOID_WASTE_REASONS, unused.)",
    "w2-ledger": "(was w3-till's W3 part of orderPosting.ts / shiftPosting.ts) the on_account block of buildSaleLines and summariseShiftSales, "
                 "refundCreditAccount('on_account'), saleBookingOf / hand-back / shift-close / postPosCardFailure moving to 1115, the unknown-method guard, "
                 "cardRefundsToBook excluding on_account, ShiftSales.onAccount.",
    "w2-oa-recv": "receivables/onAccount.ts (CHARGE_ERRORS, lockAccountTx, exposureOfTx, assertChargeableTx, recordChargeTx, applyChargeRefundTx, "
                  "flagRevokedCardUse), customerAccounts.ts (clients, cards, limits, approvals, tie-out, reminders), statements.ts, workers/onAccountDaily.ts, "
                  "statement kind in receivables/routes.ts (LIVE_KINDS, statement void / credit-note rules, customerAccountId on POST /, H13 statement "
                  "authority, STATEMENT_MULTI_AUTHORITY), the write-off's statement split / lockAccountTx / client suspension; tests onAccountClients, "
                  "onAccountExposure, onAccountStatements.",
    "w2-cash-ledger": "trustops/routes.ts delivery part: remove GET /trustops/orders/:id/otp, the verify-otp 423 message pointing at Emergency overrides, "
                      "the lost_package description; the sepTrustops 'otp route gone' case.",
    "w2-dlv-cod (whole agent)": "parked (see PARKED). Its finance-only pieces moved: reports/service.ts SalesTotals.deliveryFees → w2-ledger; "
                                "pos/routes.ts payout categories kind 'expense' → w2-cash-ledger. Still parked: lib/cod.ts, codPosting.ts, codRoutes.ts "
                                "(w0 stub stays empty), codCustody worker, the cod-due rider statuses, the COD rename in salesByTender, TENDER_ORDER 'on_account'.",
    "w3-till": "pos/onAccountTender.ts + onAccountRoutes.ts, the pos/service.ts exports for them, quoteOrderForTender 'on_account', on_account refunds "
               "(applyChargeRefundTx in writeRefundTx), Z-report on-account rows, BASE_MONEY_ACCOUNTS / TILL_CLEARING_CODES / CUSTOMER_AR → TILL_CLEARING, "
               "accounting/tillClearing.ts + workers/tillClearingSweep.ts + the boot cut-over, the COD rider-debt reversal in settlePayment, the orderPosting / "
               "shiftPosting OA parts; tests onAccountTill, onAccountLedger, tillClearing, the 1110 → 1115 updates (auditLedgerFollowups, auditLedgerSales, "
               "booksLedger, postingFailures, baseLayers). The Raast-void refundDueCents exclusion moved to w2-ledger (W2).",
    "w3-dlv-return (whole agent)": "parked (see PARKED) — orders/routes.ts stays unchanged (cod-unpaid and refused-at-door routes remain).",
    "w3-admin-finance": "reconciliation/CodTab.tsx (COD with rider / overdue / owed by rider).",
    "w4-integration": "the on_account_client approvals provider; the 'cod.rider_debt.reversal' and 'ledger.till_clearing_split' REPOSTERS; the "
                      "company merge of customer_accounts / customer_account_cards / customer_account_charges (renumber colliding OA-numbers) and "
                      "customer_strikes.tenantId / customer_bans.tenantId, with their tenantMergeWaveB fixtures (the merge of receivable_write_offs "
                      "/ attachments is KEPT — bad debts are finance).",
    "w4-admin-oa": "PaymentModal 'On account' + OnAccountPanel, tillApi on-account calls + CHARGE_ERRORS map, RefundOptions / refundEngine "
                   "'Back to the client's account', pos/shift Z-report row, client list / detail pages, OnAccountCardPrint, statements on the receivables "
                   "page (kind badge, period, credit-note hint, client picker in Raise), the on_account tender label on orders/[id].",
    "w4-customer": "BlockedNotice + ban appeals (storefront account / login / signup / reserve / group order, checkout BANNED notice), the tracker's "
                   "'Your rider has the code' text, every mobile/ change (server quote, real checkout body, pickup-only, blocked notice).",
    "w4-docs": "docs/on-account.md, docs/emergency-overrides.md, the dispatch / rider / riders / complaints / crm / whatsapp READMEs, contra 1115 in "
               "raast.md, the on_account tender paragraph in pos-connector-api.md, the tillClearingSweep / onAccountDaily / codCustody worker rows.",
}
