// /reserve — top-level reservation landing.
// Lists brands that accept reservations (reservationsEnabled !== false)
// so a customer who lands here without a brand context can pick one.
//
// Server component, on-system tokens, no fake content.

import Link from 'next/link'
import type { Concept } from '../../lib/concept'
import { conceptHeroImage, brandStory, brandAccent } from '../../lib/concept'
import { OpenNowPill } from '../../components/brand/parts/OpenNowPill'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Reserve a table',
  description: 'Book a table at a servd brand — Simmer, and any other kitchen that takes reservations.',
}

async function getReservableConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    if (!res.ok) return []
    const all: Concept[] = await res.json()
    return all.filter((c) => c.reservationsEnabled !== false && c.type === 'restaurant')
  } catch { return [] }
}

export default async function ReservePage() {
  const concepts = await getReservableConcepts()

  return (
    <main className="surface-bg" style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <section className="section" style={{ paddingTop: 'clamp(4rem, 9vw, 6rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)' }}>
        <div className="container">
          <p className="eyebrow eyebrow-accent">Reservations</p>
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem' }}>
            Book a table.<br />
            <span className="display-italic">Pick the kitchen.</span>
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
            These brands hold the room for you — pick one to choose your party size and time.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
        <div className="container">
          {concepts.length === 0 ? (
            <div className="servd-card" style={{ padding: '2.5rem 1.5rem', textAlign: 'center' }}>
              <p style={{ color: 'var(--servd-mute)' }}>No brands are accepting reservations right now.</p>
              <Link href="/browse" className="brand-pill" style={{ marginTop: '1.25rem', background: 'var(--servd-green)', color: 'white' }}>
                Browse all kitchens
              </Link>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
              {concepts.map((c) => {
                const story = brandStory(c.slug)
                const accent = brandAccent(c.slug, c.primaryColor)
                return (
                  <Link
                    key={c.id}
                    href={`/reserve/${c.slug}`}
                    aria-label={`Book a table at ${c.name}`}
                    className="servd-card"
                    style={{
                      textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column',
                      ['--brand-accent' as string]: accent,
                    }}>
                    <div style={{
                      aspectRatio: '4/3',
                      background: `${accent} url(${conceptHeroImage(c)}) center/cover`,
                      position: 'relative',
                    }}>
                      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.55) 100%)' }} />
                      <div style={{ position: 'absolute', top: '0.85rem', left: '0.85rem' }}>
                        <OpenNowPill slug={c.slug} fallback="Dine-in" />
                      </div>
                    </div>
                    <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
                        {c.name}
                      </h2>
                      <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', lineHeight: 1.45 }}>
                        {story.oneLiner}
                      </p>
                      <span style={{ marginTop: '0.6rem', fontSize: '0.85rem', fontWeight: 800, color: accent }}>
                        Book at {c.name} →
                      </span>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}
