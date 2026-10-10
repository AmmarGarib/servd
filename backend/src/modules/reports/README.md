# reports

Backend module: **reports**. HTTP routes + business logic for the Reports domain. Registered into Fastify by `src/index.ts` under the `/reports` URL prefix.

## Files

- `demand-forecast.ts` — TypeScript module
- `menu-engineering.ts` — TypeScript module
- `routes.ts` — Fastify route registrations for this module
- `service.ts` — the one implementation of each sales KPI (totals from completed orders net of refunds — net = the P&L net revenue — by hour / channel / day, top items, station times) and the PKT report-period helper, shared with /management, /reconciliation and the daily sales email
