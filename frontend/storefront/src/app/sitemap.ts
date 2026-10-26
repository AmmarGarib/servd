import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'

import { BRAND_ORIGIN, SERVD_ORIGIN, brandCanonical, hostBrand } from '../lib/brandDomains'
import { isPublishableLocation, locationFromConcept, type BrandLocation } from '../lib/brandLocations'
import { fetchLivePages } from '../lib/blocks'
import { conceptsOrFallback, fetchConceptList } from '../lib/liveConcepts'

// sitemap.xml, per host. A sitemap may only list URLs on its own host — a
// stackd.pk Search Console property rejects anything else as "URL not
// allowed" — so each host gets its own:
//
//   stackd.pk / simmer.pk / flipd.pk → that brand's microsite at its canonical
//     URLs (/, /menu, /about, /visit) plus the owner's published brand pages
//     (/pages/<page>).
//   servd.pk → servd's own pages: /home, the waitlist, press, reservations,
//     each brand's ordering page, the location pages that have a real
//     address, and the published servd pages (/pages/<slug>). A brand with no
//     domain of its own keeps its microsite under servd.pk/brand/<slug>, so
//     it is listed here too.
//
// Brands come from the live Concept rows and pages from the published
// SiteLayouts, so a brand or page added in admin is in the sitemap on the next
// request — and a brand hidden or deactivated in admin drops out of it, the
// same answer the ordering and booking routes give (they 404 it; see
// lookupConcept in lib/liveConcepts). Only when the API doesn't answer do the
// bundled brands stand in. Never listed: redirects (servd.pk/ → /home),
// placeholder locations, drafts, and the account / checkout / order-tracker
// URLs.
//
// lastModified is the page's real change time and nothing else: the latest of
// its layout's publish time (SiteLayout.publishedAt) and, for a page built
// from a brand's record (ordering, reservations, the microsite, the location
// pages, /locations), the brand's own updatedAt when the API sends it. It is
// left out when no real date is known — a made-up date (the old "now at boot",
// identical on every URL) teaches Google to ignore the field.
// changeFrequency and priority are hints Google ignores; kept for other
// crawlers.

export const dynamic = 'force-dynamic'

type Entry = MetadataRoute.Sitemap[number]

/** Brand-page parts that are chrome or fixed pages (or the brand kit), not owner pages. */
const FIXED_BRAND_PARTS = new Set(['header', 'footer', 'about', 'visit', 'menu', 'kit'])
/** The page names the brand and servd custom-page routes accept. */
const PAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/i


/** True when the brand has a domain of its own (BRAND_ORIGIN). Own-property
 *  check: a pattern host like constructor.servd.pk resolves to the slug
 *  "constructor", which must not read Object.prototype.constructor. */
function hasOwnDomain(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(BRAND_ORIGIN, slug)
}

/** publishedAt as a sitemap date, or nothing when never published / unparseable. */
function lastModifiedOf(published: Map<string, string>, layoutSlug: string): Pick<Entry, 'lastModified'> {
  const at = published.get(layoutSlug)
  if (!at || Number.isNaN(Date.parse(at))) return {}
  return { lastModified: at }
}

/** A date string as a timestamp, or NaN. */
function ms(at: string | null | undefined): number {
  return at ? Date.parse(at) : Number.NaN
}

/** The brand record's own last-change time, when the storefront API sends it
 *  (Concept.updatedAt). Read loosely: the field is optional in the payload. */
function recordUpdatedAt(c: { updatedAt?: unknown } | undefined): string | undefined {
  const at = c?.updatedAt
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : undefined
}

/** The latest of the known real dates, as a sitemap date; nothing when none is known. */
function latest(...dates: Array<string | undefined>): Pick<Entry, 'lastModified'> {
  const known = dates.filter((d): d is string => !!d && !Number.isNaN(ms(d)))
  if (known.length === 0) return {}
  return { lastModified: new Date(Math.max(...known.map(ms))).toISOString() }
}

/** A brand microsite at its canonical URLs, plus the owner's own brand pages. */
function brandEntries(slug: string, published: Map<string, string>, livePages: string[], record?: string): Entry[] {
  const at = (layoutSlug: string) => latest(published.get(layoutSlug), record)
  const fixed: Entry[] = [
    { url: brandCanonical(slug),          ...at(`brand:${slug}`),       changeFrequency: 'weekly',  priority: 0.9 },
    { url: brandCanonical(slug, 'menu'),  ...at(`brand:${slug}:menu`),  changeFrequency: 'daily',   priority: 0.9 },
    { url: brandCanonical(slug, 'about'), ...at(`brand:${slug}:about`), changeFrequency: 'monthly', priority: 0.7 },
    { url: brandCanonical(slug, 'visit'), ...at(`brand:${slug}:visit`), changeFrequency: 'monthly', priority: 0.7 },
  ]
  const own: Entry[] = []
  for (const layoutSlug of livePages) {
    const parts = layoutSlug.split(':')
    if (parts.length !== 3 || parts[0] !== 'brand' || parts[1] !== slug) continue
    const page = parts[2]!
    if (FIXED_BRAND_PARTS.has(page.toLowerCase()) || !PAGE_NAME.test(page)) continue
    own.push({ url: brandCanonical(slug, `pages/${page}`), ...lastModifiedOf(published, layoutSlug), changeFrequency: 'monthly', priority: 0.6 })
  }
  return [...fixed, ...own]
}

/** servd.pk's own pages. `record` maps a brand slug to its record's updatedAt. */
function servdEntries(
  brands: BrandLocation[], published: Map<string, string>, livePages: string[], record: Map<string, string>,
): Entry[] {
  const top: Entry[] = [
    { url: `${SERVD_ORIGIN}/`,     ...lastModifiedOf(published, 'servd:home'),     changeFrequency: 'daily',   priority: 1.0 },
    { url: `${SERVD_ORIGIN}/reserve`,  ...lastModifiedOf(published, 'servd:reserve'),  changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SERVD_ORIGIN}/waitlist`, ...lastModifiedOf(published, 'servd:waitlist'), changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SERVD_ORIGIN}/press`,    ...lastModifiedOf(published, 'servd:press'),    changeFrequency: 'monthly', priority: 0.5 },
  ]

  // The servd content pages (Admin → Storefront: servd:<page>). A date only
  // once the owner has published one; until then the default sections render
  // and no change time is claimed.
  const content: Entry[] = [
    { page: 'about',   changeFrequency: 'monthly' as const, priority: 0.7 },
    { page: 'faq',     changeFrequency: 'monthly' as const, priority: 0.7 },
    { page: 'contact', changeFrequency: 'monthly' as const, priority: 0.6 },
    { page: 'privacy', changeFrequency: 'yearly'  as const, priority: 0.3 },
    { page: 'terms',   changeFrequency: 'yearly'  as const, priority: 0.3 },
  ].map(({ page, changeFrequency, priority }) => ({
    url: `${SERVD_ORIGIN}/${page}`, ...lastModifiedOf(published, `servd:${page}`), changeFrequency, priority,
  }))

  // Ordering (the menu you order from) and, where the brand takes bookings,
  // its reservation page. Both are built from the brand's record.
  const ordering: Entry[] = brands.flatMap((b) => [
    { url: `${SERVD_ORIGIN}/${b.slug}`, ...latest(record.get(b.slug)), changeFrequency: 'daily' as const, priority: 0.9 },
    ...(b.acceptsReservations
      ? [{ url: `${SERVD_ORIGIN}/reserve/${b.slug}`, ...latest(record.get(b.slug)), changeFrequency: 'weekly' as const, priority: 0.6 }]
      : []),
  ])

  // One page per kitchen with a real address. A placeholder area would put
  // "TODO_FILL_AREA" in a title Google indexes.
  const publishable = brands.filter(isPublishableLocation)
  const locations: Entry[] = publishable.map((b) => ({
    url: `${SERVD_ORIGIN}/locations/${b.locationSlug}`,
    ...latest(published.get('servd:location'), record.get(b.slug)),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }))
  // The hub lists them all: it changed when the template or any listed brand did.
  const hub: Entry[] = publishable.length > 0
    ? [{
        url: `${SERVD_ORIGIN}/locations`,
        ...latest(published.get('servd:location'), ...publishable.map((b) => record.get(b.slug))),
        changeFrequency: 'weekly' as const,
        priority: 0.8,
      }]
    : []

  // Brands with no domain of their own live under servd.pk/brand/<slug>.
  const hostedMicrosites: Entry[] = brands
    .filter((b) => !hasOwnDomain(b.slug))
    .flatMap((b) => brandEntries(b.slug, published, livePages, record.get(b.slug)))

  // The owner's servd pages: page:<slug> → /pages/<slug>.
  const custom: Entry[] = livePages
    .filter((s) => s.startsWith('page:') && PAGE_NAME.test(s.slice('page:'.length)))
    .map((s) => ({ url: `${SERVD_ORIGIN}/pages/${s.slice('page:'.length)}`, ...lastModifiedOf(published, s), changeFrequency: 'monthly' as const, priority: 0.5 }))

  return [...top, ...content, ...hub, ...ordering, ...locations, ...hostedMicrosites, ...custom]
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = (await headers()).get('host') ?? ''
  const [hostSlug, list, pages] = await Promise.all([
    hostBrand(host),
    fetchConceptList(),
    fetchLivePages(),
  ])
  const concepts = conceptsOrFallback(list ?? [])
  const brands = concepts.map((c) => locationFromConcept(c))
  // Each brand's record change time (Concept.updatedAt), when the API sends it.
  const record = new Map<string, string>()
  for (const c of concepts) {
    const at = recordUpdatedAt(c as { updatedAt?: unknown })
    if (at) record.set(c.slug, at)
  }

  const published = new Map<string, string>()
  for (const p of pages) if (p.publishedAt) published.set(p.slug, p.publishedAt)
  const livePages = pages.map((p) => p.slug)

  // A brand domain lists only its own microsite. (A brand host whose brand
  // has no domain of its own — a dev / preview host — has its canonical URLs
  // on servd, so it gets servd's sitemap.)
  const entries = hostSlug && hasOwnDomain(hostSlug)
    ? brandEntries(hostSlug, published, livePages, record.get(hostSlug))
    : servdEntries(brands, published, livePages, record)

  // One entry per URL.
  const seen = new Set<string>()
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
}
