const { withSentryConfig } = require('@sentry/nextjs')

// The servd origin this build is for — the same NEXT_PUBLIC_SITE_URL
// lib/brandDomains.ts reads (a build arg in the Dockerfile).
const SERVD_URL = new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://servd.pk')

/** A string as a literal inside a `has` regex. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A request on www.<domain>: `apex` is the domain without the www. Never
// www.*.localhost — `has` matches the host without its port, so a dev
// redirect would lose it; the middleware sends those to the apex instead.
const WWW_HOST = { type: 'host', value: 'www\\.(?<apex>(?!.*localhost).+)' }

// The café brand was "stax" before the rebrand to "stackd". Printed QR
// codes, table tents, old posts and anything already shared point at the old
// paths, and those keep working — permanently, because the printed ones can't
// be reissued. Ordering, the microsite, the menu and reservations are all
// covered. (The old eatstax.com domain was retired 2026-10-07; Stackd lives
// at stackd.pk.)
//
// Every legacy URL goes to its FINAL page in one hop: a redirect whose
// destination is itself redirected is a chain, and Google stops following
// chains (and drops link equity along the way). So /stax/menu goes straight
// to /stackd, not via /stackd/menu, and /brands/stax straight to
// /brand/stackd. Order matters — the first match wins.
const LEGACY_REDIRECTS = [
  { source: '/stax/menu',         destination: '/stackd',              permanent: true },
  { source: '/stax/order',        destination: '/stackd',              permanent: true },
  { source: '/stax',              destination: '/stackd',              permanent: true },
  { source: '/stax/:path*',       destination: '/stackd/:path*',       permanent: true },
  { source: '/brand/stax',        destination: '/brand/stackd',        permanent: true },
  { source: '/brand/stax/:path*', destination: '/brand/stackd/:path*', permanent: true },
  { source: '/reserve/stax',      destination: '/reserve/stackd',      permanent: true },
  // The old /brands/<slug> microsite paths (app/brands/ is gone).
  { source: '/brands/stax',                        destination: '/brand/stackd', permanent: true },
  { source: '/brands/:slug(stackd|simmer|flipd)',  destination: '/brand/:slug',  permanent: true },
  // The menu IS the ordering screen: /<brand>/menu and the /<brand>/order
  // index were only ever hops to /<brand>. These three here (so www is one
  // hop too); the middleware does the same for every other brand.
  { source: '/:concept(stackd|simmer|flipd)/menu',  destination: '/:concept', permanent: true },
  { source: '/:concept(stackd|simmer|flipd)/order', destination: '/:concept', permanent: true },
  // The brand picker merged into /home, the one landing page (owner,
  // 2026-10-07) — permanent, so /home is the URL that gets indexed.
  { source: '/browse',            destination: '/home',                permanent: true },
  { source: '/order',             destination: '/home',                permanent: true },
  // The icon paths browsers and crawlers probe without reading the page's
  // <link> tags; the real one is app/apple-icon.png.
  { source: '/apple-touch-icon.png',             destination: '/apple-icon.png', permanent: true },
  { source: '/apple-touch-icon-precomposed.png', destination: '/apple-icon.png', permanent: true },
]

// The baseline security headers (see headers() below).
const BASE_HEADERS = [
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // HTTPS only, for a year. No includeSubDomains until every servd.pk
  // subdomain (admin, api, media, …) is confirmed https-only; the
  // Cloudflare zone setting is the primary control, this is the backstop.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.BUILD_STANDALONE === 'true' && { output: 'standalone' }),
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // The editor frame (/editor-frame) renders through a same-origin Server
  // Action. Behind the Cloudflare tunnel the Host the app sees can differ from
  // the browser's Origin, so the servd host is allowed explicitly. Never list
  // the admin origins here — the action is only ever called by the frame
  // itself. The body is the operator's working copy (capped at 600 kB of
  // UTF-8 by the frame and the action; the stored page is ≤ 200 kB).
  experimental: {
    serverActions: { allowedOrigins: [SERVD_URL.host], bodySizeLimit: '2mb' },
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
      { protocol: 'https', hostname: 'media.servd.pk' },
    ],
  },
  // These run before the middleware, the filesystem and the page, so they are
  // real 308s and also cover public files. (A redirect() called inside a page
  // body can arrive as a 200 + meta refresh instead, once streaming started.)
  //
  // www.<domain> → <domain> comes first, in one hop to the final page: a
  // legacy path on www goes straight to its apex destination
  // (www.servd.pk/browse → https://servd.pk/home), and www.servd.pk/ straight
  // to /home. Only the /brand/… pages on www are left to the middleware,
  // because where they settle depends on which brand owns the domain
  // (www.stackd.pk/brand/stackd/menu → https://stackd.pk/menu). The Cloudflare
  // zone rule (www → apex) is still worth having — it saves the trip into the
  // app — but this no longer depends on it. Every servd and brand domain is
  // https-only, so the www hop goes straight to https.
  async redirects() {
    return [
      {
        source: '/',
        has: [{ type: 'host', value: `www\\.${escapeRe(SERVD_URL.hostname)}` }],
        destination: `${SERVD_URL.origin}/home`,
        permanent: true,
      },
      ...LEGACY_REDIRECTS.map((r) => ({ ...r, has: [WWW_HOST], destination: `https://:apex${r.destination}` })),
      {
        source: '/:path((?!brand/[^.]*$).*)',
        has: [WWW_HOST],
        destination: 'https://:apex/:path',
        permanent: true,
      },
      ...LEGACY_REDIRECTS,
    ]
  },

  // Baseline security headers for the consumer site, plus crawl and cache
  // hints that have to be headers rather than <meta> tags.
  //
  // X-Frame-Options SAMEORIGIN goes on every path EXCEPT the editor frame
  // (/editor-frame), which only the admin may frame: the middleware sends its
  // CSP frame-ancestors from ADMIN_ORIGINS (src/editor/README.md). Anything
  // under /editor-frame/… is a 404 and keeps SAMEORIGIN.
  async headers() {
    return [
      { source: '/', headers: BASE_HEADERS },
      { source: '/:path((?!editor-frame(?:/|$)).*)', headers: BASE_HEADERS },
      { source: '/editor-frame/:rest+', headers: BASE_HEADERS },
      {
        source: '/editor-frame',
        headers: [
          ...BASE_HEADERS.filter((h) => h.key !== 'X-Frame-Options'),
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      // Pages that must never be indexed but must stay crawlable so the
      // noindex is seen. They are client pages that cannot export metadata,
      // so the header does it. (Token URLs — order trackers, reservation
      // claim/confirm links, group orders — are kept off the crawl path
      // entirely in app/robots.ts.)
      {
        source: '/:concept/checkout',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/brand/:slug/qr',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/preview/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      // Images and fonts from public/: a day fresh, a week
      // stale-while-revalidate, so repeat visits and Cloudflare stop
      // revalidating every image (Next sends max-age=0 for public files).
      // Matched on the extension only, never on a folder. Excluded: /_next/
      // (its hashed files already get `max-age=31536000, immutable`, which a
      // header set here would replace) and the app/ icon routes, which send
      // their own Cache-Control — a route handler's header is appended to
      // this one, not swapped for it, and two would conflict.
      {
        source: '/:file((?!_next/|icon\\.png$|apple-icon\\.png$|favicon\\.ico$).*\\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?))',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
      {
        source: '/manifest.webmanifest',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' }],
      },
    ]
  },
}

// Sentry wraps the build only when it is configured (a DSN at build time).
// Unwrapped, none of the SDK reaches the browser bundle; with no DSN it would
// ship disabled code to every visitor for nothing.
const sentryEnabled = !!(process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN)

module.exports = sentryEnabled
  ? withSentryConfig(nextConfig, {
      silent: true,
      org: 'servd',
      project: 'storefront',
      widenClientFileUpload: true,
      hideSourceMaps: true,
      disableLogger: true,
      automaticVercelMonitors: false,
    })
  : nextConfig
