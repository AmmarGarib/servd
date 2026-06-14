'use client'
// Stax — brand microsite layout.
//
// Style direction (per CEO direction May 2026): industrial palette —
// light grey paper + deep purple ink, mono-spec sheets, factory-spec
// numbering. Think workshop documentation, not loud diner.
//
// No real menu data wired in yet — signature items render from the
// BRAND_STORIES highlights list and double as marketing modules until
// the menu API exposes per-brand items.

import Link from 'next/link'
import dynamic from 'next/dynamic'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory } from '../../../lib/concept'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Industrial spec-numbers — each section gets a `00 / SECTION` tag like
// a parts catalogue. Pure ornament, but it ties the visual language to
// the workshop reference.
const SPECS = ['00', '01', '02', '03', '04', '05'] as const

// Animated blueprint-grid background (WebGL2), fixed behind the WHOLE page so
// every panel sits on the moving blueprint. ssr:false — WebGL can't SSR;
// reduced-motion falls back to the static CSS grid on .stax-page.
const StaxGridBackground = dynamic(() => import('../../ui/StaxGridBackground'), { ssr: false })

export function StaxLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false

  // Classes (.stax-page, .stax-mono, .stax-spec, .stax-rule, .stax-line,
  // .stax-display, .stax-btn, .stax-btn-ghost, .stax-grid-bg,
  // .stax-visit-grid) live in globals.css.
  return (
    <div className="stax-page">
      {/* Page-wide moving blueprint — fixed behind every panel; content above.
          z-index 0 keeps it under the sticky nav (z-50). */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        <StaxGridBackground />
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}>
      {concept.announcementBanner && (
        <div role="status" style={{ background: 'var(--stax-blueprint-deep)', color: 'var(--stax-cream)', padding: '0.7rem 1.5rem', textAlign: 'center', fontFamily: 'var(--stax-mono)', fontSize: '0.78rem', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
          {concept.announcementBanner}
        </div>
      )}

      {/* ── HERO ─ Industrial header: spec tag, wordmark, spec line, sub. ── */}
      <section style={{ padding: 'clamp(4rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem) clamp(3rem, 6vh, 4rem)' }}>
        <div style={{ maxWidth: '76rem', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '2rem', flexWrap: 'wrap', marginBottom: '2rem' }}>
            <span className="stax-spec">{SPECS[0]} / KITCHEN — KARACHI</span>
            <span className="stax-spec" style={{ color: 'var(--stax-grey-60)' }}>SPEC SHEET · v.2026</span>
          </div>

          <h1 className="stax-display" style={{ fontSize: 'clamp(4.5rem, 14vw, 11rem)', margin: '0 0 1rem', color: 'var(--stax-grey-100)' }}>
            STAX<span style={{ color: 'var(--stax-cream)' }}>.</span>
          </h1>

          <hr className="stax-line" />

          <p className="stax-display" style={{ fontSize: 'clamp(1.4rem, 2.4vw, 2rem)', maxWidth: '36ch', margin: '2rem 0 0', fontWeight: 500, lineHeight: 1.2 }}>
            {story.tagline}
          </p>

          <p style={{ fontFamily: 'var(--stax-mono)', fontSize: '0.95rem', letterSpacing: '0.02em', maxWidth: '52ch', margin: '1.25rem 0 0', color: 'var(--stax-grey-80)' }}>
            {story.oneLiner}
          </p>

          <div style={{ marginTop: '3rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link href={`/${concept.slug}`} className="stax-btn">Order Stax →</Link>
            <Link href={`/brand/${concept.slug}/menu`} className="stax-btn stax-btn-ghost">View menu</Link>
          </div>
        </div>
      </section>

      <hr className="stax-rule" />

      {/* ── STATUS BOARD — "what's coming out of the kitchen right now."
            Industrial spec voice. Reads like a workshop board, not a
            promo. Operator can keep it static; the few-times-a-week
            update earns the eyeball that returning customers come
            looking for. */}
      <section style={{ padding: 'clamp(2.5rem, 6vh, 4rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '76rem', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '2rem', marginBottom: '1.25rem' }}>
            <span className="stax-spec">07 / STATUS · LIVE</span>
            <span className="stax-spec" style={{ color: 'var(--stax-grey-60)' }}>updated daily</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', border: '1px solid var(--stax-line)' }}>
            <div style={{ padding: '1.5rem 1.4rem', borderRight: '1px solid var(--stax-line)' }}>
              <p className="stax-spec" style={{ marginBottom: '0.5rem' }}>GRILL</p>
              <p className="stax-mono" style={{ fontSize: '0.95rem', margin: 0, color: 'var(--stax-grey-80)' }}>HOT · 240°C</p>
            </div>
            <div style={{ padding: '1.5rem 1.4rem', borderRight: '1px solid var(--stax-line)' }}>
              <p className="stax-spec" style={{ marginBottom: '0.5rem' }}>BUNS</p>
              <p className="stax-mono" style={{ fontSize: '0.95rem', margin: 0, color: 'var(--stax-grey-80)' }}>BAKED · IN-HOUSE</p>
            </div>
            <div style={{ padding: '1.5rem 1.4rem', borderRight: '1px solid var(--stax-line)' }}>
              <p className="stax-spec" style={{ marginBottom: '0.5rem' }}>PATTY</p>
              <p className="stax-mono" style={{ fontSize: '0.95rem', margin: 0, color: 'var(--stax-grey-80)' }}>DRY-AGED 28d</p>
            </div>
            <div style={{ padding: '1.5rem 1.4rem' }}>
              <p className="stax-spec" style={{ marginBottom: '0.5rem' }}>SAUCES</p>
              <p className="stax-mono" style={{ fontSize: '0.95rem', margin: 0, color: 'var(--stax-grey-80)' }}>HOUSE · DAILY</p>
            </div>
          </div>
        </div>
      </section>

      <hr className="stax-rule" />

      {/* ── SPEC SHEET — story.highlights as numbered specs, monospace ── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '76rem', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '2rem', marginBottom: '3rem' }}>
            <span className="stax-spec">{SPECS[1]}</span>
            <h2 className="stax-display" style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', margin: 0 }}>The brief.</h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0', border: '1px solid var(--stax-line)' }}>
            {story.highlights.map((h, i) => (
              <div key={h} style={{ padding: '1.75rem 1.5rem', borderRight: '1px solid var(--stax-line)', borderBottom: i < story.highlights.length - 1 ? '0' : '0', minHeight: '8rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <span className="stax-spec">{String(i + 1).padStart(2, '0')}</span>
                <p className="stax-mono" style={{ fontSize: '0.95rem', lineHeight: 1.5, margin: '1rem 0 0', fontWeight: 500 }}>
                  {h}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <hr className="stax-rule" />

      {/* ── LONG STORY — single column, sober ── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '46rem', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '2rem', marginBottom: '2rem' }}>
            <span className="stax-spec">{SPECS[2]}</span>
            <h2 className="stax-display" style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', margin: 0 }}>The kitchen.</h2>
          </div>
          <p className="stax-mono" style={{ fontSize: '1.1rem', lineHeight: 1.65, color: 'var(--stax-grey-80)' }}>
            {story.long}
          </p>
        </div>
      </section>

      <hr className="stax-rule" />

      {/* ── HOURS + LOCATION ── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '76rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }} className="stax-visit-grid">
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '2rem', marginBottom: '2rem' }}>
              <span className="stax-spec">{SPECS[3]}</span>
              <h2 className="stax-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: 0 }}>Hours.</h2>
            </div>
            <div style={{ marginBottom: '1.5rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
            <div className="stax-mono" style={{ fontSize: '0.95rem' }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hoursData={hoursData} />
              ) : (
                <p style={{ opacity: 0.6 }}>Hours not published yet.</p>
              )}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '2rem', marginBottom: '2rem' }}>
              <span className="stax-spec">{SPECS[4]}</span>
              <h2 className="stax-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: 0 }}>Where.</h2>
            </div>
            <p className="stax-display" style={{ fontSize: '1.3rem', lineHeight: 1.4, margin: '0 0 1rem', fontWeight: 500 }}>
              {concept.address ?? 'Karachi · address TBA'}
            </p>
            {concept.phone && (
              <p className="stax-mono" style={{ fontSize: '0.95rem', margin: 0 }}>
                <a href={`tel:${concept.phone.replace(/\s/g, '')}`} style={{ color: 'var(--stax-cream)', textDecoration: 'none', borderBottom: '1px solid currentColor' }}>
                  {concept.phone}
                </a>
              </p>
            )}
            {reservations && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={`/reserve/${concept.slug}`} className="stax-btn stax-btn-ghost">Reserve a table</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      <hr className="stax-rule" />

      {/* ── CROSS-BRAND STRIP — transparent so the blueprint shows through ── */}
      <div>
        <CrossBrandStrip
          current={concept}
          concepts={concepts}
          accent="var(--stax-cream)"
          kicker="ALSO FROM THE OPERATOR"
          heading="Other lines coming out of the same kitchen group."
        />
      </div>

      {/* ── CTA STRIP — transparent over the blueprint ── */}
      <section style={{ color: 'var(--stax-cream)', padding: 'clamp(4rem, 10vh, 7rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto', textAlign: 'center' }}>
          <span className="stax-spec" style={{ color: 'rgba(236,234,230,0.5)' }}>{SPECS[5]} · ORDER</span>
          <h2 className="stax-display" style={{ fontSize: 'clamp(2.2rem, 5vw, 4rem)', margin: '1rem 0 2rem' }}>
            Get it built<span style={{ color: 'var(--stax-cream)' }}>.</span>
          </h2>
          <Link href={`/${concept.slug}`} className="stax-btn" style={{ background: 'var(--stax-cream)', color: 'var(--stax-blueprint)' }}>
            Order from Stax →
          </Link>
        </div>
      </section>
      </div>
    </div>
  )
}
