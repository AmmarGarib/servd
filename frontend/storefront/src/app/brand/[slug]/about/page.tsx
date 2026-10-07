// Brand About page — the SiteLayout `brand:<slug>:about`, edited in Admin →
// Storefront. Nothing published → the default sections (src/sections/brand:
// story hero, pillars, image break, call to action).

import { notFound } from 'next/navigation'
import type { Concept } from '../../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../../lib/fallbackBrands'
import { ManagedPage } from '../../../../sections/ManagedPage'

// force-dynamic + cache: 'no-store' so a single API outage at deploy
// time can't poison the ISR cache and return 404s for the lifetime of
// the container (see CLAUDE.md "Fetch caching gotcha").
export const dynamic = 'force-dynamic'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    return res.ok ? ((await res.json()) as Concept[]) : []
  } catch { return [] }
}

export default async function BrandAboutPage({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concepts = await getConcepts()
  if (!concepts.some((c) => c.slug === slug) && !FALLBACK_CONCEPTS[slug]) notFound()
  return <ManagedPage slug={`brand:${slug}:about`} {...(concepts.length ? { concepts } : {})} />
}
