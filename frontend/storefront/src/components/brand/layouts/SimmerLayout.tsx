'use client'
// simmer — brand microsite layout.
// Built strictly to the simmer-brand SKILL.md (canonical source of truth):
//   • Night mode (forest green surface, bone ink)
//   • Amarante for display, Times for body/utility
//   • lowercase wordmark `simmer`, tagline `simmer down.` (below, never above)
//   • single orange signal per viewport, no decorative repetition
//   • no white, no gradients, no emojis, no exclamation marks
//   • no banned words: elevated, curated, experience, journey, passionate,
//     crafted, artisanal, fusion, twist on a classic
//
// Menu items are intentionally absent from this surface — the dedicated
// /brand/simmer/menu route renders the full menu in the locked format.
// This page leads with brand identity and routes to menu / reserve / order.

import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Today's date in the menu's signature `26.05.26` format — same rhythm
// the printed menu uses at the top right. Tracked-out Times below the
// wordmark, never above.
function todayStamp(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${dd}.${mm}.${yy}`
}

const STAMP = todayStamp()

export function SimmerLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const reservations = concept.reservationsEnabled !== false

  return (
    <div className="simmer-page">
      <style jsx>{`
        .simmer-page {
          background: var(--simmer-green);
          color: var(--simmer-bone);
          font-family: var(--simmer-body);
          letter-spacing: 0.04em;
        }
        .simmer-page :global(.amarante)  { font-family: var(--simmer-display); letter-spacing: 0.02em; }
        .simmer-page :global(.utility)   { font-family: var(--simmer-body); letter-spacing: 0.28em; text-transform: lowercase; }
        .simmer-page :global(.signal)    { color: var(--simmer-orange); }
        .simmer-page :global(.rule)      { height: 1px; background: rgba(237,230,211,0.2); border: 0; margin: 0; }
        .simmer-page :global(.wordmark)  { font-family: var(--simmer-display); font-weight: 400; line-height: 1; }
        .simmer-page :global(.action) {
          display: inline-block;
          font-family: var(--simmer-body);
          letter-spacing: 0.28em;
          text-transform: lowercase;
          padding: 0.95rem 1.6rem;
          border: 1px solid var(--simmer-bone);
          color: var(--simmer-bone);
          background: transparent;
          text-decoration: none;
          font-size: 0.78rem;
          transition: background 180ms ease, color 180ms ease;
        }
        .simmer-page :global(.action:hover) {
          background: var(--simmer-bone);
          color: var(--simmer-green);
        }
        .simmer-page :global(.action--signal) {
          border-color: var(--simmer-orange);
          color: var(--simmer-orange);
        }
        .simmer-page :global(.action--signal:hover) {
          background: var(--simmer-orange);
          color: var(--simmer-green);
        }
      `}</style>

      {/* ── Announcement strip (only when operator has filled the field) ───────
          Per the brand bible: operational copy stays plain and clear. */}
      {concept.announcementBanner && (
        <div
          role="status"
          style={{
            background: 'var(--simmer-black)',
            color: 'var(--simmer-bone)',
            padding: '0.7rem 1.5rem',
            textAlign: 'center',
            fontFamily: 'var(--simmer-body)',
            fontSize: '0.78rem',
            letterSpacing: '0.22em',
            textTransform: 'lowercase',
          }}
        >
          {concept.announcementBanner}
        </div>
      )}

      {/* ── HERO ─────────────────────────────────────────────────────────────
          The wordmark is the hero. Single orange signal sits as the date
          stamp to its right. Tagline below — never above. */}
      <section style={{ padding: 'clamp(5rem, 14vh, 9rem) clamp(1.5rem, 5vw, 3rem) clamp(3rem, 6vh, 4rem)' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '2rem', flexWrap: 'wrap' }}>
            <h1 className="wordmark" style={{ fontSize: 'clamp(5rem, 18vw, 12rem)', margin: 0 }}>simmer</h1>
            <p className="utility signal" style={{ fontSize: '0.78rem', margin: '1.5rem 0 0', whiteSpace: 'nowrap' }}>
              {STAMP}
            </p>
          </div>

          <p className="amarante" style={{ fontSize: 'clamp(1.5rem, 2.4vw, 2rem)', lineHeight: 1.25, margin: '2rem 0 0', maxWidth: '36ch', color: 'var(--simmer-bone)' }}>
            Small plates and mocktails. A dark room on Bukhari, served softly.
          </p>

          <p className="utility" style={{ marginTop: '2.25rem', fontSize: '0.7rem', opacity: 0.75 }}>simmer down.</p>
        </div>
      </section>

      <hr className="rule" />

      {/* ── WHAT WE ARE ─────────────────────────────────────────────────────
          Caption voice. Plain truths, dry. One sentence per line. */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'clamp(2rem, 5vw, 4rem)' }}>
          <div>
            <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1.25rem' }}>the room</p>
            <p style={{ fontSize: '1.05rem', lineHeight: 1.7, fontFamily: 'var(--simmer-body)', letterSpacing: '0.02em' }}>
              Basement. Walnut, green marble, low light. Reservations are how we hold the room quiet.
            </p>
          </div>
          <div>
            <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1.25rem' }}>the kitchen</p>
            <p style={{ fontSize: '1.05rem', lineHeight: 1.7, fontFamily: 'var(--simmer-body)', letterSpacing: '0.02em' }}>
              Small plates, large plates, desserts. Ingredient-driven. The menu changes when the kitchen changes.
            </p>
          </div>
          <div>
            <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1.25rem' }}>the bar</p>
            <p style={{ fontSize: '1.05rem', lineHeight: 1.7, fontFamily: 'var(--simmer-body)', letterSpacing: '0.02em' }}>
              Mocktails only, on their own menu. Built like cocktails, without the alcohol.
            </p>
          </div>
        </div>
      </section>

      <hr className="rule" />

      {/* ── MENU CTA ────────────────────────────────────────────────────────
          The menu lives at /brand/simmer/menu. This is the route in. */}
      <section style={{ padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '54rem', margin: '0 auto', textAlign: 'center' }}>
          <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1.5rem' }}>the menu</p>
          <p className="amarante" style={{ fontSize: 'clamp(2.2rem, 5vw, 3.6rem)', lineHeight: 1.05, margin: 0 }}>
            ingredient-driven.<br />printed on the date you read it.
          </p>
          <p style={{ marginTop: '1.5rem', fontFamily: 'var(--simmer-body)', fontSize: '1.05rem', letterSpacing: '0.02em', opacity: 0.85, maxWidth: '36ch', marginLeft: 'auto', marginRight: 'auto' }}>
            Today's menu is dated <span className="amarante signal" style={{ letterSpacing: '0.04em' }}>{STAMP}</span>. Read it before you sit.
          </p>
          <div style={{ marginTop: '2.5rem', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href={`/brand/${concept.slug}/menu`} className="action action--signal">read the menu</Link>
            <Link href={`/${concept.slug}`} className="action">order from simmer</Link>
          </div>
        </div>
      </section>

      <hr className="rule" />

      {/* ── HOURS + RESERVATIONS + VISIT ─────────────────────────────────── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }} className="simmer-visit-grid">
          <style jsx>{`
            @media (max-width: 700px) {
              :global(.simmer-visit-grid) { grid-template-columns: 1fr !important; }
            }
          `}</style>

          <div>
            <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1.5rem' }}>hours</p>
            <div style={{ marginBottom: '1.25rem' }}>
              <OpenStatusBadge slug={concept.slug} />
            </div>
            <div style={{ fontFamily: 'var(--simmer-body)', fontSize: '0.95rem', letterSpacing: '0.02em', opacity: 0.9 }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hours={hoursData.hours} />
              ) : (
                <p style={{ opacity: 0.7 }}>Hours not published yet.</p>
              )}
            </div>
          </div>

          <div>
            <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1.5rem' }}>visit</p>
            <p className="amarante" style={{ fontSize: '1.6rem', lineHeight: 1.3, margin: '0 0 1rem' }}>
              {concept.address ?? 'Bukhari Commercial, DHA Phase 6, Karachi'}
            </p>
            {concept.phone && (
              <p style={{ fontFamily: 'var(--simmer-body)', fontSize: '1rem', letterSpacing: '0.02em', opacity: 0.85, margin: 0 }}>
                <a href={`tel:${concept.phone.replace(/\s/g, '')}`} style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px solid rgba(237,230,211,0.3)' }}>
                  {concept.phone}
                </a>
              </p>
            )}
            {reservations && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={`/reserve/${concept.slug}`} className="action">book a table</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      <hr className="rule" />

      {/* ── CROSS-BRAND STRIP — reuse the existing component. The accent
          comes through via the brand-accent override at the BrandShell. */}
      <div style={{ background: 'var(--simmer-bone)', color: 'var(--simmer-green)' }}>
        <CrossBrandStrip
          current={concept}
          concepts={concepts}
          accent="var(--simmer-orange)"
          kicker="other kitchens"
          heading="more from the operator."
        />
      </div>

      {/* ── SIGN-OFF — the brand's closing line ───────────────────────── */}
      <section style={{ padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)', textAlign: 'center' }}>
        <p className="wordmark" style={{ fontSize: 'clamp(3.5rem, 10vw, 6rem)', margin: 0 }}>
          simmer down<span className="signal">.</span>
        </p>
      </section>
    </div>
  )
}
