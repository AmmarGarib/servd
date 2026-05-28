'use client'
// Flipd — brand microsite layout.
//
// Style direction (per CEO direction May 2026): cool palette — pale sky
// background, vibrant blue accent, deep navy ink. Diner energy without
// the heat. Big headlines, fat numbers, generous air.
//
// No real menu data wired in yet — signature items render from the
// BRAND_STORIES highlights and the brand-page CTA routes to the full
// menu at /brand/flipd/menu when that's ready.

import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory } from '../../../lib/concept'

interface Props {
  concept: Concept
  concepts: Concept[]
}

export function FlipdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false

  // Classes (.flipd-page, .flipd-display, .flipd-eyebrow, .flipd-btn,
  // .flipd-btn-ghost, .flipd-card, .flipd-visit-grid) live in globals.css.
  return (
    <div className="flipd-page">
      {concept.announcementBanner && (
        <div role="status" style={{ background: 'var(--flipd-ink)', color: 'var(--flipd-sky)', padding: '0.7rem 1.5rem', textAlign: 'center', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
          {concept.announcementBanner}
        </div>
      )}

      {/* ── HERO ─ Pale blue surface, big eyebrow + big headline + price-from-style hero number ── */}
      <section style={{ background: 'var(--flipd-pale)', padding: 'clamp(4rem, 12vh, 9rem) clamp(1.5rem, 5vw, 3rem) clamp(4rem, 8vh, 6rem)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ maxWidth: '72rem', margin: '0 auto', position: 'relative', zIndex: 2 }}>
          <p className="flipd-eyebrow" style={{ margin: 0 }}>Flipd · Karachi · Open kitchen</p>

          <h1 className="flipd-display" style={{ fontSize: 'clamp(4rem, 13vw, 10rem)', margin: '1.5rem 0 0', color: 'var(--flipd-ink)' }}>
            Cold air.<br />
            <span style={{ color: 'var(--flipd-sky-deep)' }}>Hot bird.</span>
          </h1>

          <p style={{ fontSize: 'clamp(1.1rem, 1.8vw, 1.4rem)', lineHeight: 1.5, color: 'rgba(14,26,42,0.75)', margin: '2rem 0 0', maxWidth: '36rem', fontWeight: 500 }}>
            {story.oneLiner}
          </p>

          <div style={{ marginTop: '2.5rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link href={`/${concept.slug}`} className="flipd-btn">Order Flipd →</Link>
            <Link href={`/brand/${concept.slug}/menu`} className="flipd-btn flipd-btn-ghost">See the menu</Link>
          </div>
        </div>

        {/* Decorative repeat-line band — pure ornament, fades behind hero on mobile via the negative inset. */}
        <div aria-hidden style={{
          position: 'absolute', right: '-4rem', bottom: '-4rem', width: '24rem', height: '24rem',
          background: 'repeating-linear-gradient(45deg, var(--flipd-sky) 0 2px, transparent 2px 14px)',
          opacity: 0.18, borderRadius: '50%', zIndex: 1, pointerEvents: 'none',
        }} />
      </section>

      {/* ── BIG NUMBERS / spec strip ── */}
      <section style={{ padding: 'clamp(3rem, 7vh, 5rem) clamp(1.5rem, 5vw, 3rem)', borderBottom: '1px solid rgba(14,26,42,0.08)' }}>
        <div style={{ maxWidth: '72rem', margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'clamp(1.5rem, 3vw, 2.5rem)' }}>
          <Spec value="24h" label="Buttermilk brine, every piece" />
          <Spec value="180°C" label="Fryer holds it, every piece" />
          <Spec value="0" label="Reheats. Made-to-order only" />
          <Spec value="100%" label="Hand-breaded. No machine." />
        </div>
      </section>

      {/* ── HIGHLIGHTS — story.highlights as feature cards ── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
          <p className="flipd-eyebrow" style={{ marginBottom: '1.25rem' }}>What we do</p>
          <h2 className="flipd-display" style={{ fontSize: 'clamp(2.2rem, 4.5vw, 3.5rem)', margin: '0 0 3rem', maxWidth: '20ch' }}>
            Chicken, done the long way.
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
            {story.highlights.map((h) => (
              <div key={h} className="flipd-card">
                <p style={{ fontFamily: "'Bricolage Grotesque', sans-serif", fontWeight: 800, fontSize: '1.25rem', lineHeight: 1.25, margin: 0, color: 'var(--flipd-ink)' }}>
                  {h}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── STORY ── */}
      <section style={{ background: 'var(--flipd-pale)', padding: 'clamp(4rem, 10vh, 7rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '48rem', margin: '0 auto' }}>
          <p className="flipd-eyebrow" style={{ marginBottom: '1.25rem' }}>The long way</p>
          <p style={{ fontSize: 'clamp(1.1rem, 1.8vw, 1.35rem)', lineHeight: 1.6, color: 'rgba(14,26,42,0.85)', margin: 0, fontWeight: 500 }}>
            {story.long}
          </p>
        </div>
      </section>

      {/* ── HOURS + LOCATION ── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '72rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }} className="flipd-visit-grid">

          <div>
            <p className="flipd-eyebrow" style={{ marginBottom: '1.25rem' }}>Hours</p>
            <div style={{ marginBottom: '1.5rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
            <div style={{ fontSize: '0.95rem' }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hoursData={hoursData} />
              ) : (
                <p style={{ opacity: 0.6 }}>Hours not published yet.</p>
              )}
            </div>
          </div>

          <div>
            <p className="flipd-eyebrow" style={{ marginBottom: '1.25rem' }}>Where</p>
            <p className="flipd-display" style={{ fontSize: '1.5rem', lineHeight: 1.3, fontWeight: 700, margin: '0 0 1rem' }}>
              {concept.address ?? 'Karachi · address TBA'}
            </p>
            {concept.phone && (
              <p style={{ fontSize: '1rem', margin: 0 }}>
                <a href={`tel:${concept.phone.replace(/\s/g, '')}`} style={{ color: 'var(--flipd-sky-deep)', textDecoration: 'none', borderBottom: '1.5px solid currentColor', fontWeight: 600 }}>
                  {concept.phone}
                </a>
              </p>
            )}
            {reservations && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={`/reserve/${concept.slug}`} className="flipd-btn flipd-btn-ghost">Reserve a table</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── CROSS-BRAND STRIP ── */}
      <CrossBrandStrip
        current={concept}
        concepts={concepts}
        accent="var(--flipd-sky-deep)"
        kicker="Also from the operator"
        heading="More from the same kitchen group."
      />

      {/* ── FINAL CTA ── */}
      <section style={{ background: 'var(--flipd-ink)', color: 'var(--flipd-cream)', padding: 'clamp(4rem, 10vh, 7rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto', textAlign: 'center' }}>
          <p className="flipd-eyebrow" style={{ color: 'var(--flipd-sky)', marginBottom: '1rem' }}>Hungry now?</p>
          <h2 className="flipd-display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', margin: '0 0 2rem' }}>
            Hot bird,<br /><span style={{ color: 'var(--flipd-sky)' }}>at your door.</span>
          </h2>
          <Link href={`/${concept.slug}`} className="flipd-btn">Order from Flipd →</Link>
        </div>
      </section>
    </div>
  )
}

function Spec({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <span className="flipd-display" style={{ fontSize: 'clamp(2.5rem, 5vw, 3.75rem)', color: 'var(--flipd-sky-deep)' }}>
        {value}
      </span>
      <span style={{ fontSize: '0.88rem', color: 'rgba(14,26,42,0.7)', lineHeight: 1.4, maxWidth: '14rem' }}>{label}</span>
    </div>
  )
}
