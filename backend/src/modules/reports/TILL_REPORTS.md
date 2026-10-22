# Till Reports — contract (owner, 2026-10-22)

The till's **Reports** (till menu → MANAGER → Reports) replaces the 20 Oct till
"Sales report" screen. Owner screenshots: a report list on the left (search,
star favourites, groups), the chosen report on the right (Mandatory Fields,
Filter Options, buttons Report / Download / Reset; Cashier Sales Detail also
Print). ONE engine: every sales figure comes from `reports/service.ts`
(`soldOrderWhere`, the sales definitions) and `reports/tillSales.ts`
(which this module may refactor and absorb — the old `GET /reports/till-sales`
route may stay as a thin alias or be removed together with its screen). Never
a second definition of "a sale". Read only: nothing here posts or changes data.

All routes under `/api/v1/reports/till`, `requireAuth(...REPORT_READERS)` like
`/reports/till-sales`; money columns only for FINANCIALS_VIEWERS (others get
counts / quantities, money cells null) — the same rule as till-sales.
Company separation: every `conceptId` is checked with `assertConceptOwned(req,
id, 'read')` (foreign → 404); lookups list only the caller's companies' rows.

## GET /reports/till/catalog
```jsonc
{ "groups": [ { "key": "recommended", "title": "Recommended reports", "reportIds": [...] },
              { "key": "menu_item", "title": "Menu item sales report", "reportIds": [...] },
              { "key": "sales", "title": "Sales report", "reportIds": [...] },
              { "key": "no_charge", "title": "No charge report", "reportIds": [...] },
              { "key": "stock", "title": "Stock report", "reportIds": [...] } ],
  "reports": [ { "id", "title", "filters": FilterKey[], "options": OptionKey[],
                 "groupBy": GroupByKey[] | null,   // Payment Summary's "Select Payment" (required when present)
                 "printable": boolean } ] }
```
Report ids (title):
- `menu_item_sales_summary` Menu Item Sales Summary — per menu item within category: qty, gross, discount, net, tax.
- `sales_detail` Sales Detail — one row per sold order: order no (orderRefOf), date/time, receipt no (fiscal ?? tax invoice), order type, R/T no, guest, user, waiter, items, gross, discount, service charge, delivery fee, tax, total, payment methods.
- `cashier_sales_detail` Cashier Sales Detail — one section per user (who rang it), each with the breakdowns the ticked options ask for (below), plus a totals section.
- `no_charge_item_detail` No Charge Menu Item Sales Detail — comped orders' lines: order no, time, guest, item, qty, value, reason / approver if stored.
- `no_charge_item_summary` No Charge Menu Item Sales Summary — per item: qty, value.
- `payment_summary` Payment Summary — payments in the period grouped by the chosen `groupBy`, with count and amount per group + grand total; rows can be expanded server-side as detail (order no, time, method, amount, order by, settle by, terminal) when `opts=detail`.
- `city_ledger_detail` City Ledger Detail — on-account clients (`receivables/customerAccounts.ts`): per client, charges / payments / balance in the period, read from the existing tables.
- `stock_transfer_summary` Stock Transfer Summary — stock transfers in the period (stockTransfer module): from, to, items, qty, value, status.
- `stock_ledger` Stock Ledger — stock movements (lib/stockLedger.ts) per item: opening, in, out, closing qty (+ value for financials viewers).
- `closing_stock` Closing Stock — per item at the end date: qty and value (FIFO lots).
Stock reports take the outlets' LOCATIONS (the brands' locations) — the agent decides the exact link and documents it here.
  **Decided (2026-10-22):** Stock Transfer Summary lists transfers whose from OR to location is one of the selected brands'
  `ConceptLocation` rows, both ends inside the brands' companies, by request date; qty = received qty once received; value =
  qty × the item's current FIFO head cost (an estimate — transfers do not move lots yet, stockLedger.ts reserves
  `transfer_in/out`). Stock Ledger and Closing Stock read the COMPANY pool of the selected brands' companies
  (`StockMovement.tenantId`): FIFO lots are company-wide today (per-outlet pools are the next build), so a per-outlet cut
  would not add up (opening + in − out ≠ closing). Closing = Σ movements up to the end of `dateTo` (= the lots as at then).

Back office group (owner, 2026-10-22; key `back_office`, title "Back office report") — Payment Summary and City Ledger
Detail are ONE id each, listed in both groups:
- `settlement_detail` Settlement Detail — one row per sold bill: order no, time, receipt no, order type, order by, settle by
  (drawer owners of its payments), closed by (`Order.settlementChannel`: Pushed to Keenu / Closed in servd / Online), bill
  total (incl. wallet + gift card), one column per tender used. Options `showCurrency`, `includeNoCharge` (default off).
- `settlement_summary` Settlement Summary — sections "By tender" (= `salesByTender`: tenders, comp and refunds apart) and
  "By channel" (= `salesBySettlement`), the till's filters ANDed in.
- `payment_detail` Payment Detail — one row per payment (same rows as Payment Summary's `detail`).
- `discount_detail` Discount Detail — bills with a discount or promo: gross, discount, promo, promo code, %, reason (only
  where the till raised a `discount_above_cap` flag, which carries the cashier's reason); servd stores no approver per discount.
- `tax_collection` Tax Collection — per Karachi day × brand: GST as charged (`Order.taxCents`), split by the tax class the bill
  was settled at (`lib/pricing.ts tenderOfPayments`: cash or a mix = cash rate; wholly card / Raast / wallet = card rate).
  Never `concept.taxRate`. Taxable = bill ex-GST, ex-tip. Refunds are not netted.
- `tax_analysis` Tax Analysis — per stored `Order.taxRatePct`: bills, taxable value, GST, total.
- `category_tax_collection` Category Wise Tax Collection — each bill's GST (less the delivery fee's) shared across its lines
  after discount with `allocateTaxCents`, summed per category.
- `city_ledger_summary` City Ledger Summary — per client: bills, charges (selected brands, less refunds), statement payments
  in the period, balance now (`exposureOfTx`: owed − credit). `city_ledger_detail` = one section per client with every
  charge / refund / payment line, the total line = balance now.
- `fiscal` Fiscal — `FiscalDocument` rows of the brands created in the period: order, kind, closed by, status, reason
  (`servd_channel` / manual_required …), fiscal number, authority, filed, test, amount.
- `driver_efficiency` / `driver_deliveries` Driver Efficiency / Deliveries — own-fleet riders on the brands' SOLD orders with a
  `riderId` (assigned → accepted → picked up → delivered from the Order timestamps; delivered = deliveredAt ?? code time ??
  completedAt), plus offers / declines / time-outs from `RiderJobEvent` (the order's company). Times over 10 h are dropped from
  averages.

Decisions the contract left open (2026-10-22):
- Every sales report reads `soldOrderWhere` with the filters passed as `SalesQuery.extra` (and `conceptIds`) — the same
  engine as /reports. No Charge = a paid comp covering the bill (pos/orderSummary.ts rule); orderTypes `dine_in` etc. exclude
  No Charge bills, `no_charge` picks them. `includeNoCharge` exists on Cashier Sales Detail, Settlement Detail / Summary and
  the tax reports; elsewhere No Charge bills are included unless the orderTypes filter leaves them out.
- Line figures (menu item / category reports): gross = menu price × qty (voided lines out, as `topItems`); the bill's
  discount and GST (less the delivery fee's GST) are shared by `allocateTaxCents`. A bill refunded later stays sold.
- Filters a report does not list are ignored; a malformed value of any filter is 400 `INVALID_FILTER`; `groupBy` on a report
  without one is 400. Missing dates = today; > 92 days 400 `RANGE_TOO_LONG`; no conceptIds 400 `CONCEPTS_REQUIRED`.
- `paymentType` on order reports: `refund` alone keeps bills with a refund; `orderBy` = `Order.posStaffId`; `settleBy` = a paid
  payment in a drawer of that user. On Payment Summary / Detail they apply to the payments.
- Cashier Sales Detail sections: one per user (title = name; online orders under "No user (online)"), then "All users"; each
  has columns breakdown / line / count / amount — "Summary" lines (orders, gross, discount, GST, net = `salesTotals`, payments
  received) then one block per ticked option. `userWise` adds a leading "By user" table. `vouchers` = payouts (expense) and
  pay-ins (income) of drawers in the brands' companies, by drawer owner.
- `showCurrency` only adds "(PKR)" to money column labels; cells stay paisa numbers.
- Lookups: users = who rang the brands' orders + drawer owners in the window (default last 31 days); waiters = waiters on
  those orders, of the brands' companies; terminals = drawers of the brands' companies overlapping the window that took a
  payment for the brands or sit at one of their outlets; items = the companies' stock items.
- Export: one section = one table; several = one table with a `Section` column (`sectionKey`) over the union of columns.
- `GET /reports/till-sales` (reports/tillSales.ts) is left unchanged as the old route.

FilterKey: `users` (who rang: Order.posStaffId) · `waiters` (Order.waiterEmployeeId) · `orderTypes` (dine_in|takeout|delivery|no_charge) · `categories` · `menuItems` · `sources` (Order.source + till delivery: servd|pos|cart|manual) · `terminals` (= drawers: Shift ids of the period) · `paymentMethods` (cash|card|raast|on_account|comp|…) · `paymentType` (sale|refund) · `orderBy` (users) · `settleBy` (users = the drawer owner, Shift.userId of the payment's shift) · `q` (search: order no / receipt no / guest) · `items` (stock items, stock reports).
OptionKey (Cashier Sales Detail): `orderType` · `category` · `menuItem` · `tax` · `extraCharge` (service charge + delivery fee) · `discount` · `payment` · `businessSource` · `waiterWise` · `userWise` · `taxableValue` (show ex-tax value) · `includeNoCharge` (comped orders counted; default off) · `vouchers` (the drawers' cash movements: payouts = expense, pay-ins = income). Payment Summary option: `showCurrency` (prefix PKR) · `detail`.
GroupByKey (Payment Summary "Select Payment"): `payment_method` (default) · `payment_type` · `order_by` · `settle_by` · `terminal` · `order_type`.
Not in servd's data (owner asked; do NOT invent): sub category, menu subgroup, session. Leave them out of the catalog.

## GET /reports/till/lookups?conceptIds=a,b&dateFrom&dateTo
`{ outlets: [{id,name}], users: [{id,name}], waiters: [{id,name}], categories: [{id,name,conceptId}], menuItems: [{id,name,categoryId}], terminals: [{id,label}] /* drawers: "<cashier> · <opened PKT>" */, sources: [{id,label}], paymentMethods: [{id,label}], orderTypes: [{id,label}], items: [{id,name}] }` — `outlets` = the caller's brands (no conceptIds needed); the rest scoped to the given brands.

## GET /reports/till/run/:reportId
Query: `conceptIds` (comma list, ≥1, required) · `dateFrom` `dateTo` (YYYY-MM-DD, Karachi days, ≤ 92 days) · each FilterKey as a comma list (`q` plain) · `groupBy` · `opts` (comma list of OptionKeys) · `format` (csv|xlsx|pdf → a file through `lib/reportExport.ts sendReportFor`; sections become one table with a `Section` column, or one ReportTable per section if the exporter supports it).
JSON:
```jsonc
{ "id", "title", "period": "2026-10-22 to 2026-10-22", "outlets": ["Dastaan"],
  "sections": [ { "title": "Muhammad Bilal" | null,
                  "columns": [ { "key", "label", "type": "text"|"number"|"cents" } ],
                  "rows": [ { "<key>": string|number|null } ],
                  "totals": { "<key>": … } | null } ],
  "notes": [ "…" ] }
```
Errors: unknown report 404; bad filters 400; foreign brand 404.
