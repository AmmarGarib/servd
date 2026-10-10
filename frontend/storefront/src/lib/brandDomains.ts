// Shared between middleware (edge runtime) and client components — no imports,
// safe in both environments.
//
// Brand hosts come from the Domain table (admin → Configuration → Domains),
// the ONE list of custom domains, via the public GET /api/v1/domains/hosts.
// The hardcoded BRAND_DOMAIN_MAP that used to live here is gone: a domain
// added and made Live in admin never routed, because the middleware read this
// file instead. The API builds its CORS allowlist from the same rows, so a
// brand domain that routes here can also call the API.
//
//   <brand>.pk  → the brand microsite (Domain.purpose = brand_microsite).
//   servd.pk    → the consumer-facing servd site and the ordering system. It is
//                 in SERVD_HOSTS below, never a Domain row.
//
// The list is cached in memory for a minute (stale-while-revalidate), and a
// failed refresh keeps the last good list — an API blip must not unbrand
// every brand domain. Dev and preview hosts (<slug>.localhost,
// <slug>.servd.pk) resolve by pattern with no lookup at all.

export const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'admin', 'api', 'cdn', 'media'])

// Hostnames that mean "this is the servd canonical domain, not a brand".
export const SERVD_HOSTS = new Set(['servd.pk', 'localhost'])

const HOSTS_TTL_MS = 60_000
const HOSTS_TIMEOUT_MS = 2_500

let hostMap: Record<string, string> = {}
let hostsLoadedAt = 0
let hostsInflight: Promise<void> | null = null

function apiBase(): string {
  // Written as direct process.env reads so Next inlines the public one into
  // the client bundle. Server / edge prefer the internal URL.
  const internal = typeof window === 'undefined' ? process.env['INTERNAL_API_URL'] : undefined
  return (internal ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001').replace(/\/+$/, '')
}

/** hostMap lookup that never reads Object.prototype ('constructor', …). */
function ownHost(bare: string): string | null {
  return Object.prototype.hasOwnProperty.call(hostMap, bare) ? hostMap[bare]! : null
}

function bareHost(host: string): string {
  return (host.split(':')[0] ?? host).trim().toLowerCase().replace(/\.$/, '')
}

function patternSlug(bare: string): string | null {
  const m = bare.match(/^([a-z0-9-]+)\.(localhost|servd\.app|servd\.pk)$/)
  if (m?.[1] && !RESERVED_SUBDOMAINS.has(m[1])) return m[1]
  return null
}

async function loadBrandHosts(): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HOSTS_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase()}/api/v1/domains/hosts`, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return
    const body = (await res.json()) as { hosts?: Array<{ hostname: string; slug: string | null }> }
    const next: Record<string, string> = {}
    for (const h of body.hosts ?? []) {
      if (h.slug) next[bareHost(h.hostname)] = h.slug
    }
    hostMap = next
    hostsLoadedAt = Date.now()
  } catch {
    // Keep the last good map.
  } finally {
    clearTimeout(timer)
  }
}

function refreshBrandHosts(): Promise<void> {
  hostsInflight ??= loadBrandHosts().finally(() => { hostsInflight = null })
  return hostsInflight
}

/**
 * Resolve a Host header (or window.location.host) to a brand slug, or null
 * for the servd canonical domain / an unknown host. Waits for the Domain list
 * only on the very first call in this runtime; after that a stale list is
 * served while it refreshes in the background.
 */
export async function resolveBrandHost(host: string): Promise<string | null> {
  const bare = bareHost(host)
  if (SERVD_HOSTS.has(bare)) return null
  if (hostsLoadedAt === 0) await refreshBrandHosts()
  else if (Date.now() - hostsLoadedAt > HOSTS_TTL_MS) void refreshBrandHosts()
  return ownHost(bare) ?? patternSlug(bare)
}

/**
 * Synchronous variant for render paths that cannot await: answers from the
 * cached Domain list (plus the dev / preview patterns) and kicks off a load
 * if there is none yet. Returns null for a custom domain until the list has
 * loaded once, so anything that must be right on the first call — the
 * middleware, the client host hook — uses resolveBrandHost().
 */
export function resolveBrandSlug(host: string): string | null {
  const bare = bareHost(host)
  if (SERVD_HOSTS.has(bare)) return null
  if (hostsLoadedAt === 0 || Date.now() - hostsLoadedAt > HOSTS_TTL_MS) void refreshBrandHosts()
  return ownHost(bare) ?? patternSlug(bare)
}

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
 * a brand domain (/home, /login, /orders, the ordering screens) is an
 * ordinary servd page that keeps the servd header. Shared with the client so
 * the header can answer "is this render a microsite?" on every client-side
 * navigation, not just on the document load.
 */
export const BRAND_REWRITE_PATHS = new Set(['/', '/menu', '/about', '/visit'])

/** True for a path that is the brand microsite on a brand host: the fixed set
 *  above, plus the owner's own brand pages at /pages/<page>. */
export function isBrandRewritePath(pathname: string): boolean {
  return BRAND_REWRITE_PATHS.has(pathname) || /^\/pages\/[a-z0-9][a-z0-9_-]{0,79}$/i.test(pathname)
}

// ─── Canonical origins ────────────────────────────────────────────────────────
//
// Which URL each surface calls home. This is what tells Google that the flipd
// microsite lives at https://flipd.pk and not at some tunnel hostname — the
// whole reason each brand owns a domain in the first place.
//
// Every canonical URL, the sitemap, robots.txt, the JSON-LD and the printed-QR
// generator used to hardcode the tunnel host `servd.pk`, in nine
// separate files. A brand page therefore told search engines it lived on
// servd's domain, which is the opposite of the intent.

/** The consumer-facing servd site: the ordering system. Override per env. */
export const SERVD_ORIGIN: string =
  (process.env['NEXT_PUBLIC_SITE_URL'] ?? 'https://servd.pk').replace(/\/+$/, '')

/**
 * The origin links to servd pages use when they are rendered on a brand
 * domain (stackd.pk → https://servd.pk/login). Empty when NEXT_PUBLIC_SITE_URL
 * is not set (local dev), so links stay on the current host there.
 */
export const SERVD_LINK_ORIGIN: string =
  (process.env['NEXT_PUBLIC_SITE_URL'] ?? '').replace(/\/+$/, '')

/**
 * Each brand's own domain — the canonical home of its microsite, used for
 * <link rel=canonical>, the sitemap and JSON-LD. Still a code constant: the
 * canonical URL is rendered synchronously in metadata, and which of a brand's
 * several Domain rows is canonical is not yet recorded on the table (follow-up:
 * a `canonical` flag on Domain, then derive this from /domains/hosts).
 */
export const BRAND_ORIGIN: Record<string, string> = {
  flipd:  'https://flipd.pk',
  stackd: 'https://stackd.pk',
  simmer: 'https://simmer.pk',
}

/**
 * The brand a request's Host belongs to, or null for servd / an unknown host.
 * Server-side (middleware, sitemap, robots, llms.txt). Port, trailing dot and
 * a www. prefix are ignored. The Domain list decides; if it has never loaded
 * (API down since boot), a brand's canonical domain (BRAND_ORIGIN) still
 * answers for itself, so a brand host never serves servd's files.
 */
export async function hostBrand(host: string): Promise<string | null> {
  const bare = bareHost(host).replace(/^www\./, '')
  if (SERVD_HOSTS.has(bare) || bare === hostnameOf(SERVD_ORIGIN)) return null
  const slug = await resolveBrandHost(bare)
  if (slug) return slug
  return Object.keys(BRAND_ORIGIN).find((s) => hostnameOf(BRAND_ORIGIN[s]!) === bare) ?? null
}

function hostnameOf(origin: string): string {
  try { return new URL(origin).hostname } catch { return '' }
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


// ─── Page metadata ────────────────────────────────────────────────────────────
//
// One helper for every page's title, description, canonical and share card, so
// og:url always equals the canonical and no page drops the share image (a
// segment-level `openGraph` replaces its parent's entirely, image included).

/** servd's default share card (src/app/opengraph-image.tsx). */
export const SERVD_OG_IMAGE = `${SERVD_ORIGIN}/opengraph-image`
export const SERVD_OG_IMAGE_ALT = 'servd. — every kitchen, one place'

export interface PageMetaInput {
  /** The page's own title. A string goes through the nearest title template
   *  ('%s · servd' / '%s · <Brand>'); { absolute } skips it. */
  title?: string | { absolute: string }
  description?: string
  /** Absolute canonical URL (brandCanonical(...) or `${SERVD_ORIGIN}/...`). */
  canonical: string
  /** og:site_name — 'servd' unless a brand site. */
  siteName?: string
  /** Absolute share-image URL; defaults to servd's card. */
  image?: string
  /** Alt text for the share image (defaults to servd's card alt). */
  imageAlt?: string
  /** Keep the page out of the index (it stays crawlable so the tag is seen). */
  noindex?: boolean
}

/** Next.js Metadata for a page: title, description, canonical, Open Graph and
 *  Twitter card. Typed loosely (no `next` import) — this module also runs in
 *  the edge middleware. */
export function pageMetadata(m: PageMetaInput) {
  const shareTitle = typeof m.title === 'string' ? m.title : m.title?.absolute
  const alt = m.imageAlt ?? (m.image ? undefined : SERVD_OG_IMAGE_ALT)
  const images = [{ url: m.image ?? SERVD_OG_IMAGE, width: 1200, height: 630, type: 'image/png', ...(alt && { alt }) }]
  return {
    ...(m.title !== undefined && { title: m.title }),
    ...(m.description && { description: m.description }),
    alternates: { canonical: m.canonical },
    openGraph: {
      type: 'website' as const,
      siteName: m.siteName ?? 'servd',
      locale: 'en_PK',
      url: m.canonical,
      ...(shareTitle && { title: shareTitle }),
      ...(m.description && { description: m.description }),
      images,
    },
    twitter: {
      card: 'summary_large_image' as const,
      ...(shareTitle && { title: shareTitle }),
      ...(m.description && { description: m.description }),
      images: images.map((i) => i.url),
    },
    ...(m.noindex && { robots: { index: false, follow: true } }),
  }
}

/** A description trimmed to ~155 chars on a word boundary. */
export function metaDescription(text: string | null | undefined, max = 155): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 80 ? cut.lastIndexOf(' ') : cut.length).replace(/[,.;:—-]+$/, '')}…`
}
