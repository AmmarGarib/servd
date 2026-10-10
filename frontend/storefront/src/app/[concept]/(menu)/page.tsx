// Per-brand ordering page (/<concept>). A server component so the page's
// heading is in the server HTML: it resolves the brand and hands it to the
// client ordering screen (OrderingScreen.tsx), which paints the real hero —
// brand name as the h1, description, art — while the menu is still loading.
//
// lookupConcept is the same no-store GET /storefront/concepts the layout makes
// (Next memoises it within the request), so this costs no extra API call.
// 'missing' never reaches here — the layout 404s it. 'unverified' (the API
// didn't answer and the slug isn't a bundled brand) passes null, and the
// screen names the page from the slug until its own lookup.

import { lookupConcept } from '../../../lib/liveConcepts'
import OrderingScreen, { type OrderingConcept } from './OrderingScreen'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ concept: string }> | { concept: string } }

export default async function ConceptOrderPage({ params }: Params) {
  const { concept: slug } = await Promise.resolve(params as Promise<{ concept: string }>)
  const { status, concept } = await lookupConcept(slug)
  // Only the fields the hero needs, so the props stay small and serialisable
  // (the live record also carries hours, contacts and coordinates).
  const initialConcept: OrderingConcept | null = concept && {
    id:           concept.id,
    slug:         concept.slug,
    name:         concept.name,
    type:         concept.type,
    description:  concept.description ?? null,
    logoUrl:      concept.logoUrl ?? null,
    primaryColor: concept.primaryColor ?? null,
  }
  // Keyed on the slug so moving between brands starts a fresh screen.
  // 'fallback' is the bundled record (the server's lookup got no answer —
  // often the API's shared per-IP rate limit, which the browser's own request
  // doesn't share): the screen still asks for the live record.
  return <OrderingScreen key={slug} initialConcept={initialConcept} verified={status === 'live'} />
}
