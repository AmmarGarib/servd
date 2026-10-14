W4 = []

W4.append(dict(
id="w4-integration", wave="W4", area="all areas — cross-cutting backend glue", idx=26,
title="Approvals inbox providers, REPOSTERS for every new posting, company-merge for every new table, chart/setup guards",
summary="approvals/providers.ts + README + approvalsInbox test, reconciliation/backfillOrders.ts REPOSTERS + sweeps, tenants/routes.ts merge, setup/routes.ts guards.",
owns=["backend/src/modules/approvals/providers.ts", "backend/src/modules/approvals/README.md", "backend/tests/approvalsInbox.test.ts",
      "backend/src/modules/reconciliation/backfillOrders.ts", "backend/src/modules/tenants/routes.ts (W4: merge only)",
      "backend/src/modules/setup/routes.ts (W4: chart-of-accounts guards only — w1-taxcore changed PATCH /setup/operations-config in W1)",
      "backend/src/modules/accounting/supplierPosting.ts (W4: drop the postWasteLog re-export once no importer remains — nothing else)",
      "backend/src/modules/crosschecks/countPosting.ts (W4: delete when no importer remains)",
      "backend/tests/repostersWaveB.test.ts (new)", "backend/tests/tenantMergeWaveB.test.ts (new)", "backend/tests/fixedAssetsMerge.test.ts (new)",
      "backend/tests/setupChartGuards.test.ts (new)",
      "existing suites covering these files (grep tests/ for 'REPOSTERS', 'backfill-unposted', '/tenants/merge' or the merge route, '/setup/chart-of-accounts', '/setup/operations-config', '/approvals')"],
read=["shared-files.md §A backfillOrders.ts (the merged REPOSTERS list), §B approvals/providers.ts, tenants/routes.ts (W4 part), setup/routes.ts",
      "plan_*.json shared_file_changes for approvals/providers.ts, backfillOrders.ts, tenants/routes.ts, setup/routes.ts (every area)",
      "critic_tax_people_0.json violation 3 (multiPost reposter), critic_cash_delivery_onaccount_2.json violations 4, 5, 7 (assertNotSelfApproval, delegable false, till-clearing reposter shape), critic_assets_foodcost_0.json violation 8 (FA reposters), critic_assets_foodcost_1.json violations 5 (GRNI provider), 8 (restore-failure sweep), critic_tax_people_1.json violation 5 (fleet reposter)"],
tasks=r"""
**approvals/providers.ts (+ README rows; one inbox — every button calls the module's EXISTING route, whose own guard decides; never a second engine):**
each provider reads its module's queue AS THE CALLER; `delegable: false` unless noted.
- fixed_asset_request — module accounting, ADMIN_ONLY, reads GET /accounting/fixed-assets/requests?status=pending, approve/reject → that module's
  routes. (README: replace the 'capex posting not in the inbox' note.)
- intercompany_transfer — accounting, ADMIN_ONLY; disabledReason when the CEO is not a member of BOTH companies.
- on_account_client — accounting, ADMIN_ONLY, GET /accounting/customer-accounts?pending=1 (new clients and requested limit increases).
- bad_debt — accounting, ADMIN_ONLY, GET /accounting/receivables/write-offs?status=requested; NO requester-based disabledReason (the CEO is exempt from
  self-approval — decision 27; the route's assertNotSelfApproval decides).
- raast_void — reconciliation, ADMIN_ONLY, GET /reconciliation/raast/receipts?voidRequested=1.
- grni_writeoff — procurement | accounting, ADMIN_ONLY, GET /procurement/grni?writeOffRequested=1.
- cash_request_hod — no module, approverRoles null, GET /trustops/cash-vouchers?view=hod, sign / reject (the route decides who may sign).
- cash_voucher — relabelled 'Cash requests', title `${number} — ${payeeName} — PKR …`, facts per the cash plan (holder, purpose, brand, box, HOD
  signer), delegable kept true; Approve disabled for the HOD signer (SAME_SIGNER).
- recipe provider (~212-218): derive a MODIFIER recipe's company via modifier → group → menu item → concept (FC critic).
- Counts (/approvals/counts) include every new type per company.
**reconciliation/backfillOrders.ts — the merged REPOSTERS (all areas):**
- `RefusedPostingKind += 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire' | 'ic.fleet_charge' |
  'cod.rider_debt.reversal' | 'ledger.till_clearing_split'`; the Reposter interface gains `multiPost?: boolean` (skips the exact-reference "Already on
  the books" check and decides nothingOwed in load() — TX critic: '@n' gift-card entries).
- FA 'fixed_asset.depreciation' (entityType FixedAsset, flag sourceId = entityId = assetId; post() ignores opts dates and calls
  `chargeAssetThrough(assetId, lastCompletedPeriod, opts)` which late-dates per month); 'prepaid.release' (entity CapexPayment | OpexPayment by
  sourceType; sourceId = payment id; post → `releaseSourceThrough`).
- FC 'inventory.prep_draw' { entityType 'PrepBatch', nothingToPost { 'batch_not_found', 'zero_value', 'not_ad_hoc' }, post → postPrepDraw };
  'inventory.waste' and 'pos.void_waste' value from the STORED WasteLog.estimatedCostCents, logs found by WasteLog.orderItemId (not notes),
  'pos.void_waste' reason filter IN VOID_WASTE_REASONS (void_after_fire, cancelled_after_fire, returned_food); 'inventory.count' from the stored
  PhysicalCountLine.valueCents; repoint the postWasteLog / postStockCount imports to accounting/inventoryPosting.ts (then drop the old re-exports in
  supplierPosting.ts / countPosting.ts if nothing else imports them). unflaggedMisses += ad-hoc prep batches with no 'inventory.prep_draw:' entry,
  and cancelled orders with net-out sale rows but no return/waste rows (the restore-failure sweep — flag 'stock_restore_failed').
- TX 'giftcard.expire' { entityType 'GiftCard', multiPost: true, nothingOwed unless card.breakagePendingAt is set, post → expireOneGiftCard }.
- PP 'ic.fleet_charge' { entityType 'FleetCharge', entityId '<agreementId>:<YYYY-MM>', nothingOwed when the IntercompanyTransfer with sourceRef
  'fleet:<…>' is posted; post() refuses unless the operator belongs to BOTH companies (else nothingOwed + 'ask the CEO to Charge now'); re-derives
  the first day open in BOTH companies → chargeFleetMonth }.
- DL 'cod.rider_debt.reversal' { entity Payment, post → reverseCodRiderDebt(paymentId), nothingToPost when the debt entry is missing or already reversed }.
- OA 'ledger.till_clearing_split' { entityType 'Tenant', flag sourceId = tenantId, post → sweepTillClearing(tenantId, { mode: 'daily' }) } (the real
  Reposter shape: load → RefusedDoc.post).
- Petty cash / cash requests post inside their own transactions (no flags) — no reposter needed; confirm by grep and say so.
**tenants/routes.ts — company merge (inside the existing merge tx), every new company table:** FA (rename colliding assetTags with '-<srcSlug>',
merge FixedAssetClass by key (repoint fixed_assets / fixed_asset_* rows to the destination class id), repoint fixed_asset_events / pools /
tax_years / runs / depreciation, prepaid_releases); FC (stock_lots, stock_movements, grni_matches; goods_receipts.tenantId; waste_logs.tenantId);
TX (card_settlements / card_settlement_days); OA (customer_accounts (renumber colliding OA-numbers), customer_account_cards, customer_account_charges,
receivable_write_offs / attachments); CA (cash_voucher_settlements, petty_cash_spend_lines, petty_cash_movements.tenantId); DL
(customer_strikes.tenantId, customer_bans.tenantId). PP: refuse 422 MERGE_HAS_INTERCOMPANY when either company has 'intercompany'-controlled accounts
with lines, or any intercompany_transfers / fleet_rates row. Fiscal-year end month: refuse 422 FY_END_MISMATCH when the two companies differ and both
have a year-end close.
**setup/routes.ts:** PATCH /setup/chart-of-accounts/:id refuses isActive:false on a REQUIRED code, on a controlled account (422 ACCOUNT_CONTROLLED),
or on the cost / accumulated code of an active FixedAssetClass (422 ACCOUNT_IN_USE); renames allowed; POST never sets controlledBy.
(PATCH /setup/operations-config — withholdingTaxPct dropped, cashAdvanceSettleDays added — was done by w1-taxcore in W1; leave it as it is.)
""",
consumes=r"""
- Every W1-W3 exporter named above: chargeAssetThrough (w1-fa-engine), releaseSourceThrough (w2-fa-capex), postPrepDraw / postWasteLog / postStockCount
  (w1-stock), VOID_WASTE_REASONS (w2-sale), expireOneGiftCard (w1-taxsales), chargeFleetMonth + isMemberOfBoth (w1-ic), reverseCodRiderDebt (w2-dlv-cod),
  sweepTillClearing (w3-till); the module routes each provider calls. w0: APPROVAL_TYPES, REQUIRED, REGISTER_CONTROLLED_CODES.
""",
exposes=r"""
```ts
// reconciliation/backfillOrders.ts
export type RefusedPostingKind = /* existing */ | 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire'
  | 'ic.fleet_charge' | 'cod.rider_debt.reversal' | 'ledger.till_clearing_split'
export interface Reposter { /* existing */ multiPost?: boolean }
```
""",
tests=r"""
`repostersWaveB`: for each new kind, a refused posting (closed period or deactivated account) is flagged, then the reposter posts it once (late-dated
per owner decision 6) and a second run finds nothing; gift-card '@n' entries reposted with multiPost; the fleet reposter refuses an operator of one
company; B's flags are untouched by A's run. `approvalsInbox` (updated): each new type appears for A's CEO only for A's rows, counts per company,
actions call the module routes (a finance user never sees Approve), cash_voucher labelled 'Cash requests' with Approve disabled for the HOD signer,
cash_request_hod visible to the holder's line manager, the recipe provider resolves a modifier recipe's company. `tenantMergeWaveB` + `fixedAssetsMerge`:
assets, events, pools, classes, tax years move (colliding tags suffixed; the worker keeps charging in the destination; recapitalisation → 409), lots /
movements / GRNI matches, card settlements, clients / cards / charges / write-offs, settlements / spend lines, strikes all move; a company with
inter-company activity → 422 MERGE_HAS_INTERCOMPANY. `setupChartGuards`: deactivating 2210 (REQUIRED), a controlled due-from, or 1510 while its
class is active → 422; renaming works (operations-config is covered by w1-taxcore's operationsConfigWaveB test).
""",
))

W4.append(dict(
id="w4-admin-fa", wave="W4", area="admin UI — fixed assets, CapEx, Investment", idx=None,
title="Admin: fixed-asset register v2 (tabs, requests, pools, reports, classes) and CapEx capitalisation / Quick buy / WHT / deposits",
summary="UI only — accounting/fixed-assets/**, components/fixedAssets/**, finance/capex, finance/capital-ledger, accounting hub ledger link + README.",
owns=["frontend/admin/src/app/accounting/fixed-assets/page.tsx", "frontend/admin/src/app/accounting/fixed-assets/[id]/page.tsx (new)",
      "frontend/admin/src/app/accounting/fixed-assets/pools/page.tsx (new)", "frontend/admin/src/app/accounting/fixed-assets/requests/page.tsx (new)",
      "frontend/admin/src/app/accounting/fixed-assets/reports/page.tsx (new)", "frontend/admin/src/app/accounting/fixed-assets/classes/page.tsx (new)",
      "frontend/admin/src/components/fixedAssets/** (new: shared tabs, request forms, schedule table)",
      "frontend/admin/src/app/finance/capex/page.tsx", "frontend/admin/src/app/finance/capital-ledger/page.tsx",
      "frontend/admin/src/app/accounting/page.tsx (W4: LEDGER_LINKS gains Fixed assets)", "frontend/admin/src/app/accounting/README.md"],
read=["plan_assets.json: build_split D + E, routes (fixed-assets + capex)",
      "critic_assets_foodcost_0.json: violations 1 (no auto switch), 2 (Quick buy bank only), 13 (LINE_CAPITALISED), 12 (prepaid term required)",
      "the API on disk: backend/src/modules/fixedAssets/routes.ts, requests.ts, pools.routes.ts, reports.ts; financePlanning/routes.ts"],
tasks=r"""
**Fixed assets (Finance → Accounting → Fixed assets, the EXISTING page upgraded in place):** tabs Register | Smallwares | Requests | Reports | Classes &
policy.
- Register: company column + per-company totals in All-companies view; filters (class, brand, location, status, as-of date); CSV; a 'Last run' strip
  (the worker's last run and failures) with 'Charge now through <last completed month>' (POST /depreciate; 422 MONTH_NOT_ENDED in words) — there is
  NO on/off switch (depreciation is automatic); 'Buy equipment' → /finance/capex?quickBuy=1 for users with the capital module; NO Add form (POST /
  answers USE_CAPEX); back link → /accounting (not /modules/assets).
- [id] page: past + forecast schedule, events timeline, edit form for descriptive fields only, request forms (dispose — sale/scrap/lost/stolen with
  proceeds and BankAccountSelect; impair / write down; change estimate; void; undispose; transfer brand/location); pending requests with inline
  approve/reject for the CEO only (from the API's capability flags).
- Pools page: pools per outlet / brand / type with units, NBV, layers and last count; record a count (also fnb_manager); write-off (breakage/loss) and
  transfer-units requests.
- Requests page: the module's queue (pending / applied / rejected), CEO actions.
- Reports page: schedule, roll-forward, NBV as-of, tie-out (red mismatch, green ok), 1340 advances, tax + deferred tax (freeze for the CEO).
- Classes page: lives, tax rates, pooled flag, and policy (alert days, deferred tax rate, tag prefix) — CEO edits, others read.
- Every class list and default life comes from GET /accounting/fixed-assets/lookups — delete the local DEFAULT_LIFE (~35) and any local list.
  Write controls hidden for fnb_manager except the pool count.
**CapEx (finance/capex/page.tsx):** CapitalisePanel → 'Prepare for the register': class list from the response's assetClasses (delete the local list
~1477-1488), default life from the class; in-service date (default installed ?? delivery), salvage, name, location, pool type (pooled classes), input
tax; 'N assets will be tagged' for a split line; 'posts into the open month' when the delivery month is closed; pending state linking to
/accounting/fixed-assets/requests; finance sees 'Send to CEO', the CEO 'Capitalise now'. Line form: supplier picker (lookups.suppliers), 'Book as'
treatment (capital / prepaid / deposit / expense; 409 TREATMENT_LOCKED), input tax amount + authority, WHT section. Payment form: WHT preview (gross /
WHT / net) + exemption reference; 'Covers N months from' REQUIRED for rent advances (422 PREPAID_TERM_REQUIRED); deposit-return action on deposit
payments; the CEO's reclass-deposit (dry run first) and orphan reverse. **Quick buy modal** (?quickBuy=1): outlet, brand, item, class, smallwares type,
quantity, unit cost, supplier, BANK account only (critic — cash-bought equipment comes through a cash request's capex line), WHT and input tax.
Errors/badges: LINE_HAS_POSTINGS, PROJECT_HAS_POSTINGS, ADVANCE_APPLIED_TO_ASSET, PREPAID_RELEASING, TREATMENT_LOCKED, LINE_CAPITALISED,
CAPITALISATION_PENDING; badges 'Awaiting capitalisation' and 'Advance overdue'; asset links → /accounting/fixed-assets/<id>.
**Investment page (capital-ledger):** 'On the books as assets' excludes disposed / voided, with the disposed figure apart; no 'put on register' from
history (owner: no pre-servd assets).
**accounting/page.tsx:** LEDGER_LINKS gains 'Fixed assets' (keep w3-fc-report's gauge as it is). accounting/README.md: the new pages.
Tokens only (green charged / on target / posted; red failed / mismatch; purple actions); money in rupees; phone width.
""",
consumes=r"""
- w3-fa-api routes (fixed-assets, requests, pools, reports, classes, policy, lookups); w2-fa-capex CapEx routes (capitalise, quick-buy, deposit-return,
  reclass-deposit, orphans, lookups.suppliers / pools / assetClasses, WHT fields).
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Screenshot checklist for wave Z: register as finance and as
fnb_manager (no write controls but count); an asset page with a pending disposal (CEO sees approve); Quick buy; a capitalisation 'Send to CEO'; reports
tie-out; phone width.
""",
))

W4.append(dict(
id="w4-admin-stock", wave="W4", area="admin UI — stock documents, procurement bills, GRNI", idx=None,
title="Admin: counts (spot / opening / suggested / history), waste with brand + outlet, prep, sourcing classes, receiving, bills on receipts with tax/WHT, GRNI page",
summary="UI only — inventory pages, sourcing, procurement (bill form, receiving, new GRNI page).",
owns=["frontend/admin/src/app/inventory/count/page.tsx", "frontend/admin/src/app/inventory/count/history/page.tsx (new)",
      "frontend/admin/src/app/inventory/page.tsx", "frontend/admin/src/app/inventory/prep/page.tsx", "frontend/admin/src/app/sourcing/page.tsx",
      "frontend/admin/src/app/procurement/receiving/page.tsx", "frontend/admin/src/app/procurement/page.tsx",
      "frontend/admin/src/app/procurement/grni/page.tsx (new)",
      "frontend/admin/src/app/marketing/brands/page.tsx (service vessel field only)",
      "frontend/admin/src/app/onboarding/page.tsx (service vessel field only)"],
read=["plan_foodcost.json: build_split G (minus recipes — w3-recipes did them; minus MissedBillVariances — w3-admin-finance; minus exception labels — w0)",
      "plan_tax.json shared_file_changes procurement page (supplier tax block, bill authority + WHT); plan_assets.json bill equipment override",
      "critic_assets_foodcost_1.json violations 5 (GRNI: finance requests, CEO approves), 13 (opening counts roles + default cost)",
      "the API on disk: crosschecks/routes.ts, inventory/routes.ts, procurement/routes.ts + grniRoutes.ts + receiving"],
tasks=r"""
- **Count page:** Spot | Opening picker (Opening shown only when the API says the user may — finance / CEO / management); 'Suggest a spot count'
  (GET /crosschecks/physical-counts/suggested); outlet picker; opening unit cost per line defaulting to the latest purchase price the API returns;
  shows the ledger result (green posted, red notice when the posting failed); 422 OPENING_NOT_ALLOWED / OPENING_COST_REQUIRED in words.
  New count history page (GET /crosschecks/physical-counts) with lines, values and ledger status.
- **Inventory page:** waste drawer gains brand (GET /concepts?view=picker limited to the item's company) and outlet pickers; category select incl.
  Drinks (beverage → 1220) and Packaging (→ 1230); 'Issue on receipt' toggle with the helper 'for oil, salt and other items no recipe measures';
  'Assign a company' for company-less items with an opening unit cost (creates the opening stock); unit cost read-only once the item has deliveries
  (COST_FROM_DELIVERIES); **G15: the dead 'Purchase order coming soon' button → a 'Purchase order' button opening /procurement (new PO).**
- **Prep page:** outlet picker; ad-hoc batch shows 'draws from stock at the price paid'.
- **Sourcing:** the category becomes a select incl. Drinks and Packaging, each labelled with its stock account.
- **Receiving page:** outlet picker and the note 'booked to Goods received not invoiced until the bill arrives'.
- **Procurement bill form:** each line is either a stock item ('Fill from PO' sends poLineId + inventoryItemId; 'Fill from receipt' uses GET
  /procurement/grni/unbilled-lines?supplierId) or an expense (category → 6xxx code); 422 STOCK_LINE_NEEDS_RECEIPT / RECEIPT_LINE_MISMATCH /
  OVER_BILLED / EXPENSE_ACCOUNT_REQUIRED in words; 'Tax charged by' (FBR / PRA / SRB / KPRA / BRA, default the supplier's) and WHT section; an
  equipment refusal (422 USE_CAPEX) explains CapEx Quick buy and offers 'Not equipment' (reason ≥ 10) only to finance / the CEO (API capability).
  Supplier form: Tax block (filer status, WHT exemption certificate no. + until, usual tax authority, usual WHT section).
- **New /procurement/grni page:** open received-not-billed lines (supplier, item, received − billed, value, age, stale > 30 days badge), pending
  bill matches, 'Ask to write off' (finance / procurement, reason) and the CEO's Approve / Reject (from capability flags); 409 NOTHING_OPEN /
  WRITE_OFF_PENDING in words.
- **Brand primary service vessel (packaging rule, FINAL owner rule):** Marketing → Brands create + edit and the onboarding company/brand create
  (POST /tenants first brand and POST /concepts) gain a REQUIRED 'Primary service vessel' choice — 'Plate' / 'Packaging (the packaging is the
  serving vessel)' — no preselected value on create; helper text 'Packaging counts on takeaway and delivery always; with Plate, dine-in counts
  packaging only when staff tap Box given'; editing it shows 'applies to orders from now on'.
Tokens only; money in rupees; phone width; costs hidden where the API hides them.
""",
consumes=r"""
- w3-recipes (concepts / tenants serviceVessel); w3-stockdocs routes (counts, suggested, history, waste, prep, item PATCH, transfers); w2-ap routes (bills, suppliers, GRNI, receiving).
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Screenshot checklist: count page (spot + suggested) as boh, opening
as finance; waste drawer with brand/outlet; bill form with a receipt-filled stock line and an expense line; GRNI page as finance (ask) and as CEO
(approve); inventory 'Purchase order' button; brand create with the vessel choice (refused without it).
""",
))

W4.append(dict(
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

W4.append(dict(
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

W4.append(dict(
id="w4-customer", wave="W4", area="customer surfaces — storefront, mobile, tablet receipt", idx=None,
title="Customers: delivery fee + one GST row (incl. delivery), blocked-account notice with appeal, tracker hides a rerouted code; mobile checkout on the server quote",
summary="UI only — storefront checkout / tracker / account / auth / reserve / group order, BlockedNotice, mobile checkout / order / login / account, tablet printer.",
owns=["frontend/storefront/src/app/[concept]/checkout/page.tsx", "frontend/storefront/src/app/[concept]/checkout/README.md",
      "frontend/storefront/src/app/[concept]/order/[id]/page.tsx", "frontend/storefront/src/app/account/page.tsx",
      "frontend/storefront/src/components/auth/LoginForm.tsx", "frontend/storefront/src/components/auth/SignupForm.tsx",
      "frontend/storefront/src/components/account/BlockedNotice.tsx (new)",
      "frontend/storefront/src/app/reserve/page.tsx", "frontend/storefront/src/app/reserve/[slug]/page.tsx",
      "frontend/storefront/src/app/group-order/page.tsx", "frontend/storefront/src/app/group-order/[code]/page.tsx",
      "mobile/app/[concept]/checkout.tsx", "mobile/app/order/[id].tsx", "mobile/app/login.tsx", "mobile/app/(tabs)/account.tsx",
      "tablet/src/lib/printer.ts"],
read=["plan_delivery.json build_split G; plan_tax.json build_split T7 (customer parts only — docs are w4-docs')",
      "critic_tax_people_0.json violation 12 (mobile pickup-only until a pin picker exists; no expo-location, no package change)",
      "critic_cash_delivery_onaccount_0.json violation 10 (reserve + group-order pages), Q9 (a blocked customer can still sign in, with the notice)"],
tasks=r"""
- **Storefront checkout:** the Quote type adds itemTaxCents and deliveryFeeTaxCents; rows Subtotal / GST (taxCents, sub-label 'incl. PKR x on
  delivery' when deliveryFeeTaxCents > 0) / Delivery (the fee) / Service charge / Total — the server's figures only. BANNED at checkout → BlockedNotice
  with the appeal (error details { banId, companyName, appeal }). README.
- **BlockedNotice (new):** reads GET /storefront/account/blocks; copy 'Your account can't order from <brands> right now. If this number or email is new
  to you, or you think this is a mistake, ask our help desk to review it.'; an appeal form (reason select new_number / mistake / other + message
  10-1000) → POST /storefront/account/ban-appeals; states open / declined / sent (409 APPEAL_OPEN, 429 APPEAL_TOO_SOON in words). Shown after login and
  signup success (servd.pk and brand hosts), on /account, at checkout, and on reserve / group-order when they answer BANNED. Sign-in itself is never
  refused (owner default Q9).
- **Order tracker:** the Delivery row (fee) and GST sub-label; when handoverRerouted, the code is replaced by 'Your rider has the code for this order'.
- **Mobile:** checkout uses GET /storefront/quote (no local 17 %), sends the real checkout body (createDirectOrderSchema: conceptSlug, type,
  paymentGateway, items …), text segment labels (no emoji), and offers PICKUP ONLY until a pin picker exists (no expo-location — no package change);
  order/[id].tsx adds the Delivery row; login and account show the blocked notice + appeal; checkout BANNED shows the appeal action.
- **Tablet printer.ts:** ReceiptOrder.deliveryFeeCents? and totalLine('Delivery', …) before Tax.
servd pages on --servd-* tokens; brand pages keep their palettes; brand names via formatBrandName(); SVG or text only, no emoji.
""",
consumes=r"""
- w1-taxsales (quote / checkout / order fields), w1-bans (GET /storefront/account/blocks, POST /storefront/account/ban-appeals, BANNED details),
  w1-dlv-core (tracker handoverRerouted).
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. `npx tsc --noEmit -p .` in frontend/storefront, mobile and tablet clean for your files. Checklist: checkout with a delivery fee
on servd.pk and one brand host; the blocked notice + appeal; tracker with a rerouted code; mobile checkout pickup-only.
""",
))

W4.append(dict(
id="w4-admin-oa", wave="W4", area="admin UI — on-account at the till, clients, statements, write-offs, order page", idx=None,
title="Admin: 'On account' at the till (scan the client's QR card), client pages + card print, statements, bad-debt write-off, order page fee/tender rows",
summary="UI only — components/pos/**, refunds, pos shift Z-report, lib/api.ts, receivables pages, clients pages, card print, write-off dialog, orders/[id].",
owns=["frontend/admin/src/components/pos/PaymentModal.tsx", "frontend/admin/src/components/pos/OnAccountPanel.tsx (new)",
      "frontend/admin/src/components/pos/tillApi.ts", "frontend/admin/src/app/refunds/RefundOptions.tsx", "frontend/admin/src/app/refunds/refundEngine.ts",
      "frontend/admin/src/app/pos/shift/page.tsx", "frontend/admin/src/lib/api.ts",
      "frontend/admin/src/app/accounting/receivables/page.tsx", "frontend/admin/src/app/accounting/receivables/clients/page.tsx (new)",
      "frontend/admin/src/app/accounting/receivables/clients/[id]/page.tsx (new)", "frontend/admin/src/components/finance/OnAccountCardPrint.tsx (new)",
      "frontend/admin/src/components/finance/WriteOffDialog.tsx (new)", "frontend/admin/src/app/orders/[id]/page.tsx",
      "frontend/admin/src/components/pos/PosCart.tsx (Box given only)",
      "admin READMEs for pos, refunds and receivables (the folders above)"],
read=["plan_onaccount.json build_split D1-till-ui + D2-finance-ui; routes (pos on-account, customer-accounts, write-offs)",
      "plan_tax.json: receivables withholding dialog (income tax s.153 → 1330 / sales tax withheld → 1335), orders/[id] delivery fee row",
      "critic_cash_delivery_onaccount_2.json violations 13 (refundEngine, orders/[id], lib/api), 15 (capability flags, no role lists)"],
tasks=r"""
- **Till:** PaymentModal gains 'On account' (hint 'Client card'), disabled offline and for a part-paid or tipped bill; picking it shows OnAccountPanel:
  an auto-focused scan input (a keyboard-wedge scanner types the code + Enter), a 'Use camera' button with window.BarcodeDetector (qr_code) when
  supported (hidden otherwise), a typed-code fallback; POST /pos/on-account/lookup → client name, card label, available credit (green progress bar),
  refusals in plain words with the amounts; the bill from GET /pos/orders/:id/on-account/quote (cash-rate GST line); a reference field when
  requiresReference; 'Charge PKR X to <client>' → POST /pos/orders/:id/on-account with a NEW idempotency key per submission; the done screen shows the
  fiscal line + 'Ask the client to sign the bill' and prints the receipt. A pre-bill for an on-account bill uses 'cash'. tillApi.ts: lookupOnAccount,
  onAccountQuote, chargeOnAccount, the error-code → message map (every CHARGE_ERRORS code). RefundOptions + refundEngine: 'Back to the client's
  account' for on_account tenders (HAND_BACK_TENDERS knows on_account). pos/shift/page.tsx: an 'On account' row (count, total, per client) in the
  Z-report. lib/api.ts: any shared type / helper the above need.
- **Clients (new pages under Receivables):** list (status chips, limit, exposure progress bar, available, overdue badge, unbilled), 'New client' form
  (a 'waits for the CEO' note unless the API says the user approves), 'Issue <Month> statements' bulk dialog (periodTo = last day of the previous PKT
  month), filters overdue / pending. Client page: header + actions (edit, request a limit change, suspend / reactivate, issue a statement, send a
  reminder), cards (issue / rotate open OnAccountCardPrint with 'shown once — print now', revoke), unbilled bills (order ref via lib/orderRef, brand,
  card, reference, amount, refunded; 'not billed yet' rows), statements (print HTML, send, open in Receivables), write-off history, tie-out panel.
  Every action shown from the API's capability flags (canApprove, canEdit, canIssueCards …) — no local role lists; NTN / limits only when returned.
- **OnAccountCardPrint:** credit-card-size print layout with the existing `qrcode` package (QRCode.toDataURL(code, { errorCorrectionLevel: 'M' })),
  client name, OA number, card label, the code in groups, 'valid only at <company> outlets; report a lost card to finance'; window.print; the code is
  never kept in state after close.
- **Receivables page:** statements in the list (kind badge 'Statement', period); status 'written_off'; a 'Write off' action on outstanding rows
  opening WriteOffDialog (amount defaulting to the balance, reason, 1-5 files — images compressed with lib/photoPrep, PDFs as is); pending write-off
  badge; recovery dialog (BankAccountSelect); 'Credit note' hidden for statements with the hint 'refund the bill at the till'; an optional client
  picker in Raise; the withholding dialog offers 'Income tax (s.153) → 1330' and 'Sales tax withheld by the client → 1335' (with the authority shown);
  header comment.
- **"Box given" (packaging rule, FINAL owner rule):** on a DINE-IN order, each line whose serviceVessel is 'plate' (null = plate) shows a small
  'Box given' toggle — in the till cart / open ticket (PosCart.tsx) and on orders/[id] — calling POST /pos/orders/:orderId/items/:itemId/box-given
  ({ undo: true } to take it back while the order is open). On shows a 'Boxed' chip (green state token); 409 BOX_NOT_NEEDED / ORDER_COMPLETED in
  words; hidden on takeaway, delivery and packaging-vessel lines (packaging already counts there). tillApi.ts: boxGiven(orderId, itemId, undo?).
- **orders/[id] page:** a 'Delivery fee' row and the GST sub-label '(incl. PKR x on delivery)'; the on_account tender label (client name + OA number)
  and its colour token; HAND_BACK_TENDERS includes on_account.
Money typed in rupees (toPaisa); tokens only; phone width.
""",
consumes=r"""
- w3-till (/pos/on-account/*), w2-oa-recv (customer-accounts, statements, write-offs, receivables withholding), w1-taxsales (order fee fields, receipt labels).
""",
exposes="(UI only — none)",
tests=r"""
UI agent — no tests. `npx tsc --noEmit -p .` in frontend/admin clean for your files. Screenshot checklist: Box given on a Simmer dine-in line (on,
then undo), absent on a takeaway line; scan → over-limit refusal → successful charge →
done screen; Z-report row; refund screen option; client create (pending) → CEO approve in the inbox → card print → statement issue → payment →
write-off request → CEO approve.
""",
))

W4.append(dict(
id="w4-docs", wave="W4", area="all areas — runbooks and READMEs", idx=None,
title="Runbooks for finance, the CEO, cashiers and IT; module READMEs; the D1/D3 spec amendment",
summary="docs/*.md (new + updated), backend module READMEs not owned by another agent, workers/README.md, .handoff/fixes/D1D3-spec.md amendment.",
owns=["docs/fixed-assets.md (new)", "docs/food-cost.md (new)", "docs/cash-requests-and-petty-cash.md (new)", "docs/on-account.md (new)",
      "docs/emergency-overrides.md (new)", "docs/raast.md", "docs/TAX_SETUP.md", "docs/pos-connector-api.md",
      "backend/src/workers/README.md", "backend/src/modules/accounting/README.md", "backend/src/modules/inventory/README.md",
      "backend/src/modules/procurement/README.md", "backend/src/modules/orders/README.md", "backend/src/modules/pos/README.md",
      "backend/src/modules/dispatch/README.md", "backend/src/modules/rider/README.md", "backend/src/modules/riders/README.md",
      "backend/src/modules/complaints/README.md", "backend/src/modules/crm/README.md", "backend/src/modules/storefront/README.md",
      "backend/src/modules/reports/README.md", "backend/src/modules/invoices/README.md", "backend/src/adapters/whatsapp/README.md",
      "backend/src/connectors/README.md", "backend/src/lib/README.md", "backend/src/modules/README.md",
      ".handoff/fixes/D1D3-spec.md (amendment section only)"],
read=["every plan_*.json summary + removes + assumptions; schema-merged.prisma.md §0; chart-merged.md; this wave's build-waves.md (what was built)",
      "the code on disk (W1-W3 are merged when you start) — document what IS there; if code and plan differ, the code wins and you note it"],
tasks=r"""
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
""",
consumes="- Everything merged in W1-W3 (read the code).",
exposes="(docs only — none)",
tests=r"""
Docs agent — no tests. Check `grep -n` that every identity string integrationPass2Books.test.ts reads from docs/pos-connector-api.md is still present.
""",
))
