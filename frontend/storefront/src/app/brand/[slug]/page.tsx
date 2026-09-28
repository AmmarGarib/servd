// Brand microsite home — mirrors the servd home pattern: read the live
// SiteLayout `brand:<slug>` and render it if one is published, otherwise
// render the rich BrandFallback (the bespoke per-brand layout). A `signature`
// block inside a live layout renders that same BrandFallback, so the owner can
// add elements above/below the built-in design.

import { notFound } from 'next/navigation'
import { brandAccent, brandStory, formatBrandName, type Concept } from '../../../lib/concept'
import { fetchSiteLayout } from '../../../lib/blocks'
import { SiteLayoutView } from '../../../components/blocks/SiteLayoutView'
import { BrandFallback } from '../../../components/brand/BrandFallback'
import ConceptViewTracker from '../../../components/ConceptViewTracker'
import { locationFromConcept } from '../../../lib/brandLocations'
import { SERVD_ORIGIN, brandCanonical } from '../../../lib/brandDomains'
import { restaurantSchema, breadcrumbSchema, jsonLdScript } from '../../../lib/jsonLd'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

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
    description: 'Gourmet smash and grilled burgers, built to a fixed spec. Same burger, every time.',
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

export default async function BrandHome({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)

  const [concepts, layout] = await Promise.all([
    getConcepts(),
    fetchSiteLayout(`brand:${slug}`),
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
    // Rooted at servd (the ordering system) then the brand on its own domain,
    // which is where the microsite actually lives.
    breadcrumbSchema([
      { name: 'servd', url: `${SERVD_ORIGIN}/` },
      { name: formatBrandName(concept.name), url: brandCanonical(slug) },
    ]),
  ]

  const signature = <BrandFallback concept={concept} concepts={concepts} />

  if (!layout?.blocks?.length) {
    return (
      <>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
        <ConceptViewTracker conceptId={concept.id} slug={slug} />
        {signature}
      </>
    )
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ConceptViewTracker conceptId={concept.id} slug={slug} />
      <SiteLayoutView
        layout={layout}
        context={{
          signature,
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
