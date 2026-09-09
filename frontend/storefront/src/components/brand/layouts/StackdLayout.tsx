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

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory, formatBrandName } from '../../../lib/concept'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// What the counter actually puts out, in the order it reads best. These are
// menu categories, not marketing lines — the point of the cycler is that a
// customer who lands here learns what the kitchen makes.
// The brand's die-cut seal outline, traced pixel-for-pixel off the printed
// coaster in the brand photography — not drawn to approximate it. Two earlier
// passes generated sine-wave blobs by hand and neither matched: the first was
// too pointed, the second too regular. This is the real die.
//
// One shape, used on every sticker. They are stamped from a single die in
// life, so identical is correct here; varying them would read as hand-made,
// which is the opposite of the brief.
//
// Normalised to a 0-100 grid and stretched to
// each card by preserveAspectRatio="none" — the keylines stay an even width
// because they use vector-effect: non-scaling-stroke.
const DIE_SHAPES = [
  'M77.63,92.00C76.25,92.05 74.84,91.78 73.49,91.43C72.13,91.08 70.81,90.50 69.51,89.91C68.22,89.33 66.96,88.62 65.71,87.90C64.46,87.17 63.29,86.25 62.04,85.56C60.78,84.86 59.51,84.14 58.17,83.75C56.84,83.37 55.42,83.18 54.05,83.27C52.69,83.36 51.31,83.81 49.99,84.30C48.67,84.79 47.38,85.47 46.13,86.18C44.88,86.89 43.70,87.77 42.49,88.56C41.27,89.35 40.08,90.83 38.85,90.92C37.61,91.02 36.07,90.13 35.10,89.15C34.12,88.16 33.61,86.43 32.98,84.99C32.35,83.55 31.94,81.96 31.33,80.50C30.71,79.05 30.08,77.58 29.27,76.27C28.46,74.96 27.54,73.67 26.48,72.65C25.42,71.63 24.18,70.77 22.92,70.14C21.66,69.52 20.26,69.24 18.90,68.90C17.55,68.56 16.08,68.60 14.78,68.10C13.48,67.60 12.14,66.91 11.11,65.91C10.08,64.91 9.09,63.51 8.57,62.07C8.06,60.64 7.91,58.89 8.00,57.31C8.09,55.74 8.59,54.11 9.14,52.63C9.69,51.15 10.45,49.74 11.28,48.45C12.11,47.15 13.09,45.97 14.11,44.87C15.13,43.77 16.32,42.88 17.40,41.86C18.49,40.84 19.67,39.93 20.63,38.77C21.58,37.60 22.47,36.27 23.14,34.87C23.81,33.46 24.29,31.89 24.65,30.33C25.01,28.78 25.18,27.15 25.30,25.54C25.41,23.92 25.32,22.27 25.36,20.64C25.40,19.02 25.26,17.34 25.52,15.77C25.78,14.19 26.18,12.50 26.93,11.21C27.68,9.91 28.84,8.40 30.02,8.00C31.21,7.60 32.74,8.27 34.02,8.78C35.30,9.29 36.51,10.26 37.71,11.07C38.92,11.89 40.05,12.87 41.26,13.67C42.48,14.46 43.71,15.25 45.00,15.84C46.29,16.42 47.65,16.89 49.02,17.17C50.38,17.44 51.80,17.60 53.17,17.48C54.54,17.36 55.95,16.98 57.25,16.43C58.54,15.88 59.70,14.91 60.95,14.20C62.20,13.50 63.43,12.59 64.75,12.19C66.08,11.78 67.53,11.68 68.90,11.79C70.26,11.90 71.68,12.24 72.94,12.85C74.20,13.46 75.39,14.44 76.46,15.46C77.53,16.47 78.52,17.67 79.37,18.95C80.21,20.23 81.02,21.64 81.52,23.13C82.02,24.61 82.35,26.29 82.37,27.87C82.39,29.46 81.97,31.07 81.63,32.64C81.29,34.21 80.67,35.71 80.34,37.28C80.02,38.86 79.73,40.49 79.69,42.10C79.64,43.71 79.80,45.36 80.07,46.95C80.34,48.53 80.76,50.11 81.29,51.61C81.82,53.11 82.51,54.55 83.24,55.93C83.97,57.31 84.81,58.62 85.67,59.90C86.53,61.18 87.56,62.32 88.40,63.60C89.23,64.88 90.10,66.16 90.70,67.59C91.29,69.03 91.74,70.63 91.96,72.21C92.17,73.79 92.19,75.49 92.00,77.07C91.81,78.66 91.38,80.26 90.82,81.73C90.27,83.20 89.55,84.66 88.66,85.88C87.77,87.10 86.65,88.18 85.50,89.06C84.35,89.93 83.05,90.65 81.73,91.14C80.42,91.63 79.00,91.95 77.63,92.00Z',
]

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
const DISH_INTERVAL_MS = 2600

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

  // The counter cycler. Starts at 0 on the server so the markup hydrates
  // cleanly, then advances on a timer. Paused while the tab is hidden —
  // a background tab throttles the interval anyway, and letting it run just
  // means the word jumps several steps the moment you come back.
  const [dish, setDish] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => {
      if (document.hidden) return
      setDish((d) => (d + 1) % COUNTER_LINES.length)
    }, DISH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

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

        {/* ── THE MASCOT ──────────────────────────────────────────────────────
            Off-centre on purpose: he sits right of the axis and leans past the
            container, and the space that leaves on the left carries the one
            thing a customer wants there — what actually comes out of the
            kitchen — cycling a line at a time, with the way in underneath.
            Still no copy describing the drawing. */}
        <section>
          <div className="stackd-mascot-band">
            <div>
              <span className="stackd-spec">On the counter</span>
              <p className="stackd-cycler">
                <span className="stackd-cycler-lead">we do</span>
                {/* A screen reader gets the whole list once, in place of a
                    slot that would otherwise announce a new word every 2.6
                    seconds — which is what a live region here would do, and it
                    is unbearable. The animated slot is hidden from them. */}
                <span
                  style={{
                    position: 'absolute', width: 1, height: 1, overflow: 'hidden',
                    clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
                  }}
                >
                  {COUNTER_LINES.join(' ')}
                </span>
                <span className="stackd-cycler-slot" aria-hidden>
                  {/* key forces a remount so the entry animation replays. */}
                  <span key={dish} className="stackd-cycler-word">
                    {COUNTER_LINES[dish]}
                  </span>
                </span>
              </p>
              <div style={{ marginTop: 'clamp(1.75rem, 4vh, 2.5rem)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Link href={`/${concept.slug}`} className="stackd-btn">Order stackd</Link>
                <Link href={`/brand/${concept.slug}/menu`} className="stackd-btn stackd-btn-ghost">See the menu</Link>
              </div>
            </div>

            <div className="stackd-mascot-stage">
              <div className="stackd-mascot-seal">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mascotSrc}
                  alt={mascotAlt}
                  {...mascotDims}
                />
              </div>
            </div>
          </div>

        </section>

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
