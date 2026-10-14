// /waitlist — the shareable servd new-brand waitlist link (?src=<tag> for the
// channel). The page is content (SiteLayout `servd:waitlist`, Admin →
// Storefront); nothing published → the default sections (the pitch beside the
// form). Either way one anonymous visit is counted.
//
// Every ?src= variant canonicalises to the bare /waitlist on servd.pk.

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { ManagedPage } from '../../sections/ManagedPage'
import { VisitBeacon } from './VisitBeacon'

export const dynamic = 'force-dynamic'

const CANONICAL = `${SERVD_ORIGIN}/waitlist`
const DESCRIPTION = 'Join the servd waitlist and be first to hear, on WhatsApp, when servd opens a new brand.'

export async function generateMetadata(): Promise<Metadata> {
  const layout = await fetchSiteLayout('servd:waitlist')
  const seo = pageSeo(layout)
  // The page's SEO title first, then its editor title (only once published),
  // then the default. The root template adds ' · servd'.
  const title = seo.title
    ?? (layout?.blocks?.length && layout.title ? layout.title : 'Join the waitlist for new Karachi kitchens')
  // pageMetadata sets og/twitter with the share image — a bare openGraph
  // object here would drop the image, type and site name.
  return pageMetadata({
    title,
    description: seo.description ?? DESCRIPTION,
    canonical:   CANONICAL,
  })
}

export default async function WaitlistPage() {
  const schema = breadcrumbSchema([
    { name: 'servd',    url: `${SERVD_ORIGIN}/` },
    { name: 'Waitlist', url: CANONICAL },
  ])
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      <VisitBeacon />
      <ManagedPage slug="servd:waitlist" />
    </>
  )
}
