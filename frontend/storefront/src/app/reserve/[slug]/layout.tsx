// Server shell for /reserve/<brand> (the booking widget is a client page).
// Gives the route what only the server can: a real 404 for a slug that is not
// a brand (it used to render a booking form for /reserve/anything), and its
// own title, description and canonical. The canonical is servd's, so the copy
// reached on a brand domain (simmer.pk/reserve/simmer) consolidates onto
// servd.pk/reserve/simmer.
//
// It 404s only when the API ANSWERED without the slug (not a brand, or one
// the owner hid / deactivated). When the API didn't answer (down, a 5xx, a
// 429 from its shared rate limit) the booking page renders as before and
// copes on its own — an outage must not turn a real brand into a 404.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SERVD_ORIGIN, pageMetadata } from '../../../lib/brandDomains'
import { filled, locationFromConcept } from '../../../lib/brandLocations'
import { formatBrandName } from '../../../lib/concept'
import { brandImageUrl } from '../../../lib/jsonLd'
import { TestCompanyStripe } from '../../../components/TestCompanyStripe'
import { asSentence, fitSentences, lookupConcept } from '../../../lib/liveConcepts'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }> }

export default async function ReserveBrandLayout({ children, params }: Params & { children: React.ReactNode }) {
  const { slug } = await params
  const { status, concept } = await lookupConcept(slug)
  if (status === 'missing') notFound()
  return <><TestCompanyStripe concept={concept} />{children}</>
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const { status, concept } = await lookupConcept(slug)
  if (status === 'missing') notFound()
  // The API didn't answer and this isn't a bundled brand: render (above), but
  // keep an unconfirmed path out of the index until the API can vouch for it.
  if (!concept) return { title: 'Book a table', robots: { index: false, follow: true } }

  const name = formatBrandName(concept.name)
  const loc = locationFromConcept(concept)
  const area = filled(loc.area)
  const city = filled(loc.city) || 'Karachi'
  // A brand that takes no bookings shows only "Reservations not available
  // right now" here — a thin page, so it stays out of the index.
  const takesBookings = concept.reservationsEnabled !== false
  return pageMetadata({
    title:       `Book a table at ${name}`,
    description: takesBookings
      ? fitSentences([
          `Book a table at ${name}${area ? ` on ${area}` : ''}, ${city}.`,
          asSentence(concept.description),
          'Pick a date, party size and time.',
        ])
      : fitSentences([
          `${name}${area ? ` on ${area}` : ''}, ${city}, isn’t taking table bookings online right now.`,
          asSentence(concept.description),
          'Order ahead, or walk in.',
        ]),
    canonical:   `${SERVD_ORIGIN}/reserve/${concept.slug}`,
    image:       brandImageUrl(concept.slug),
    noindex:     !takesBookings,
  })
}
