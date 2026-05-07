# frontend/storefront

Customer-facing online ordering. Next.js + Tailwind. Hosts the main "all brands" site and the per-brand microsites (Stax, Strata, Flipd).

## Layout

- [`src/app/`](./src/app/) — App Router pages. `/[concept]` is the primary order flow; `/brand/[slug]` is the brand-specific microsite; `/brands/<name>` are hand-built static brand pages.
- [`src/components/`](./src/components/) — Shared components (cart drawer, menu grids, brand layouts).
- [`src/lib/`](./src/lib/) — API client, analytics tracker, formatters.
- [`src/store/`](./src/store/) — Zustand stores (cart, customer auth).

## Run

```
npm run dev    # http://localhost:3002
```
