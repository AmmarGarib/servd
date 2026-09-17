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

import Link from 'next/link'
import { fetchBrandLocations, whatsappLink, locationFor } from '../../lib/brandLocations'
import { breadcrumbSchema, jsonLdScript } from '../../lib/jsonLd'

import { SERVD_ORIGIN } from '../../lib/brandDomains'

const SITE = SERVD_ORIGIN
const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

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

  // Pick the brand to surface as the primary press WhatsApp — Simmer is the
  // press-friendliest of the three (premium, room-led, reservation-based).
  // Live-edited values win; fallback const used if API is unreachable.
  const brands = await fetchBrandLocations(API_URL)
  const pressContact = brands['simmer'] ?? locationFor('simmer')!

  return (
    <main style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />

      <section className="section" style={{ paddingTop: 'clamp(4rem, 9vw, 6rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)' }}>
        <div className="container">
          <p className="eyebrow eyebrow-accent">For press &amp; creators</p>
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem', letterSpacing: '-0.04em' }}>
            Writing about food<br />
            <span className="display-italic">in Karachi?</span>
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
            Three kitchens, one operator. Below is what&rsquo;s on offer, who to reach, and what we don&rsquo;t do.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>What&rsquo;s on offer</p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.65 }}>
              <li>Comp visits for verified creators with relevant audience</li>
              <li>Chef&rsquo;s-table previews of new menu drops at simmer</li>
              <li>First access to seasonal items and collab nights</li>
              <li>High-res food + room photography on request</li>
              <li>Background interviews with the chefs / operator</li>
            </ul>
          </div>
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>What we don&rsquo;t do</p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.65 }}>
              <li>Pay for posts framed as organic</li>
              <li>Trade comp meals for guaranteed five-star reviews</li>
              <li>Buy follower-count guarantees</li>
              <li>Brief on what to say — write honestly or skip it</li>
            </ul>
          </div>
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>Get in touch</p>
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.55, marginBottom: '1rem' }}>
              Message on WhatsApp with your handle, audience, and which brand you&rsquo;re curious about.
              We&rsquo;ll reply within two business days.
            </p>
            <a href={whatsappLink(pressContact, "hi servd — press inquiry. handle: @ / audience: / brand: ")}
              target="_blank" rel="noopener noreferrer"
              className="brand-pill"
              style={{ background: '#25D366', color: 'white' }}>
              Message us on WhatsApp →
            </a>
          </div>
        </div>
      </section>
    </main>
  )
}
