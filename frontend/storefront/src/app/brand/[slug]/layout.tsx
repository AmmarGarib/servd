// Per-brand microsite layout. Hides the global servd nav/footer and renders
// a brand-themed shell instead — so each brand reads like its own website
// while still living on the servd domain.
//
// The header and footer are content-module pages (`brand:<slug>:header`,
// `brand:<slug>:footer`), edited in Admin → Storefront; nothing published →
// the default `brand.header` / `brand.footer` sections (src/sections/brand).
//
// Resilient against api hiccups: if the live concepts fetch fails (api
// warmup, network blip), fall through to a hardcoded fallback for the
// known live brands so customers don't get a 404 wall.

import { notFound } from 'next/navigation'
import { brandCanonical } from '../../../lib/brandDomains'
import { BrandShell } from '../../../components/brand/BrandShell'
import { brandAccent, formatBrandName, type Concept } from '../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../lib/fallbackBrands'
import { ManagedPage } from '../../../sections/ManagedPage'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (res.ok) return (await res.json()) as Concept[]
  } catch { /* fall through to fallback */ }
  return []
}

function findConcept(slug: string, live: Concept[]): Concept | null {
  // Live fetch failed OR slug wasn't in the response — degrade to the
  // hardcoded fallback for known brands so the page still renders.
  return live.find((c) => c.slug === slug) ?? FALLBACK_CONCEPTS[slug] ?? null
}

export default async function BrandLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const live = await getConcepts()
  const concept = findConcept(slug, live)
  if (!concept) notFound()

  const themed: Concept = { ...concept, primaryColor: brandAccent(concept.slug, concept.primaryColor) }
  // Hand ManagedPage the brands we already have (it falls back itself when
  // the list is empty).
  const known = live.length ? { concepts: live } : {}
  return (
    <BrandShell
      concept={themed}
      header={<ManagedPage slug={`brand:${slug}:header`} {...known} />}
      footer={<ManagedPage slug={`brand:${slug}:footer`} {...known} />}
    >
      {children}
    </BrandShell>
  )
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }> | { slug: string }
}) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = findConcept(slug, await getConcepts())
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
