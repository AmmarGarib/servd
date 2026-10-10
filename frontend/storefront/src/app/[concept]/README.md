# [concept]

Storefront route: **/[concept]** — the per-brand ordering screen (`/stackd`,
`/simmer`, `/flipd`). Customer-facing page rendered via Next.js App Router.

## Files

- [`(menu)/`](./(menu)/) — a route group (no URL segment) holding the ordering
  screen itself, so its layout wraps `/<concept>` only:
  - `(menu)/layout.tsx` — server shell: looks the brand up
    (`lookupConcept` in `lib/liveConcepts.ts`) and returns a real 404 when the
    API answered without the slug (not a brand, or one hidden / deactivated in
    admin). When the API didn't answer (down, 5xx, a 429 from its shared rate
    limit) it renders the page anyway — bundled brands from
    `lib/fallbackBrands.ts` keep their full metadata, any other slug gets a
    `noindex` title. Sets the ordering screen's title, description and
    canonical (`${SERVD_ORIGIN}/<slug>`).
  - `(menu)/page.tsx` — the ordering UI (client component): menu, item modal,
    cart drawer.

## Subdirectories

- [`checkout/`](./checkout/) — see [`checkout/README.md`](./checkout/README.md).
  Its `layout.tsx` sets its own title, `noindex` and no canonical.
- [`order/[id]/`](./order/[id]/) — the live order tracker; its `layout.tsx`
  does the same.

Neither has a slug gate: a basket or an open tracker link keeps working when
the API blinks or the owner hides the brand mid-service.

`/<concept>/menu` and `/<concept>/order` are no longer pages. For the three
GS brands (`stackd`, `simmer`, `flipd`) `next.config.js` 308s them to
`/<concept>`; for any other slug they return 404.
