// Geo landing page — one per physical location.
//
// Per the local-seo skill: each physical location needs its own indexable
// page with H1 carrying the location, embedded Google Map, canonical NAP,
// hours, menu + reservation CTA. Avoids "thin location pages" by including
// the brand description + concept context + an embedded map.
//
// One content template serves every location: SiteLayout `servd:location`
// (Admin → Storefront). Its sections read the location from params.loc and
// render the live NAP data; the fixed copy is fields. 404, redirects,
// metadata and the JSON-LD stay here.
//
// One URL per location: an alias (/locations/<brand>, a retired slug such as
// bukhari-commercial) 308s to the location's own slug. A location whose area
// is not filled in yet is noindex — its title would otherwise carry a
// placeholder or nothing at all.

import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { addressLine, filled, isPublishableLocation, type BrandLocation } from '../../../lib/brandLocations'
import { restaurantSchema, breadcrumbSchema, jsonLdScript } from '../../../lib/jsonLd'
import { SERVD_ORIGIN, brandCanonical, pageMetadata } from '../../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../../lib/blocks'
import { asSentence, fetchLiveConcepts, fitSentences, isServdCompanyBrand } from '../../../lib/liveConcepts'
import { ManagedPage } from '../../../sections/ManagedPage'
import { fillLocation, findLocation } from '../../../sections/servd/location'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ loc: string }> | { loc: string } }

const canonicalFor = (brand: BrandLocation) => `${SERVD_ORIGIN}/locations/${brand.locationSlug}`

/** "Ittehad Commercial, DHA Phase 6, Karachi" — only the parts that are filled. */
function placeOf(brand: BrandLocation): string {
  return [filled(brand.area), filled(brand.city)].filter(Boolean).join(', ') || 'Karachi'
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { loc } = await Promise.resolve(params as Promise<{ loc: string }>)
  const [brand, layout] = await Promise.all([findLocation(loc), fetchSiteLayout('servd:location')])
  if (!brand) notFound()

  // The template's own SEO settings (Admin → Storefront → servd:location)
  // apply to every location, so they take the same {name} {area} {city}
  // placeholders as its sections.
  const seo = pageSeo(layout)
  const address = addressLine(brand)
  const fallbackDescription = fitSentences([
    `Visit ${brand.name} at ${placeOf(brand)}.`,
    asSentence(brand.description) || asSentence(brand.cuisine),
    brand.acceptsReservations ? 'Reservations available.' : 'Walk-in friendly.',
    'Directions, map and contact details.',
  ])
  return pageMetadata({
    title:       seo.title ? fillLocation(seo.title, brand) : (address ? `${brand.name} · ${address}` : brand.name),
    description: seo.description ? fillLocation(seo.description, brand) : fallbackDescription,
    // Always the location's OWN slug, whichever alias was requested.
    canonical:   canonicalFor(brand),
    noindex:     !isPublishableLocation(brand),
  })
}

export default async function LocationPage({ params }: Params) {
  const { loc: locSlug } = await Promise.resolve(params as Promise<{ loc: string }>)
  // locationSlug first, then the concept slug, then a retired slug's brand
  // (see findLocation) — the same lookup the page's sections make.
  const [brand, live] = await Promise.all([findLocation(locSlug), fetchLiveConcepts()])
  if (!brand) notFound()
  // An alias is the same page: send it (308) to the one canonical URL.
  if (locSlug !== brand.locationSlug) permanentRedirect(`/locations/${brand.locationSlug}`)

  const schemaGraph = [
    // The brand's own description and hours (restaurantSchema's defaults),
    // so this node matches the one on the brand's domain and /home.
    restaurantSchema({ loc: brand, ownedByServd: isServdCompanyBrand(brand.slug, live) }),
    breadcrumbSchema([
      { name: 'servd',                            url: `${SERVD_ORIGIN}/home` },
      { name: brand.name,                         url: brandCanonical(brand.slug) },
      { name: addressLine(brand) || brand.name,   url: canonicalFor(brand) },
    ]),
  ]

  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schemaGraph) }} />
      <ManagedPage slug="servd:location" params={{ loc: brand.locationSlug }} />
    </div>
  )
}
