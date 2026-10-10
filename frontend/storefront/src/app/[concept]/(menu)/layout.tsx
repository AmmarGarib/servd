// Server shell for the per-brand ordering screen (/<concept>). The page
// (page.tsx → the client OrderingScreen) renders the hero; this layout is
// where the route gets the rest of what only the server can give it:
//
//   • a real 404 for anything that is not a brand. [concept] is a one-segment
//     catch-all, so every typo (/nope, /Stackd, /favicon.ico before the icon
//     files existed) used to answer 200 with an indexable ordering shell.
//     It 404s only when the API ANSWERED without the slug (not a brand, or one
//     the owner hid / deactivated). When the API didn't answer (down, a 5xx, a
//     429 from its shared rate limit) the page renders as before and copes on
//     its own — an outage must not turn a real brand into a 404.
//   • its own title, description and canonical. The canonical is servd's
//     (`${SERVD_ORIGIN}/<slug>`), so the copy reached on a brand domain
//     (stackd.pk/stackd) consolidates onto servd.pk/stackd.
//
// It sits in the (menu) route group so it wraps ONLY the ordering screen:
// checkout/ and order/[id]/ are siblings with their own layouts (noindex, no
// canonical) and no slug gate, so a customer mid-checkout or tracking an order
// never gets a 404 because the API blinked or the brand was hidden mid-service.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SERVD_ORIGIN, pageMetadata } from '../../../lib/brandDomains'
import { filled, locationFromConcept } from '../../../lib/brandLocations'
import { formatBrandName } from '../../../lib/concept'
import { brandImageUrl } from '../../../lib/jsonLd'
import { asSentence, fitSentences, lookupConcept } from '../../../lib/liveConcepts'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ concept: string }> | { concept: string } }

export default async function ConceptMenuLayout({ children, params }: Params & { children: React.ReactNode }) {
  const { concept: slug } = await Promise.resolve(params as Promise<{ concept: string }>)
  if ((await lookupConcept(slug)).status === 'missing') notFound()
  return <>{children}</>
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { concept: slug } = await Promise.resolve(params as Promise<{ concept: string }>)
  const { status, concept } = await lookupConcept(slug)
  if (status === 'missing') notFound()
  // The API didn't answer and this isn't a bundled brand: render (above), but
  // keep an unconfirmed path out of the index until the API can vouch for it.
  if (!concept) return { title: 'Order online', robots: { index: false, follow: true } }

  const name = formatBrandName(concept.name)
  const loc = locationFromConcept(concept)
  const city = filled(loc.city) || 'Karachi'
  // 'DHA Phase 6, Karachi' — the district (last part of the area) keeps the
  // lead sentence short enough to leave room for the brand's description.
  // (An area typed as '…, Karachi' would otherwise read 'Karachi, Karachi'.)
  const district = filled(loc.area).split(',').map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== city.toLowerCase()).slice(-1)[0] ?? ''
  const place = [district, city].filter(Boolean).join(', ')
  return pageMetadata({
    // Distinct from the microsite's own title ('Stackd' on stackd.pk): this
    // is the ordering screen. The city is the brand's own, as in the
    // description.
    title:       `Order ${name} online in ${city}`,
    // Live data: the brand's own description (admin → Marketing → Brands)
    // and its kitchen's area.
    description: fitSentences([
      `Order ${name} online from ${place}.`,
      asSentence(concept.description),
      'Check out once on servd.',
    ]),
    canonical:   `${SERVD_ORIGIN}/${concept.slug}`,
    image:       brandImageUrl(concept.slug),
  })
}
