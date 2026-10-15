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
  - `(menu)/page.tsx` — server component: resolves the brand with the same
    `lookupConcept` (memoised within the request, so no extra API call) and
    renders `OrderingScreen` with the hero's fields (`initialConcept`; `null`
    when the API didn't answer and the slug isn't a bundled brand). That puts
    the hero — the brand name as the page's one h1, its description and art —
    in the server HTML. It also reads the menu on the server
    (`(menu)/orderingData.ts`, no-store) and passes it as `initialMenu`, so the
    dishes, prices and sections are in the first HTML, and emits JSON-LD:
    Restaurant (same `@id` as the brand's own domain), Menu (when a menu is
    published) and a BreadcrumbList servd › Order <Brand>. None for a test
    company's brand.
  - `(menu)/OrderingScreen.tsx` — the ordering UI (client component): the
    category nav, menu, item modal and cart drawer. With `initialMenu` it
    renders the menu at once and refreshes it after mount (availability); a
    failed refresh keeps the server menu. The basket and the table flag are
    browser-only, so they wait for mount (no hydration mismatch). Fires
    `track('view_item')` when a dish is opened and `track('add_to_cart')` on
    an add (`lib/analytics.ts`). With `initialMenu` `null` (the server's read
    failed) it fetches the menu itself: the real hero shows above a shimmer skeleton (category
    strip + item rows, `role="status"`); the hero stays mounted when the menu
    arrives, so it doesn't jump. With `initialConcept` `null` the hero is
    named from the slug until the client's own `/storefront/concepts` lookup.
    The "isn't live yet" error state keeps the brand name as its h1.

## Subdirectories

- [`checkout/`](./checkout/) — see [`checkout/README.md`](./checkout/README.md).
  Its `layout.tsx` sets its own title, `noindex` and no canonical.
- [`order/[id]/`](./order/[id]/) — the live order tracker; its `layout.tsx`
  does the same.

Neither has a slug gate: a basket or an open tracker link keeps working when
the API blinks or the owner hides the brand mid-service.

`/<concept>/menu` and `/<concept>/order` are no longer pages: they 308 to
`/<concept>` for every brand (the middleware; `next.config.js` does the three
GS brands and the legacy `/stax` paths in the same single hop, www included).
An unknown slug lands on `/<slug>`, which 404s.
