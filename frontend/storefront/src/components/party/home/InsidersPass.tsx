'use client'
// InsidersPass — servd's loyalty pitch as a VIP lanyard pass next to three
// perk "stickers" (one per kitchen, each in its own colours).
//
// The pass is a toy:
//  - grab it and throw it: it swings on its strap (the strap stretches with
//    the pull) and pendulums back; a hard fling (> 900 px/s) finds the
//    'pass-swing' sticker. Keyboard twin: the "give the pass a swing" key
//    that appears under the pass on focus.
//  - it tilts toward the pointer (mouse or a finger mid-drag) with a holo
//    shine; tilt is pinned at rest for reduced motion.
//  - the barcode is a button: a scan line sweeps, then a drawn check.
// The stackd perk card carries a six-stamp punch card (illustrative).
//
// Per the loyalty-program skill: simmer (premium) gets quiet recognition —
// no points, no coupony language, no cartoon treatment; stackd + Flipd get
// a clean, generous points mechanic. WhatsApp is the primary route
// (dominant channel in PK); email signup and sign-in stay as backups.
import Link from 'next/link'
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type PanInfo,
} from 'framer-motion'
import { ArrowRight, Coffee, Gem, MessageCircle, Trophy } from 'lucide-react'
import { buzz, celebrate, collect, sfx } from '@/lib/play'
import { BRAND_LOCATIONS, whatsappLink } from '../../../lib/brandLocations'
import { formatBrandName } from '../../../lib/concept'
import s from './home.module.css'
import v from './insiders.module.css'

const PERKS = [
  {
    slug: 'simmer',
    Icon: Gem,
    tag: 'simmer · regulars',
    head: 'The regulars’ list',
    body: 'Quiet recognition. First word on the next menu drop. A held table when the room is full. Now and then the chef sends out a plate. No card, no points — you’re known here.',
    tilt: -2,
    featured: false,
  },
  {
    slug: 'stackd',
    Icon: Coffee,
    tag: 'stackd · counter club',
    head: 'Five coffees in, the sixth is on us',
    body: 'Buy five drinks at stackd and the sixth is on the house. Insiders also get first look at the pastry case before the morning bake goes out to the floor.',
    tilt: 1.5,
    featured: true,
  },
  {
    slug: 'flipd',
    Icon: Trophy,
    tag: 'Flipd · points',
    head: 'Points on every box',
    body: 'Earn 1 point per Rs. 10 spent at Flipd. Free weekday lunch delivery for members. Redeem points for a meal at 2,000.',
    tilt: -1,
    featured: false,
  },
]

const BARS = [2, 6, 9, 14, 17, 19, 24, 29, 31, 35, 40, 42, 47, 50, 55, 57, 61, 66, 68, 73, 77, 80, 84, 89, 91, 96, 99, 103, 108, 111, 115]

/** Release speed (px/s) that counts as a fling. */
const FLING_SPEED = 900
/** Low-damping pendulum: ~3 visible swings over ~1.4s. */
const PENDULUM = { type: 'spring', stiffness: 180, damping: 7 } as const
const SWING_MS = 1400
/** Half the strap width, in px. */
const STRAP_HALF = 15
/** How far the strap tucks under the pass top (behind the clip). */
const STRAP_TUCK = 12

type Pt = { x: number; y: number }
type Scan = 'idle' | 'scanning' | 'done'

function centreOf(el: Element | null): Pt {
  if (el) {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  return typeof window === 'undefined' ? { x: 0, y: 0 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

function releasePoint(e: MouseEvent | TouchEvent | PointerEvent, el: Element | null): Pt {
  if ('clientX' in e && Number.isFinite(e.clientX)) return { x: e.clientX, y: e.clientY }
  if ('changedTouches' in e) {
    const t = e.changedTouches[0]
    if (t) return { x: t.clientX, y: t.clientY }
  }
  return centreOf(el)
}

function Pass() {
  const reduce = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const patternId = `strap-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  // ── Pointer tilt + holo shine ─────────────────────────────────────────
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 200, damping: 16 })
  const sy = useSpring(py, { stiffness: 200, damping: 16 })
  const rotateY = useTransform(sx, [0, 1], [-16, 16])
  const rotateX = useTransform(sy, [0, 1], [12, -12])
  const shine = useTransform(sx, (x) => `${x * 100}%`)
  const holo = useMotionTemplate`linear-gradient(115deg, transparent 20%, rgba(255,212,71,0.45) calc(${shine} - 12%), rgba(124,242,154,0.35) ${shine}, rgba(58,168,255,0.35) calc(${shine} + 10%), transparent 80%)`

  // ── Drag / throw ──────────────────────────────────────────────────────
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  // Pulled right, the pass hangs off the strap with its foot trailing out.
  const rotate = useTransform(x, [-120, 120], [25, -25])
  // Strap length in px (the lanyard's padding-top); measured on mount.
  const len = useMotionValue(104)
  const strapFill = useTransform([x, y, len], ([a = 0, b = 0, l = 104]: number[]) => {
    const foot = l + b + STRAP_TUCK
    return `M${-STRAP_HALF} 0 L${STRAP_HALF} 0 L${a + STRAP_HALF} ${foot} L${a - STRAP_HALF} ${foot} Z`
  })
  const strapEdges = useTransform([x, y, len], ([a = 0, b = 0, l = 104]: number[]) => {
    const foot = l + b + STRAP_TUCK
    return `M${-STRAP_HALF} 0 L${a - STRAP_HALF} ${foot} M${STRAP_HALF} 0 L${a + STRAP_HALF} ${foot}`
  })

  const [held, setHeld] = useState(false)
  const [swung, setSwung] = useState(false)
  const heldTimer = useRef<number | undefined>(undefined)
  const swungTimer = useRef<number | undefined>(undefined)
  const draggedAt = useRef(0)

  // ── Barcode scan ──────────────────────────────────────────────────────
  const [scan, setScan] = useState<Scan>('idle')
  const [shineRun, setShineRun] = useState(0)
  const scanTimers = useRef<number[]>([])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => {
      const pad = parseFloat(window.getComputedStyle(el).paddingTop)
      if (Number.isFinite(pad) && pad > 0) len.set(pad)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [len])

  useEffect(
    () => () => {
      window.clearTimeout(heldTimer.current)
      window.clearTimeout(swungTimer.current)
      scanTimers.current.forEach((t) => window.clearTimeout(t))
    },
    [],
  )

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    // Mouse hover and a finger mid-drag both tilt; reduced motion pins it at rest.
    if (reduce) return
    const r = ref.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return
    px.set(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
    py.set(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)))
  }
  function onLeave() {
    if (reduce) return
    px.set(0.5)
    py.set(0.5)
  }

  function reward(at: Pt) {
    collect('pass-swing', at)
    void celebrate({ x: at.x, y: at.y, power: 'small' })
    sfx('whoosh')
    buzz(12)
    if (reduce) {
      // Hand-authored static state: the tier chip lights for a beat.
      setSwung(true)
      window.clearTimeout(swungTimer.current)
      swungTimer.current = window.setTimeout(() => setSwung(false), 900)
    }
  }

  function swingBack(vx: number, vy: number) {
    window.clearTimeout(heldTimer.current)
    if (reduce) {
      // No pendulum: the pass simply hangs straight again.
      x.stop()
      y.stop()
      x.set(0)
      y.set(0)
      setHeld(false)
      return
    }
    setHeld(true)
    animate(x, 0, { ...PENDULUM, velocity: vx })
    animate(y, 0, { ...PENDULUM, velocity: vy })
    heldTimer.current = window.setTimeout(() => setHeld(false), SWING_MS)
  }

  function onDragStart() {
    window.clearTimeout(heldTimer.current)
    draggedAt.current = Date.now()
    setHeld(true)
  }

  function onDragEnd(e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    draggedAt.current = Date.now()
    swingBack(info.velocity.x, info.velocity.y)
    if (Math.hypot(info.velocity.x, info.velocity.y) > FLING_SPEED) reward(releasePoint(e, ref.current))
  }

  /** Keyboard twin of a hard fling. */
  function keyFling() {
    if (!reduce) {
      window.clearTimeout(heldTimer.current)
      setHeld(true)
      animate(x, 0, { ...PENDULUM, velocity: 1500 })
      animate(y, 0, { ...PENDULUM, velocity: -260 })
      heldTimer.current = window.setTimeout(() => setHeld(false), SWING_MS)
    }
    reward(centreOf(ref.current))
  }

  function onScan() {
    // A drag that happened to start on the barcode is not a scan.
    if (Date.now() - draggedAt.current < 250) return
    sfx('clack')
    setShineRun((n) => n + 1)
    scanTimers.current.forEach((t) => window.clearTimeout(t))
    if (reduce) {
      setScan('done')
      scanTimers.current = [window.setTimeout(() => setScan('idle'), 1800)]
      return
    }
    setScan('scanning')
    scanTimers.current = [
      window.setTimeout(() => setScan('done'), 380),
      window.setTimeout(() => setScan('idle'), 380 + 1800),
    ]
  }

  return (
    <motion.div
      ref={rootRef}
      className={v.lanyard}
      data-held={held || undefined}
      initial={reduce ? false : { rotate: -24, y: -80, opacity: 0 }}
      whileInView={{ rotate: 0, y: 0, opacity: 1 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 110, damping: 8, mass: 1 }}
    >
      <div className={v.swing}>
        <svg className={v.strap} aria-hidden focusable="false">
          <defs>
            <pattern id={patternId} patternUnits="userSpaceOnUse" width="20" height="20" patternTransform="rotate(45)">
              <rect width="10" height="20" fill="#FF5A3C" />
              <rect x="10" width="10" height="20" fill="#FFD447" />
            </pattern>
          </defs>
          <motion.path d={strapFill} fill={`url(#${patternId})`} />
          <motion.path d={strapEdges} fill="none" stroke="#2A1A2B" strokeWidth="2.5" />
        </svg>
        <motion.div
          ref={ref}
          className={v.pass}
          data-toy="throw"
          data-swung={swung || undefined}
          drag
          dragConstraints={{ left: -120, right: 120, top: -40, bottom: 90 }}
          dragElastic={0.35}
          dragMomentum={false}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          style={{ x, y, rotate, rotateX, rotateY }}
        >
          <span className={v.clip} aria-hidden />
          <div className={v.passTop} aria-hidden>
            <span className={v.passBrand}>servd<span>.</span></span>
            <span className={v.passTier}>insider</span>
          </div>
          <p className={v.passTitle} aria-hidden>All-access<br /><em>pass</em></p>
          <ul className={v.passKitchens} aria-hidden>
            <li>{formatBrandName('stackd')}</li>
            <li>{formatBrandName('simmer')}</li>
            <li>{formatBrandName('Flipd')}</li>
          </ul>
          <div className={v.passFoot}>
            <button
              type="button"
              className={v.scan}
              data-state={scan}
              data-toy="tap"
              aria-label="scan the pass"
              onClick={onScan}
            >
              {scan === 'done' ? (
                <span className={v.scanned} aria-hidden>
                  <svg viewBox="0 0 34 26" className={v.check} focusable="false">
                    <path d="M3 14 L12 22 L31 4" pathLength={1} />
                  </svg>
                  <span>scanned</span>
                </span>
              ) : (
                <svg viewBox="0 0 120 34" className={v.barcode} preserveAspectRatio="none" aria-hidden focusable="false">
                  {BARS.map((bx, i) => (
                    <rect key={bx} x={bx} y="0" width={i % 3 === 0 ? 2.6 : 1.3} height="34" />
                  ))}
                </svg>
              )}
              {scan === 'scanning' && <span className={v.scanLine} aria-hidden />}
            </button>
            <span aria-hidden>free forever</span>
            <span className={s.srOnly} role="status">{scan === 'done' ? 'pass scanned' : ''}</span>
          </div>
          <motion.span className={v.holo} style={{ background: holo }} aria-hidden />
          {shineRun > 0 && <span key={shineRun} className={v.shineOnce} aria-hidden />}
        </motion.div>
      </div>
      <button type="button" className={v.flingKey} onClick={keyFling}>
        give the pass a swing
      </button>
    </motion.div>
  )
}

/** stackd's punch card: five stamps thud in, the sixth waits (illustrative). */
function PunchCard() {
  const reduce = useReducedMotion()
  return (
    <div className={v.punch} role="img" aria-label="punch card: five stamps in, the sixth drink is on us">
      {Array.from({ length: 5 }, (_, i) =>
        reduce ? (
          <span key={i} className={v.stamp} aria-hidden>
            <Coffee size={15} strokeWidth={2.6} />
          </span>
        ) : (
          <motion.span
            key={i}
            className={v.stamp}
            aria-hidden
            initial={{ scale: 1.4, opacity: 0 }}
            whileInView={{ scale: [1.4, 0.9, 1], opacity: [0, 1, 1] }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.32, times: [0, 0.55, 1], ease: 'easeOut', delay: 0.3 + i * 0.06 }}
          >
            <Coffee size={15} strokeWidth={2.6} />
          </motion.span>
        ),
      )}
      <span className={`${v.stamp} ${v.stampFree}`} aria-hidden>free</span>
    </div>
  )
}

export function InsidersPass() {
  const reduce = useReducedMotion()
  return (
    <section className={v.section} aria-labelledby="insiders-title">
      <div className={s.wrap}>
        <div className={v.top}>
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 180, damping: 18 }}
          >
            <p className={s.eyebrow}>Insiders · free to join</p>
            <h2 id="insiders-title" className={s.h2}>
              The best stuff<br />
              <em>doesn&rsquo;t get listed.</em>
            </h2>
            <p className={s.lead}>
              Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.
            </p>

            <div className={v.ctas}>
              <a
                href={whatsappLink(BRAND_LOCATIONS['simmer']!, 'add me to servd insiders')}
                target="_blank"
                rel="noopener noreferrer"
                className={`${s.btn} ${v.wa}`}
              >
                <MessageCircle aria-hidden size={20} strokeWidth={2.5} />
                Join on WhatsApp
                <ArrowRight aria-hidden size={20} strokeWidth={2.6} />
              </a>
              <Link href="/signup?insider=1" className={s.btn}>
                Or sign up with email
              </Link>
            </div>
            <p className={v.fine}>
              <Link href="/login" className={v.signin}>Already a member? Sign in</Link>
              <span>· free forever · cancel anytime</span>
            </p>
          </motion.div>

          <Pass />
        </div>

        <ul className={v.perks}>
          {PERKS.map((p, i) => (
            <motion.li
              key={p.head}
              className={`${v.perk} ${v[p.slug] ?? ''} ${p.featured ? v.featured : ''}`}
              initial={reduce ? false : { opacity: 0, y: 50, rotate: p.tilt * 4, scale: 0.94 }}
              whileInView={{ opacity: 1, y: p.featured ? -14 : 0, rotate: p.tilt, scale: 1 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 190, damping: 15, delay: i * 0.1 }}
            >
              <span className={v.perkIcon} aria-hidden><p.Icon size={22} strokeWidth={2.2} /></span>
              <p className={v.perkTag}>{p.tag}</p>
              <h3 className={v.perkHead}>{p.head}</h3>
              <p className={v.perkBody}>{p.body}</p>
              {p.slug === 'stackd' && <PunchCard />}
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  )
}
