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
