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
// lastModified is the page's real publish time (SiteLayout.publishedAt), and
// is left out when a page has never been published — a made-up date (the old
// "now at boot", identical on every URL) teaches Google to ignore the field.
// changeFrequency and priority are hints Google ignores; kept for other
// crawlers.

export const dynamic = 'force-dynamic'

type Entry = MetadataRoute.Sitemap[number]

/** Brand-page parts that are chrome or fixed pages, not owner pages. */
const FIXED_BRAND_PARTS = new Set(['header', 'footer', 'about', 'visit', 'menu'])
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

/** A brand microsite at its canonical URLs, plus the owner's own brand pages. */
function brandEntries(slug: string, published: Map<string, string>, livePages: string[]): Entry[] {
  const fixed: Entry[] = [
    { url: brandCanonical(slug),          ...lastModifiedOf(published, `brand:${slug}`),       changeFrequency: 'weekly',  priority: 0.9 },
    { url: brandCanonical(slug, 'menu'),  ...lastModifiedOf(published, `brand:${slug}:menu`),  changeFrequency: 'daily',   priority: 0.9 },
    { url: brandCanonical(slug, 'about'), ...lastModifiedOf(published, `brand:${slug}:about`), changeFrequency: 'monthly', priority: 0.7 },
    { url: brandCanonical(slug, 'visit'), ...lastModifiedOf(published, `brand:${slug}:visit`), changeFrequency: 'monthly', priority: 0.7 },
  ]
  const own: Entry[] = []
  for (const layoutSlug of livePages) {
    const parts = layoutSlug.split(':')
    if (parts.length !== 3 || parts[0] !== 'brand' || parts[1] !== slug) continue
    const page = parts[2]!
    if (FIXED_BRAND_PARTS.has(page) || !PAGE_NAME.test(page)) continue
    own.push({ url: brandCanonical(slug, `pages/${page}`), ...lastModifiedOf(published, layoutSlug), changeFrequency: 'monthly', priority: 0.6 })
  }
  return [...fixed, ...own]
}

/** servd.pk's own pages. */
function servdEntries(brands: BrandLocation[], published: Map<string, string>, livePages: string[]): Entry[] {
  const top: Entry[] = [
    { url: `${SERVD_ORIGIN}/`,     ...lastModifiedOf(published, 'servd:home'),     changeFrequency: 'daily',   priority: 1.0 },
    { url: `${SERVD_ORIGIN}/reserve`,  ...lastModifiedOf(published, 'servd:reserve'),  changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SERVD_ORIGIN}/waitlist`, ...lastModifiedOf(published, 'servd:waitlist'), changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SERVD_ORIGIN}/press`,    ...lastModifiedOf(published, 'servd:press'),    changeFrequency: 'monthly', priority: 0.5 },
  ]

  // Ordering (the menu you order from) and, where the brand takes bookings,
  // its reservation page.
  const ordering: Entry[] = brands.flatMap((b) => [
    { url: `${SERVD_ORIGIN}/${b.slug}`, changeFrequency: 'daily' as const, priority: 0.9 },
    ...(b.acceptsReservations
      ? [{ url: `${SERVD_ORIGIN}/reserve/${b.slug}`, changeFrequency: 'weekly' as const, priority: 0.6 }]
      : []),
  ])

  // One page per kitchen with a real address. A placeholder area would put
  // "TODO_FILL_AREA" in a title Google indexes.
  const locationTemplate = lastModifiedOf(published, 'servd:location')
  const locations: Entry[] = brands
    .filter(isPublishableLocation)
    .map((b) => ({ url: `${SERVD_ORIGIN}/locations/${b.locationSlug}`, ...locationTemplate, changeFrequency: 'monthly' as const, priority: 0.7 }))

  // Brands with no domain of their own live under servd.pk/brand/<slug>.
  const hostedMicrosites: Entry[] = brands
    .filter((b) => !hasOwnDomain(b.slug))
    .flatMap((b) => brandEntries(b.slug, published, livePages))

  // The owner's servd pages: page:<slug> → /pages/<slug>.
  const custom: Entry[] = livePages
    .filter((s) => s.startsWith('page:') && PAGE_NAME.test(s.slice('page:'.length)))
    .map((s) => ({ url: `${SERVD_ORIGIN}/pages/${s.slice('page:'.length)}`, ...lastModifiedOf(published, s), changeFrequency: 'monthly' as const, priority: 0.5 }))

  return [...top, ...ordering, ...locations, ...hostedMicrosites, ...custom]
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = headers().get('host') ?? ''
  const [hostSlug, list, pages] = await Promise.all([
    hostBrand(host),
    fetchConceptList(),
    fetchLivePages(),
  ])
  const brands = conceptsOrFallback(list ?? []).map((c) => locationFromConcept(c))

  const published = new Map<string, string>()
  for (const p of pages) if (p.publishedAt) published.set(p.slug, p.publishedAt)
  const livePages = pages.map((p) => p.slug)

  // A brand domain lists only its own microsite. (A brand host whose brand
  // has no domain of its own — a dev / preview host — has its canonical URLs
  // on servd, so it gets servd's sitemap.)
  const entries = hostSlug && hasOwnDomain(hostSlug)
    ? brandEntries(hostSlug, published, livePages)
    : servdEntries(brands, published, livePages)

  // One entry per URL.
  const seen = new Set<string>()
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
}
