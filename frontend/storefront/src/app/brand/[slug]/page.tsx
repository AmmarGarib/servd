// Brand microsite home — the SiteLayout `brand:<slug>`, edited in Admin →
// Storefront. Nothing published → the brand's default sections (its bespoke
// design with today's content, from src/sections/<brand>).

import { notFound } from 'next/navigation'
import { brandAccent, brandStory, formatBrandName, type Concept } from '../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../lib/fallbackBrands'
import { ManagedPage } from '../../../sections/ManagedPage'
import ConceptViewTracker from '../../../components/ConceptViewTracker'
import { locationFromConcept } from '../../../lib/brandLocations'
import { SERVD_ORIGIN, brandCanonical } from '../../../lib/brandDomains'
import { restaurantSchema, breadcrumbSchema, jsonLdScript } from '../../../lib/jsonLd'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

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

  const concepts = await getConcepts()

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

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ConceptViewTracker conceptId={concept.id} slug={slug} />
      <ManagedPage slug={`brand:${slug}`} concepts={concepts} />
    </>
  )
}
