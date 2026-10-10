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
import { formatBrandName } from '../../lib/concept'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { conceptsOrFallback, fetchLiveConcepts, fitSentences, inBrandOrder, joinNames } from '../../lib/liveConcepts'
import { ManagedPage } from '../../sections/ManagedPage'

export const dynamic = 'force-dynamic'

const CANONICAL = `${SERVD_ORIGIN}/reserve`

export async function generateMetadata(): Promise<Metadata> {
  const [layout, live] = await Promise.all([fetchSiteLayout('servd:reserve'), fetchLiveConcepts()])
  const seo = pageSeo(layout)
  // Fixed order (inBrandOrder): the API's row order moves when a brand is
  // edited, and the title must not flip between requests.
  const names = inBrandOrder(conceptsOrFallback(live))
    .filter((c) => c.reservationsEnabled !== false)
    .map((c) => formatBrandName(c.name))
  const list = names.length > 0 && names.length <= 3 ? joinNames(names, 'or') : ''
  return pageMetadata({
    title:       seo.title ?? (list ? `Reserve a table at ${list}, Karachi` : 'Reserve a table in Karachi'),
    description: seo.description ?? fitSentences([
      `Book a table at ${list || 'a servd kitchen'} in Karachi.`,
      'Pick the brand, a date, your party size and a time, and get an SMS confirmation.',
    ]),
    canonical:   CANONICAL,
  })
}

export default async function ReservePage() {
  const live = await fetchLiveConcepts()
  const schema = breadcrumbSchema([
    { name: 'servd',   url: `${SERVD_ORIGIN}/home` },
    { name: 'Reserve', url: CANONICAL },
  ])
  return (
    <div className="surface-bg" style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      <ManagedPage slug="servd:reserve" {...(live.length > 0 && { concepts: live })} />
    </div>
  )
}
