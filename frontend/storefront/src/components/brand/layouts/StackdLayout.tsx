'use client'
// stackd — brand microsite layout.
//
// Design direction comes from the brand deck (Sept 2026), not from the old
// stax theme, which this replaces wholesale:
//
//   Palette   Pantone 19-2025 Red Plum as the field, Pantone 9180 cream as
//             the type, Pantone 635 pale blue as the single cool accent.
//             The chips are photographed in the deck; the hexes live in
//             globals.css as --stackd-*.
//   Wordmark  lowercase "stackd." in a high-contrast didone, cream on plum,
//             with "stackd & servd" set in italic beneath it. Lowercase is
//             the brand — never "Stackd" in display type.
//   Mascot    the hand-drawn bread-stack character — a stack of slices over a
//             plum tray bar with two hands on it, striped trousers, shoes.
//             He gets a band of his own, at size. He is what goes on the cups,
//             wrappers and pastry bags, and since the packaging IS the service
//             vessel here, the character does the work a plate would.
//   Stickers  the brand's seals: wavy die-cut lozenges, cream or white, ringed
//             with a plum keyline then a pale-blue band, applied off-square.
//             Symmetric and evenly lobed — a pressed coaster, not an organic
//             blob. There is no yellow in this brand. Every card
//             on this page is one of these, not a rectangle — the brand has no
//             straight-edged boxes anywhere in its collateral.
//
// Deliberately NO grid anywhere. The first pass ruled the background and the
// story panel with graph paper, which was a hangover from the old stax
// blueprint theme; it fought a brand whose whole visual language is hand-drawn
// ink, rounded seals and warm paper.
//
// The concept is a 20-seat scratch-cooking cafe with a small market at the
// cashier/barista bar — sandwiches, pastries, light bites, craft mocktails.
// It is NOT the burger room the first pass described. Copy lives in
// BRAND_STORIES (lib/concept.ts); no real menu data is wired in yet, so the
// stickers render from the highlights and stand in as marketing modules
// until the menu API exposes per-brand items.

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory, formatBrandName } from '../../../lib/concept'
import { DIE_SHAPES } from '../../../lib/stackdDie'
import { StackdSlipHero } from '../../kinetic/StackdSlipHero'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// What the counter actually puts out, in the order it reads best. These are
// menu categories, not marketing lines — the point of the cycler is that a
// customer who lands here learns what the kitchen makes.

/** The wavy seal behind a sticker: pale-blue outer band, plum keyline, fill. */
function StickerDie({ index }: { index: number }) {
  const d = DIE_SHAPES[index % DIE_SHAPES.length]!
  return (
    <svg className="stackd-sticker-die" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <path className="die-band" d={d} />
      <path className="die-face" d={d} />
    </svg>
  )
}

// Bundled artwork. Used until the operator uploads a replacement in
// admin -> Marketing -> Brands -> Storefront. These files ship in
// public/brand/ so the page never depends on the uploads host being up.
const FALLBACK_WORDMARK = '/brand/stackd-wordmark-tagline.png'
const FALLBACK_MASCOT = '/brand/stackd-mascot.png'

const COUNTER_LINES = ['sandwiches.', 'pastries.', 'light bites.', 'craft mocktails.', 'grab & go.']

export function StackdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false

  // Artwork comes from the brand row when the operator has uploaded it, and
  // falls back to the copy bundled in this build otherwise. `|| fallback`
  // rather than `??` on purpose: an empty string is what a cleared admin field
  // sends, and it must fall back too, not render a broken image.
  const wordmarkSrc = concept.wordmarkUrl || FALLBACK_WORDMARK
  const mascotSrc = concept.mascotUrl || FALLBACK_MASCOT
  // width/height on an <img> declare the INTRINSIC ratio so the browser can
  // reserve the right space before the file arrives. We know the bundled
  // files' dimensions; we know nothing about an upload, and stating the old
  // numbers for a differently-shaped image reserves the wrong box and shifts
  // the page on load. So the hint is given only for the fallback.
  const wordmarkDims = concept.wordmarkUrl ? {} : { width: 599, height: 195 }
  const mascotDims = concept.mascotUrl ? {} : { width: 338, height: 453 }
  // The specific description only holds for the artwork we ship. Once an
  // operator uploads their own, we have no idea what it depicts, so fall back
  // to naming its role instead of describing a picture that may not be there.
  const mascotAlt = concept.mascotUrl
    ? `${formatBrandName(concept.name)} brand character`
    : 'The stackd character — a stack of bread slices carried on a plum tray, striped trousers below'

  // The counter cycler's timer used to live here. Its markup went with the
  // standing mascot band, so it was left ticking every 2.6s to set state
  // nothing read. COUNTER_LINES itself is still used — the drop prints the
  // whole list once it lands.

  // Scroll reveal for the stickers. Everything renders visible by default and
  // the .stackd-reveal class is only ADDED here, so a browser without JS (or
  // without IntersectionObserver) simply gets the page with no animation
  // rather than a page of invisible cards.
  const revealRoot = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = revealRoot.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))
    cards.forEach((el, i) => {
      el.classList.add('stackd-reveal')
      el.style.transitionDelay = `${Math.min(i, 6) * 70}ms`
    })

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          e.target.classList.add('is-in')
          io.unobserve(e.target)   // one-way: cards don't fade back out on scroll up
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
    )
    cards.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  // Classes (.stackd-page, .stackd-mono, .stackd-spec, .stackd-rule,
  // .stackd-line, .stackd-display, .stackd-btn, .stackd-btn-ghost,
  // .stackd-sticker, .stackd-sticker-lg, .stackd-mascot-band,
  // .stackd-mascot-stage, .stackd-mascot-seal, .stackd-visit-grid)
  // live in globals.css.
  return (
    <div className="stackd-page">
      {/* The plum field: fixed, full-bleed, with a soft pool of warm light at
          the top and nothing else — no grid. Sized in lvh so a mobile toolbar
          toggle can't resize it mid-scroll. z-index 0 keeps it under the nav. */}
      <div aria-hidden className="stackd-bg-fixed" />

      <div style={{ position: 'relative', zIndex: 1 }}>
        {concept.announcementBanner && (
          <div
            role="status"
            style={{
              background: 'var(--stackd-plum-dark)',
              color: 'var(--stackd-cream)',
              padding: '0.7rem 1.5rem',
              textAlign: 'center',
              fontFamily: 'var(--stackd-mono)',
              fontSize: '0.74rem',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
            }}
          >
            {concept.announcementBanner}
          </div>
        )}

        {/* ── THE SLIP ────────────────────────────────────────────────────────
            He goes down and the bread goes up. Scroll down, it climbs — the
            inversion is the gag. This replaced a standing mascot band further
            down the page; he appears once, at full height. See StackdSlipHero. */}
        <StackdSlipHero
          brandName={formatBrandName(concept.name)}
          orderHref={`/${concept.slug}`}
          menuHref={`/brand/${concept.slug}/menu`}
          mascotAlt={mascotAlt}
          counterLines={COUNTER_LINES}
          customMascotSrc={concept.mascotUrl}
          customMascotDims={mascotDims}
        />

        {/* ── HERO ────────────────────────────────────────────────────────────
            The wordmark, set the way the brand sets it: lowercase, cream, with
            the full stop, and the italic lockup line underneath. Nothing else
            competes with it above the fold. */}
        <section style={{ padding: 'clamp(4.5rem, 14vh, 9rem) clamp(1.5rem, 5vw, 3rem) clamp(3rem, 7vh, 4.5rem)' }}>
          <div style={{ maxWidth: '76rem', margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '2rem', flexWrap: 'wrap', marginBottom: '3rem' }}>
              <span className="stackd-spec">Karachi</span>
              <span className="stackd-spec">Café · market · scratch kitchen</span>
            </div>

            {/* The supplied wordmark asset, not a webfont approximation. The
                brand face is a bespoke didone we don't have a licence for, and
                Playfair only rhymes with it. The source PNG's plum background
                was knocked out to alpha so the cream artwork sits on any panel.
                The <h1> stays real text for search and screen readers; the
                image is decorative on top of it. */}
            <h1
              style={{
                margin: '0 0 2.75rem',
                position: 'relative',
                display: 'block',
                maxWidth: 'min(34rem, 78vw)',
              }}
            >
              <span
                style={{
                  position: 'absolute', width: 1, height: 1, overflow: 'hidden',
                  clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
                }}
              >
                stackd — stackd &amp; servd
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={wordmarkSrc}
                alt=""
                aria-hidden="true"
                {...wordmarkDims}
                style={{ display: 'block', width: '100%', height: 'auto' }}
              />
            </h1>

            <hr className="stackd-line" />

            <p
              className="stackd-display"
              style={{ fontSize: 'clamp(1.5rem, 2.8vw, 2.3rem)', maxWidth: '30ch', margin: '2rem 0 0', fontWeight: 500, lineHeight: 1.15 }}
            >
              {story.tagline}
            </p>

            <p
              style={{
                fontFamily: 'var(--stackd-body)',
                fontSize: '1rem',
                lineHeight: 1.65,
                maxWidth: '52ch',
                margin: '1.25rem 0 0',
                color: 'var(--stackd-cream-dim)',
              }}
            >
              {story.oneLiner}
            </p>

            <div style={{ marginTop: '3rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <Link href={`/${concept.slug}`} className="stackd-btn">Order stackd</Link>
              <Link href={`/brand/${concept.slug}/menu`} className="stackd-btn stackd-btn-ghost">View menu</Link>
            </div>
          </div>
        </section>

        {/* The standing mascot band lived here. He is the drop now: one
            appearance, at full height, rather than two at rest. The counter
            cycler it carried moved into the drop's landing. */}

        {/* ── STICKERS ────────────────────────────────────────────────────────
            Each highlight is a seal, in the packaging palette and set slightly
            off-square, the way a label goes on by hand. */}
        <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
          <div ref={revealRoot} style={{ maxWidth: '76rem', margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '2rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
              <h2 className="stackd-display" style={{ fontSize: 'clamp(1.9rem, 4vw, 2.8rem)', margin: 0 }}>
                What we do.
              </h2>
              <span className="stackd-spec">The short version</span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                gap: 'clamp(1rem, 2vw, 1.5rem)',
                marginTop: '2.25rem',
              }}
            >
              {story.highlights.map((h, i) => (
                <div key={h} data-reveal className="stackd-sticker" style={{ aspectRatio: '1 / 0.92' }}>
                  <StickerDie index={i} />
                  <div className="stackd-sticker-inner">
                    <span className="stackd-spec">{String(i + 1).padStart(2, '0')}</span>
                    <p
                      className="stackd-display"
                      style={{ fontSize: 'clamp(0.95rem, 1.45vw, 1.15rem)', lineHeight: 1.18, margin: '0.5rem 0 0', fontWeight: 600 }}
                    >
                      {h}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── THE ROOM ────────────────────────────────────────────────────────
            The long story on one large seal — same language, calmer angle. */}
        <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
          <div
            className="stackd-sticker-lg"
            style={{ maxWidth: '58rem', margin: '0 auto', padding: 'clamp(2.25rem, 5vw, 3.5rem)' }}
          >
            <span className="stackd-spec">The room</span>
            <h2 className="stackd-display" style={{ fontSize: 'clamp(1.9rem, 4vw, 2.8rem)', margin: '0.75rem 0 1.5rem' }}>
              Twenty seats, and a market.
            </h2>
            <p
              style={{
                fontFamily: 'var(--stackd-body)',
                fontSize: '1.05rem',
                lineHeight: 1.75,
                color: 'rgba(61,17,34,0.78)',
                margin: 0,
                maxWidth: '62ch',
              }}
            >
              {story.long}
            </p>
          </div>
        </section>

        {/* ── HOURS + WHERE ───────────────────────────────────────────────── */}
        <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
          <div
            className="stackd-visit-grid"
            style={{ maxWidth: '76rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }}
          >
            <div>
              <span className="stackd-spec">Hours</span>
              <h2 className="stackd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.75rem' }}>
                When we&rsquo;re on.
              </h2>
              <div style={{ marginBottom: '1.5rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
              <div className="stackd-mono" style={{ fontSize: '0.95rem' }}>
                {hoursData?.hours && hoursData.hours.length > 0 ? (
                  <HoursGrid hoursData={hoursData} />
                ) : (
                  <p style={{ opacity: 0.6 }}>Hours not published yet.</p>
                )}
              </div>
            </div>

            <div>
              <span className="stackd-spec">Where</span>
              <h2 className="stackd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.75rem' }}>
                Find us.
              </h2>
              <p className="stackd-display" style={{ fontSize: '1.3rem', lineHeight: 1.45, margin: '0 0 1rem', fontWeight: 500 }}>
                {concept.address ?? 'Karachi · address TBA'}
              </p>
              {concept.phone && (
                <p className="stackd-mono" style={{ fontSize: '0.95rem', margin: 0 }}>
                  <a
                    href={`tel:${concept.phone.replace(/\s/g, '')}`}
                    style={{ color: 'var(--stackd-cream)', textDecoration: 'none', borderBottom: '1px solid currentColor' }}
                  >
                    {concept.phone}
                  </a>
                </p>
              )}
              {reservations && (
                <div style={{ marginTop: '2rem' }}>
                  <Link href={`/reserve/${concept.slug}`} className="stackd-btn stackd-btn-ghost">Reserve a table</Link>
                </div>
              )}
            </div>
          </div>
        </section>

        <hr className="stackd-rule" />

        {/* ── CROSS-BRAND STRIP ───────────────────────────────────────────── */}
        <CrossBrandStrip
          current={concept}
          concepts={concepts}
          accent="var(--stackd-cream)"
          kicker="Also from the same kitchen group"
          heading="Other lines coming out of the same kitchen group."
        />

        {/* ── SIGN-OFF ────────────────────────────────────────────────────────
            The lockup again, on the deepest plum, to bookend the page. No order
            button here on purpose: BrandShell renders its own "ready when you
            are" CTA immediately below this, and stacking two order buttons a
            screen apart just splits the click. This closes the brand; the shell
            closes the sale. */}
        <section
          style={{
            background: 'var(--stackd-plum-dark)',
            color: 'var(--stackd-cream)',
            padding: 'clamp(4.5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)',
          }}
        >
          <div style={{ maxWidth: '64rem', margin: '0 auto', textAlign: 'center' }}>
            <h2 style={{ margin: '0 0 2.5rem' }}>
              <span
                style={{
                  position: 'absolute', width: 1, height: 1, overflow: 'hidden',
                  clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
                }}
              >
                stackd &amp; servd
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={wordmarkSrc}
                alt=""
                aria-hidden="true"
                {...wordmarkDims}
                style={{ display: 'block', width: 'min(22rem, 70vw)', height: 'auto', margin: '0 auto' }}
              />
            </h2>
            <p
              className="stackd-spec"
              style={{ margin: 0, color: 'var(--stackd-cream-faint)' }}
            >
              {concept.address ?? 'Karachi'}
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
