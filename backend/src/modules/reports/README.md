# reports

Backend module: **reports**. HTTP routes + business logic for the Reports domain. Registered into Fastify by `src/index.ts` under the `/reports` URL prefix.

## Files

- `demand-forecast.ts` — TypeScript module
- `menu-engineering.ts` — TypeScript module
- `routes.ts` — Fastify route registrations for this module
- `service.ts` — the one implementation of each sales KPI (register totals, by hour / channel / day, top items, station times), shared with /management and the daily sales email
