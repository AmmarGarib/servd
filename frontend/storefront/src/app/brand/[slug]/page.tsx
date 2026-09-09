// Brand microsite home — mirrors the servd home pattern: fetch raw blocks
// from the SiteLayout API, render PageRenderer if the operator has saved any,
// otherwise render the rich BrandFallback (a per-brand mirror of HomeClient).
// We deliberately bypass `fetchLayout` here because that helper falls back to
// a 4-block minimal default; we want the *real* DB state, with BrandFallback
// as the only fallback so brand pages match the depth of the servd home.

import { notFound } from 'next/navigation'
import { brandAccent, brandStory, formatBrandName, type Concept } from '../../../lib/concept'
import type { Block } from '../../../lib/blocks'
import { PageRenderer } from '../../../components/blocks/PageRenderer'
import { BrandFallback } from '../../../components/brand/BrandFallback'
import ConceptViewTracker from '../../../components/ConceptViewTracker'
import { locationFromConcept } from '../../../lib/brandLocations'
import { restaurantSchema, breadcrumbSchema, jsonLdScript } from '../../../lib/jsonLd'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

interface LayoutResponse {
  slug: string
  blocks: Block[] | null
}

// Same fallback record set as brand/[slug]/layout.tsx — keeps the
// microsites usable when the live /storefront/concepts can't be
// reached (api warmup / network blip).
const FALLBACK_CONCEPTS: Record<string, Concept> = {
  simmer: {
    id: 'fallback-simmer', name: 'simmer', slug: 'simmer', type: 'restaurant',
    description: 'Small plates and mocktails. A dark room on Ittehad, served softly.',
    logoUrl: null, primaryColor: null, reservationsEnabled: true,
  },
  stackd: {
    id: 'fallback-stackd', name: 'stackd', slug: 'stackd', type: 'restaurant',
    description: 'Scratch-cooking café and small market — sandwiches, pastries, light bites and craft mocktails.',
    logoUrl: null, primaryColor: null, reservationsEnabled: false,
  },
  flipd: {
    id: 'fallback-flipd', name: 'Flipd', slug: 'flipd', type: 'restaurant',
    description: 'Buttermilk-brined fried chicken, made-to-order. No reheats.',
    logoUrl: null, primaryColor: null, reservationsEnabled: false,
  },
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (res.ok) {
      const live: Concept[] = await res.json()
      if (live.length > 0) return live
    }
    // res.ok was false (api 4xx/5xx) — fall through to fallback below
  } catch { /* api unreachable — fall through */ }
  // API empty/down → return the hardcoded fallback set so the
  // brand-page render still finds the slug and never notFound()s.
  return Object.values(FALLBACK_CONCEPTS)
}

async function getBrandBlocks(slug: string): Promise<Block[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/site-layouts/brand:${encodeURIComponent(slug)}`, { cache: 'no-store' })
    if (!res.ok) return []
    const body = await res.json() as LayoutResponse
    return Array.isArray(body.blocks) ? body.blocks : []
  } catch { return [] }
}

export default async function BrandHome({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)

  const [concepts, blocks] = await Promise.all([
    getConcepts(),
    getBrandBlocks(slug),
  ])

  const found = concepts.find((c) => c.slug === slug) ?? null
  if (!found) notFound()
  const concept: Concept = { ...found, primaryColor: brandAccent(found.slug, found.primaryColor) }

  // JSON-LD: Restaurant + breadcrumb. Drives Google rich results (rating
  // stars, Knowledge Panel, Maps prominence) and AI search citations.
  // BrandLocation is built from the live Concept row (admin-edited NAP)
  // merged over the hardcoded fallback, so a partially-filled concept
  // still renders a sensible schema.
  const loc = locationFromConcept(concept)
  const ld = [
    restaurantSchema({
      loc,
      description: concept.description ?? brandStory(slug).tagline,
      hours:       concept.serviceHours ?? undefined,
    }),
    breadcrumbSchema([
      { name: 'servd',      url: 'https://servd-app.garibsons.app/' },
      { name: formatBrandName(concept.name), url: `https://servd-app.garibsons.app/brand/${slug}` },
    ]),
  ]

  if (blocks.length === 0) {
    return (
      <>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
        <ConceptViewTracker conceptId={concept.id} slug={slug} />
        <BrandFallback concept={concept} concepts={concepts} />
      </>
    )
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ConceptViewTracker conceptId={concept.id} slug={slug} />
      <PageRenderer
        blocks={blocks}
        context={{
          conceptSlug: slug,
          brand: {
            name: formatBrandName(concept.name),
            description: concept.description,
            primaryColor: concept.primaryColor,
            slug,
          },
        }}
      />
    </>
  )
}
