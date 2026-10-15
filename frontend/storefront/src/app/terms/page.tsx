// /terms — terms of service (draft wording, to be approved).
//
// The page is content (SiteLayout `servd:terms`, Admin → Storefront); nothing
// published → the default sections from sections/legal. Its search title and
// description come from the page's SEO settings in the editor, else the
// defaults below.

import type { Metadata } from 'next'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'

const CANONICAL = `${SERVD_ORIGIN}/terms`

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const seo = pageSeo(await fetchSiteLayout('servd:terms'))
  return pageMetadata({
    // The root template adds ' · servd' — never put it in the title itself.
    title:       seo.title ?? 'Terms of service for ordering on servd in Karachi',
    description: seo.description ?? 'The terms for ordering, paying, delivery, refunds and table bookings with servd and the GS Foods kitchens in Karachi, Pakistan.',
    canonical:   CANONICAL,
  })
}

export default async function Page() {
  const crumbs = breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/` },
    { name: 'Terms of service', url: CANONICAL },
  ])
  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(crumbs) }} />
      <ManagedPage slug="servd:terms" />
    </div>
  )
}
