// servd home page (/home — `/` and `/browse` redirect here). Every section on it
// is content (SiteLayout `servd:home`, Admin → Storefront, CEO-approved): the
// scroll-expansion hero, the kitchen tiles, how it works, Insiders, Visit and
// the waitlist strip. Nothing published → the catalogue's default sections,
// which are the page as designed. Anchors #kitchens / #insiders / #visit live
// on those sections.

import { SERVD_ORIGIN } from '../../lib/brandDomains'
import type { Concept } from '../../lib/concept'
import { fetchBrandLocations } from '../../lib/brandLocations'
import { organizationSchema, websiteSchema, restaurantSchema, jsonLdScript } from '../../lib/jsonLd'
import { brandStory } from '../../lib/concept'
import { ManagedPage } from '../../sections/ManagedPage'
import { HomeSearchParam } from '../../sections/servd/HomeSearchParam'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

export const metadata = {
  alternates: { canonical: '/home' },
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

export default async function HomePage() {
  const [concepts, brandLocations] = await Promise.all([
    getConcepts(),
    fetchBrandLocations(API_URL),
  ])

  // JSON-LD: Organization (servd) + WebSite (search-box) + one Restaurant
  // graph per brand. Carrying the brand Restaurant nodes on the home page
  // helps Karachi "restaurants near me" hits find each concept directly
  // from the operator entry point. Brand-location data flows live from
  // the Concept rows (admin-editable) with a hardcoded fallback so a fresh
  // database still renders a plausible schema.
  const schema = [
    organizationSchema({
      name:    'servd',
      url:     SERVD_ORIGIN,
      logoUrl: `${SERVD_ORIGIN}/icon.png`,
      sameAs:  ['https://instagram.com/simmer_down'],
    }),
    websiteSchema(),
    ...Object.values(brandLocations).map((loc) =>
      restaurantSchema({ loc, description: brandStory(loc.slug).tagline })
    ),
  ]

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      {/* /home?q=… (the sitelinks search box above) opens the search sheet. */}
      <HomeSearchParam />
      <div className="sv-home">
        <ManagedPage slug="servd:home" concepts={concepts} />
      </div>
    </>
  )
}
