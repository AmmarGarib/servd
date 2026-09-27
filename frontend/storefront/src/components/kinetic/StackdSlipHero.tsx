'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useScrollProgress } from './motionHooks'
import { Die } from '../brand/stackd/Die'
import { Steam } from '../world/Ambient'
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
 * At rest he has to read as a character, not a shape: he stands on a small
 * die-cut coaster (a floor, not a backdrop), and his striped trousers and
 * hands are backed in cream like a die-cut sticker of him, so the plum line
 * art holds up on the plum field without a big cream blob behind him.
 *
 * Choreography, in scroll progress (section is 250vh; 210svh on phones).
 * Everything is finished by 0.8, and every frame in between is a pose:
 *   0.00-0.10  standing, alive — idle breathing, cursor lean, steam
 *   0.10-0.32  the slip: he rotates back and drops; the bread holds a beat
 *   0.33-0.45  landing — the coaster squashes, the seals jump off
 *   0.14-0.77  the bread climbs and tumbles out of frame
 *   0.17-0.31  the tagline tips over into "we'll make another."
 *
 * The CTAs are always visible and reachable — nothing here is gated behind
 * the gag. Reduced motion: he stands still, holding it, and nothing pins.
 * After hours (html[data-k-stackd='closed']) the loaf stops steaming.
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

  // Cursor lean: which side of him the pointer is on, -1..1. Written straight
  // to a CSS variable once per frame; the springy transition does the rest.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
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
  }, [])

  useEffect(() => () => window.clearTimeout(hopTimer.current), [])

  // Poke him: a hop, the loaf jumps on the tray. Only while he is standing.
  const poke = useCallback(() => {
    if (progressRef.current > 0.08) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    setHopping(false)
    requestAnimationFrame(() => setHopping(true))
    window.clearTimeout(hopTimer.current)
    hopTimer.current = window.setTimeout(() => setHopping(false), 860)
  }, [progressRef])

  const pinVars = {
    '--s': ramp(0.1, 4.5),
    '--toss': ramp(0.14, 1.6),
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
              <Die face="#FFFFFF" bandWidth={0} keylineWidth={4} keyline="#3D1122" />
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
                        {/* Cream behind the see-through trousers and hands,
                            traced from guy.png (326x274): the sticker of him. */}
                        <svg className={s.backing} viewBox="0 0 326 274" aria-hidden focusable="false">
                          <path d="M118 26 H 223 V 140 C 223 172, 209 196, 191 222 L 178 236 H 150 L 128 224 C 122 180, 116 140, 118 26 Z" />
                          <ellipse cx="70" cy="25" rx="22" ry="9" />
                          <ellipse cx="256" cy="25" rx="19" ry="9" />
                        </svg>
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
                            <div className={s.steam}>
                              <Steam count={3} seed={5} color="#FCE8CE" />
                            </div>
                            {/* The loaf's crumb is see-through in the PNG; a cream
                                fill traced from its silhouette keeps it a solid
                                loaf on the plum field. */}
                            <svg className={s.breadBacking} viewBox="0 0 197 167" aria-hidden focusable="false">
                              <path d="M88 5 L 164 9 L 178 38 L 184 60 L 189 72 L 189 160 L 8 161 L 7 90 L 5 68 L 13 48 L 23 32 L 47 16 Z" />
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
