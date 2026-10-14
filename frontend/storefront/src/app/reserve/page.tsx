// /reserve — top-level reservation landing.
// Lists brands that accept reservations (reservationsEnabled !== false)
// so a customer who lands here without a brand context can pick one.
//
// The page is content (SiteLayout `servd:reserve`, Admin → Storefront);
// nothing published → the default sections (header + the live brand picker).
// Its search title/description come from the page's own SEO settings in the
// editor, else from the live list of brands that take bookings.

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { conceptsOrFallback, fetchLiveConcepts, fitSentences } from '../../lib/liveConcepts'
import { ManagedPage } from '../../sections/ManagedPage'
import { PageSurface } from '../../sections/pageSurface'
import { bookableNames, takesReservations } from '../../sections/servd/reservable'

export const dynamic = 'force-dynamic'

const CANONICAL = `${SERVD_ORIGIN}/reserve`

export async function generateMetadata(): Promise<Metadata> {
  const [layout, live] = await Promise.all([fetchSiteLayout('servd:reserve'), fetchLiveConcepts()])
  const seo = pageSeo(layout)
  // The same kitchens, in the same words, as the picker's cards and the
  // header's {bookable} (sections/servd/reservable.ts) — dine-in brands that
  // take bookings, in a fixed order so the title never flips between
  // requests. With the API down it names the bundled brands that do.
  const reservable = conceptsOrFallback(live).filter(takesReservations)
  const list = bookableNames(reservable)
  return pageMetadata({
    title:       seo.title ?? (list ? `Reserve a table at ${list}, Karachi` : 'Reserve a table in Karachi'),
    description: seo.description ?? fitSentences([
      `Book a table at ${list || 'a servd kitchen'} in Karachi.`,
      reservable.length > 1
        ? 'Pick the kitchen, a date, your party size and a time, and get an SMS confirmation.'
        : 'Pick a date, your party size and a time, and get an SMS confirmation.',
    ]),
    canonical:   CANONICAL,
  })
}

export default async function ReservePage() {
  const live = await fetchLiveConcepts()
  const schema = breadcrumbSchema([
    { name: 'servd',   url: `${SERVD_ORIGIN}/` },
    { name: 'Reserve', url: CANONICAL },
  ])
  return (
    <PageSurface slug="servd:reserve">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      <ManagedPage slug="servd:reserve" {...(live.length > 0 && { concepts: live })} />
    </PageSurface>
  )
}
