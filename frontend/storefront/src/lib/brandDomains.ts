// Shared between middleware (edge runtime) and client components. Pure data,
// no imports — safe in both environments. Single source of truth: edit here,
// the middleware host-resolver and the client `lib/host.ts` both pick it up.

// Only the three live consumer brands. Phantom brand domains
// (eatstrata, bukharirice, craveman.pk, garnish.pk) were removed in
// May 2026 — those brands are not real operations.
//   <brand>.pk  → the brand microsite. This is the live setup: each brand owns
//                 its own domain so it reads as a real independent restaurant
//                 and builds its own SEO authority.
//   servd.pk    → the consumer-facing servd site and the ordering system. It is
//                 in SERVD_HOSTS below, NOT here.
//
// A domain missing from this map does not fail loudly — resolveBrandSlug just
// returns null, the middleware never rewrites `/` onto /brand/<slug>, and the
// site quietly serves servd chrome on the brand's domain. That is exactly what
// flipd.pk did until it was noticed. Add the entry the moment DNS is pointed.
export const BRAND_DOMAIN_MAP: Record<string, string> = {
  'flipd.pk':        'flipd',
  'www.flipd.pk':    'flipd',
  'stackd.pk':       'stackd',
  'www.stackd.pk':   'stackd',
  'simmer.pk':       'simmer',
  'www.simmer.pk':   'simmer',
  // The eat*.com set predates the .pk domains. Kept because they are
  // registered and anything already shared on them keeps resolving.
  'eatstax.com':     'stackd',
  'eatsimmer.com':   'simmer',
  'eatflipd.com':    'flipd',
}

export const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'admin', 'api', 'cdn', 'media'])

// Hostnames that mean "this is the servd canonical domain, not a brand".
export const SERVD_HOSTS = new Set(['servd.app', 'servd.pk', 'localhost'])

/**
 * Request header the middleware stamps with the brand slug when it rewrites a
 * brand host onto /brand/<slug>.
 *
 * The rewrite is invisible to the client — the browser's path stays "/" — so
 * anything that needs to know "this render is a brand microsite" has to read
 * it on the server. usePathname() cannot tell you, and guessing from
 * window.location on the client renders the wrong thing first and then
 * corrects it, which is a visible flash of the wrong header.
 */
export const BRAND_HOST_HEADER = 'x-servd-brand-host'

/**
 * The paths that, on a brand host, ARE the brand microsite.
 *
 * The middleware rewrites exactly these onto /brand/<slug>; everything else on
 * a brand domain (/browse, /login, /orders, the ordering screens) is an
 * ordinary servd page that keeps the servd header. Shared with the client so
 * the header can answer "is this render a microsite?" on every client-side
 * navigation, not just on the document load.
 */
export const BRAND_REWRITE_PATHS = new Set(['/', '/menu', '/about', '/visit'])

// Resolve a Host header (or window.location.hostname) to a brand slug, or
// null if it's the servd canonical domain.
export function resolveBrandSlug(host: string): string | null {
  const bare = (host.split(':')[0] ?? host).toLowerCase()
  if (SERVD_HOSTS.has(bare)) return null

  const explicit = BRAND_DOMAIN_MAP[bare]
  if (explicit) return explicit

  const m = bare.match(/^([a-z0-9-]+)\.(localhost|servd\.app|servd\.pk)$/)
  if (m?.[1] && !RESERVED_SUBDOMAINS.has(m[1])) return m[1]

  return null
}

// ─── Canonical origins ────────────────────────────────────────────────────────
//
// Which URL each surface calls home. This is what tells Google that the flipd
// microsite lives at https://flipd.pk and not at some tunnel hostname — the
// whole reason each brand owns a domain in the first place.
//
// Every canonical URL, the sitemap, robots.txt, the JSON-LD and the printed-QR
// generator used to hardcode the tunnel host `servd-app.garibsons.app`, in nine
// separate files. A brand page therefore told search engines it lived on
// servd's domain, which is the opposite of the intent.

/** The consumer-facing servd site: the ordering system. Override per env. */
export const SERVD_ORIGIN: string =
  (process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://servd.pk').replace(/\/+$/, '')

/** Each brand's own domain — the canonical home of its microsite. */
export const BRAND_ORIGIN: Record<string, string> = {
  flipd:  'https://flipd.pk',
  stackd: 'https://stackd.pk',
  simmer: 'https://simmer.pk',
}

/**
 * Canonical origin for a brand's microsite, falling back to servd for a brand
 * with no domain of its own (where the microsite really does live under
 * servd.pk/brand/<slug>).
 */
export function brandOrigin(slug: string): string {
  return BRAND_ORIGIN[slug] ?? SERVD_ORIGIN
}

/**
 * Canonical URL for a brand microsite path. On its own domain the brand IS the
 * root, so `/brand/<slug>/menu` on servd is `/menu` on the brand domain — the
 * same rewrite the middleware does for incoming requests, in reverse.
 */
export function brandCanonical(slug: string, subpath = ''): string {
  const origin = brandOrigin(slug)
  const tail = subpath.replace(/^\/+/, '')
  if (origin === SERVD_ORIGIN) return `${origin}/brand/${slug}${tail ? `/${tail}` : ''}`
  return tail ? `${origin}/${tail}` : `${origin}/`
}
