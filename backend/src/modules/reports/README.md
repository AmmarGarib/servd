# reports

Backend module: **reports**. HTTP routes + business logic for the Reports domain. Registered into Fastify by `src/index.ts` under the `/reports` URL prefix.

## Files

- `demand-forecast.ts` — TypeScript module
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
