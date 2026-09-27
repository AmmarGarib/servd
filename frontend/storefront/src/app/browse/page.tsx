import { BrowseClient } from './BrowseClient'
import type { Concept } from '../../lib/concept'

export const dynamic = 'force-dynamic'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// An API blip must not take the whole page down. BrowseClient falls back to
// the three live kitchens on an empty list, same as the home page does, so
// the heading never reads "0 kitchens".
async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

export const metadata = {
  title: 'All brands',
  description: 'Browse every kitchen on servd — simmer, stackd, and Flipd.',
}

export default async function BrowsePage() {
  const concepts = await getConcepts()
  return <BrowseClient concepts={concepts} />
}
