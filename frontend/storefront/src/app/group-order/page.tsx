// /group-order — landing page for shared carts.
// Replaces the legacy dev-facing "type a brand slug" text input with a
// proper grid of live brand cards fetched from the API.
//
// Two modes: "Start" (pick a brand → start a shared cart) and "Join"
// (enter a 6-char code from someone else). After start, redirects to
// /group-order/<code>.

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { brandAccent, conceptHeroImage, formatBrandName } from '../../lib/concept'
import { conceptsOrFallback, fetchLiveConcepts, fitSentences, inBrandOrder, joinNames } from '../../lib/liveConcepts'
import { GroupOrderEntryClient } from './GroupOrderEntryClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  // Built from the live brand list, in a fixed order (inBrandOrder — the
  // API's row order moves when a brand is edited): 'Group order from
  // Simmer, Stackd & Flipd'.
  const names = inBrandOrder(conceptsOrFallback(await fetchLiveConcepts())).map((c) => formatBrandName(c.name))
  const list = names.length > 0 && names.length <= 3 ? joinNames(names) : ''
  return pageMetadata({
    title:       list ? `Group order from ${list}` : 'Group order in Karachi',
    description: fitSentences([
      'Start a shared cart, send the link, everyone adds their own — checkout once.',
      `Group orders from ${list || 'every servd kitchen'} in Karachi.`,
    ]),
    canonical:   `${SERVD_ORIGIN}/group-order`,
  })
}

export default async function GroupOrderEntryPage() {
  const concepts = await fetchLiveConcepts()
  // Pre-build the brand cards on the server so the client component
  // gets a small typed payload (id/name/slug/accent/image) instead of
  // re-fetching. The card art is the 640x480 card crop, not the full hero.
  const brandCards = concepts.map((c) => ({
    id: c.id,
    name: formatBrandName(c.name),
    slug: c.slug,
    accent: brandAccent(c.slug, c.primaryColor),
    heroImage: conceptHeroImage(c, 'card'),
  }))

  return <GroupOrderEntryClient brands={brandCards} />
}
