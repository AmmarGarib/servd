# [slug]

Storefront route: **/brand/[slug]** — a brand's microsite. On the brand's own
domain (stackd.pk, simmer.pk, flipd.pk) the middleware serves it at `/`,
`/menu`, `/about`, `/visit` and `/pages/<page>`; those are the canonical URLs.

## Files

- `layout.tsx` — brand shell (header + footer content pages), 404 for an unknown
  brand, and the brand home's metadata + the `%s · <Brand>` title template
- `page.tsx` — the brand home (Restaurant + WebSite JSON-LD)
- `meta.ts` — shared titles, descriptions, canonicals and breadcrumb for the
  brand routes
- `brandArt.tsx` — the artwork behind the share card and icons
- `opengraph-image.tsx` — the brand's 1200×630 share card
- `icon.tsx` / `apple-icon.tsx` — the brand's favicon and home-screen icon

No `loading.tsx`: the pages render in order on the server, so the h1 comes
before the footer in the HTML and a missing brand or page is a real 404.

## Subdirectories

- [`about/`](./about/) — see [`about/README.md`](./about/README.md)
- [`menu/`](./menu/) — see [`menu/README.md`](./menu/README.md)
- [`visit/`](./visit/) — see [`visit/README.md`](./visit/README.md)
- `pages/[page]/` — pages the owner adds to the brand
- `qr/` — printable table QR card (noindex)
