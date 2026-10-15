// /about — what servd is, answer first, and the kitchens on it.
//
// The page is content (SiteLayout `servd:about`, Admin → Storefront); nothing
// published → the default sections (servd.aboutIntro + how it works). The
// opening paragraph is marked up as speakable for voice answers.

import type { Metadata } from 'next'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'

const CANONICAL = `${SERVD_ORIGIN}/about`

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const seo = pageSeo(await fetchSiteLayout('servd:about'))
  return pageMetadata({
    // The root template adds ' · servd' — never put it in the title itself.
    title:       seo.title ?? 'What is servd? Karachi kitchens, one place to order',
    description: seo.description ?? 'servd is the online ordering platform of GS Foods in Karachi: Simmer, Stackd and Flipd, with menus in PKR, pickup, delivery and reservations.',
    canonical:   CANONICAL,
  })
}

export default async function AboutPage() {
  const crumbs = breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/` },
    { name: 'About', url: CANONICAL },
  ])
  const page = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    url: CANONICAL,
    name: 'About servd',
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['[data-speakable="about"]'] },
  }
  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript([crumbs, page]) }} />
      <ManagedPage slug="servd:about" />
    </div>
  )
}
