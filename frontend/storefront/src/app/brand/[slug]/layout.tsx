// Per-brand microsite layout. Hides the global servd nav/footer and renders
// a brand-themed shell instead — so each brand reads like its own website
// while still living on the servd domain.
//
// Resilient against api hiccups: if the live concepts fetch fails (api
// warmup, network blip), fall through to a hardcoded fallback for the
// known live brands so customers don't get a 404 wall.

import { notFound } from 'next/navigation'
import { brandCanonical } from '../../../lib/brandDomains'
import { BrandShell } from '../../../components/brand/BrandShell'
import { brandAccent, formatBrandName, type Concept } from '../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../lib/fallbackBrands'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

async function getConcept(slug: string): Promise<Concept | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (res.ok) {
      const all: Concept[] = await res.json()
      const live = all.find((c) => c.slug === slug)
      if (live) return live
    }
  } catch { /* fall through to fallback */ }
  // Live fetch failed OR slug wasn't in the response — degrade to the
  // hardcoded fallback for known brands so the page still renders.
  return FALLBACK_CONCEPTS[slug] ?? null
}

export default async function BrandLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await getConcept(slug)
  if (!concept) notFound()

  const themed: Concept = { ...concept, primaryColor: brandAccent(concept.slug, concept.primaryColor) }
  return <BrandShell concept={themed}>{children}</BrandShell>
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await getConcept(slug)
  if (!concept) return { title: 'Not found' }
  // Route the name through formatBrandName — the browser tab, search results,
  // and link previews are user-visible surfaces, so they get the canonical
  // capitalised name whatever case the DB row holds.
  const displayName = formatBrandName(concept.name)
  return {
    title: displayName,
    description: concept.description ?? `Order from ${displayName} on servd.`,
    // The canonical is the brand's OWN domain. This page is reachable at both
    // servd.pk/brand/flipd and flipd.pk/, and without this Google picks one
    // itself — which defeats the reason each brand owns a domain at all.
    alternates: { canonical: brandCanonical(slug) },
  }
}
