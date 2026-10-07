// Geo landing page — one per physical location.
//
// Per the local-seo skill: each physical location needs its own indexable
// page with H1 carrying the location, embedded Google Map, canonical NAP,
// hours, menu + reservation CTA. Avoids "thin location pages" by including
// the brand description + concept context + an embedded map.
//
// One content template serves every location: SiteLayout `servd:location`
// (Admin → Storefront). Its sections read the location from params.loc and
// render the live NAP data; the fixed copy is fields. 404, metadata and the
// JSON-LD stay here.

import { notFound } from 'next/navigation'
import { addressLine } from '../../../lib/brandLocations'
import { restaurantSchema, breadcrumbSchema, jsonLdScript } from '../../../lib/jsonLd'
import { brandStory } from '../../../lib/concept'

import { SERVD_ORIGIN } from '../../../lib/brandDomains'
import { ManagedPage } from '../../../sections/ManagedPage'
import { findLocation } from '../../../sections/servd/location'

const SITE = SERVD_ORIGIN
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ loc: string }> }) {
  const { loc } = await params
  const brand = await findLocation(loc)
  if (!brand) return { title: 'Location not found' }
  return {
    title:       `${brand.name} · ${brand.area} · ${brand.city}`,
    description: `Visit ${brand.name} at ${addressLine(brand)}. ${brand.cuisine}. ${brand.acceptsReservations ? 'Reservations available.' : 'Walk-in friendly.'}`,
    alternates:  { canonical: `${SITE}/locations/${loc}` },
  }
}

export default async function LocationPage({ params }: { params: Promise<{ loc: string }> }) {
  const { loc: locSlug } = await params
  // locationSlug first, then the concept slug, then a retired slug's brand
  // (see findLocation) — the same lookup the page's sections make.
  const brand = await findLocation(locSlug)
  if (!brand) notFound()
  const story = brandStory(brand.slug)

  const schemaGraph = [
    restaurantSchema({
      loc:         brand,
      description: story.tagline,
    }),
    breadcrumbSchema([
      { name: 'servd',         url: `${SITE}/` },
      { name: brand.name,      url: `${SITE}/brand/${brand.slug}` },
      { name: brand.area,      url: `${SITE}/locations/${brand.locationSlug}` },
    ]),
  ]

  return (
    <main style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schemaGraph) }} />
      <ManagedPage slug="servd:location" params={{ loc: locSlug }} />
    </main>
  )
}
