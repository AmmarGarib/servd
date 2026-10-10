// The one server-side lookup of the live brands and of a brand by slug:
// GET /storefront/concepts, else the bundled records in lib/fallbackBrands.ts
// when the API can't be reached (warmup, network blip) — so a known brand's
// pages keep rendering instead of 404ing.
//
// Use it from server components, layouts and generateMetadata instead of a
// per-route getConcepts()/findConcept() copy. Next memoises identical GET
// fetches within one request, so a layout, its generateMetadata and the page
// asking for the list cost one API call.

import type { Concept } from './concept'
import { FALLBACK_CONCEPTS } from './fallbackBrands'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/**
 * GET /storefront/concepts as the API answered it: the list of brands that
 * are active and shown on the storefront, or null when it did NOT answer —
 * down, a timeout, a 5xx, a 429 from the API's shared per-IP limit (every
 * server-side fetch from this container shares one bucket), or a body that
 * isn't a list. "Not in the list" means something only when this is non-null.
 */
export async function fetchConceptList(): Promise<Concept[] | null> {
  try {
    // no-store: a cached failure would stick until restart (CLAUDE.md).
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return Array.isArray(body) ? (body as Concept[]) : null
  } catch {
    return null
  }
}

/** Every live brand (GET /storefront/concepts). [] when the API is down. */
export async function fetchLiveConcepts(): Promise<Concept[]> {
  return (await fetchConceptList()) ?? []
}

/** The live brands, or the bundled fallback records when the list is empty. */
export function conceptsOrFallback(live: Concept[]): Concept[] {
  return live.length ? live : Object.values(FALLBACK_CONCEPTS)
}

/** The bundled record for a known brand slug. (Own-property check: a path
 *  like /constructor must not resolve to Object.prototype.constructor.) */
function fallbackConcept(slug: string): Concept | null {
  return Object.prototype.hasOwnProperty.call(FALLBACK_CONCEPTS, slug) ? FALLBACK_CONCEPTS[slug] ?? null : null
}

/**
 * A brand by its exact slug: the live row, else the bundled fallback for a
 * known brand. null for anything else — the caller 404s.
 *
 * Lenient: a bundled brand resolves even when the API answered without it
 * (hidden or deactivated in admin). The brand microsites rely on that. A
 * route that must 404 a hidden brand, and must NOT 404 just because the API
 * didn't answer, uses lookupConcept() instead.
 */
export function findConcept(slug: string, live: Concept[]): Concept | null {
  return live.find((c) => c.slug === slug) ?? fallbackConcept(slug)
}

/**
 * True when the brand belongs to the company that runs servd (GS Foods): a
 * bundled brand, or a live brand of the same company (tenantId) as one. The
 * storefront lists every company's brands, so anything that CLAIMS a relation
 * to servd — the JSON-LD parentOrganization / publisher — asks this first
 * (CLAUDE.md: claims that brands are related must filter on tenantId).
 */
export function isServdCompanyBrand(slug: string, live: Concept[]): boolean {
  if (fallbackConcept(slug)) return true
  const tenantId = live.find((c) => c.slug === slug)?.tenantId
  if (!tenantId) return false
  return live.some((c) => c.tenantId === tenantId && fallbackConcept(c.slug) !== null)
}

/**
 * Thrown when a route can't tell whether a slug is a brand: the API didn't
 * answer (an empty list counts, as in conceptsOrFallback) and the slug isn't
 * a bundled brand. It renders app/error.tsx with a 500, which search engines
 * retry, instead of a 404, which they act on — another company's brand pages
 * must not drop out of Google because the API blinked.
 */
export class BrandListUnavailableError extends Error {
  constructor(slug: string) {
    super(`The brand list is unavailable; cannot resolve "${slug}"`)
    this.name = 'BrandListUnavailableError'
  }
}

/** findConcept for a list from fetchLiveConcepts(): null only when the API
 *  answered without the slug (the caller 404s); throws
 *  BrandListUnavailableError when it can't tell. */
export function findConceptOrThrow(slug: string, live: Concept[]): Concept | null {
  const found = findConcept(slug, live)
  if (!found && live.length === 0) throw new BrandListUnavailableError(slug)
  return found
}

/** fetchLiveConcepts + findConceptOrThrow in one call (layouts,
 *  generateMetadata): null = not a brand (404); throws when the API is down
 *  and the slug isn't bundled. */
export async function resolveConcept(slug: string): Promise<Concept | null> {
  return findConceptOrThrow(slug, await fetchLiveConcepts())
}

/**
 * Where a slug stands, telling "the API said no" apart from "the API didn't
 * answer":
 *   live       — the API answered and lists it.
 *   missing    — the API answered and does not list it (not a brand, or one
 *                the owner hid / deactivated): the caller 404s.
 *   fallback   — the API didn't answer; a known brand's bundled record.
 *   unverified — the API didn't answer and the slug isn't a bundled brand.
 *                It may well be a real brand (another company's, or a new
 *                one), so the caller renders and lets the client page cope,
 *                rather than turning an outage or a rate limit into a 404.
 * An empty list from the API counts as "didn't answer" (as in
 * conceptsOrFallback): a working storefront always has brands.
 */
export type ConceptLookup =
  | { status: 'live' | 'fallback'; concept: Concept }
  | { status: 'missing' | 'unverified'; concept: null }

export async function lookupConcept(slug: string): Promise<ConceptLookup> {
  const list = await fetchConceptList()
  if (list && list.length > 0) {
    const live = list.find((c) => c.slug === slug)
    return live ? { status: 'live', concept: live } : { status: 'missing', concept: null }
  }
  const bundled = fallbackConcept(slug)
  return bundled ? { status: 'fallback', concept: bundled } : { status: 'unverified', concept: null }
}

/**
 * The brands in one fixed order, for anything built from the list as text or
 * schema (titles, descriptions, ItemList positions). The API's order is the
 * database's row order, which moves when a row is edited, so a title built
 * from it could change between two requests. The bundled brands come first
 * in the order the site's own copy names them (Simmer, Stackd, Flipd), then
 * every other brand by name. Returns a copy; on-page lists keep their own
 * order.
 */
export function inBrandOrder(concepts: Concept[]): Concept[] {
  const fixed = Object.keys(FALLBACK_CONCEPTS)
  const rank = (c: Concept) => {
    const i = fixed.indexOf(c.slug)
    return i === -1 ? fixed.length : i
  }
  return [...concepts].sort((a, b) =>
    rank(a) - rank(b) ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

/** "Simmer", "Simmer & Stackd", "Simmer, Stackd & Flipd" — for titles and
 *  descriptions built from the live brand list. Names are already formatted. */
export function joinNames(names: string[], last = '&'): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} ${last} ${names[names.length - 1]}`
}

/**
 * A meta description built from whole sentences: the first always (trimmed
 * on a word boundary if it alone is too long), then each further sentence
 * that still fits under `max`. Built-from-data descriptions then end on a
 * full stop instead of being cut mid-phrase.
 */
export function fitSentences(sentences: Array<string | null | undefined | false>, max = 160): string {
  const parts = sentences
    .map((s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean)
  if (!parts.length) return ''
  let out = parts[0]!
  if (out.length > max) {
    const cut = out.slice(0, max - 1)
    const sp = cut.lastIndexOf(' ')
    return `${(sp > 60 ? cut.slice(0, sp) : cut).replace(/[,.;:—-]+$/, '')}…`
  }
  for (const p of parts.slice(1)) {
    if (out.length + 1 + p.length <= max) out = `${out} ${p}`
  }
  return out
}

/** "Ends with a full stop." — for owner-written text joined into a sentence list. */
export function asSentence(text: string | null | undefined): string {
  const t = (text ?? '').trim()
  return !t ? '' : /[.!?…]$/.test(t) ? t : `${t}.`
}
