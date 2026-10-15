// /contact — contact page: details per kitchen and the form.
//
// The page is content (SiteLayout `servd:contact`, Admin → Storefront); nothing
// published → the default sections from sections/legal. Its search title and
// description come from the page's SEO settings in the editor, else the
// defaults below.

import type { Metadata } from 'next'
import { breadcrumbSchema, jsonLdScript, ORG_ID } from '../../lib/jsonLd'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'

const CANONICAL = `${SERVD_ORIGIN}/contact`

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const seo = pageSeo(await fetchSiteLayout('servd:contact'))
  return pageMetadata({
    // The root template adds ' · servd' — never put it in the title itself.
    title:       seo.title ?? 'Contact servd in Karachi: phone, WhatsApp, address',
    description: seo.description ?? 'Phone, WhatsApp, email and address for servd and each GS Foods kitchen in Karachi, plus a form for catering, press, jobs and order problems.',
    canonical:   CANONICAL,
  })
}

export default async function Page() {
  const crumbs = breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/` },
    { name: 'Contact', url: CANONICAL },
  ])
  const page = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: 'Contact servd',
    url: CANONICAL,
    about: { '@id': ORG_ID },
  }
  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(crumbs) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(page) }} />
      <ManagedPage slug="servd:contact" />
    </div>
  )
}
