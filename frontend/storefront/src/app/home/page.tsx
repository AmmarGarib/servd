// servd home page (/home — `/` and `/browse` redirect here) — content can be overridden from the storefront content
// module (SiteLayout `servd:home`, approved drafts only). When nothing is live
// the page renders the conversion-focused HomeClient marketing layout directly;
// when a layout is live, a `signature` block in it renders that same HomeClient
// so the owner can add elements above/below the built-in design.

import { SiteLayoutView } from '../../components/blocks/SiteLayoutView'
import { SERVD_ORIGIN } from '../../lib/brandDomains'
import { HomeClient } from '../../components/HomeClient'
import { fetchSiteLayout } from '../../lib/blocks'
import type { Concept } from '../../lib/concept'
import { fetchBrandLocations } from '../../lib/brandLocations'
import { organizationSchema, websiteSchema, restaurantSchema, jsonLdScript } from '../../lib/jsonLd'
import { brandStory } from '../../lib/concept'
import { parseHeroBlock } from '../../lib/heroConfig'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

export const metadata = {
  alternates: { canonical: '/home' },
}

// Operator-editable landing hero (background image + the expanding photo/video),
// stored as a `scrollHero` block under the SiteLayout slug `servd:hero`.
// Nothing live → defaults.
async function getHeroConfig() {
  const layout = await fetchSiteLayout('servd:hero')
  return parseHeroBlock(layout?.blocks)
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

export default async function HomePage() {
  const [layout, concepts, brandLocations, heroConfig] = await Promise.all([
    fetchSiteLayout('servd:home'),
    getConcepts(),
    fetchBrandLocations(API_URL),
    getHeroConfig(),
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

  const home = <HomeClient concepts={concepts} heroConfig={heroConfig} />

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      {layout?.blocks?.length
        ? <SiteLayoutView layout={layout} context={{ signature: home }} />
        : home}
    </>
  )
}
