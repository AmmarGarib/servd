// /locations — the hub: every kitchen / restaurant servd lists, with its
// address and a link to its own page (/locations/<slug>), plus a Restaurant
// node per location in the JSON-LD so search engines and AI answers can tie
// each brand to a real place. Pure live data (the brand records, edited in
// Admin → Marketing → Brands): no hard-coded copy beyond the heading, and a
// location with no real area yet is left out (same bar as its own page and
// the sitemap — a placeholder address must never be published). A test
// company's brand is reachable by link only, so it is never listed.

import type { Metadata } from 'next'
import Link from 'next/link'
import { Breadcrumbs } from '../../components/Breadcrumbs'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { addressLine, filled, isPublishableLocation, locationFromConcept, type BrandLocation } from '../../lib/brandLocations'
import { formatBrandName } from '../../lib/concept'
import { jsonLdScript, restaurantSchema } from '../../lib/jsonLd'
import {
  conceptsOrFallback, fetchConceptList, fitSentences, inBrandOrder, isServdCompanyBrand, joinNames,
} from '../../lib/liveConcepts'

export const dynamic = 'force-dynamic'

const CANONICAL = `${SERVD_ORIGIN}/locations`

async function listedLocations() {
  const live = conceptsOrFallback((await fetchConceptList()) ?? [])
  const concepts = inBrandOrder(live).filter((c) => c.isTestCompany !== true)
  const locations: BrandLocation[] = concepts.map((c) => locationFromConcept(c)).filter(isPublishableLocation)
  return { live, locations }
}

export async function generateMetadata(): Promise<Metadata> {
  const { locations } = await listedLocations()
  const names = joinNames(locations.map((l) => formatBrandName(l.name)), 'and')
  return pageMetadata({
    title: 'Locations in Karachi',
    description: fitSentences([
      names ? `Find ${names} in Karachi.` : 'Find our kitchens and restaurants in Karachi.',
      'Addresses, directions, opening hours and how to order or book a table.',
    ], 155),
    canonical: CANONICAL,
  })
}

export default async function LocationsHubPage() {
  const { live, locations } = await listedLocations()
  const graph = locations.map((loc) => restaurantSchema({ loc, ownedByServd: isServdCompanyBrand(loc.slug, live) }))

  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      {graph.length > 0 && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(graph) }} />
      )}
      <Breadcrumbs
        origin={SERVD_ORIGIN}
        items={[{ name: 'servd', href: '/' }, { name: 'Locations', href: '/locations' }]}
      />
      <div style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem 1rem 4rem' }}>
        <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.25rem)', fontWeight: 900, letterSpacing: '-0.04em', margin: '0 0 0.5rem' }}>
          Locations
        </h1>
        <p style={{ color: 'var(--servd-mute)', maxWidth: '36rem', margin: '0 0 2rem' }}>
          {locations.length > 0
            ? `${locations.length === 1 ? 'Our kitchen' : `Our ${locations.length} kitchens`} in Karachi.`
            : 'Our kitchens in Karachi.'}
        </p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))' }}>
          {locations.map((loc) => {
            const phone = filled(loc.phone)
            return (
              <li key={loc.slug} className="sv-hard-card" style={{ background: '#fff', borderRadius: '1rem', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0 }}>
                  <Link href={`/locations/${loc.locationSlug}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                    {formatBrandName(loc.name)}
                  </Link>
                </h2>
                {filled(loc.cuisine) && <p style={{ margin: 0, color: 'var(--servd-mute)' }}>{loc.cuisine}</p>}
                <p style={{ margin: 0 }}>
                  {[filled(loc.street), addressLine(loc)].filter(Boolean).join(', ')}
                </p>
                {phone && (
                  <p style={{ margin: 0 }}>
                    <a href={`tel:${phone.replace(/[^+\d]/g, '')}`} style={{ color: 'inherit' }}>{phone}</a>
                  </p>
                )}
                <div style={{ margin: '0.5rem 0 0', display: 'flex', gap: '0.5rem 1.25rem', flexWrap: 'wrap', fontWeight: 700 }}>
                  <Link href={`/locations/${loc.locationSlug}`} className="sv-tap-link" style={{ color: 'var(--servd-ink)' }}>Directions and hours</Link>
                  <Link href={`/${loc.slug}`} className="sv-tap-link" style={{ color: 'var(--servd-ink)' }}>Order</Link>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
