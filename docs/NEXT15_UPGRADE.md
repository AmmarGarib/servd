# Next 15 upgrade — admin + storefront (owner F12 (a), 2026-10-26)

Owner: "Upgrade both sites to Next 15, with the same screenshot check on every page."
Why: Next 14.2.35 carries advisories fixed only in 15.5.28+ (image optimizer RCE / DoS,
server-action DoS, rewrite SSRF) — see CLAUDE.md "Dependencies (2026-10-23)".

## Versions

| Package | Before | After |
|---|---|---|
| next | 14.2.35 | **15.5.28** (exact) |
| react / react-dom | ^18.3.1 | **19.2.8** (exact) |
| @types/react / @types/react-dom | ^18.3 | 19.2.18 / 19.2.7 |
| eslint-config-next | — | 15.5.28 (lint stays off in builds) |
| @tanstack/react-query (+ devtools, admin) | ^5.36.0 | ^5.100.6 (React 19 peer; lock 5.100.6) |
| lucide-react | ^0.379.0 | ^0.469.0 (first range with a React 19 peer) |
| qrcode.react (storefront) | ^3.1.0 | ^4.2.0 (React 19 peer; same `QRCodeSVG` export) |
| react-beautiful-dnd (admin) | ^13.1.1 | **removed** — not imported anywhere, and it has no React 19 support |

zustand 4.5, next-intl 4, sonner 2, @sentry/nextjs 10 already accept React 19 / Next 15.
Both `package-lock.json` files are regenerated.

`images: { unoptimized: true }` is kept in both apps and there are still no `remotePatterns`.

## What changed in code

- **Async request APIs (storefront).** `params` / `searchParams` are Promises in Next 15. The
  storefront pages already read them as `await Promise.resolve(params as Promise<…>)` with a
  `Promise<X> | X` type; the types are now `Promise<X>` only and the reads are `await params`
  (16 pages / layouts + `brand/[slug]/meta.ts`). `/preview/[token]` awaits `searchParams`.
  `headers()` / `cookies()` are awaited: root layout, `not-found.tsx` (its helper is now async),
  `robots.ts`, `sitemap.ts`, `editor-frame/actions.ts`, `sections/ManagedPage.tsx`, and
  `components/blocks/SiteLayoutView.tsx` — `resolveVariant` (reads the A/B cookie) is async now,
  so `pageBlocks()` in `brand/[slug]/meta.ts` is async and its callers await it.
- **Admin:** `/marketing/brands` (the only server page reading `searchParams`) awaits it. Every
  other admin page is a client page using `useParams` / `useSearchParams` — unchanged.
- **React 19 types:** `JSX` is no longer global — `PageRenderer.tsx` imports it from `react`.
  Nothing else needed (no `useFormState`, `findDOMNode`, `defaultProps`, string refs,
  `ReactDOM.render`, `useRef()` without an argument).
- **next.config.js (both):** `outputFileTracingRoot: __dirname` — each app is its own package,
  and Next 15 otherwise guesses the repo root from the root lockfile (warning at build). No
  renamed options were in use (`experimental.serverActions` is still the right place in 15.5).
- **Caching:** unchanged behaviour. Every storefront page/layout was already
  `force-dynamic` (the root layout reads `headers()`), the explicit
  `fetch(..., { next: { revalidate } })` calls keep their revalidate in 15, and the GET route
  handlers (`/api/storefront-sections`, `/api/storefront-brand-kit`, `llms*.txt`) read the
  request or were already `force-dynamic`. The build route tables (static ○ / dynamic ƒ) are
  identical before and after: storefront 50 routes, admin 216 routes.
- `next-env.d.ts` (generated) now references `.next/types/routes.d.ts`, as Next 15.5 writes it.

## Checks run

- `npx tsc --noEmit` clean in both apps; `node scripts/check-tokens.mjs` passes (admin).
- `next build` succeeds in both (storefront with `NEXT_PUBLIC_API_URL=https://api.servd.pk`,
  `NEXT_PUBLIC_SITE_URL=https://servd.pk`).
- **Middleware / headers (storefront):** 32 host + path cases curled against `next start` of the
  old and the new build — servd.pk, www.servd.pk, stackd.pk / simmer.pk / flipd.pk (and www),
  `*.localhost`, an unknown host; `/`, `/home` (308 → `/`), `/browse`, `/stax`, `/<brand>/menu`,
  brand-host rewrites (`/menu`, `/about`, `/visit`), `/brand/<own>/…` → brand-domain 308s,
  `/editor-frame` (CSP `frame-ancestors`, no X-Frame-Options, noindex), `/editor-frame/x`,
  404s, robots / sitemap. Status, Location, CSP, X-Frame-Options, X-Robots-Tag, cache and
  security headers and page titles are **identical**.
- **Editor frame:** a host page on an allowed admin origin framed `/editor-frame`, posted an
  `init` draft and got `ready` → `rendered ok` with the block rendered through the server action,
  on both builds.
- **Screenshots:** Playwright, every route at 390 and 1440 px, old build vs new build,
  reduced motion, fixed browser clock, pixel diff per route (threshold 24/255 per channel).
  - Storefront (live API): 49 routes × 2 widths = 98 shots. 75 identical, 21 "tiny" (< 0.2 % of
    pixels, anti-aliasing on input placeholders / the loading skeleton), 2 differed and were
    re-shot twice: `/simmer` @390 (the old build had rendered the API-down fallback hero once —
    identical on re-runs) and `/` (the kitchen-card deck photos are lazy remote images that
    sometimes are not in yet at capture — missing on the OLD build as often as on the new).
    No route changed status.
  - Admin (mocked API: a signed-in CEO, empty lists elsewhere): 215 routes × 2 = 430 shots.
    265 identical, 19 tiny. The 146 that differed were re-shot with the page text captured: 140
    are pages that show the "Client error" box on BOTH builds (the mock's empty data doesn't fit
    the page) and differ only in the printed stack trace (chunk names / line numbers); `/` and
    `/w` the same plus one extra stack line; 3 identical text with a pixel difference that does
    not repeat between runs; `/configuration/notifications` @390 crashed on the OLD build in
    one run (timing) and rendered on the new one. No regression found.
  - Console errors / page errors: **no new error on any route** after the upgrade. The old
    build logged React hydration errors #418/#423/#425 on storefront `/about`; the new build
    logs none.

## Remaining differences (accepted)

- Admin pages that crash under the empty mock crash identically before and after; they are a
  property of the mock, not of the upgrade.
- Sentry build warnings (no instrumentation file / no `global-error`) are the same as before.
- Response `Vary` now also lists `next-router-segment-prefetch`, and Next 15 sends extra
  `Link: rel=preload` headers for CSS — Next 15 internals, harmless.

## Rollback

Before deploying, tag the live images as rollback (`ammargarib/servd:admin-pre-next15`,
`ammargarib/servd:storefront-pre-next15`). Rolling back = re-tag those as `:admin` /
`:storefront` and trigger the deploy webhook (or revert this commit and rebuild). Nothing in the
API or the database depends on this change, so the API image is untouched.
