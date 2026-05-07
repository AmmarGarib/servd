// Shared between middleware (edge runtime) and client components. Pure data,
// no imports — safe in both environments. Single source of truth: edit here,
// the middleware host-resolver and the client `lib/host.ts` both pick it up.

export const BRAND_DOMAIN_MAP: Record<string, string> = {
  'eatstax.com':     'stax',
  'eatstrata.com':   'strata',
  'eatflipd.com':    'flipd',
  'bukharirice.com': 'bukhari',
  'eatsimmer.com':   'simmer',
  'craveman.pk':     'craveman',
  'garnish.pk':      'garnish-station',
}

export const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'admin', 'api', 'cdn', 'media'])

// Hostnames that mean "this is the servd canonical domain, not a brand".
export const SERVD_HOSTS = new Set(['servd.app', 'servd.pk', 'localhost'])

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
