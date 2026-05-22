// Per-brand microsite layout. Hides the global servd nav/footer and renders
// a brand-themed shell instead — so each brand reads like its own website
// while still living on the servd domain.

import { notFound } from 'next/navigation'
import { BrandShell } from '../../../components/brand/BrandShell'
import type { Concept } from '../../../lib/concept'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcept(slug: string): Promise<Concept | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const all: Concept[] = await res.json()
    return all.find((c) => c.slug === slug) ?? null
  } catch { return null }
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

  return <BrandShell concept={concept}>{children}</BrandShell>
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
