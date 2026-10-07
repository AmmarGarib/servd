// /waitlist — the shareable servd new-brand waitlist link (?src=<tag> for the
// channel). A live content-module page `page:waitlist` wins (a `signature`
// block in it renders the built-in design below); otherwise the built-in
// design renders directly. Either way one anonymous visit is counted.

import type { Metadata } from 'next'
import { fetchSiteLayout } from '../../lib/blocks'
import { SiteLayoutView } from '../../components/blocks/SiteLayoutView'
import { WaitlistForm } from '../../components/waitlist/WaitlistForm'
import { VisitBeacon } from './VisitBeacon'

export const dynamic = 'force-dynamic'

const DESCRIPTION = 'Join the servd waitlist and be first to hear, on WhatsApp, when servd opens a new brand.'

export async function generateMetadata(): Promise<Metadata> {
  const layout = await fetchSiteLayout('page:waitlist')
  return {
    title: layout?.blocks?.length && layout.title ? layout.title : 'Be first in line',
    description: DESCRIPTION,
    openGraph: { title: 'Be first in line · servd', description: DESCRIPTION },
  }
}

export default async function WaitlistPage() {
  // fetchSiteLayout reads with cache: 'no-store' (CLAUDE.md fetch-caching gotcha).
  const layout = await fetchSiteLayout('page:waitlist')
  const builtIn = <WaitlistBuiltIn />
  return (
    <>
      <VisitBeacon />
      {layout?.blocks?.length
        ? <SiteLayoutView layout={layout} context={{ signature: builtIn }} />
        : builtIn}
    </>
  )
}

const POINTS = [
  'One message when a new brand opens. No spam.',
  'Your number is confirmed with a WhatsApp code.',
  'Opt out any time.',
]

function WaitlistBuiltIn() {
  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>
      <div
        className="container grid items-center gap-10 md:grid-cols-2"
        style={{ paddingTop: 'clamp(3rem, 8vw, 6rem)', paddingBottom: 'clamp(3rem, 8vw, 6rem)' }}
      >
        <div>
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 800, fontSize: '0.8rem', letterSpacing: '0.14em', textTransform: 'uppercase', margin: '0 0 1rem' }}>
            The servd waitlist
          </p>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 'clamp(2.6rem, 9vw, 4.75rem)', letterSpacing: '-0.04em', lineHeight: 0.95, margin: '0 0 1.25rem' }}>
            Be first in line.
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: 'clamp(1rem, 2.4vw, 1.15rem)', lineHeight: 1.55, maxWidth: '32rem', margin: '0 0 1.75rem' }}>
            servd keeps opening new kitchens in Karachi. Leave your number and we will tell you the day the next one opens, before anyone else hears about it.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
            {POINTS.map((p) => (
              <li key={p} style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', fontWeight: 600 }}>
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }}>
                  <circle cx="10" cy="10" r="10" fill="var(--servd-green)" />
                  <path d="M5.5 10.5l3 3 6-6.5" fill="none" stroke="var(--servd-on-green)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <WaitlistForm title="Join the list." subtitle="It takes a minute. We only ask for what we need to reach you." />
      </div>
    </div>
  )
}
