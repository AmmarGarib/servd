'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useScrollProgress } from './motionHooks'
import { useIsCoarsePointer, usePrefersReducedMotion } from '../../lib/film/motion'
import { haptic } from '../../lib/haptics'
import { Die } from '../brand/stackd/Die'
import s from '../brand/stackd/slip.module.css'
import ui from '../brand/stackd/ui.module.css'

/**
 * StackdSlipHero — the stackd hero. He stands on the brand's die-cut coaster
 * with a loaf for a head: breathing, the loaf teetering and steaming on the
 * tray, leaning after the cursor, hopping when poked. Scroll, and he slips —
 * he goes down, the bread goes up, and it never comes back. The tagline
 * ("Cooked here. Wrapped, not plated.") gives way to the punchline.
 *
 * The slip needs the drawing in two pieces, which it can be: rows 173-198 of
 * the source PNG are the tray, a solid bar 326px wide, so a cut at y=173 runs
 * exactly along its top edge. Above it, the bread; below it, the guy. See
 * public/brand/stackd/.
 *
 * Choreography, in scroll progress (section is 250vh):
 *   0.00-0.10  standing, alive — idle breathing, cursor lean, steam
 *   0.10-0.32  the slip: he rotates back and drops; the bread holds a beat
 *   0.34-0.44  landing — the coaster squashes, the seals jump off
 *   0.14-1.00  the bread climbs and tumbles out of frame
 *   0.18-0.36  the tagline tips over into "we'll make another."
 *
 * The CTAs are always visible and reachable — nothing here is gated behind
 * the gag. Reduced motion: he stands still, holding it, and nothing pins.
 *
 * Touch twin (phones have no cursor to lean after and no hover to fret
 * over): a tap pokes him — he hops and leans away from your finger, with a
 * short haptic tick — and flinging the page makes him nervous, the loaf
 * wobbling on the tray until the scroll calms down.
 */

interface Props {
  brandName: string
  orderHref: string
  menuHref: string
  mascotAlt: string
  wordmarkSrc: string
  wordmarkDims: { width?: number; height?: number }
  tagline: string
  oneLiner: string
  /** Live open/closed line, rendered under the CTAs. */
  status?: ReactNode
  /**
   * An operator-uploaded mascot (admin -> Marketing -> Brands). It cannot be
   * split into bread + guy at runtime, so it is shown whole — still alive
   * (breathing, leaning), but it does not slip.
   */
  customMascotSrc?: string | null
  customMascotDims?: { width?: number; height?: number }
}

/** 0..1 across a window of the scroll. */
const ramp = (from: number, rate: number) =>
  `max(0, min(1, (var(--scroll-progress, 0) - ${from}) * ${rate}))`
/** A 0..1..0 pulse. */
const pulse = (up: number, upRate: number, down: number, downRate: number) =>
  `max(0, ${ramp(up, upRate)} - ${ramp(down, downRate)})`

// Seals that jump off the landing. x/y in units of his width.
const SEALS = [
  { x: -0.95, y: -0.1, size: '11%', tilt: -14, fire: 0.36 },
  { x: 0.85, y: -0.25, size: '9%', tilt: 11, fire: 0.37 },
  { x: -0.55, y: -0.5, size: '7%', tilt: 8, fire: 0.39 },
  { x: 0.95, y: -0.4, size: '6%', tilt: -19, fire: 0.38 },
  { x: -1.1, y: 0.08, size: '5%', tilt: 16, fire: 0.41 },
]

export function StackdSlipHero({
  brandName, orderHref, menuHref, mascotAlt, wordmarkSrc, wordmarkDims, tagline, oneLiner, status,
  customMascotSrc, customMascotDims,
}: Props) {
  const custom = !!customMascotSrc
  const { ref, progressRef } = useScrollProgress<HTMLElement>()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [nervous, setNervous] = useState(false)
  const [hopping, setHopping] = useState(false)
  const hopTimer = useRef<number | undefined>(undefined)
  const leanTimer = useRef<number | undefined>(undefined)
  const reduced = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()

  // Cursor lean: which side of him the pointer is on, -1..1. Written straight
  // to a CSS variable once per frame; the springy transition does the rest.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (reduced) return
    if (!window.matchMedia('(pointer: fine)').matches) return
    let raf = 0
    let x = 0
    const apply = () => {
      raf = 0
      const r = stage.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return
      const cx = r.left + r.width / 2
      const span = Math.max(260, window.innerWidth / 2)
      const lx = Math.max(-1, Math.min(1, (x - cx) / span))
      stage.style.setProperty('--lx', lx.toFixed(3))
    }
    const onMove = (e: PointerEvent) => {
      x = e.clientX
      if (!raf) raf = requestAnimationFrame(apply)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [reduced])

  // Touch twin of the hover fret: on coarse pointers, a fast fling of the
  // page makes him nervous; he calms down once the scroll settles. Scroll
  // speed is sampled per frame from scrollY (no layout reads) and React only
  // hears about it when he starts or stops fretting.
  useEffect(() => {
    if (!coarse || reduced || custom) return
    let lastY = window.scrollY
    let lastT = performance.now()
    let raf = 0
    let calm: number | undefined
    let fretting = false
    const sample = () => {
      raf = 0
      const now = performance.now()
      const y = window.scrollY
      const dt = Math.max(1, now - lastT)
      const v = Math.abs(y - lastY) / dt // px per ms
      lastY = y
      lastT = now
      // Only while he is still standing; once he has slipped there is
      // nothing left to be nervous about.
      if (v > 1.1 && progressRef.current < 0.12) {
        if (!fretting) { fretting = true; setNervous(true) }
        window.clearTimeout(calm)
        calm = window.setTimeout(() => { fretting = false; setNervous(false) }, 420)
      }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(sample) }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      window.clearTimeout(calm)
    }
  }, [coarse, reduced, custom, progressRef])

  useEffect(() => () => {
    window.clearTimeout(hopTimer.current)
    window.clearTimeout(leanTimer.current)
  }, [])

  // Poke him: a hop, the loaf jumps on the tray. Only while he is standing.
  // A tap also leans him away from the finger (the touch twin of the cursor
  // lean) and gives a short haptic tick.
  const poke = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (progressRef.current > 0.08) return
    if (reduced) return
    haptic(8)
    setHopping(false)
    requestAnimationFrame(() => setHopping(true))
    window.clearTimeout(hopTimer.current)
    hopTimer.current = window.setTimeout(() => setHopping(false), 860)
    const stage = stageRef.current
    if (stage && !window.matchMedia('(pointer: fine)').matches) {
      const r = stage.getBoundingClientRect()
      const side = e.clientX < r.left + r.width / 2 ? 1 : -1
      stage.style.setProperty('--lx', (side * 0.85).toFixed(2))
      window.clearTimeout(leanTimer.current)
      leanTimer.current = window.setTimeout(() => stage.style.setProperty('--lx', '0'), 520)
    }
  }, [progressRef, reduced])

  const pinVars = {
    '--s': ramp(0.1, 4.5),
    '--toss': ramp(0.14, 1.2),
    '--impact': pulse(0.33, 20, 0.37, 12),
    '--swap': ramp(0.17, 7),
    '--hintOut': ramp(0.02, 14),
  } as CSSProperties

  const stageClass = [s.stage, nervous ? s.nervous : '', hopping ? s.hopping : ''].filter(Boolean).join(' ')

  return (
    <section ref={ref} className={`${s.hero} ${custom ? s.still : ''}`} aria-labelledby="stackd-hero-title">
      <div className={s.pin} style={custom ? undefined : pinVars}>
        <div className={s.copy}>
          <div className={s.kicker}>
            <p className={ui.spec}>Karachi</p>
            <p className={ui.spec}>café · market · scratch kitchen</p>
          </div>

          {/* The supplied wordmark artwork, not a webfont approximation. The
              <h1> stays real text for search and screen readers. */}
          <h1 id="stackd-hero-title" className={s.wordmark}>
            <span className={ui.srOnly}>{brandName} — stackd &amp; servd</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={wordmarkSrc} alt="" aria-hidden="true" {...wordmarkDims} />
          </h1>

          <div className={s.lines}>
            <p className={`${s.line} ${s.lineA}`}>{tagline}</p>
            {!custom && (
              <p className={`${s.line} ${s.lineB}`} aria-hidden="true">we&rsquo;ll make another.</p>
            )}
          </div>

          <p className={s.sub}>{oneLiner}</p>

          <div className={s.ctas}>
            <Link href={orderHref} className={ui.btn}>
              Order {brandName}
              <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            <Link href={menuHref} className={`${ui.btn} ${ui.ghost}`}>See the menu</Link>
          </div>

          {status && <div className={s.status}>{status}</div>}
        </div>

        {/* The stage is decoration with one toy in it: poke him. It is a
            div, not a button, because it does nothing a reader needs — the
            mascot's alt text still describes him. */}
        <div
          ref={stageRef}
          className={stageClass}
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') setNervous(true) }}
          onPointerLeave={() => setNervous(false)}
          onClick={poke}
        >
          {!custom && (
            <p className={s.hint} aria-hidden>
              scroll. carefully.
              <svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
            </p>
          )}

          <div className={s.coaster} aria-hidden>
            <Die className={s.coasterDie} />
            <span className={s.stamp}>
              <Die face="#FCE8CE" bandWidth={0} keylineWidth={4} keyline="#3D1122" />
              <span className={s.stampText}>cooked<br />here.</span>
            </span>
          </div>

          {!custom && (
            <div className={s.seals} aria-hidden>
              {SEALS.map((seal, i) => (
                <span
                  key={i}
                  className={s.seal}
                  style={{
                    '--t': ramp(seal.fire, 4.5),
                    '--x': seal.x,
                    '--y': seal.y,
                    '--tilt': `${seal.tilt}deg`,
                    '--size': seal.size,
                  } as CSSProperties}
                >
                  <Die face="#FCE8CE" band="#9BD3DD" keyline="#3D1122" bandWidth={5} keylineWidth={2.5} />
                </span>
              ))}
            </div>
          )}

          <div className={s.figure}>
            <div className={s.lean}>
              <div className={s.hop}>
                {custom ? (
                  <div className={`${s.custom} ${s.guyIdle}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={customMascotSrc!} alt={mascotAlt} {...(customMascotDims ?? {})} />
                  </div>
                ) : (
                  <>
                    <div className={s.guy}>
                      <div className={s.guyIdle}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/brand/stackd/guy.png" alt={mascotAlt} width={326} height={274} />
                      </div>
                      <span className={s.crumb} aria-hidden />
                      <span className={s.crumb} aria-hidden />
                      <span className={s.crumb} aria-hidden />
                    </div>
                    <div className={s.bread} aria-hidden>
                      <div className={s.breadHop}>
                        <div className={s.breadWobble}>
                          <div className={s.breadIdle}>
                            <svg className={s.steam} viewBox="0 0 100 70" preserveAspectRatio="none">
                              <path d="M28 68 C 18 54, 38 44, 28 30 S 34 10, 26 2" />
                              <path d="M52 68 C 42 52, 62 42, 52 28 S 58 8, 50 0" />
                              <path d="M74 68 C 66 56, 84 46, 74 32 S 80 12, 72 4" />
                            </svg>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src="/brand/stackd/bread.png" alt="" width={197} height={167} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
