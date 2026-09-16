'use client'
// flipd — brand microsite, rebuilt from the GS Foods brand book (Sept 2026).
//
// This replaced a 1950s American-diner treatment (candy-stripe awning, Lobster
// cursive, neon, chrome) and, before that, a padel-court turf theme. Neither is
// what the book describes, and the turf one broke an explicit rule in it:
// "Not about padel: We happen to be there. We never borrow the court's
// identity."
//
// What the book actually specifies, and what this page is built to:
//
//   Palette    Three colours. Smash Mustard #FED561 is the field, Flipd Blue
//              #294375 is every mark on it, Bone #F9F0E1 is the third checker
//              square and the calm surface. Tokens are --flipd-* in globals.css.
//   Logo       The stamped badge, supplied as artwork (/brand/flipd-badge.png).
//              "The badge is built to feel stamped, not printed — a little
//              rough, entirely intentional. Keep it that way." So it is used as
//              the image, never re-set in type, and never recoloured.
//   Checker    Navy/bone, the signature edge. It bands the top and bottom of
//              the page and rules between sections, as it does on every spread.
//   Type       Display is Bronto Burger, which we have no webfont licence for;
//              Alfa Slab One stands in and the comment on the token says so.
//              Body is Poppins, which IS the book's pick and is free.
//   Voice      "Plain-spoken: names the ingredient, skips the adjective." The
//              menu prints build lines verbatim from the spec sheet — no
//              invented descriptions, because that breaks the voice rule and
//              the first core value ("the spec is the boss") simultaneously.
//   Restraint  "Restraint over decoration... If something on the plate isn't
//              earning its place, it comes off." No gradients, no glows, no
//              drop-shadowed type, no motion for its own sake.

import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory, formatBrandName } from '../../../lib/concept'
import { FlipdSpecHero } from '../../kinetic/FlipdSpecHero'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Straight from the book's Core Values spread. Kept as the brand's own words —
// these are operating commitments, not marketing lines, and paraphrasing them
// would soften exactly the thing that makes them useful.
const CORE_VALUES = [
  {
    title: 'The spec is the boss.',
    body: 'Every burger is built the same way by whoever is on the line. Recipes are written, weights are weighed, no one improvises during service.',
  },
  {
    title: 'Restraint over decoration.',
    body: 'Salt and pepper. Components, not sauce. We don’t hide a weak ingredient behind a strong one. If something on the plate isn’t earning its place, it comes off.',
  },
  {
    title: 'Buy the ingredient, not the price.',
    body: 'A naked patty means the beef has nowhere to hide. Food cost holds by managing yield and waste, never by downgrading the protein.',
  },
  {
    title: 'Fuel is a responsibility, not a garnish.',
    body: 'Players are eating and drinking to recover. The electrolyte, coconut water and sparkling programme exists because it does a job — not because it reads well on a menu.',
  },
]

/** The navy/bone checker band. The brand's edge, used as a rule. */
function Checker() {
  return <div aria-hidden className="flipd-checker" />
}

export function FlipdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false

  // Operator-uploaded artwork wins; otherwise the copy bundled in this build.
  // `||` not `??` — a cleared admin field sends '', which must fall back too.
  const badge = concept.wordmarkUrl || '/brand/flipd-badge.png'
  const badgeIsFallback = !concept.wordmarkUrl

  return (
    <div className="flipd-page">
      <Checker />

      {concept.announcementBanner && (
        <div
          role="status"
          style={{
            background: 'var(--flipd-blue)',
            color: 'var(--flipd-mustard)',
            padding: '0.7rem 1.5rem',
            textAlign: 'center',
            fontSize: '0.74rem',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          {concept.announcementBanner}
        </div>
      )}

      {/* ── HERO: THE BUILD SHEET ────────────────────────────────────────
          Was a static badge with the tagline under it — the brand book laid
          on a page. It is now the book's own exploded-burger artwork, at
          size, assembling on scroll with the real build spec on leader
          lines. See FlipdSpecHero for the reasoning. The badge still leads
          the page, above the diagram, because the book says it carries the
          brand and nothing should compete with it. */}
      <section style={{ padding: 'clamp(2.5rem, 7vh, 4rem) clamp(1.5rem, 5vw, 3rem) 0' }}>
        <div style={{ maxWidth: '68rem', margin: '0 auto', textAlign: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={badge}
            alt={`${concept.name} logo`}
            {...(badgeIsFallback ? { width: 1200, height: 1200 } : {})}
            style={{
              display: 'block',
              width: 'clamp(9rem, 20vw, 14rem)',
              height: 'auto',
              margin: '0 auto',
            }}
          />
        </div>
      </section>

      <FlipdSpecHero
        brandName={formatBrandName(concept.name)}
        orderHref={`/${concept.slug}`}
        menuHref={`/brand/${concept.slug}/menu`}
        tagline={story.tagline}
      />

      <Checker />

      {/* ── MISSION ──────────────────────────────────────────────────────────
          A bone panel so the long read is comfortable; a full-strength mustard
          field behind a paragraph this length is punishing. */}
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div className="flipd-panel" style={{ maxWidth: '54rem', margin: '0 auto', padding: 'clamp(2rem, 5vw, 3.25rem)' }}>
          <span className="flipd-eyebrow">Our mission</span>
          <h2 className="flipd-display" style={{ fontSize: 'clamp(1.7rem, 3.6vw, 2.5rem)', margin: '0.7rem 0 1.4rem' }}>
            Same burger, every time.
          </h2>
          <p style={{ fontSize: '1.02rem', lineHeight: 1.75, color: 'var(--flipd-blue-dim)', margin: 0, maxWidth: '62ch' }}>
            {story.long}
          </p>
        </div>
      </section>

      {/* The menu used to live here, inline. It is now its own page
          (/brand/flipd/menu) driven by the live menu API, so the landing page
          stays a pitch and there is exactly one copy of the menu — the one
          the kitchen and the till already agree on. */}
      {/* ── CORE VALUES ──────────────────────────────────────────────────────
          On the inverted band: Flipd Blue field, mustard type. */}
      <section
        style={{
          background: 'var(--flipd-blue)',
          color: 'var(--flipd-mustard)',
          padding: 'clamp(3.5rem, 9vh, 5.5rem) clamp(1.5rem, 5vw, 3rem)',
        }}
      >
        <div style={{ maxWidth: '68rem', margin: '0 auto' }}>
          <h2
            className="flipd-display"
            style={{ fontSize: 'clamp(1.9rem, 4vw, 2.8rem)', margin: '0 0 2rem', color: 'var(--flipd-mustard)' }}
          >
            What we hold to.
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))', gap: 'clamp(1.5rem, 3vw, 2.5rem)' }}>
            {CORE_VALUES.map((v, i) => (
              <div key={v.title}>
                <span
                  className="flipd-display"
                  style={{ fontSize: '1.6rem', color: 'rgba(254,213,97,0.38)', display: 'block', lineHeight: 1 }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0.6rem 0 0.5rem', color: 'var(--flipd-mustard)' }}>
                  {v.title}
                </h3>
                <p style={{ fontSize: '0.88rem', lineHeight: 1.65, margin: 0, color: 'rgba(254,213,97,0.74)' }}>
                  {v.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOURS + WHERE ─────────────────────────────────────────────────── */}
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div
          className="flipd-visit-grid"
          style={{ maxWidth: '68rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }}
        >
          <div>
            <span className="flipd-eyebrow">Hours</span>
            <h2 className="flipd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.5rem' }}>
              When we&rsquo;re on.
            </h2>
            <div style={{ marginBottom: '1.4rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
            <div style={{ fontSize: '0.92rem', color: 'var(--flipd-blue-dim)' }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hoursData={hoursData} />
              ) : (
                <p style={{ opacity: 0.7 }}>Hours not published yet.</p>
              )}
            </div>
          </div>

          <div>
            <span className="flipd-eyebrow">Where</span>
            <h2 className="flipd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.5rem' }}>
              Find us.
            </h2>
            <p style={{ fontSize: '1.05rem', lineHeight: 1.5, margin: '0 0 1rem', fontWeight: 500 }}>
              {concept.address ?? 'Karachi · address TBA'}
            </p>
            {concept.phone && (
              <p style={{ fontSize: '0.92rem', margin: 0 }}>
                <a
                  href={`tel:${concept.phone.replace(/\s/g, '')}`}
                  style={{ color: 'var(--flipd-blue)', textDecoration: 'none', borderBottom: '1px solid currentColor' }}
                >
                  {concept.phone}
                </a>
              </p>
            )}
            {reservations && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={`/reserve/${concept.slug}`} className="flipd-btn flipd-btn-ghost">Book a table</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      <Checker />

      <CrossBrandStrip
        current={concept}
        concepts={concepts}
        accent="var(--flipd-blue)"
        kicker="Also from the same kitchen group"
        heading="Other kitchens from the same group."
      />

      {/* ── SIGN-OFF ─────────────────────────────────────────────────────────
          The badge again to close, on the blue band. No order button: BrandShell
          renders its own CTA directly below, and two order buttons a screen
          apart just split the click. */}
      <section
        style={{
          background: 'var(--flipd-blue)',
          padding: 'clamp(3.5rem, 10vh, 6rem) clamp(1.5rem, 5vw, 3rem)',
          textAlign: 'center',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={badge}
          alt=""
          aria-hidden="true"
          style={{ display: 'block', width: 'min(11rem, 40vw)', height: 'auto', margin: '0 auto 1.25rem' }}
        />
        <p className="flipd-eyebrow" style={{ color: 'rgba(254,213,97,0.6)' }}>
          {concept.address ?? 'Karachi'}
        </p>
      </section>

      <Checker />
    </div>
  )
}
