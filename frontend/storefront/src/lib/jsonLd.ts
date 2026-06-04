// schema.org JSON-LD generators.
//
// Per the schema + ai-seo skills: well-structured JSON-LD is one of the
// strongest signals for Google rich results (rating stars in search,
// Knowledge Panel, Maps prominence) AND for getting cited by AI search
// (Perplexity, ChatGPT, Google AI Overviews). For Karachi food queries
// the AI surfaces are now answering before Google's blue links —
// missing this is missing the channel.
//
// Output is plain JSON (object → JSON.stringify in the consuming page).
// Pages render via:
//
//   <script type="application/ld+json"
//     dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }} />

import { type BrandLocation } from './brandLocations'

const SITE_URL = 'https://servd-app.garibsons.app'

interface OrgGraphInput {
  name:        string
  url:         string
  logoUrl:     string
  sameAs?:     string[]              // social profiles
}

/** Organization schema for the operator brand (servd / GS Foods). */
export function organizationSchema(o: OrgGraphInput): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type':    'Organization',
    name:       o.name,
    url:        o.url,
    logo:       o.logoUrl,
    sameAs:     o.sameAs ?? [],
  }
}

/** WebSite schema with SearchAction (lights up the Google search-box sitelink). */
export function websiteSchema(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type':    'WebSite',
    name:       'servd',
    url:        SITE_URL,
    potentialAction: {
      '@type':       'SearchAction',
      target:        `${SITE_URL}/browse?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  }
}

interface RestaurantGraphInput {
  loc:         BrandLocation
  description: string
  imageUrl?:   string
  /** Aggregated rating data — surface stars + count in Maps + Knowledge Panel.
   *  Pull from the API when available; omit when no reviews exist (passing
   *  zero counts violates Google's guidelines). */
  rating?: {
    value:  number       // 1-5
    count:  number       // total review count
  }
  /** Service hours per day-of-week. dayOfWeek follows JS getDay() (0=Sun..6=Sat).
   *  openMin/closeMin are minutes since midnight; same shape as the
   *  /storefront/brands/:slug/hours endpoint. */
  hours?: Array<{ dayOfWeek: number; openMin: number; closeMin: number }>
}

const DOW_NAME = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
function minsToHHMM(m: number): string {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Restaurant schema for a brand microsite. The combination of address +
 *  geo + cuisine + priceRange + acceptsReservations is what unlocks the
 *  full Knowledge Panel treatment in Google. */
export function restaurantSchema(r: RestaurantGraphInput): Record<string, unknown> {
  const url = `${SITE_URL}/brand/${r.loc.slug}`
  const node: Record<string, unknown> = {
    '@context':   'https://schema.org',
    '@type':      'Restaurant',
    '@id':        `${url}#restaurant`,
    name:         r.loc.name,
    url,
    description:  r.description,
    image:        r.imageUrl ?? `${SITE_URL}/og/${r.loc.slug}.jpg`,
    telephone:    r.loc.phone,
    servesCuisine: r.loc.cuisine,
    priceRange:    r.loc.priceRange,
    acceptsReservations: r.loc.acceptsReservations,
    menu:         `${SITE_URL}/${r.loc.slug}`,
    address: {
      '@type':           'PostalAddress',
      streetAddress:     r.loc.street,
      addressLocality:   r.loc.area,
      addressRegion:     'Sindh',
      addressCountry:    r.loc.country,
    },
    geo: {
      '@type':    'GeoCoordinates',
      latitude:   r.loc.geo.lat,
      longitude:  r.loc.geo.lng,
    },
  }
  if (r.hours && r.hours.length > 0) {
    node['openingHoursSpecification'] = r.hours.map((h) => ({
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
}

/** Menu schema scoped to a brand. Each section becomes a MenuSection, each
 *  item a MenuItem with offers. Lights up Google's menu carousel + helps
 *  LLMs answer "what's on simmer's menu". */
export function menuSchema(input: {
  loc:        BrandLocation
  sections:   Array<{ name: string; items: MenuItemInput[] }>
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type':    'Menu',
    '@id':      `${SITE_URL}/${input.loc.slug}#menu`,
    name:       `${input.loc.name} menu`,
    hasMenuSection: input.sections.map((s) => ({
      '@type': 'MenuSection',
      name:    s.name,
      hasMenuItem: s.items.map((it) => ({
        '@type':       'MenuItem',
        name:          it.name,
        description:   it.description ?? undefined,
        offers: {
          '@type':         'Offer',
          price:           (it.priceCents / 100).toFixed(2),
          priceCurrency:   'PKR',
          availability:    'https://schema.org/InStock',
        },
      })),
    })),
  }
}

/** FAQPage schema for a brand microsite's Visit page (parking, dress code,
 *  reservations, halal, alcohol policy, etc.). LLMs lift these verbatim. */
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

/** BreadcrumbList — helps Google show breadcrumb trail in search results. */
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

/** Convenience: render a JSON-LD <script> with consistent indentation. */
export function jsonLdScript(obj: Record<string, unknown> | Record<string, unknown>[]): string {
  return JSON.stringify(obj)
}
