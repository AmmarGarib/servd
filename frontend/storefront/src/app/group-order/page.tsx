// /group-order — landing page for shared carts.
// Replaces the legacy dev-facing "type a brand slug" text input with a
// proper grid of live brand cards fetched from the API.
//
// Two modes: "Start" (pick a brand → start a shared cart) and "Join"
// (enter a 6-char code from someone else). After start, redirects to
// /group-order/<code>.

import Link from 'next/link'
import type { Concept } from '../../lib/concept'
import { brandAccent, conceptHeroImage, formatBrandName } from '../../lib/concept'
import { GroupOrderEntryClient } from './GroupOrderEntryClient'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Group order',
  description: 'Start a shared cart, send the link, everyone adds their own — checkout once.',
}

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

export default async function GroupOrderEntryPage() {
  const concepts = await getConcepts()
  // Pre-build the brand cards on the server so the client component
  // gets a small typed payload (id/name/slug/accent/image) instead of
  // re-fetching.
  const brandCards = concepts.map((c) => ({
    id: c.id,
    name: formatBrandName(c.name),
    slug: c.slug,
    accent: brandAccent(c.slug, c.primaryColor),
    heroImage: conceptHeroImage(c),
  }))

  return <GroupOrderEntryClient brands={brandCards} />
}
