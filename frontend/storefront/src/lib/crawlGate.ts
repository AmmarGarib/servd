// Edge-safe helpers for the middleware's crawl hygiene (no imports: the
// middleware runs on the edge runtime, as lib/brandDomains.ts does).
//
// Two jobs, both answered from the public brand list (GET /storefront/concepts):
//
//  1. Is this one-segment path (/<x>, /reserve/<x>) NOT a brand? Next 14.2
//     answers a notFound() thrown from a page, layout or generateMetadata with
//     a 404 whose HTML is the bare `<html id="__next_error__">` shell (the
//     page is drawn by the browser afterwards) — only a URL that matches NO
//     route is drawn on the server, with the root layout and app/not-found.tsx.
//     So the middleware rewrites a path that is certainly not a brand onto an
//     unmatched path and gets the real server-rendered 404 (status 404, title,
//     designed page, noindex). The layouts keep their own notFound() as the
//     safety net for anything this gate lets through.
//
//  2. Which slugs are brands (so a brand domain can send /<other-brand> to
//     servd.pk with a permanent redirect).
//
// FAIL OPEN: when the API does not answer, or answers with an empty list, the
// gate says "don't know" and the request goes through untouched — an outage
// must never turn a real brand into a 404 (same rule as lookupConcept()).
// A TEST company's brand is hidden from the list on purpose but reachable by
// direct link, so a slug that is not listed is asked of the direct-by-slug API
// before it counts as unknown.

const TTL_MS = 60_000
const TIMEOUT_MS = 2_500
const MAX_NEGATIVES = 500

let slugs: Set<string> | null = null
let loadedAt = 0
let inflight: Promise<void> | null = null
// slug → expiry of "the direct-by-slug API says this is not a (test) brand".
const notABrand = new Map<string, number>()

function apiBase(): string {
  const internal = typeof window === 'undefined' ? process.env['INTERNAL_API_URL'] : undefined
  return (internal ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001').replace(/\/+$/, '')
}

/** `status` is the HTTP status the API answered, or 0 when it did not answer
 *  (timeout, network error, unreadable body). */
async function getJson(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase()}${path}`, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return { ok: false, status: res.status, body: null }
    return { ok: true, status: res.status, body: await res.json() }
  } catch {
    return { ok: false, status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

async function loadSlugs(): Promise<void> {
  const { ok, body } = await getJson('/api/v1/storefront/concepts')
  if (!ok || !Array.isArray(body)) return // keep the last good list
  const next = new Set<string>()
  for (const c of body as Array<{ slug?: unknown }>) if (typeof c?.slug === 'string') next.add(c.slug)
  slugs = next
  loadedAt = Date.now()
}

function refresh(): Promise<void> {
  inflight ??= loadSlugs().finally(() => { inflight = null })
  return inflight
}

/** The live brand slugs, or null when the API has not answered (or listed none). */
export async function liveBrandSlugs(): Promise<Set<string> | null> {
  if (loadedAt === 0) await refresh()
  else if (Date.now() - loadedAt > TTL_MS) void refresh()
  return slugs && slugs.size > 0 ? slugs : null
}

/**
 * True ONLY when the API answered and `slug` is not a brand: not in the live
 * list AND the direct-by-slug lookup answered HTTP 404. Anything uncertain is
 * false — a timeout, a network error, a 5xx or a 429 (the API's per-IP limit)
 * means "don't know", and is never cached. A 200 means the brand exists (a test
 * company's brand, or one made visible since the list was read).
 */
export async function isCertainlyNotABrand(slug: string): Promise<boolean> {
  const live = await liveBrandSlugs()
  if (!live || live.has(slug)) return false
  const until = notABrand.get(slug)
  if (until && until > Date.now()) return true
  const { status } = await getJson(`/api/v1/storefront/${encodeURIComponent(slug)}/menu`)
  if (status !== 404) return false
  if (notABrand.size >= MAX_NEGATIVES) notABrand.clear()
  notABrand.set(slug, Date.now() + TTL_MS)
  return true
}
