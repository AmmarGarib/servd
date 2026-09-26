'use client'
import Link from 'next/link'
import { useCallback, useRef, useState, type CSSProperties } from 'react'
import { emitCrowd } from '../characters/crowdBus'
import type { CharacterKind } from '../characters/types'
import {
  FlipdCrowd,
  OrderLink,
  DoodleBurst,
  DoodleSpeed,
  DoodleSquiggle,
  DoodleStar,
  DoodleSeeds,
  DoodleSpatula,
} from '../brand/flipd/FlipdBits'
import { useBuildProgress } from '../brand/flipd/useFlipdMotion'
import f from '../brand/flipd/flipd.module.css'
import s from '../brand/flipd/hero.module.css'

/**
 * FlipdSpecHero — Flipd's entrance: the burger built to its own spec, in
 * front of a court-side crowd.
 *
 * The idea is unchanged from the brand-book rebuild — the first core value is
 * "The spec is the boss", so the page shows the BUILD SHEET for a burger (a
 * technical drawing with a datum line and numbered callouts) and builds it as
 * you scroll, heel first, the way it is built on the line. The parts are the
 * brand's own artwork, cut out of the badge.
 *
 * What is new is that it is now a show:
 *   - The first frame is never empty. The wordmark drops in letter by letter
 *     and flips over in a wave every few seconds, marker doodles boil on the
 *     sheet, and the order buttons are live immediately.
 *   - Parts fall with tilt and motion streaks, squash as they seat, and the
 *     patty gets a real spatula flip — one and a half turns on the way down.
 *   - The finished stack drops onto the datum, bounces three times, and the
 *     SMASH throws register marks and grease spray; the sheet shakes, steam
 *     rises, an inspection stamp slams on.
 *   - The crowd (fries, burger, shake) stands on the counter along the bottom
 *     and watches: each seated part gets one of them hopping, the smash gets
 *     all of them cheering, and hovering Order winds them up.
 *
 * Mechanics: one tall section with a pinned child. useBuildProgress writes
 * --scroll-progress on the section and CSS does the motion off it, so
 * scrolling never re-renders React; React state changes only when progress
 * crosses a mark (a part seats, the burger lands) — a handful of renders per
 * pass, not one per frame.
 *
 * prefers-reduced-motion: the whole thing renders built, landed and static,
 * with every callout and the stamp visible, and the pinned scroll removed.
 */

interface Props {
  brandName: string
  orderHref: string
  menuHref: string
  /** Shown under the build, above the order buttons. */
  tagline: string
}

interface Part {
  /** Callout number — the BUILD step, so 01 is the heel at the bottom. */
  no: string
  name: string
  /** One line, verbatim from the menu sheet or the brand book. */
  spec: string
  art: 'crown' | 'lettuce' | 'wing' | 'patty' | 'heel'
  side: 'left' | 'right'
  /** Scroll progress at which this part starts to fall. */
  fire: number
  /** The part's own width as a fraction of the widest piece (real PNG widths). */
  w: number
  /** Start height above its slot, as a multiple of the drawing's width. */
  drop: number
  /** Degrees of spin about X on the way down. Only the patty flips. */
  flip?: number
  /** Degrees of in-plane tilt at the top of the fall, straightened on landing. */
  tilt: number
  /** Which member of the crowd hops when this part seats. */
  cheer: CharacterKind
}

// Crown-first for the vertical layout; built heel-first (the numbers are
// build steps). Every spec line is a fact already published on the menu
// sheet or in the brand book — the voice rule is "names the ingredient,
// skips the adjective".
const PARTS: Part[] = [
  { no: '05', name: 'Crown', spec: 'Brioche.',                       art: 'crown',   side: 'left',  fire: 0.460, w: 0.884, drop: -0.34, tilt: -9,  cheer: 'burger' },
  { no: '04', name: 'Jam',   spec: 'Shroom & onion. House made.',    art: 'lettuce', side: 'right', fire: 0.355, w: 0.957, drop: -0.50, tilt: 11,  cheer: 'shake' },
  { no: '03', name: 'Aioli', spec: 'Chimichurri. Roasted garlic.',   art: 'wing',    side: 'left',  fire: 0.250, w: 1.000, drop: -0.61, tilt: -7,  cheer: 'fries' },
  { no: '02', name: 'Patty', spec: 'Salt and pepper. Nothing else.', art: 'patty',   side: 'right', fire: 0.145, w: 0.803, drop: -0.68, tilt: 6,   cheer: 'burger', flip: 540 },
  { no: '01', name: 'Heel',  spec: 'Brioche.',                       art: 'heel',    side: 'left',  fire: 0.040, w: 0.861, drop: -0.75, tilt: -5,  cheer: 'fries' },
]
const BUILD_ORDER = [...PARTS].reverse()

/** Each part's fall spans 1/RATE of the scroll. */
const RATE = 6

/** 0..1 for one window of the scroll, as a CSS expression. */
const seat = (fire: number, rate = RATE) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${fire}) * ${rate}))`

/** A 0..1..0 pulse: rises over the first window, falls over the second. */
const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${seat(up, upRate)} - ${seat(down, downRate)})`

/** A parabola 0..1..0 across one window — a bounce under gravity. */
const hump = (from: number, to: number) => {
  const r = `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${(1 / (to - from)).toFixed(3)}))`
  return `(4 * ${r} * (1 - ${r}))`
}

// The drop and the bounce. The crown seats at 0.627; nothing moves until 0.76
// — a beat looking at a finished burger — then it falls, hits at 0.8267 and
// bounces three times, each smaller, each with its own squash.
const FALL_AT = 0.76
const HIT_AT = 0.8267
const fall = seat(FALL_AT, 15)
const b1 = hump(HIT_AT, 0.868)
const b2 = hump(0.868, 0.898)
const b3 = hump(0.898, 0.918)
const bounce = `calc(${b1} * 0.38 + ${b2} * 0.15 + ${b3} * 0.055)`
const stretch = `calc(${b1} * 0.55 + ${b2} * 0.3 + ${b3} * 0.12)`
const squash = `calc(${pulse(0.82, 150, HIT_AT, 26)} + ${pulse(0.8635, 220, 0.868, 40)} * 0.45 + ${pulse(0.8955, 400, 0.898, 70)} * 0.18)`
const hit = pulse(0.82, 150, HIT_AT, 26)
/** Runs 0 → 1 once, starting at impact: drives the grease spray. */
const spray = seat(HIT_AT, 11)
/** The wordmark clears before the heel reaches it. */
const markGone = seat(0.02, 14)

/** Where each part has fully seated, in build order (heel → crown). */
const SEAT_MARKS = BUILD_ORDER.map((p) => p.fire + 1 / RATE)
/** [build started, ...each part seated, burger hit the datum] */
const MARKS = [0.02, ...SEAT_MARKS, HIT_AT]

// The register marks struck at impact, as angles off the vertical.
const TICKS = [-78, -58, -38, -18, 18, 38, 58, 78]
// Grease spray: [dx, dy, size]. Mostly outward and up; gravity is in the CSS.
const DOTS: [number, number, number][] = [
  [-150, -60, 8], [-118, -96, 6], [-84, -118, 9], [-40, -86, 5], [-190, -24, 6],
  [150, -56, 8], [112, -104, 7], [70, -124, 6], [36, -90, 9], [196, -30, 6],
  [-128, -30, 5], [132, -26, 5],
]

function Stamp() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden>
      <defs>
        <path id="flipd-stamp-ring" d="M60 60 m-44 0 a44 44 0 1 1 88 0 a44 44 0 1 1 -88 0" />
      </defs>
      <circle cx="60" cy="60" r="56" fill="#F9F0E1" stroke="#294375" strokeWidth="4" />
      <circle cx="60" cy="60" r="33" fill="none" stroke="#294375" strokeWidth="2" />
      <text fill="#294375" fontFamily="Poppins, system-ui, sans-serif" fontWeight="700" fontSize="10.5" letterSpacing="2.6">
        <textPath href="#flipd-stamp-ring">SAME BURGER · EVERY TIME · SAME BURGER · EVERY TIME ·</textPath>
      </text>
      <text x="60" y="57" textAnchor="middle" fill="#294375" fontFamily="'Alfa Slab One', Georgia, serif" fontSize="15">
        SMASHED
      </text>
      <text x="60" y="73" textAnchor="middle" fill="#294375" fontFamily="Poppins, system-ui, sans-serif" fontWeight="700" fontSize="9" letterSpacing="2">
        TO SPEC
      </text>
    </svg>
  )
}

export function FlipdSpecHero({ brandName, orderHref, menuHref, tagline }: Props) {
  const [started, setStarted] = useState(false)
  const [landed, setLanded] = useState(false)
  const [excited, setExcited] = useState(false)
  const [jiggling, setJiggling] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // Point the crowd's eyes at the burger (they go back to the cursor on the
  // next real pointer move).
  const glance = useCallback(() => {
    const r = stageRef.current?.getBoundingClientRect()
    if (r) emitCrowd({ type: 'look', x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }, [])

  const ref = useBuildProgress<HTMLElement>(MARKS, (i, forward) => {
    if (i === 0) { setStarted(forward); return }
    if (i === MARKS.length - 1) {
      setLanded(forward)
      if (forward) { glance(); emitCrowd({ type: 'cheer' }) }
      return
    }
    if (forward) {
      glance()
      const part = BUILD_ORDER[i - 1]
      if (part) emitCrowd({ type: 'cheer', kind: part.cheer })
    }
  })

  function onStageClick() {
    if (!landed || jiggling) return
    setJiggling(true)
    emitCrowd({ type: 'cheer' })
    window.setTimeout(() => setJiggling(false), 640)
  }

  const excitement = excited ? 1 : landed ? 0.55 : started ? 0.3 : 0.1
  const letters = Array.from(brandName)

  return (
    <>
      <section ref={ref} className={s.hero} aria-labelledby="flipd-hero-title">
        <div className={`${s.pin} ${landed ? s.landed : ''}`}>
          <div className={s.title}>
            <span className={s.titleNo}>Build sheet</span>
            <span className={s.titleRule} aria-hidden />
            <span className={s.titleNo}>Same, every time</span>
          </div>

          <div className={s.doodles} aria-hidden>
            <DoodleBurst className={`${s.d1} ${f.float}`} />
            <DoodleSpeed className={s.d2} />
            <DoodleSpeed className={s.d3} />
            <DoodleSquiggle className={`${s.d4} ${f.float}`} />
            <DoodleStar className={`${s.d5} ${f.float}`} />
            <DoodleSpatula className={s.d6} />
            <DoodleSeeds className={s.d7} />
          </div>

          <div className={s.field}>
            <div
              ref={stageRef}
              className={`${s.stage} ${jiggling ? s.jiggle : ''}`}
              onClick={onStageClick}
              style={{
                ['--fall' as string]: fall,
                ['--hit' as string]: hit,
                ['--bounce' as string]: bounce,
                ['--stretch' as string]: stretch,
                ['--squash' as string]: squash,
              }}
            >
              {PARTS.map((part, i) => {
                const seatEnd = part.fire + 1 / RATE
                return (
                  <div
                    key={part.no}
                    className={`${s.part} ${part.side === 'left' ? s.left : s.right}`}
                    style={{
                      ['--t' as string]: seat(part.fire),
                      ['--w' as string]: `${(part.w * 100).toFixed(1)}%`,
                      ['--drop' as string]: part.drop,
                      ['--land' as string]: pulse(seatEnd - 0.012, 84, seatEnd, 28),
                      // Upper layers paint over lower ones.
                      zIndex: PARTS.length - i,
                    }}
                  >
                    <div className={s.callout} aria-hidden>
                      <span className={s.no}>{part.no}</span>
                      <span className={s.lead} />
                      <span className={s.text}>
                        <span className={s.name}>{part.name}</span>
                        <span className={s.sub}>{part.spec}</span>
                      </span>
                    </div>
                    {/* Hover spreads the finished stack into an exploded view:
                        crown furthest, heel not at all. */}
                    <div className={s.spread} style={{ ['--k' as string]: PARTS.length - 1 - i }}>
                      <div
                        className={s.art}
                        style={{
                          ['--flip' as string]: `${part.flip ?? 0}deg`,
                          ['--tilt' as string]: `${part.tilt}deg`,
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/brand/parts/${part.art}.png`} alt="" aria-hidden="true" />
                      </div>
                    </div>
                  </div>
                )
              })}

              <div className={s.steam} aria-hidden>
                {[0, 1, 2].map((k) => (
                  <svg key={k} className={s.wisp} viewBox="0 0 20 80" preserveAspectRatio="none">
                    <path d="M10 78 C 2 64, 18 54, 10 40 S 2 16, 10 2" />
                  </svg>
                ))}
              </div>

              <div className={s.intro} style={{ ['--t' as string]: markGone }}>
                <h1 id="flipd-hero-title" className={s.mark}>
                  <span className={f.srOnly}>{brandName}</span>
                  <span aria-hidden>
                    {letters.map((ch, i) => (
                      <span key={`${ch}-${i}`} className={s.letter} style={{ '--i': i } as CSSProperties}>
                        <span className={s.letterIn} style={{ '--i': i } as CSSProperties}>{ch}</span>
                      </span>
                    ))}
                  </span>
                </h1>
                <span className={s.hint} aria-hidden>
                  Scroll to build it
                  <svg viewBox="0 0 24 24"><path d="M12 4v15M6 13l6 6 6-6" /></svg>
                </span>
              </div>
            </div>

            <div className={s.datum} style={{ ['--hit' as string]: hit, ['--spray' as string]: spray }} aria-hidden>
              <span className={s.datumRule} />
              {TICKS.map((a) => (
                <span key={a} className={s.tick} style={{ ['--a' as string]: `${a}deg` }} />
              ))}
              {DOTS.map(([dx, dy, sz], k) => (
                <span
                  key={k}
                  className={s.dot}
                  style={{ ['--dx' as string]: `${dx}px`, ['--dy' as string]: `${dy}px`, ['--sz' as string]: `${sz}px` }}
                />
              ))}
            </div>

            <div className={s.stamp} aria-hidden>
              <Stamp />
            </div>
          </div>

          <div className={s.outro}>
            <p className={s.tagline}>{tagline}</p>
            <div className={f.ctaRow}>
              <OrderLink href={orderHref} onExcite={setExcited}>Order now</OrderLink>
              <Link href={menuHref} className={`${f.btn} ${f.btnGhost}`}>See the menu</Link>
            </div>
          </div>

          <FlipdCrowd className={s.crowd} excitement={excitement} />
        </div>
      </section>

      {/* The written build. The callouts are aria-hidden so a screen reader
          gets this copy and not both; on narrow screens it is also the
          visible one, because callouts do not fit beside the drawing. */}
      <ol className={s.list} aria-label={`How a ${brandName} burger is built`}>
        {BUILD_ORDER.map((p) => (
          <li key={p.no} className={s.listItem}>
            <span className={s.no}>{p.no}</span>
            <span className={s.name}>{p.name}</span>
            <span className={s.sub}>{p.spec}</span>
          </li>
        ))}
      </ol>
    </>
  )
}
