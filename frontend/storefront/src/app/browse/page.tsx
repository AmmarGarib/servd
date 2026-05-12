import { BrowseClient } from './BrowseClient'
import type { Concept } from '../../lib/concept'

export const dynamic = 'force-dynamic'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcepts(): Promise<Concept[]> {
  const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { next: { revalidate: 60 } })
  if (!res.ok) throw new Error(`Concepts API returned ${res.status}`)
  return res.json()
}

export const metadata = {
  title: 'All brands',
  description: 'Browse every kitchen on servd — Simmer, Stax, Flipd, Bukhari and more.',
}

export default async function BrowsePage() {
  const concepts = await getConcepts()
  return <BrowseClient concepts={concepts} />
}
