// servd home page — content can be overridden via the SiteLayout CMS system
// (operator edits blocks at /content/servd:home), but if no blocks are saved
// the page renders the conversion-focused HomeClient marketing layout
// directly. We deliberately bypass `fetchLayout` here because that helper has
// its own internal fallback to a stale `defaultServdHomeLayout()`; we want
// the *real* DB state, with HomeClient as the only fallback.

import { PageRenderer } from '../components/blocks/PageRenderer'
import { SERVD_ORIGIN } from '../lib/brandDomains'
import { HomeClient } from '../components/HomeClient'
import type { Block } from '../lib/blocks'
import type { Concept } from '../lib/concept'
import { fetchBrandLocations } from '../lib/brandLocations'
import { organizationSchema, websiteSchema, restaurantSchema, jsonLdScript } from '../lib/jsonLd'
import { brandStory } from '../lib/concept'
import { parseHeroBlock } from '../lib/heroConfig'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

interface LayoutResponse {
  slug: string
  blocks: Block[] | null
}

async function getHomeBlocks(): Promise<Block[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/site-layouts/servd:home`, { cache: 'no-store' })
    if (!res.ok) return []
    const body = await res.json() as LayoutResponse
    return Array.isArray(body.blocks) ? body.blocks : []
  } catch { return [] }
}

// Operator-editable landing hero (background image + the expanding photo/video),
// stored as a `scrollHero` block under the SiteLayout slug `servd:hero` and
// edited in Admin → Marketing → Landing Hero. Empty → food placeholders.
async function getHeroConfig() {
  try {
    const res = await fetch(`${API_URL}/api/v1/site-layouts/servd:hero`, { cache: 'no-store' })
    if (!res.ok) return parseHeroBlock(null)
    const body = await res.json() as LayoutResponse
    return parseHeroBlock(body.blocks)
  } catch { return parseHeroBlock(null) }
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

export default async function HomePage() {
  const [blocks, concepts, brandLocations, heroConfig] = await Promise.all([
    getHomeBlocks(),
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

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      {blocks.length === 0 ? <HomeClient concepts={concepts} heroConfig={heroConfig} /> : <PageRenderer blocks={blocks} />}
    </>
  )
}
