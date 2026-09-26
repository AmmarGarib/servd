'use client'
/**
 * SpeakeasyFridgeHero — simmer's web entrance, mirroring the physical one.
 *
 * IRL: simmer is below stackd. The way in, inside stackd, looks like a
 * walk-in chiller door: no sign, no label. People who know, know. They pull
 * the handle and it opens onto the stairs down.
 *
 * On the web it plays like the opening of a film, driven only by scroll:
 *
 *   1. The closed door, drawn as an architect's sheet — tiber paper, bone
 *      line work, the title block and dimensions. Condensation beads and runs
 *      on the view pane. The only orange is the chiller's pilot light,
 *      breathing above the frame.
 *   2. The handle turns down. The seal breaks — the door jumps a few degrees
 *      ajar and cold air spills out and rolls along the floor (flat bone
 *      wisps, low opacity, drifting).
 *   3. The door swings, heavy: slow to start, slow to settle, with a real
 *      edge so it has thickness. The pilot light goes out.
 *   4. Inside, the back wall of the chiller is a false wall. A narrow door in
 *      it opens onto stairs going down, and at the bottom a candle is lit —
 *      the orange now lives there.
 *   5. The titles set, line by line: tonight's date, then "reservations" /
 *      "only.", then reserve / menu, then the hours on the floor.
 *
 * Bible: no gradients anywhere (the grid is an SVG pattern, the steel is two
 * rules, there is no vignette, no glow, no text-shadow), no white, one orange
 * per moment, Amarante + Times, lowercase.
 *
 * Reduced motion: no runway, no swing, no loops — one screen, door open,
 * candle lit, links live.
 */

import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Candle } from '../brand/simmer/Candle'
import { useService } from '../brand/simmer/serviceClock'
import h from '../brand/simmer/hero.module.css'
import s from '../brand/simmer/simmer.module.css'

interface Props {
  brandName: string
  reserveHref: string
  /** Optional menu link for inside-the-speakeasy navigation. */
  menuHref?: string
  /** Opening hours as the floor sticker reads them. */
  hoursLine?: string
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const seg = (p: number, a: number, b: number) => clamp01((p - a) / (b - a))
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/**
 * Scroll → eased phases, written as custom properties on the section. One
 * rAF per scroll frame, no React re-render except when the links cross their
 * live threshold (so they are hidden — out of the tab order and hit-testing —
 * until they are actually on screen).
 */
function useWalkIn() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [live, setLive] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const pin = el.firstElementChild as HTMLElement | null
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let raf = 0

    const apply = (p: number) => {
      const handle = easeOut(seg(p, 0.02, 0.1))
      const crack = easeOut(seg(p, 0.09, 0.16))
      const swing = easeInOut(seg(p, 0.16, 0.62))
      const door = crack * 7 + swing * 113
      const vapor = seg(p, 0.1, 0.22) * (1 - 0.5 * seg(p, 0.6, 0.8))
      const vars: Record<string, number> = {
        '--handle': handle,
        '--door': door,
        '--vapor': vapor,
        '--inside': seg(p, 0.08, 0.17),
        '--pilot': 1 - seg(p, 0.14, 0.26),
        '--flame': easeOut(seg(p, 0.44, 0.58)),
        '--l0': seg(p, 0.5, 0.6),
        '--l1': easeOut(seg(p, 0.53, 0.65)),
        '--l2': easeOut(seg(p, 0.58, 0.7)),
        '--cta': easeOut(seg(p, 0.65, 0.77)),
        '--floor': seg(p, 0.72, 0.84),
        '--cue': 1 - seg(p, 0.02, 0.1),
      }
      for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v.toFixed(4))
      const now = p >= 0.65
      setLive((prev) => (prev === now ? prev : now))
    }

    const update = () => {
      raf = 0
      if (mq?.matches || !pin) { apply(1); return }
      const rect = el.getBoundingClientRect()
      const stickTop = parseFloat(getComputedStyle(pin).top) || 0
      const total = rect.height - pin.offsetHeight
      apply(total > 0 ? clamp01((stickTop - rect.top) / total) : 1)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }

    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    mq?.addEventListener?.('change', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      mq?.removeEventListener?.('change', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  return { ref, live }
}

export function SpeakeasyFridgeHero({
  brandName, reserveHref, menuHref,
  hoursLine = 'open 7pm — late · tue–sun',
}: Props) {
  const { ref, live } = useWalkIn()
  const { stamp } = useService()

  return (
    <section ref={ref} className={h.walkin} aria-labelledby="simmer-walkin-title">
      <div className={h.pin}>
        <BlueprintGrid />

        {/* Title blocks — drawing furniture, hidden from screen readers. */}
        <div aria-hidden="true" className={`${h.block} ${h.blockTL}`}>
          <p className={h.hideSm}>· project</p>
          <p className={h.strong}>{brandName} · below stackd</p>
          <p className={h.hideSm} style={{ marginTop: '0.4rem' }}>· sheet a-02 / entrance</p>
        </div>
        <div aria-hidden="true" className={`${h.block} ${h.blockTR}`}>
          <p className={h.hideSm}>scale 1 : 24</p>
          <p className={h.hideSm} suppressHydrationWarning>rev · {new Date().getFullYear()}.09</p>
          <p className={h.cue} style={{ marginTop: '0.4rem' }}>
            <span className={h.strong}>scroll to open</span>
            <span className={h.cueLine} />
          </p>
        </div>

        {/* THE DOORWAY. Back to front: interior, cold air, door, frame, titles. */}
        <div className={h.stage}>
          <Thermometer />

          <div aria-hidden="true" className={h.interior}>
            <CoolerInteriorSVG />
            <div className={h.candleSpot}>
              <Candle fluid />
            </div>
          </div>

          <Vapor />

          <div className={h.door}>
            <div aria-hidden="true" className={h.face}>
              <BlueprintCoolerDoor />
            </div>
            <div aria-hidden="true" className={h.edge} />
            <div aria-hidden="true" className={`${h.face} ${h.inner}`}>
              <BlueprintDoorInside />
            </div>
          </div>

          <div aria-hidden="true" className={h.frame}>
            <span className={h.bolt} style={{ top: 3, left: 3 }} />
            <span className={h.bolt} style={{ top: 3, right: 3 }} />
            <span className={h.bolt} style={{ bottom: 3, left: 3 }} />
            <span className={h.bolt} style={{ bottom: 3, right: 3 }} />
          </div>

          {/* The titles. Real text (not inside the aria-hidden drawing), so a
              screen reader gets the heading, the date, the links and the
              hours in order. */}
          <div className={h.titles}>
            <p className={h.stamp} suppressHydrationWarning>tonight · {stamp}</p>
            <h2 id="simmer-walkin-title" className={h.headline}>
              <span className={h.hLine}><span style={{ ['--t' as string]: 'var(--l1)' } as CSSProperties}>reservations</span></span>
              {' '}
              <span className={h.hLine}><span style={{ ['--t' as string]: 'var(--l2)' } as CSSProperties}>only.</span></span>
            </h2>
            <div className={h.ctas} style={{ visibility: live ? 'visible' : 'hidden' }}>
              <Link href={reserveHref} className={s.btnSolid}>reserve a table</Link>
              {menuHref && <Link href={menuHref} className={s.btn}>the menu</Link>}
            </div>
            <p className={h.floor}>{hoursLine}</p>
          </div>
        </div>

        <div aria-hidden="true" className={`${h.block} ${h.blockBottom}`}>
          <span>↳ door · 1900 × 800 mm</span>
          <span className={h.hideSm}>entrance · members only</span>
          <span className={h.hideSm}>wic-002 · −2.4°c</span>
        </div>
      </div>
    </section>
  )
}

// ─── The sheet: 40px minor + 200px major grid as an SVG pattern ─────────
// (Was a stack of linear-gradients; this is the same drawing with no
// gradient function anywhere.)
function BlueprintGrid() {
  return (
    <svg aria-hidden="true" className={h.grid} focusable="false">
      <defs>
        <pattern id="simmer-grid-minor" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0 H0 V40" fill="none" stroke="var(--simmer-bone)" strokeOpacity="0.06" strokeWidth="1" />
        </pattern>
        <pattern id="simmer-grid-major" width="200" height="200" patternUnits="userSpaceOnUse">
          <rect width="200" height="200" fill="url(#simmer-grid-minor)" />
          <path d="M200 0 H0 V200" fill="none" stroke="var(--simmer-bone)" strokeOpacity="0.1" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#simmer-grid-major)" />
    </svg>
  )
}

// ─── Thermometer + the pilot light ──────────────────────────────────────
function Thermometer() {
  return (
    <div aria-hidden="true" className={h.thermo}>
      <div className={h.thermoBody}>
        <span>wic-002</span>
        <span className={h.readout}>−2.4°c</span>
      </div>
      <span className={h.pilotWrap}>
        <span className={h.pilotRing} />
        <span className={h.pilot} />
      </span>
    </div>
  )
}

// ─── Cold air ───────────────────────────────────────────────────────────
// Flat bone ribbons at 8–14% opacity, hugging the floor: cold air falls
// out of the seal and rolls sideways across the ground.
function Vapor() {
  const w = (i: number, d: string, dx: string): CSSProperties =>
    ({ ['--i' as string]: i, ['--d' as string]: d, ['--dx' as string]: dx } as CSSProperties)
  return (
    <>
      <div aria-hidden="true" className={h.vapor}>
        <svg viewBox="0 0 400 100" preserveAspectRatio="none" focusable="false">
          <g fill="var(--simmer-bone)">
            <path className={h.wisp} style={w(0, '11s', '18px')} opacity="0.08"
                  d="M0 88 C 60 80, 120 84, 180 86 C 240 88, 300 80, 400 84 C 330 91, 250 95, 180 93 C 110 91, 50 95, 0 88 Z" />
            <path className={h.wisp} style={w(1, '9s', '-16px')} opacity="0.12"
                  d="M40 76 C 90 69, 150 71, 205 76 C 170 80, 110 81, 40 76 Z" />
            <path className={h.wisp} style={w(2, '13s', '22px')} opacity="0.1"
                  d="M205 69 C 250 62, 310 64, 362 70 C 320 74, 258 75, 205 69 Z" />
            <path className={h.wisp} style={w(3, '10s', '-20px')} opacity="0.14"
                  d="M100 96 C 170 89, 262 91, 332 97 C 262 100, 170 100, 100 96 Z" />
            <path className={h.wisp} style={w(4, '12s', '14px')} opacity="0.09"
                  d="M150 61 C 180 57, 216 58, 244 62 C 216 65, 180 65, 150 61 Z" />
          </g>
        </svg>
      </div>
    </>
  )
}

// ─── Line colours for the drawings ──────────────────────────────────────
const LINE = 'rgba(237,230,211,0.85)'
const FINE = 'rgba(237,230,211,0.45)'
const DIM = 'rgba(237,230,211,0.3)'
// Secondary annotation text. Kept at 0.72 (6.2:1 on tiber) — visible small
// text never drops to the line-work opacities.
const SUB = 'rgba(237,230,211,0.72)'
const LABEL = '#EDE6D3'
const TYPE = { fontFamily: 'var(--simmer-body)', letterSpacing: '2.5' } as const

// ─── The door's INSIDE face ─────────────────────────────────────────────
// Plain, as a walk-in door's inside is: the panel, the gasket that seals it,
// and the safety release. Same 600 × 880 viewbox as the front.
function BlueprintDoorInside() {
  return (
    <svg viewBox="0 0 600 880" preserveAspectRatio="xMidYMid meet" focusable="false"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
      <GridFill />
      <rect x="40" y="40" width="520" height="800" fill="none" stroke={LINE} strokeWidth="1.5" />
      <rect x="62" y="62" width="476" height="756" fill="none" stroke={FINE} strokeWidth="1" strokeDasharray="6 4" rx="3" />
      <rect x="86" y="86" width="428" height="708" fill="none" stroke={FINE} strokeWidth="0.7" strokeDasharray="2 3" />
      <circle cx="120" cy="446" r="22" fill="none" stroke={LINE} strokeWidth="1.5" />
      <circle cx="120" cy="446" r="9" fill="none" stroke={LINE} strokeWidth="1" />
      <line x1="142" y1="446" x2="200" y2="446" stroke={FINE} strokeWidth="0.8" />
      <text x="206" y="442" fill={LABEL} fontSize="12" {...TYPE}>06 — safety release</text>
      <text x="206" y="458" fill={SUB} fontSize="10" {...TYPE}>interior · push to open</text>
    </svg>
  )
}

// Flat grid for the door faces (they are opaque, so the page grid can't show
// through). Same pattern ids as the page grid.
function GridFill() {
  return <rect x="-2000" y="-2000" width="4600" height="4880" fill="url(#simmer-grid-major)" />
}

// ─── The door's FRONT face ──────────────────────────────────────────────
function BlueprintCoolerDoor() {
  // Droplets of condensation on the pane: [cx, cy, r].
  const beads: Array<[number, number, number]> = [
    [172, 196, 2.2], [214, 182, 1.4], [251, 228, 2.8], [296, 190, 1.6], [338, 214, 2.1],
    [381, 186, 1.3], [418, 236, 2.4], [190, 262, 1.5], [236, 286, 2.0], [284, 256, 1.2],
    [322, 282, 2.6], [362, 262, 1.5], [404, 290, 1.8], [432, 204, 1.1], [168, 292, 1.2],
  ]
  return (
    <svg viewBox="0 0 600 880" preserveAspectRatio="xMidYMid meet" focusable="false"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
      <defs>
        <clipPath id="simmer-pane"><rect x="150" y="170" width="300" height="140" rx="2" /></clipPath>
      </defs>
      <GridFill />

      {/* Panel + stainless trim */}
      <rect x="40" y="40" width="520" height="800" fill="none" stroke={LINE} strokeWidth="2" rx="4" />
      <rect x="56" y="56" width="488" height="768" fill="none" stroke={LINE} strokeWidth="1.2" rx="3" />
      {([[60, 60], [528, 60], [60, 808], [528, 808]] as Array<[number, number]>).map(([x, y], i) => (
        <g key={i} stroke={FINE} strokeWidth="0.7">
          <line x1={x} y1={y} x2={x + 12} y2={y + 12} />
          <line x1={x + 4} y1={y} x2={x + 12} y2={y + 8} />
          <line x1={x} y1={y + 4} x2={x + 8} y2={y + 12} />
        </g>
      ))}

      {/* Hinges */}
      {[150, 440, 690].map((y, i) => (
        <g key={i}>
          <rect x="24" y={y} width="40" height="56" fill="none" stroke={LINE} strokeWidth="1.4" rx="2" />
          <circle cx="44" cy={y + 16} r="6" fill="none" stroke={LINE} strokeWidth="1.2" />
          <circle cx="44" cy={y + 40} r="6" fill="none" stroke={LINE} strokeWidth="1.2" />
          <line x1="44" y1={y + 4} x2="44" y2={y + 52} stroke={FINE} strokeWidth="0.7" strokeDasharray="2 2" />
          {i === 0 && (
            <>
              <line x1="22" y1={y + 28} x2="-30" y2={y + 28} stroke={FINE} strokeWidth="0.7" />
              <text x="-34" y={y + 26} fill={LABEL} fontSize="12" textAnchor="end" {...TYPE}>03 — hinge</text>
              <text x="-34" y={y + 42} fill={SUB} fontSize="10" textAnchor="end" {...TYPE}>heavy-duty × 3</text>
            </>
          )}
        </g>
      ))}

      {/* View pane, fogged: beads of condensation and two slow runs. */}
      <g>
        <rect x="140" y="160" width="320" height="160" fill="none" stroke={LINE} strokeWidth="1.6" rx="3" />
        <rect x="150" y="170" width="300" height="140" fill="none" stroke={FINE} strokeWidth="1" rx="2" strokeDasharray="3 2" />
        <g clipPath="url(#simmer-pane)">
          <rect x="150" y="170" width="300" height="140" fill="var(--simmer-bone)" opacity="0.05" />
          {beads.map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="var(--simmer-bone)" opacity={0.28 + (i % 3) * 0.08} />
          ))}
          {([[262, 178], [372, 174]] as Array<[number, number]>).map(([x, y], i) => (
            <g key={`d${i}`} className={h.drip} style={{ ['--i' as string]: i } as CSSProperties}>
              <line x1={x} y1={y - 18} x2={x} y2={y} stroke="var(--simmer-bone)" strokeOpacity="0.35" strokeWidth="1" />
              <circle cx={x} cy={y + 2} r="2.4" fill="var(--simmer-bone)" opacity="0.55" />
            </g>
          ))}
        </g>
        <line x1="460" y1="240" x2="540" y2="240" stroke={FINE} strokeWidth="0.7" />
        <text x="546" y="238" fill={LABEL} fontSize="12" {...TYPE}>02 — view pane</text>
        <text x="546" y="254" fill={SUB} fontSize="10" {...TYPE}>double-glaze · fogged</text>
      </g>

      {/* Paddle handle — the lever turns down as you begin to scroll. */}
      <g>
        <rect x="320" y="430" width="220" height="80" fill="none" stroke={LINE} strokeWidth="1.4" rx="3" />
        <g style={{ transform: 'rotate(calc(var(--handle, 0) * 16deg))', transformOrigin: '358px 468px' }}>
          <rect x="336" y="454" width="188" height="28" rx="14" fill="var(--simmer-green)" stroke={LABEL} strokeWidth="2" />
          <line x1="378" y1="468" x2="508" y2="468" stroke={FINE} strokeWidth="0.8" />
        </g>
        <circle cx="358" cy="468" r="6.5" fill="var(--simmer-green)" stroke={LABEL} strokeWidth="1.6" />
        <circle cx="358" cy="468" r="2" fill={LABEL} />
        <rect x="436" y="490" width="40" height="14" fill="none" stroke={FINE} strokeWidth="1" rx="2" />
        <circle cx="456" cy="497" r="2.5" fill={FINE} />
        <line x1="540" y1="470" x2="590" y2="470" stroke={FINE} strokeWidth="0.7" />
        <text x="596" y="468" fill={LABEL} fontSize="12" {...TYPE}>01 — paddle handle</text>
        <text x="596" y="484" fill={SUB} fontSize="10" {...TYPE}>pull</text>
      </g>

      {/* Manufacturer plate */}
      <g>
        <rect x="80" y="80" width="190" height="50" fill="none" stroke={LINE} strokeWidth="1" rx="2" />
        <text x="92" y="100" fill={LABEL} fontSize="11" {...TYPE}>wic-002 · provisions</text>
        <text x="92" y="114" fill={SUB} fontSize="9" {...TYPE}>model wic-300 / class c</text>
        <text x="92" y="125" fill={SUB} fontSize="8" {...TYPE}>built 2026 · karachi</text>
      </g>

      {/* Kick plate */}
      <g>
        <rect x="80" y="720" width="440" height="100" fill="none" stroke={LINE} strokeWidth="1.4" rx="2" />
        {[745, 760, 775, 790, 805].map((y) => (
          <line key={y} x1="100" y1={y} x2="500" y2={y} stroke={FINE} strokeWidth="0.5" strokeDasharray="2 4" />
        ))}
        {[[95, 735], [505, 735], [95, 805], [505, 805]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="none" stroke={LINE} strokeWidth="0.9" />
        ))}
        <line x1="520" y1="770" x2="580" y2="770" stroke={FINE} strokeWidth="0.7" />
        <text x="586" y="768" fill={LABEL} fontSize="12" {...TYPE}>04 — kick plate</text>
        <text x="586" y="784" fill={SUB} fontSize="10" {...TYPE}>stainless 16ga</text>
      </g>

      {/* Dimensions */}
      <g stroke={DIM} strokeWidth="0.7">
        <line x1="-18" y1="40" x2="-18" y2="840" />
        <line x1="-22" y1="40" x2="-14" y2="40" />
        <line x1="-22" y1="840" x2="-14" y2="840" />
        <line x1="40" y1="858" x2="560" y2="858" />
        <line x1="40" y1="854" x2="40" y2="862" />
        <line x1="560" y1="854" x2="560" y2="862" />
      </g>
      <text x="-30" y="446" fill={LABEL} fontSize="12" textAnchor="middle" transform="rotate(-90, -30, 446)" {...TYPE}>1900 mm</text>
      <text x="300" y="878" fill={LABEL} fontSize="12" textAnchor="middle" {...TYPE}>800 mm</text>
    </svg>
  )
}

// ─── Inside the chiller ─────────────────────────────────────────────────
// Same hand: a walk-in drawn in one-point perspective, racks on the side
// walls, the evaporator on the ceiling. The back wall is false — a narrow
// door in it opens onto stairs going down, where the candle stands.
function CoolerInteriorSVG() {
  const line = 'rgba(237,230,211,0.62)'
  const fine = 'rgba(237,230,211,0.34)'
  const dim = 'rgba(237,230,211,0.22)'
  return (
    <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" focusable="false"
         style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <rect x="0" y="0" width="1600" height="1000" fill="url(#simmer-grid-major)" />

      {/* Construction lines to the vanishing point */}
      <g stroke={dim} strokeWidth="0.6" strokeDasharray="3 4">
        <line x1="0" y1="0" x2="800" y2="500" />
        <line x1="1600" y1="0" x2="800" y2="500" />
        <line x1="0" y1="1000" x2="800" y2="500" />
        <line x1="1600" y1="1000" x2="800" y2="500" />
      </g>

      {/* Room — the back wall sits low, so the ceiling above it is clear
          for the titles. */}
      <g fill="none" stroke={line} strokeWidth="1.6">
        <polygon points="0,0 1600,0 1060,300 540,300" />
        <polygon points="0,0 540,300 540,700 0,1000" />
        <polygon points="1600,0 1600,1000 1060,700 1060,300" />
        <polygon points="0,1000 1600,1000 1060,700 540,700" />
        <rect x="540" y="300" width="520" height="400" />
      </g>
      <line x1="670" y1="300" x2="670" y2="700" stroke={fine} strokeWidth="0.8" />
      <line x1="930" y1="300" x2="930" y2="700" stroke={fine} strokeWidth="0.8" />

      {/* The false wall's door — dark below, stairs going down. */}
      <rect x="752" y="476" width="96" height="224" fill="var(--simmer-black)" opacity="0.6" />
      <rect x="752" y="476" width="96" height="224" fill="none" stroke={line} strokeWidth="1.4" />
      <g stroke={fine} strokeWidth="1">
        {([[646, 10], [656, 9], [668, 8], [682, 6], [696, 3]] as Array<[number, number]>).map(([y, inset]) => (
          <line key={y} x1={752 + inset} y1={y} x2={848 - inset} y2={y} />
        ))}
      </g>
      {/* The false panel, standing ajar on its hinge side */}
      <polygon points="752,476 730,468 730,708 752,700" fill="var(--simmer-green)" stroke={line} strokeWidth="1.2" />

      {/* Racks on the side walls */}
      <BlueprintRack side="left" lineColor={line} fineColor={fine} />
      <BlueprintRack side="right" lineColor={line} fineColor={fine} />

      {/* Floor dimension */}
      <g stroke={dim} strokeWidth="0.7">
        <line x1="40" y1="970" x2="1560" y2="970" />
        <line x1="40" y1="965" x2="40" y2="975" />
        <line x1="1560" y1="965" x2="1560" y2="975" />
      </g>
    </svg>
  )
}

function BlueprintRack({ side, lineColor, fineColor }: {
  side: 'left' | 'right'
  lineColor: string
  fineColor: string
}) {
  const isLeft = side === 'left'
  const fx1 = isLeft ? 70 : 1130
  const fx2 = isLeft ? 240 : 1300
  const bx1 = isLeft ? 480 : 1120
  const bx2 = isLeft ? 540 : 1060
  const shelves: Array<[number, number]> = [[200, 360], [400, 480], [600, 600], [820, 690]]
  return (
    <g>
      <line x1={fx1} y1="80" x2={fx1} y2="940" stroke={lineColor} strokeWidth="1.4" />
      <line x1={fx2} y1="120" x2={fx2} y2="900" stroke={lineColor} strokeWidth="1.4" />
      <line x1={bx1} y1="330" x2={bx1} y2="700" stroke={fineColor} strokeWidth="1.1" />
      <line x1={bx2} y1="300" x2={bx2} y2="700" stroke={fineColor} strokeWidth="1.1" />
      {shelves.map(([fy, by], i) => (
        <polygon key={i} points={`${fx1},${fy} ${fx2},${fy} ${bx2},${by} ${bx1},${by}`}
                 fill="none" stroke={lineColor} strokeWidth="1.2" />
      ))}
    </g>
  )
}
