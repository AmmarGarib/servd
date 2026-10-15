// /faq — ordering, delivery, payment, Insiders, reservations and refunds.
//
// The page is content (SiteLayout `servd:faq`, Admin → Storefront); nothing
// published → the default sections (header + the draft FAQ). The FAQPage
// structured data is written by the servd.faq section itself, from the same
// fields it shows, so the markup can never describe text that isn't there.

import type { Metadata } from 'next'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'

const CANONICAL = `${SERVD_ORIGIN}/faq`

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const seo = pageSeo(await fetchSiteLayout('servd:faq'))
  return pageMetadata({
    title:       seo.title ?? 'FAQ: ordering, delivery, payment and rewards in Karachi',
    description: seo.description ?? 'How to order from servd in Karachi: delivery and pickup, paying with cash, card or Raast QR, Insiders rewards, table bookings and refunds.',
    canonical:   CANONICAL,
  })
}

export default async function FaqPage() {
  const crumbs = breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/` },
    { name: 'FAQ', url: CANONICAL },
  ])
  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(crumbs) }} />
      <ManagedPage slug="servd:faq" />
    </div>
  )
}
