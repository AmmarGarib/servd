import { isDomainOriginAllowed, describeDomainOrigins } from '../modules/domains/hostCache.js'
// Origin allowlist for the API.
//
// Background:
//   The storefront is a single Next.js app served at multiple hostnames:
//   - The canonical servd domain (servd.pk / servd.app) → STOREFRONT_URL
//   - Each brand's custom domain (eatstax.com, bukharirice.com, etc.) — set up
//     so the brand can build its own SEO authority and read as an independent
//     restaurant. Middleware in storefront/src/middleware.ts rewrites a few
//     paths into /brand/<slug> on those hosts; everything else passes through.
//
//   Customers placing orders OR booking reservations from a brand custom
//   domain hit the SAME servd backend. Without listing those hosts, the
//   browser blocks the cross-origin POST and the user sees a vague network
//   error.
//
// Configure brand hosts via env so adding a new brand domain is one env-var
// edit, no redeploy of the allowlist code needed:
//
//   BRAND_HOSTS=eatstax.com,eatflipd.com,bukharirice.com,...
//
// We also accept any *.localhost (dev) and any *.servd.{app,pk} (per-brand
// subdomain pattern) without listing each one — wildcard regexes catch them.
//
// Server-to-server requests (no Origin header — curl, server-rendered fetch,
// webhooks) are allowed through. Browsers always send Origin, so this only
// gates browser traffic.

const STATIC_FROM_ENV = [
  process.env['WEB_URL'] ?? 'http://localhost:3000',
  process.env['STOREFRONT_URL'] ?? 'http://localhost:3002',
]

// The canonical servd hosts, hardcoded rather than read from env.
//
// These used to reach the allowlist ONLY through WEB_URL / STOREFRONT_URL. That
// makes a two-character env typo — a trailing slash, http instead of https — a
// total outage: every browser call from the admin app is blocked by CORS and
// the operator sees "network error" on a healthy API. These hostnames are ours
// and are not going to change, so list them. The env vars still work and still
// take effect; this is a floor, not a replacement.
const CANONICAL_HOSTS = [
  'servd-admin.garibsons.app',
  'servd-app.garibsons.app',
  // The live public domains (owner, 2026-10-07): servd.pk is the servd site
  // and ordering system; each brand has its own .pk. www. is added below.
  'servd.pk',
  'simmer.pk',
  'stackd.pk',
  'flipd.pk',
]

const BRAND_HOSTS = (process.env['BRAND_HOSTS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Brand hosts come from the Domain table (modules/domains/hostCache.ts);
// BRAND_HOSTS is only for local dev.
const RESOLVED_BRAND_HOSTS = BRAND_HOSTS

// An Origin header is scheme + host + optional port, never a path and never a
// trailing slash. WEB_URL, though, is written by hand into a .env file and is
// routinely set to "https://servd-admin.garibsons.app/" — which would never
// match an incoming Origin. Normalise both sides so it does.
function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

const STATIC_ALLOWED = new Set<string>(
  [
    ...STATIC_FROM_ENV,
    ...CANONICAL_HOSTS.flatMap((h) => [`https://${h}`, `https://www.${h}`]),
    ...RESOLVED_BRAND_HOSTS.flatMap((h) => [`https://${h}`, `https://www.${h}`]),
  ].map(normaliseOrigin),
)

// Catch-alls for dev and brand subdomains.
//   *.localhost           → dev: stax.localhost:3002, simmer.localhost:3002
//   *.servd.app           → prod subdomain pattern: stax.servd.app
//   *.servd.pk            → same on the .pk apex
const WILDCARD_PATTERNS: RegExp[] = [
  /^https?:\/\/[a-z0-9-]+\.localhost(:\d+)?$/i,
  /^https:\/\/[a-z0-9-]+\.servd\.(app|pk)$/i,
]

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true                // server-to-server / curl / webhooks
  const o = normaliseOrigin(origin)
  if (STATIC_ALLOWED.has(o)) return true
  if (WILDCARD_PATTERNS.some((p) => p.test(o))) return true
  if (isDomainOriginAllowed(o)) return true  // brand domains from the Domain table
  return false
}

// For diagnostics / boot logging.
export function describeAllowlist(): string {
  return `cors: ${STATIC_ALLOWED.size} static + ${WILDCARD_PATTERNS.length} wildcard patterns + ${describeDomainOrigins()}`
}
