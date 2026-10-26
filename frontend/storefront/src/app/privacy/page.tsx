// /privacy — privacy policy (draft wording, to be approved).
//
// The page is content (SiteLayout `servd:privacy`, Admin → Storefront); nothing
// published → the default sections from sections/legal. Its search title and
// description come from the page's SEO settings in the editor, else the
// defaults below.

import type { Metadata } from 'next'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'

const CANONICAL = `${SERVD_ORIGIN}/privacy`

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const seo = pageSeo(await fetchSiteLayout('servd:privacy'))
  return pageMetadata({
    // The root template adds ' · servd' — never put it in the title itself.
    title:       seo.title ?? 'Privacy policy: how servd handles your data in Karachi',
    description: seo.description ?? 'How servd and GS Foods in Karachi collect, use and protect your phone number, orders and cookies, and how to ask us about your data.',
    canonical:   CANONICAL,
    noindex:     true, // owner 2026-10-26 (S8): hidden from the website for now, page kept
  })
}

export default async function Page() {
  const crumbs = breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/` },
    { name: 'Privacy policy', url: CANONICAL },
  ])
  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(crumbs) }} />
      <ManagedPage slug="servd:privacy" />
    </div>
  )
}
