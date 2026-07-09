// Per-brand microsite layout. Hides the global servd nav/footer and renders
// a brand-themed shell instead — so each brand reads like its own website
// while still living on the servd domain.
//
// Resilient against api hiccups: if the live concepts fetch fails (api
// warmup, network blip), fall through to a hardcoded fallback for the
// known live brands so customers don't get a 404 wall.

import { notFound } from 'next/navigation'
import { BrandShell } from '../../../components/brand/BrandShell'
import { brandAccent, type Concept } from '../../../lib/concept'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

// Fallback concept records keyed on slug — only the slugs we know are
// live in production. Used when /storefront/concepts can't be reached
// (api 5xx, network blip, etc.) so the brand microsites keep working.
const FALLBACK_CONCEPTS: Record<string, Concept> = {
  stax: {
    id: 'fallback-stax', name: 'Stax', slug: 'stax', type: 'restaurant',
    description: 'Smash burgers, loaded fries, delivery-first ghost kitchen.',
    logoUrl: null, primaryColor: null,
    reservationsEnabled: false,
  },
  flipd: {
    id: 'fallback-flipd', name: 'Flipd', slug: 'flipd', type: 'restaurant',
    description: 'Buttermilk-brined fried chicken, made-to-order. No reheats.',
    logoUrl: null, primaryColor: null,
    reservationsEnabled: false,
  },
}

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
  return {
    title: concept.name,
    description: concept.description ?? `Order from ${concept.name} on servd.`,
  }
}
