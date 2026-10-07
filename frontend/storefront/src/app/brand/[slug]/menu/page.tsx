// Brand menu page — the SiteLayout `brand:<slug>:menu`, edited in Admin →
// Storefront. Nothing published → the brand's default menu sections: the
// generic `brand.menu` (src/sections/brand), or a brand's own bespoke menu
// section where it registers one (e.g. `brand:simmer:menu`).

import { notFound } from 'next/navigation'
import type { Concept } from '../../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../../lib/fallbackBrands'
import { ManagedPage } from '../../../../sections/ManagedPage'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// Force-dynamic + no-store so a single bad fetch at first request
// doesn't get baked into the ISR cache for the next 60s.
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }> | { slug: string } }

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    return res.ok ? ((await res.json()) as Concept[]) : []
  } catch { return [] }
}

/** The brand (live, else the bundled fallback), or null for an unknown slug. */
function findConcept(slug: string, live: Concept[]): Concept | null {
  return live.find((c) => c.slug === slug) ?? FALLBACK_CONCEPTS[slug] ?? null
}

export default async function BrandMenuPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concepts = await getConcepts()
  if (!findConcept(slug, concepts)) notFound()
  return <ManagedPage slug={`brand:${slug}:menu`} {...(concepts.length ? { concepts } : {})} />
}
