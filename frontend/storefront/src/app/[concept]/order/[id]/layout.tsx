// /<concept>/order/<id> — one customer's live order tracker. Its own title,
// kept out of the index, and no canonical or og:url (it is not the ordering
// screen).
//
// No slug gate here, on purpose: the 404 for non-brands lives in
// (menu)/layout.tsx, which wraps only the ordering screen. An open tracker
// link must keep working when the API blinks or the owner hides the brand
// mid-service (the order APIs don't depend on the brand being listed).

import type { Metadata } from 'next'
import { formatBrandName } from '../../../../lib/concept'
import { lookupConcept } from '../../../../lib/liveConcepts'

type Params = { params: Promise<{ concept: string; id: string }> | { concept: string; id: string } }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { concept: slug } = await Promise.resolve(params as Promise<{ concept: string; id: string }>)
  // Only for the name (the fetch is memoised per request). Unknown, hidden,
  // or the API down → the generic title; the tracker still renders.
  const { concept } = await lookupConcept(slug)
  const title = concept ? `Your ${formatBrandName(concept.name)} order` : 'Your order'
  return {
    title,
    robots:     { index: false, follow: true },
    alternates: { canonical: null },
    openGraph:  { type: 'website', siteName: 'servd', locale: 'en_PK', title: `${title} · servd` },
    twitter:    { card: 'summary_large_image', title: `${title} · servd` },
  }
}

export default function OrderTrackerLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
