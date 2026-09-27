'use client'
// simmer — brand microsite layout.
// Built strictly to the simmer-brand SKILL.md (canonical source of truth):
//   • Night mode (forest green "tiber" surface, bone ink)
//   • Amarante for display, Times for body/utility
//   • lowercase wordmark `simmer`, tagline `simmer down.` (below, never above)
//   • single orange signal per viewport, no decorative repetition
//   • no white, no gradients (fills, overlays, glows), no emojis, no
//     exclamation marks, no cute characters
//   • no banned words: elevated, curated, experience, journey, passionate,
//     crafted, artisanal, fusion, twist on a classic
//
// "Alive", the simmer way: quiet and cinematic, like the opening titles of a
// film set in a hidden supper club. Life comes from light, smoke, pacing and
// reveal — never from colour or characters. The page plays in six scenes:
//
//   1. the walk-in        — the chiller door opens onto the stairs down
//                           (SpeakeasyFridgeHero). orange: pilot → candle.
//   2. titles             — the wordmark surfaces letter by letter, the
//                           tagline below it, then three credit lines.
//                           no orange: bone type only.
//   3. tonight's service  — bone ground; three walnut frames hung off a rail,
//                           a live service date. orange: one ember on the rail.
//   4. what's next        — the kitchen's note, by candlelight, sentence by
//                           sentence. orange: the candle.
//   5. find the door      — address, hours, live service status, directions,
//                           the elsewhere links. no orange.
//   6. other kitchens + sign-off — the candle is out; a curl of smoke over
//                           "simmer down." orange: the full stop.
//
// Menu items are intentionally absent from this surface — /brand/simmer/menu
// renders the menu as a printed card.

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import type { Concept } from '../../../lib/concept'
import { conceptHeroImage } from '../../../lib/concept'
import { SpeakeasyFridgeHero } from '../../kinetic/SpeakeasyFridgeHero'
import { locationFor, whatsappLink } from '../../../lib/brandLocations'
import { Candle } from '../simmer/Candle'
import { Itinerary } from '../simmer/Itinerary'
import { OtherKitchens } from '../simmer/OtherKitchens'
import { SimmerCursor } from '../simmer/SimmerCursor'
import { Reveal, Line, Letters } from '../simmer/reveal'
import { useService } from '../simmer/serviceClock'
import s from '../simmer/simmer.module.css'

interface Props {
  concept: Concept
  concepts: Concept[]
}

const i = (n: number) => ({ ['--i' as string]: n } as CSSProperties)
const pad = 'clamp(1.25rem, 5vw, 3rem)'

// Section title in the eyebrow voice: tracked-out lowercase Times, exposed
// as a real h2 so the page has an outline.
function Eyebrow({ id, title, aside }: { id: string, title: string, aside?: ReactNode }) {
  return (
    <div className={s.eyebrow}>
      <h2 id={id} className={s.utility} style={{ margin: 0, fontWeight: 400 }}>{title}</h2>
      {aside != null && <span className={s.utility} suppressHydrationWarning>{aside}</span>}
    </div>
  )
}

// ─── Outbound icon set ──────────────────────────────────────────────────
// Minimal line icons at 22px; stroke is currentColor (bone).
const iconProps = {
  width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
} as const
const ICONS = {
  instagram: (
    <svg {...iconProps}>
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  ),
  tiktok: (
    <svg {...iconProps}><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5" /></svg>
  ),
  facebook: (
    <svg {...iconProps}><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" /></svg>
  ),
  whatsapp: (
    <svg {...iconProps}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  maps: (
    <svg {...iconProps}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  email: (
    <svg {...iconProps}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
}

function Outbound({ href, label, icon }: { href: string, label: string, icon: ReactNode }) {
  const external = !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('/')
  return (
    <li>
      <a href={href} aria-label={label} className={s.icon}
         {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {icon}
      </a>
    </li>
  )
}

export function SimmerLayout({ concept, concepts }: Props) {
  const service = useService()

  // Canonical NAP from lib/brandLocations so the WhatsApp + Maps links match
  // the Restaurant schema, the /locations page and the Google listing.
  const loc = locationFor('simmer')
  const mapsHref = loc?.mapsUrl
    ?? (loc
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${loc.name} ${loc.area} ${loc.city}`)}`
      : 'https://www.google.com/maps/search/?api=1&query=simmer+Karachi')
  const waHref = loc ? whatsappLink(loc, 'hi simmer') : 'https://wa.me/'
  const area = (loc?.area ?? 'Ittehad Commercial, DHA Phase 6').split(',')[0]?.trim() ?? 'Ittehad Commercial'

  return (
    <div className={`simmer-page ${s.root}`}>
      <SimmerCursor />

      {/* The page's one h1. The walk-in is a drawing; this names the page.
          Lowercase wordmark; the tagline follows it in reading order. */}
      <h1 className={s.srOnly}>simmer</h1>

      {/* Announcement strip — only when the operator has filled the field.
          Operational copy stays plain and clear. */}
      {concept.announcementBanner && (
        <div role="status" style={{
          background: 'var(--simmer-black)', color: 'var(--simmer-bone)',
          padding: '0.7rem 1.5rem', textAlign: 'center',
          fontFamily: 'var(--simmer-body)', fontSize: '0.8rem',
          letterSpacing: '0.22em', textTransform: 'lowercase',
        }}>
          {concept.announcementBanner}
        </div>
      )}

      {/* ── 1. THE WALK-IN ───────────────────────────────────────────── */}
      <SpeakeasyFridgeHero
        brandName="simmer"
        reserveHref={`/reserve/${concept.slug}`}
        menuHref={`/brand/${concept.slug}/menu`}
      />

      {/* ── 2. TITLES ────────────────────────────────────────────────────
          A title card after the door: the wordmark surfaces one letter at a
          time, the tagline sets BELOW it, then the credits. Bone only. */}
      <section aria-label="simmer, the room" style={{ padding: `clamp(6rem, 16vh, 10rem) ${pad} clamp(5rem, 14vh, 9rem)`, textAlign: 'center' }}>
        <Reveal style={{ maxWidth: '60rem', margin: '0 auto' }}>
          <p className={`${s.utility} ${s.rise}`} style={{ margin: 0 }}>gs foods presents</p>
          <p className={s.amarante} style={{ fontSize: 'clamp(5.2rem, 21vw, 13rem)', lineHeight: 0.9, margin: '1.6rem 0 0' }}>
            <Letters text="simmer" />
          </p>
          <p className={`${s.amarante} ${s.rise}`} style={{ ...i(8), fontSize: 'clamp(1.5rem, 3.6vw, 2.3rem)', margin: '1.2rem 0 0' }}>
            simmer down.
          </p>
          <span aria-hidden="true" className={s.rule} style={{ width: 'min(14rem, 50%)', margin: '3.4rem auto 3rem', opacity: 0.35 }} />
        </Reveal>
        <Reveal as="p" className={s.amarante} style={{ fontSize: 'clamp(1.7rem, 4.6vw, 3.2rem)', lineHeight: 1.18, margin: '0 auto', maxWidth: '48rem' }}>
          <Line i={0}>small plates, to share.</Line>
          <Line i={1}>mocktails, stirred slow.</Line>
          <Line i={2}>a dark room below stackd.</Line>
          <Line i={3}>tuesday to sunday,</Line>
          <Line i={4}>seven till late.</Line>
        </Reveal>
      </section>

      {/* ── 3. TONIGHT'S SERVICE ─────────────────────────────────────────
          Bone ground. The date is the room's service night, live. */}
      <section data-ground="bone" className={s.bone} aria-labelledby="simmer-tonight"
               style={{ padding: `clamp(3.5rem, 8vh, 5.5rem) ${pad} clamp(3rem, 7vh, 5rem)` }}>
        <div style={{ maxWidth: 'clamp(42rem, 72vw, 60rem)', margin: '0 auto' }}>
          <Eyebrow id="simmer-tonight" title="tonight's service" aside={service.stamp} />
          <div style={{ height: '2.6rem' }} />
          <Itinerary spaceImage={conceptHeroImage(concept)} />
        </div>
      </section>

      {/* ── 4. WHAT'S NEXT ───────────────────────────────────────────────
          A short note from the kitchen, read by candlelight. The candle is
          the one orange here. */}
      <section aria-labelledby="simmer-next" style={{ padding: `clamp(5rem, 12vh, 8rem) ${pad}` }}>
        <div style={{ maxWidth: '52rem', margin: '0 auto' }}>
          <Eyebrow id="simmer-next" title="what's next" aside={service.stamp} />
          <Reveal className={s.noteGrid}>
            <div className={s.noteCandle}>
              <Candle height={190} />
            </div>
            <div>
              <p className={s.note} style={{
                fontFamily: 'var(--simmer-body)', fontSize: 'clamp(1.08rem, 1.6vw, 1.25rem)',
                lineHeight: 1.8, letterSpacing: '0.02em', margin: 0,
              }}>
                <span className={s.sentence} style={i(0)}>We&apos;re testing a stone-fruit dessert for late June. </span>
                <span className={s.sentence} style={i(1)}>Apricots came in two weeks early this year. </span>
                <span className={s.sentence} style={i(2)}>The pastry team has been pulling late nights. </span>
                <span className={s.sentence} style={i(3)}>If you sit again in three weeks, it might be on the table.</span>
              </p>
              <p className={`${s.amarante} ${s.sentence}`} style={{ ...i(5), fontSize: '1.1rem', marginTop: '2rem', color: 'rgba(237,230,211,0.85)' }}>
                — the simmer team
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <hr aria-hidden="true" style={{ height: 1, border: 0, margin: 0, background: 'rgba(237,230,211,0.2)' }} />

      {/* ── 5. FIND THE DOOR ─────────────────────────────────────────────
          Where, when, and whether the kitchen is on right now. */}
      <section aria-labelledby="simmer-door" style={{ padding: `clamp(4.5rem, 11vh, 7rem) ${pad}` }}>
        <div style={{ maxWidth: '60rem', margin: '0 auto' }}>
          <Eyebrow
            id="simmer-door"
            title="find the door"
            aside={<><span aria-hidden="true" className={service.open ? s.pilotBone : s.pilotOff} />{service.status}</>}
          />
          <Reveal className={s.doorGrid} style={{ marginTop: '2.6rem' }}>
            <div>
              <p className={s.amarante} style={{ fontSize: 'clamp(2rem, 5vw, 3.4rem)', lineHeight: 1.08, margin: 0 }}>
                <Line i={0}>below stackd,</Line>
                <Line i={1}>{area.toLowerCase()}.</Line>
              </p>
              <p className={s.rise} style={{ ...i(2), fontSize: '1.05rem', lineHeight: 1.75, margin: '1.6rem 0 0', maxWidth: '30rem' }}>
                Walk into stackd and look for the walk-in door. It is ours.
              </p>
              <div className={s.rise} style={{ ...i(3), display: 'flex', flexWrap: 'wrap', gap: '0.2rem 2rem', marginTop: '1.2rem' }}>
                <a href={mapsHref} target="_blank" rel="noopener noreferrer" className={`${s.draw} ${s.utility}`}>
                  get directions<span aria-hidden="true" className={s.arrow}>→</span>
                  <span className={s.srOnly}> (opens in a new tab)</span>
                </a>
                <Link href={`/reserve/${concept.slug}`} className={`${s.draw} ${s.utility}`}>
                  reserve a table<span aria-hidden="true" className={s.arrow}>→</span>
                </Link>
                <Link href={`/brand/${concept.slug}/menu`} className={`${s.draw} ${s.utility}`}>
                  read the menu<span aria-hidden="true" className={s.arrow}>→</span>
                </Link>
              </div>
            </div>
            <div className={s.rise} style={i(2)}>
              <dl className={s.hours}>
                <dt className={s.utility}>dinner</dt><dd>7:00 pm – 10:30 pm</dd>
                <dt className={s.utility}>late</dt><dd>10:30 pm – 2:30 am</dd>
                <dt className={s.utility}>nights</dt><dd>tuesday to sunday</dd>
                <dt className={s.utility}>monday</dt><dd>closed</dd>
              </dl>
            </div>
          </Reveal>

          {/* Elsewhere — off-platform reach. */}
          <div style={{ marginTop: 'clamp(3.5rem, 8vh, 5rem)' }}>
            <Eyebrow id="simmer-elsewhere" title="elsewhere" aside="@simmer_down" />
            <ul className={s.icons} style={{ marginTop: '1.2rem' }}>
              <Outbound label="simmer on instagram (opens in a new tab)" href="https://instagram.com/simmer_down" icon={ICONS.instagram} />
              <Outbound label="simmer on tiktok (opens in a new tab)" href="https://tiktok.com/@simmer_down" icon={ICONS.tiktok} />
              <Outbound label="simmer on facebook (opens in a new tab)" href="https://facebook.com/simmerdown" icon={ICONS.facebook} />
              <Outbound label="message simmer on whatsapp (opens in a new tab)" href={waHref} icon={ICONS.whatsapp} />
              <Outbound label="find simmer on google maps (opens in a new tab)" href={mapsHref} icon={ICONS.maps} />
              <Outbound label="email simmer" href="mailto:hello@eatsimmer.com" icon={ICONS.email} />
            </ul>
          </div>
        </div>
      </section>

      {/* ── 6. OTHER KITCHENS + SIGN-OFF ────────────────────────────────── */}
      <OtherKitchens current={concept} concepts={concepts} />

      <section aria-label="sign-off" style={{ padding: `clamp(5rem, 13vh, 8rem) ${pad} clamp(5rem, 12vh, 7rem)`, textAlign: 'center' }}>
        <Reveal>
          {/* The candle is out: a curl of smoke off the wick. */}
          <div className={s.rise} style={{ display: 'flex', justifyContent: 'center', marginBottom: '2.2rem' }}>
            <Candle lit={false} height={110} interactive />
          </div>
          <p className={`${s.amarante} ${s.rise}`} style={{ ...i(1), fontSize: '1.4rem', margin: 0 }}>simmer</p>
          <p className={s.amarante} style={{ fontSize: 'clamp(3.4rem, 11vw, 6.5rem)', lineHeight: 1, margin: '0.8rem 0 0' }}>
            <Line i={2}>simmer down<span style={{ color: 'var(--simmer-orange)' }}>.</span></Line>
          </p>
        </Reveal>
      </section>
    </div>
  )
}
