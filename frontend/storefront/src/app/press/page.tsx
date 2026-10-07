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
// published → the default sections (header + the three cards).

import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'
import { SERVD_ORIGIN } from '../../lib/brandDomains'
import { ManagedPage } from '../../sections/ManagedPage'

const SITE = SERVD_ORIGIN

export const dynamic = 'force-dynamic'

export const metadata = {
  title:       'Press & creators · servd',
  description: 'For Karachi food bloggers, journalists, and creators: how to visit, who to contact, what we offer.',
  alternates:  { canonical: `${SITE}/press` },
}

export default async function PressPage() {
  const schema = breadcrumbSchema([
    { name: 'servd', url: `${SITE}/` },
    { name: 'Press', url: `${SITE}/press` },
  ])

  return (
    <main style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      <ManagedPage slug="servd:press" />
    </main>
  )
}
