// /press — landing for food bloggers, food journalists, and Instagram creators.
//
// Per the food-influencers + referrals skills in the marketing bundle: food
// bloggers are a primary acquisition channel in Karachi F&B (not a nice-to-
// have). The site needed a capture surface for them — somewhere a creator
// can land, see who to contact, what's available (comp visit, chef table,
// menu drop preview), and what's not (paid follow farming, fake-reviews).
//
// Operational voice: direct, plain, no marketing puffery. The audience here
// is professional creators — they read through hype instantly.
//
// The page is content (SiteLayout `servd:press`, Admin → Storefront); nothing
// published → the default sections (header + the three cards). Its search
// title/description come from the page's own SEO settings in the editor, else
// the defaults below.

import type { Metadata } from 'next'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'

const CANONICAL = `${SERVD_ORIGIN}/press`

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const seo = pageSeo(await fetchSiteLayout('servd:press'))
  return pageMetadata({
    // The root template adds ' · servd' — never put it in the title itself.
    title:       seo.title ?? 'Press & creators — Karachi food writers',
    description: seo.description ?? 'For Karachi food bloggers, journalists, and creators: how to visit, who to contact, what we offer.',
    canonical:   CANONICAL,
  })
}

export default async function PressPage() {
  const schema = breadcrumbSchema([
    { name: 'servd', url: `${SERVD_ORIGIN}/home` },
    { name: 'Press', url: CANONICAL },
  ])

  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      <ManagedPage slug="servd:press" />
    </div>
  )
}
