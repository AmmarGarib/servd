// Helper for the storefront to fetch a SiteLayout from the API and fall back
// to the hard-coded default when no row exists in DB.

import type { Block } from './blocks'
import { defaultServdHomeLayout, defaultBrandLayout } from './blocks'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface LayoutResponse {
  slug: string
  title: string | null
  blocks: Block[] | null
  publishedAt: string | null
}

export async function fetchLayout(slug: string): Promise<Block[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/site-layouts/${encodeURIComponent(slug)}`, {
      next: { revalidate: 30 },
    })
    if (!res.ok) return fallback(slug)
    const body = await res.json() as LayoutResponse
    if (Array.isArray(body.blocks) && body.blocks.length > 0) return body.blocks
    return fallback(slug)
  } catch {
    return fallback(slug)
  }
}

function fallback(slug: string): Block[] {
  if (slug === 'servd:home') return defaultServdHomeLayout()
  if (slug.startsWith('brand:')) return defaultBrandLayout(slug.slice('brand:'.length))
  return []
}
