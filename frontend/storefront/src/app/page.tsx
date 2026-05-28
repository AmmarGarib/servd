// servd home page — content can be overridden via the SiteLayout CMS system
// (operator edits blocks at /content/servd:home), but if no blocks are saved
// the page renders the conversion-focused HomeClient marketing layout
// directly. We deliberately bypass `fetchLayout` here because that helper has
// its own internal fallback to a stale `defaultServdHomeLayout()`; we want
// the *real* DB state, with HomeClient as the only fallback.

import { PageRenderer } from '../components/blocks/PageRenderer'
import { HomeClient } from '../components/HomeClient'
import type { Block } from '../lib/blocks'
import type { Concept } from '../lib/concept'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

interface LayoutResponse {
  slug: string
  blocks: Block[] | null
}

async function getHomeBlocks(): Promise<Block[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/site-layouts/servd:home`, { cache: 'no-store' })
    if (!res.ok) return []
    const body = await res.json() as LayoutResponse
    return Array.isArray(body.blocks) ? body.blocks : []
  } catch { return [] }
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

export default async function HomePage() {
  const [blocks, concepts] = await Promise.all([
    getHomeBlocks(),
    getConcepts(),
  ])

  if (blocks.length === 0) {
    return <HomeClient concepts={concepts} />
  }

  return <PageRenderer blocks={blocks} />
}
