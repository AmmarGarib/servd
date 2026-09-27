'use client'
// Flipd — brand microsite.
//
// Built to the GS Foods brand book, now played loud. The book is still the
// rulebook for WHAT is on the page:
//
//   Palette    Three colours. Smash Mustard #FED561 is the field, Flipd Blue
//              #294375 is every mark on it, Bone #F9F0E1 is the third checker
//              square and the calm surface. Tokens are --flipd-* in globals.css.
//   Logo       The stamped badge artwork (/brand/flipd-badge.png), never re-set
//              in type and never recoloured.
//   Checker    Navy/bone, the signature edge.
//   Type       Alfa Slab One standing in for Bronto Burger; Poppins body.
//   Voice      "Plain-spoken: names the ingredient, skips the adjective." Every
//              line on the page is the book's, the spec sheet's, or the menu
//              API's own words.
//
// What changed (Sept 2026, "I want this website to feel alive") is HOW it
// moves. The book's personality line — "Playful, not childish. Energetic, not
// chaotic. Bold, not brash." and "Hand-made: marker lines over vectors.
// Slightly wrong is on-brand" — is the motion brief: a court-side crowd that
// watches the burger get built and cheers the smash, tickets that swing on a
// kitchen rail, stickers slapped on, marquee chase lights, spinning stools,
// marker doodles that boil like hand-drawn animation. All of it in the three
// colours, all of it transform/opacity, paused off-screen, and still under
// prefers-reduced-motion.
//
// Section rhythm: mustard hero → blue marquee → mustard mission → mustard
// rail → blue values → bone court-side → mustard cross-links → blue sign-off.

import type { CSSProperties } from 'react'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { useHoursData } from '../parts/OpenStatusBadge'
import { brandStory, formatBrandName } from '../../../lib/concept'
import { locationFor } from '../../../lib/brandLocations'
import { FlipdSpecHero } from '../../kinetic/FlipdSpecHero'
import { Marquee, Words, DoodleBurst, DoodleSquiggle, DoodleStar } from '../flipd/FlipdBits'
import { MiniBuild } from '../flipd/MiniBuild'
import { OffTheGrill, CourtSide } from '../flipd/LandingSections'
import { useSectionMotion } from '../flipd/useFlipdMotion'
import f from '../flipd/flipd.module.css'
import l from '../flipd/landing.module.css'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Straight from the book's Core Values spread — operating commitments, kept
// in the brand's own words.
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

// Marquee lines: the book's and the spec sheet's own facts, as signage.
const MARQUEE = [
  'Smash burgers',
  'Salt and pepper. Nothing else.',
  'Same burger, every time',
  'Components, not sauce',
  'Built to spec',
]

// Three facts pulled verbatim from the brand story, slapped on as stickers.
const FACTS = ['Salt and pepper, nothing else.', 'Real components, not sauce.', 'Fuel that fits the court.']
const FACT_TILTS = [-3, 2.5, -1.5]
const VALUE_TILTS = [-2, 1.5, -1, 2]

function Checker() {
  return <div aria-hidden className={f.checker} />
}

function Mission({ long }: { long: string }) {
  const ref = useSectionMotion<HTMLElement>()
  return (
    <section ref={ref} className={l.section} aria-labelledby="flipd-mission-title">
      <div className={`${l.inner} ${l.mission}`}>
        <div>
          <p className={l.eyebrow}>Our mission</p>
          <h2 id="flipd-mission-title" className={l.h2}>
            <Words text="Same burger," />{' '}
            <span className={l.underlined}>
              <Words text="every time." offset={2} />
              <svg aria-hidden className={f.scribble} viewBox="0 0 300 20" preserveAspectRatio="none">
                <path d="M4 13 C 60 5, 120 17, 180 9 S 280 6, 296 12" />
              </svg>
            </span>
          </h2>
          <p className={l.body}>{long}</p>
          <ul className={l.facts}>
            {FACTS.map((fact, i) => (
              <li
                key={fact}
                className={`${f.sticker} ${l.fact}`}
                style={{ '--r': `${FACT_TILTS[i]}deg`, '--i': i + 2 } as CSSProperties}
              >
                {fact}
              </li>
            ))}
          </ul>
        </div>
        <div className={l.missionArt}>
          <MiniBuild />
          <DoodleBurst className={f.float} style={{ top: '-4%', left: '2%', width: 56 }} />
          <DoodleStar className={f.float} style={{ bottom: '4%', right: '0%', width: 44 }} />
        </div>
      </div>
    </section>
  )
}

// Reveal hygiene: the server render is the finished band; the stickers and
// the heading only hold back once JS has mounted AND the band is still below
// the fold, trigger on a 2% sliver, and land within 450 ms — so a jump
// straight to this band never photographs an empty blue slab.
function Values() {
  const ref = useSectionMotion<HTMLElement>()
  return (
    <section ref={ref} className={`${l.section} ${l.blue}`} aria-labelledby="flipd-values-title">
      <div className={l.inner}>
        <p className={l.eyebrow}>Core values</p>
        <h2 id="flipd-values-title" className={l.h2}>
          <Words text="What we hold to." />
        </h2>
        <ol className={l.values}>
          {CORE_VALUES.map((v, i) => (
            <li
              key={v.title}
              className={`${f.sticker} ${l.value}`}
              style={{ '--r': `${VALUE_TILTS[i]}deg`, '--i': i } as CSSProperties}
            >
              <span className={l.valueNo} aria-hidden>{String(i + 1).padStart(2, '0')}</span>
              <h3 className={l.valueTitle}>{v.title}</h3>
              <p className={l.valueBody}>{v.body}</p>
            </li>
          ))}
        </ol>
        <DoodleSquiggle className={`${l.bandDoodle} ${f.float}`} style={{ top: '0.4rem', right: '2%', width: 92 }} />
      </div>
    </section>
  )
}

function SignOff({ badge, badgeIsFallback, address }: { badge: string; badgeIsFallback: boolean; address: string }) {
  const ref = useSectionMotion<HTMLElement>()
  return (
    <section ref={ref} className={l.signoff} aria-label="Sign-off">
      <div className={l.badgeWrap}>
        <svg className={l.badgeRing} viewBox="0 0 200 200" aria-hidden>
          <defs>
            <path id="flipd-signoff-ring" d="M100 100 m-90 0 a90 90 0 1 1 180 0 a90 90 0 1 1 -180 0" />
          </defs>
          <text fill="#FED561" fontFamily="Poppins, system-ui, sans-serif" fontWeight="700" fontSize="12" letterSpacing="3.4">
            <textPath href="#flipd-signoff-ring">SMASH BURGERS · BUILT TO SPEC · SAME BURGER, EVERY TIME · </textPath>
          </text>
        </svg>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={badge}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className={l.badge}
          {...(badgeIsFallback ? { width: 1200, height: 1200 } : {})}
        />
      </div>
      <p className={l.signoffLine}>Same burger, every time.</p>
      <p className={l.signoffAddr}>{address}</p>
    </section>
  )
}

export function FlipdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false
  const orderHref = `/${concept.slug}`
  const menuHref = `/brand/${concept.slug}/menu`

  // Operator-uploaded artwork wins; otherwise the copy bundled in this build.
  // `||` not `??` — a cleared admin field sends '', which must fall back too.
  const badge = concept.wordmarkUrl || '/brand/flipd-badge.png'
  const badgeIsFallback = !concept.wordmarkUrl

  // Directions: the operator's Maps link when configured, else a Maps search
  // for the published address. Nothing when there is neither.
  const mapsUrl =
    locationFor(concept.slug)?.mapsUrl ??
    (concept.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(concept.address)}` : null)

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

      <FlipdSpecHero
        brandName={formatBrandName(concept.name)}
        orderHref={orderHref}
        menuHref={menuHref}
        tagline={story.tagline}
      />

      <Marquee items={MARQUEE} />

      <Mission long={story.long} />

      <Checker />

      <OffTheGrill slug={concept.slug} orderHref={orderHref} menuHref={menuHref} />

      <Values />

      <CourtSide concept={concept} hoursData={hoursData} mapsUrl={mapsUrl} reservations={reservations} />

      <Checker />

      <CrossBrandStrip
        current={concept}
        concepts={concepts}
        accent="var(--flipd-blue)"
        kicker="Also from the same kitchen group"
        heading="Other kitchens from the same group."
      />

      {/* No order button here: BrandShell renders its own order CTA directly
          below, and two a screen apart just split the click. */}
      <SignOff badge={badge} badgeIsFallback={badgeIsFallback} address={concept.address ?? 'Karachi'} />

      <Marquee items={MARQUEE} reverse duration={46} />
    </div>
  )
}
