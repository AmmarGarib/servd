# frontend

Two Next.js applications.

- [`admin/`](./admin/) — Operations portal (staff-facing). Dashboard, POS, KDS, configuration, reports.
- [`storefront/`](./storefront/) — Customer-facing storefront with brand microsites (Stax, Strata, Flipd).

Both share a `@servd/types` package for canonical types, both consume the backend at `http://localhost:3001` in dev (configurable via `NEXT_PUBLIC_API_URL`).
