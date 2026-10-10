// /<concept>/checkout — a per-visitor screen (the basket, the bill). Its own
// title, kept out of the index, and no canonical or og:url (it is not the
// ordering screen, and it is nobody's landing page).
//
// No slug gate here, on purpose: the 404 for non-brands lives in
// (menu)/layout.tsx, which wraps only the ordering screen. A customer with a
// basket must not hit a 404 because the API didn't answer or the brand was
// hidden mid-service.

import type { Metadata } from 'next'
import { formatBrandName } from '../../../lib/concept'
import { lookupConcept } from '../../../lib/liveConcepts'

type Params = { params: Promise<{ concept: string }> | { concept: string } }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { concept: slug } = await Promise.resolve(params as Promise<{ concept: string }>)
  // Only for the name (the fetch is memoised per request). Unknown, hidden,
  // or the API down → the generic title; the page still renders.
  const { concept } = await lookupConcept(slug)
  const title = concept ? `${formatBrandName(concept.name)} checkout` : 'Checkout'
  return {
    title,
    // Matches the X-Robots-Tag header next.config.js sends for checkout.
    robots:     { index: false, follow: false },
    alternates: { canonical: null },
    openGraph:  { type: 'website', siteName: 'servd', locale: 'en_PK', title: `${title} · servd` },
    twitter:    { card: 'summary_large_image', title: `${title} · servd` },
  }
}

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
