// schema.org JSON-LD generators.
//
// Per the schema + ai-seo skills: well-structured JSON-LD is one of the
// strongest signals for Google rich results (rating stars in search,
// Knowledge Panel, Maps prominence) AND for getting cited by AI search
// (Perplexity, ChatGPT, Google AI Overviews). For Karachi food queries
// the AI surfaces are now answering before Google's blue links —
// missing this is missing the channel.
//
// Entities are linked by @id so every page describes the SAME things:
//   servd / GS Foods        `${SERVD_ORIGIN}/#organization`
//   each brand              `${brandCanonical(slug)}#restaurant`  (its own domain)
//   each brand's menu       `${brandCanonical(slug, 'menu')}#menu`
//   each site               `<origin>/#website`
// NAP values pass through filled() so an unfilled placeholder never reaches
// Google. Pages render via `jsonLdScript(graph)` (escaped for a <script>).

import { filled, type BrandLocation } from './brandLocations'
import { SERVD_ORIGIN, brandCanonical } from './brandDomains'

/** The servd / GS Foods organization node's @id. */
export const ORG_ID = `${SERVD_ORIGIN}/#organization`

/** The @id of a brand's Restaurant node (on the brand's own domain). */
export const restaurantId = (slug: string) => `${brandCanonical(slug)}#restaurant`

/** The @id of a brand's Menu node. */
export const menuId = (slug: string) => `${brandCanonical(slug, 'menu')}#menu`

/** The brand's share image (src/app/brand/[slug]/opengraph-image.tsx). */
export const brandImageUrl = (slug: string) => `${SERVD_ORIGIN}/brand/${slug}/opengraph-image`

interface OrgGraphInput {
  name:        string
  url:         string
  logoUrl:     string
  sameAs?:     string[]              // social profiles that are servd's own
  legalName?:  string
  email?:      string
}

/** Organization schema for the operator brand (servd / GS Foods). */
export function organizationSchema(o: OrgGraphInput): Record<string, unknown> {
  const email = filled(o.email)
  return {
    '@context': 'https://schema.org',
    '@type':    'Organization',
    '@id':      ORG_ID,
    name:       o.name,
    url:        o.url,
    logo:       o.logoUrl,
    ...(o.legalName && { legalName: o.legalName }),
    ...(email && {
      email,
      contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', email, areaServed: 'PK' },
    }),
    sameAs:     o.sameAs ?? [],
  }
}

/**
 * WebSite schema. With no options it is servd's, with a SearchAction (the
 * Google sitelinks search box; /home?q= opens the search sheet). A brand site
 * passes its own name + url and gets no SearchAction — it has no site search.
 */
export function websiteSchema(opts: { name?: string; url?: string; ownedByServd?: boolean } = {}): Record<string, unknown> {
  const isServd = !opts.url
  const url = opts.url ?? `${SERVD_ORIGIN}/`
  const origin = url.replace(/\/home$/, '').replace(/\/+$/, '')
  return {
    '@context': 'https://schema.org',
    '@type':    'WebSite',
    '@id':      `${origin}/#website`,
    name:       opts.name ?? 'servd',
    url,
    inLanguage: 'en',
    // A brand site names servd's company as publisher only when it is one of
    // its brands (isServdCompanyBrand) — never another company's.
    ...((isServd || opts.ownedByServd) && { publisher: { '@id': ORG_ID } }),
    ...(isServd && {
      potentialAction: {
        '@type':       'SearchAction',
        target:        `${SERVD_ORIGIN}/?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    }),
  }
}

interface RestaurantGraphInput {
  loc:         BrandLocation
  /** Defaults to the brand's own description (loc.description). Pass only
   *  when the page has nothing better — every page should agree. */
  description?: string
  imageUrl?:   string
  /** Aggregated rating data — surface stars + count in Maps + Knowledge Panel.
   *  Pull from the API when available; omit when no reviews exist (passing
   *  zero counts violates Google's guidelines). */
  rating?: {
    value:  number       // 1-5
    count:  number       // total review count
  }
  /** Service hours (dayOfWeek per JS getDay(), minutes since midnight).
   *  Defaults to loc.hours. */
  hours?: Array<{ dayOfWeek: number; openMin: number; closeMin: number }>
  /** Emit hasMenu → the Menu node's @id (only when a menu is published). */
  hasMenu?: boolean
  /** The brand belongs to the company that runs servd (isServdCompanyBrand in
   *  lib/liveConcepts): only then is servd's Organization its parent. */
  ownedByServd?: boolean
}

const DOW_NAME = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
function minsToHHMM(m: number): string {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Restaurant schema for a brand. Its url and @id are the brand's OWN domain
 *  (the canonical microsite), whichever page emits it. */
export function restaurantSchema(r: RestaurantGraphInput): Record<string, unknown> {
  const slug = r.loc.slug
  const url = brandCanonical(slug)
  const phone = filled(r.loc.phone)
  const email = filled(r.loc.email)
  const description = (r.description ?? r.loc.description ?? '').trim()
  const hours = r.hours ?? r.loc.hours
  const street = [filled(r.loc.street), filled(r.loc.area)].filter(Boolean).join(', ')
  const node: Record<string, unknown> = {
    '@context':   'https://schema.org',
    '@type':      'Restaurant',
    '@id':        restaurantId(slug),
    name:         r.loc.name,
    url,
    ...(description && { description }),
    image:        [r.imageUrl ?? brandImageUrl(slug)],
    servesCuisine: r.loc.cuisine,
    priceRange:    r.loc.priceRange,
    // A reservable brand points at its booking page (a URL is allowed here).
    acceptsReservations: r.loc.acceptsReservations ? `${SERVD_ORIGIN}/reserve/${slug}` : false,
    menu:         brandCanonical(slug, 'menu'),
    ...(r.hasMenu && { hasMenu: { '@id': menuId(slug) } }),
    ...(r.ownedByServd && { parentOrganization: { '@id': ORG_ID } }),
    potentialAction: {
      '@type': 'OrderAction',
      target:  `${SERVD_ORIGIN}/${slug}`,
    },
    // Always an address: Google wants at least the locality and country, and
    // the street is added once it is filled in admin.
    address: {
      '@type':         'PostalAddress',
      ...(street && { streetAddress: street }),
      addressLocality: filled(r.loc.city) || 'Karachi',
      addressRegion:   'Sindh',
      ...(filled(r.loc.postalCode) && { postalCode: filled(r.loc.postalCode) }),
      addressCountry:  'PK',
    },
  }
  if (phone) node['telephone'] = phone
  if (email) node['email'] = email
  // Only a sourced pin (the LocationDetails rule): mapsUrl is set exactly when
  // there is one. Flipd's bundled default and the Karachi-centroid default for
  // a new brand carry none, and must not reach Google as a real location.
  const mapsUrl = filled(r.loc.mapsUrl)
  if (mapsUrl) node['hasMap'] = mapsUrl
  if (mapsUrl && typeof r.loc.geo?.lat === 'number' && typeof r.loc.geo?.lng === 'number') {
    node['geo'] = { '@type': 'GeoCoordinates', latitude: r.loc.geo.lat, longitude: r.loc.geo.lng }
  }
  if (hours && hours.length > 0) {
    node['openingHoursSpecification'] = hours.map((h) => ({
      '@type':      'OpeningHoursSpecification',
      dayOfWeek:    DOW_NAME[h.dayOfWeek],
      opens:        minsToHHMM(h.openMin),
      closes:       minsToHHMM(h.closeMin),
    }))
  }
  if (r.rating && r.rating.count > 0) {
    node['aggregateRating'] = {
      '@type':      'AggregateRating',
      ratingValue:  r.rating.value.toFixed(1),
      reviewCount:  r.rating.count,
      bestRating:   '5',
      worstRating:  '1',
    }
  }
  return node
}

interface MenuItemInput {
  id:           string
  name:         string
  description?: string | null
  priceCents:   number
  imageUrl?:    string | null
  isAvailable?: boolean
}

/** Menu schema scoped to a brand. Each section becomes a MenuSection, each
 *  item a MenuItem with offers. Lights up Google's menu carousel + helps
 *  LLMs answer "what's on simmer's menu". Emit only for a published menu. */
export function menuSchema(input: {
  loc:        BrandLocation
  sections:   Array<{ name: string; items: MenuItemInput[] }>
}): Record<string, unknown> {
  const slug = input.loc.slug
  return {
    '@context': 'https://schema.org',
    '@type':    'Menu',
    '@id':      menuId(slug),
    url:        brandCanonical(slug, 'menu'),
    name:       `${input.loc.name} menu`,
    inLanguage: 'en',
    hasMenuSection: input.sections
      .filter((s) => s.items.length > 0)
      .map((s) => ({
        '@type': 'MenuSection',
        name:    s.name,
        hasMenuItem: s.items.map((it) => ({
          '@type':       'MenuItem',
          name:          it.name,
          ...(it.description?.trim() && { description: it.description.trim() }),
          ...(it.imageUrl && /^https:\/\//.test(it.imageUrl) && { image: it.imageUrl }),
          offers: {
            '@type':         'Offer',
            price:           (it.priceCents / 100).toFixed(2),
            priceCurrency:   'PKR',
            availability:    it.isAvailable === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
          },
        })),
      })),
  }
}

/** FAQPage schema. Only for Q&A that is VISIBLE on the page (Google's rule):
 *  build it from the same section fields the page renders. */
export function faqSchema(qa: Array<{ question: string; answer: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: qa.map((p) => ({
      '@type': 'Question',
      name:    p.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text:    p.answer,
      },
    })),
  }
}

/** BreadcrumbList — helps Google show breadcrumb trail in search results.
 *  Every item url must be a canonical URL (never a redirecting one). */
export function breadcrumbSchema(items: Array<{ name: string; url: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type':    'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type':   'ListItem',
      position:  i + 1,
      name:      it.name,
      item:      it.url,
    })),
  }
}

/** Render JSON-LD for a <script type="application/ld+json">. `<`, `>` and `&`
 *  are escaped so owner-edited text can never close the script tag; the
 *  output is still valid JSON. */
export function jsonLdScript(obj: Record<string, unknown> | Record<string, unknown>[]): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}
