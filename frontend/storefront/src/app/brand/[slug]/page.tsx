// Brand microsite home — mirrors the servd home pattern: fetch raw blocks
// from the SiteLayout API, render PageRenderer if the operator has saved any,
// otherwise render the rich BrandFallback (a per-brand mirror of HomeClient).
// We deliberately bypass `fetchLayout` here because that helper falls back to
// a 4-block minimal default; we want the *real* DB state, with BrandFallback
// as the only fallback so brand pages match the depth of the servd home.

import { notFound } from 'next/navigation'
import { brandAccent, type Concept } from '../../../lib/concept'
import type { Block } from '../../../lib/blocks'
import { PageRenderer } from '../../../components/blocks/PageRenderer'
import { BrandFallback } from '../../../components/brand/BrandFallback'
import ConceptViewTracker from '../../../components/ConceptViewTracker'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

interface LayoutResponse {
  slug: string
  blocks: Block[] | null
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
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

  if (blocks.length === 0) {
    return (
      <>
        <ConceptViewTracker conceptId={concept.id} slug={slug} />
        <BrandFallback concept={concept} concepts={concepts} />
      </>
    )
  }

  return (
    <>
      <ConceptViewTracker conceptId={concept.id} slug={slug} />
      <PageRenderer
        blocks={blocks}
        context={{
          conceptSlug: slug,
          brand: {
            name: concept.name,
            description: concept.description,
            primaryColor: concept.primaryColor,
            slug,
          },
        }}
      />
    </>
  )
}
