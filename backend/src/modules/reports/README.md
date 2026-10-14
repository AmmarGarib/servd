# reports

Backend module: **reports**. HTTP routes + business logic for the Reports domain. Registered into Fastify by `src/index.ts` under the `/reports` URL prefix.

## Files

- `demand-forecast.ts` — TypeScript module
- `foodCost.ts` — **THE food-cost variance engine** (`foodCostSummary`, `ingredientVariance`, `itemMovements`, `inventoryValuation`, `foodCostFlags`, `foodCostWarnings`, `buildFoodCostEmail`, and the close checks `inventoryCloseChecks`). The admin page, the Accounting hub's gauge and the scheduled `food_cost` email all read it; the old `GET /recipes/food-cost` is gone and nothing else computes food cost.
- `foodCostRoutes.ts` — the `/reports/food-cost` plugin (registered before `reportRoutes` at `/reports/food-cost`; below).
- `menu-engineering.ts` — TypeScript module
- `routes.ts` — Fastify route registrations for this module
- `service.ts` — the one implementation of each sales KPI (totals from completed orders net of refunds — net = the P&L net revenue — by hour / channel / day, top items, station times) and the PKT report-period helper, shared with /management, /reconciliation and the daily sales email

## Sales by tender (`GET /reports/by-tender`)

Same scope, dates and sold-order rule as `/reports/sales` (`salesByTender`):
paid receipts by method — Cash (incl. cash on delivery still pending on a
non-till order), Card – Keenu, Raast QR, the retired Keenu QR's old rows —
plus wallet credit and gift cards; `sharePct` of the money tenders; comps
apart; Raast split provisional / matched / not received; refunds by tender in
the period. Money to FINANCIALS_VIEWERS only — the other report readers get
order counts per tender (`volumeOnly`).

## Delivery fees in the sales totals

`SalesTotals.deliveryFees` is the delivery fee **before GST**, net of the fee share of refunds. It is already inside `gross` / `net` (the fee is a sale, credited to 4110) and is what the daily sales email and `/reports/sales` show as its own line. The delivery fee's GST is inside `taxCents`.

## Food cost variance (`/reports/food-cost`)

Module gate: `food_cost` (its own module; `GET` also opens with `accounting`). Every `GET` is `requireAuth(FINANCE_TEAM)`; align is `ADMIN_ONLY`. Dates `from` / `to` (or `dateFrom` / `dateTo`) as `YYYY-MM-DD`, read as PKT days, default the last 30 days; a bad date or a backwards range is 400 `BAD_DATE`. Scope is `resolveTenantScope`; an empty scope is 403 `NO_COMPANY_SCOPE`; a foreign `conceptId` / `locationId` / `tenantId` / `inventoryItemId` is 404. **Revenue and every percentage go only to `FINANCIALS_VIEWERS`**; everyone else gets `revenueHidden: true` and quantities / PKR at cost.

| Route | Returns |
|---|---|
| `GET /summary?from&to&conceptId?&locationId?` | `{ period, revenueHidden, wasteReasons, companies: FoodCostCompanyBlock[] }`, one block per company. A brand or outlet narrows the view to its company. By outlet, actual / timing / identity are `null` with a warning (the ledger is not per outlet). |
| `GET /ingredients?from&to&tenantId?&conceptId?&locationId?&costClass=food\|drinks\|beverage\|packaging&sort=unexplained\|theoretical\|waste\|name` | Per ingredient. `tenantId` defaults to the active company; 400 `TENANT_REQUIRED` in portfolio view with several companies; 400 `BAD_COST_CLASS`. |
| `GET /ingredients/:inventoryItemId/movements?from&to` | The item, its lots and its movements in the period. |
| `GET /valuation?tenantId?&asOf?` | Lots vs 1210 / 1220 / 1230, issued-not-booked, the pre-FIFO difference, unreconciled, failed postings, the 1290 balance, cut-over details (`catchupRefused`, `untied`, aligned) and GRNI (2015 vs open receipts − pending matches). |
| `GET /flags?tenantId?` | Read-only: `shrinkage`, `shrinkage_trend`, `yield_low`, `stock_shortfall`, `stock_unrecorded`, `recipe_foreign_stock`, plus `posting_failed` for `inventory.*` and `pos.void_waste`. |
| `GET /export.csv?view=summary\|ingredients\|valuation&…` | `text/csv`, same scope and revenue hiding. 400 `BAD_VIEW`. |
| `POST /align-inventory { tenantId, dryRun = true }` | CEO. Calls `postFifoAlign` (`inventory.fifo_align:<tenantId>`, Dr/Cr 12x0 vs 3020, dated now). 404 if the CEO is not a member of the company; 409 `CUTOVER_NOT_RUN` / `ALREADY_ALIGNED`. Audits `inventory.fifo_align`. |

**The identity** (checked per brand and company): `theoretical + explained + unexplained + alignment + timing == actual`, exactly.

- **actual** — the ledger's cost of sales 5010–5060 (`accounting/reports.ts costOfSalesByConcept`); **revenue** — brand sales (`brandSalesByConcept`; 4100, 4110 and 42xx are not in it).
- **theoretical** — the orders sold in the period (completed or refunded) at the lots their recipes actually relieved, with packaging where `packagingApplies`, plus the shortfall memo; comps and staff meals are their own buckets.
- **explained** — comps, staff meals, waste by reason, prep draws, issue on receipt, late-receipt settles, price adjustments (5060). Read from the **stock documents**, so they stay right while a difference waits for the CEO (H20, 1290) or a refused posting is re-posted.
- **unexplained** — spot-count variance (deliberately), the shortfall memo reversed, any manual journal to 5010–5050.
- **alignment** — the period's pre-FIFO-order cost of sales (own line); the one-off alignment itself posts to 3020 and never enters cost of sales (shown on Valuation).
- **timing** — sales (open orders, till orders whose drawer close is not posted) and stock documents (awaiting the CEO, a refused posting).
- **MC by order type** — target MC uses today's recipe cost (FIFO head) with packaging only where it applies to that order type, modifiers left out; actual MC is the lots relieved, "Box given" included. The Q factor is shown as "in menu pricing, not stock" and is never inside any figure.
- **Status** per brand: `no_data`, `incomplete` (stock data missing, or a dish sold with no recipe marks only its own brand), `good` (actual % ≤ target), `warning` (≤ 5 points over), `critical`.
- **Brand view**: lines tagged with a brand are *measured*; brand-less waste / counts / prep / issue split by the shares stored on their movements (`lib/brandShare.ts`) are *allocated*; the rest is head office's.

Close checks exported here and added to `CLOSE_CHECKS`: `grni_stale` and `inventory_postings_pending` (both warn, overridable). The scheduled `food_cost` email (`workers/scheduledReports.ts`) calls `buildFoodCostEmail` for the period since its last run.
