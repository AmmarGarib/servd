'use client'
// Act iv, "one bag": the home's climax, one pinned set piece.
//
// A tall track (240svh desktop, 190svh phones) holds a sticky 100svh frame.
// In the middle stands a kraft paper bag; the three steps are "act one / two
// / three" cards (a column on the left on desktop, a bottom sheet on phones).
// Scroll scrubs the scene:
//
//   [0.06–0.20]  a stackd pastry arcs from act one into the bag
//   [0.31–0.45]  a simmer lidded plate (line art, no face) arcs from act two
//   [0.56–0.70]  a Flipd burger arcs from act three
//   [0.80–0.88]  the bag's corner flaps fold, the act sheet slides away
//   0.90         a "servd." stamp lands (SPRING_POP)
//   [0.84–0.96]  the torn-ticket CTA slides up
//
// Every flight is a quadratic bezier scrubbed by p inside its own segment
// (rotate 0→-20deg, scale 1→0.7), so any scroll offset is a composed frame.
// Each landing (a beat at 0.2 / 0.45 / 0.7) cheers the matching crowd member
// (coffee / nobody for simmer / burger), plays the catch foley and ticks a
// haptic on touch. Reduced motion: no pin, every item already in the bag,
// the steps as a plain ordered list.
//
// Geometry is measured with offsets (transform-independent) on resize only;
// scroll frames do arithmetic, never layout reads.
import dynamic from 'next/dynamic'
import Link from 'next/link'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { animate, motion, useMotionValue, useTransform, type MotionStyle, type MotionValue } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import { CrowdPoster } from '../loader/CrowdPoster'
import { Slate } from '../../film/Slate'
import { SkipScene } from '../../film/SkipScene'
import { SPRING_POP, seg, useBeat, useIsCoarsePointer, usePrefersReducedMotion, useScene } from '../../../lib/film/motion'
import { sfx } from '../../../lib/film/sfx'
import { haptic } from '../../../lib/haptics'
import { formatBrandName } from '../../../lib/concept'
import { BAG_H, BAG_W, BagBack, BagFront, BagTab, BurgerArt, PastryArt, PlateArt, RIM_Y, StampArt } from './onebag/art'
import s from './home.module.css'
import h from './how.module.css'

const FoodCrowd = dynamic(
  () => import('../../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

const CAST: CharacterKind[] = ['fries', 'coffee', 'burger']

/** Landing beats, then the stamp. */
const BEATS = [0.2, 0.45, 0.7, 0.9]
/** Each item's flight segment; it lands exactly on its beat. */
const FLIGHTS: ReadonlyArray<readonly [number, number]> = [
  [0.06, 0.2],
  [0.31, 0.45],
  [0.56, 0.7],
]
/** Where each item settles across the bag mouth, as a fraction of bag width from centre. */
const LAND_DX = [-0.21, 0.02, 0.23]

type Theme = 'stackd' | 'simmer' | 'flipd'

const ACTS: Array<{
  act: string
  title: string
  body: string
  item: string
  theme: Theme
  cheer: CharacterKind | null
  Art: () => JSX.Element
}> = [
  {
    act: 'act one',
    title: 'pick your kitchens',
    body: `${formatBrandName('stackd')}, ${formatBrandName('simmer')} and ${formatBrandName('Flipd')}, side by side. start anywhere.`,
    item: `a ${formatBrandName('stackd')} pastry`,
    theme: 'stackd',
    cheer: 'coffee',
    Art: PastryArt,
  },
  {
    act: 'act two',
    title: 'add from any',
    body: 'a pastry here, a small plate there. whatever the mix, it all goes in one bag.',
    item: `a ${formatBrandName('simmer')} small plate`,
    theme: 'simmer',
    cheer: null,
    Art: PlateArt,
  },
  {
    act: 'act three',
    title: 'check out once',
    body: 'pay once. our own riders bring the lot in one trip. hot stays hot, cold stays cold.',
    item: `a ${formatBrandName('Flipd')} burger`,
    theme: 'flipd',
    cheer: 'burger',
    Art: BurgerArt,
  },
]

interface Pt { x: number; y: number }
interface Geo { starts: Pt[]; ends: Pt[]; size: number; arc: number }

/** Offset of `el` inside `root`, summed along the offsetParent chain (ignores transforms). */
function offsetIn(el: HTMLElement, root: HTMLElement): Pt {
  let x = 0
  let y = 0
  let n: HTMLElement | null = el
  while (n && n !== root) {
    x += n.offsetLeft
    y += n.offsetTop
    n = n.offsetParent as HTMLElement | null
  }
  return { x, y }
}

// useLayoutEffect warns during SSR; measure before paint on the client only.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function beatOf(v: number): number {
  let n = 0
  for (const t of BEATS) if (v >= t) n++
  return n
}

/** CSS custom properties are valid MotionStyle keys; TS just can't see it. */
function vars(v: Record<`--${string}`, MotionValue<number> | number | string>): MotionStyle {
  return v as unknown as MotionStyle
}

function Flyer({ t, i, geo, tick, children }: {
  t: MotionValue<number>
  i: number
  geo: MutableRefObject<Geo | null>
  tick: MotionValue<number>
  children: ReactNode
}) {
  const transform = useTransform([t, tick], (vals: number[]) => {
    const tv = vals[0] ?? 0
    const g = geo.current
    const a = g?.starts[i]
    const b = g?.ends[i]
    if (!g || !a || !b) return 'translate3d(-9999px, 0, 0)'
    const cx = (a.x + b.x) / 2
    const cy = Math.min(a.y, b.y) - g.arc
    const u = 1 - tv
    const x = u * u * a.x + 2 * u * tv * cx + tv * tv * b.x
    const y = u * u * a.y + 2 * u * tv * cy + tv * tv * b.y
    return `translate3d(${(x - g.size / 2).toFixed(1)}px, ${(y - g.size / 2).toFixed(1)}px, 0) rotate(${(-20 * tv).toFixed(2)}deg) scale(${(1 - 0.3 * tv).toFixed(3)})`
  })
  // The card's own copy shows until the item takes off; then this one does.
  const opacity = useTransform(t, (v) => (v > 0.001 ? 1 : 0))
  return (
    <motion.div className={h.flyer} style={{ transform, opacity }}>
      {children}
    </motion.div>
  )
}

function ActCard({ i, active, done, t, slotRef }: {
  i: number
  active: boolean
  done: boolean
  t: MotionValue<number>
  slotRef: (el: HTMLSpanElement | null) => void
}) {
  const a = ACTS[i]!
  const artOpacity = useTransform(t, (v) => (v > 0.001 ? 0 : 1))
  return (
    <li
      className={`${h.act} ${active ? h.actActive : ''} ${done ? h.actDone : ''}`}
      style={{ ['--i' as string]: i } as CSSProperties}
      aria-current={active ? 'step' : undefined}
    >
      <span className={h.slot} ref={slotRef} aria-hidden>
        <motion.span className={h.slotArt} style={{ opacity: artOpacity }}>
          <a.Art />
        </motion.span>
        {done && <span className={h.inBag}>in the bag</span>}
      </span>
      <span className={h.actText}>
        <span className={h.actLabel}>{a.act}</span>
        <span className={h.actTitle}>{a.title}</span>
        <span className={h.actBody}>{a.body}</span>
        <span className={s.srOnly}>Adds {a.item} to the bag.</span>
      </span>
    </li>
  )
}

export function HowItWorks() {
  const reduce = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()
  const trackRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const bagRef = useRef<HTMLDivElement>(null)
  const slotRefs = useRef<Array<HTMLSpanElement | null>>([null, null, null])
  const geo = useRef<Geo | null>(null)
  const tick = useMotionValue(0)

  const p = useScene(trackRef, 'pin')

  // Per-item flight progress (three fixed hooks, not a loop).
  const t0 = useTransform(p, (v) => seg(v, FLIGHTS[0]![0], FLIGHTS[0]![1]))
  const t1 = useTransform(p, (v) => seg(v, FLIGHTS[1]![0], FLIGHTS[1]![1]))
  const t2 = useTransform(p, (v) => seg(v, FLIGHTS[2]![0], FLIGHTS[2]![1]))
  const ts = [t0, t1, t2]

  // The wrap: flaps fold, the act sheet leaves, the ticket arrives.
  const fold = useTransform(p, (v) => seg(v, 0.8, 0.88))
  const tabL = useTransform(fold, (v) => `rotate(${(v * 90).toFixed(2)}deg)`)
  const tabR = useTransform(fold, (v) => `rotate(${(-v * 90).toFixed(2)}deg)`)
  const sheetOut = useTransform(p, (v) => seg(v, 0.8, 0.9))
  const ticketY = useTransform(p, (v) => `${((1 - seg(v, 0.84, 0.96)) * 135).toFixed(2)}%`)
  const reel = useTransform(p, (v) => Math.min(1, v / 0.9))

  // Beat state: which act is on, what has landed, whether the stamp is down.
  const [beat, setBeat] = useState(0)
  const beatRef = useRef(0)
  useEffect(() => {
    const b = beatOf(p.get())
    beatRef.current = b
    setBeat(b)
  }, [p])

  // The bag gives a little squash on every catch (time-based, 300ms, transform only).
  const squash = useMotionValue(1)
  const squashX = useTransform(squash, (v) => 2 - v)

  useBeat(p, BEATS, (b) => {
    const prev = beatRef.current
    beatRef.current = b
    setBeat(b)
    if (reduce || b <= prev) return
    if (b <= ACTS.length) {
      const a = ACTS[b - 1]!
      if (a.cheer) emitCrowd({ type: 'cheer', kind: a.cheer })
      sfx('catch', { theme: a.theme })
      if (coarse) haptic(8)
      squash.set(0.9)
      animate(squash, 1, { type: 'spring', stiffness: 520, damping: 14 })
    } else {
      // The wrap: the whole crowd celebrates the packed bag.
      emitCrowd({ type: 'cheer' })
      sfx('stamp')
      if (coarse) haptic(14)
    }
  })

  // Measure once per layout change: slot centres, bag mouth, item size.
  const measure = useCallback(() => {
    const frame = frameRef.current
    const bag = bagRef.current
    if (!frame || !bag) return
    const first = slotRefs.current[0]
    const size = first?.offsetWidth || 80
    const starts = slotRefs.current.map((el) => {
      if (!el) return { x: 0, y: 0 }
      const o = offsetIn(el, frame)
      return { x: o.x + el.offsetWidth / 2, y: o.y + el.offsetHeight / 2 }
    })
    const bo = offsetIn(bag, frame)
    const bw = bag.offsetWidth
    const bh = bag.offsetHeight || (bw * BAG_H) / BAG_W
    const rimY = bo.y + (bh * RIM_Y) / BAG_H
    const ends = LAND_DX.map((dx, i) => ({
      x: bo.x + bw * (0.5 + dx),
      // Centre a little above the rim: ~70% of the (scaled) item shows.
      y: rimY - size * 0.1 - (i === 1 ? size * 0.08 : 0),
    }))
    geo.current = { starts, ends, size, arc: Math.max(70, frame.offsetHeight * 0.2) }
    tick.set(tick.get() + 1)
  }, [tick])

  useIsoLayoutEffect(() => {
    measure()
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(frame)
    if (bagRef.current) ro.observe(bagRef.current)
    // Web fonts can reflow the cards after first paint.
    document.fonts?.ready.then(() => measure()).catch(() => {})
    return () => ro.disconnect()
  }, [measure])

  // Mount the WebGL crowd only when the scene is near; the poster holds the
  // frame until its first painted frame.
  const [crowdOn, setCrowdOn] = useState(false)
  const [crowdReady, setCrowdReady] = useState(false)
  const [excited, setExcited] = useState(false)
  useEffect(() => {
    if (reduce) return
    const el = trackRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setCrowdOn(true)
          io.disconnect()
        }
      },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [reduce])

  const active = Math.min(beat, ACTS.length - 1)
  const stamped = beat >= BEATS.length

  return (
    <section
      id="one-bag"
      ref={trackRef}
      className={h.track}
      data-film-pin=""
      aria-labelledby="how-title"
    >
      <div ref={frameRef} className={h.frame} data-film-frame="">
        <svg aria-hidden className={`${h.doodle} ${h.doodleSquiggle}`} viewBox="0 0 80 24">
          <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
        </svg>
        <svg aria-hidden className={`${h.doodle} ${h.doodleStar}`} viewBox="0 0 40 40">
          <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
        </svg>

        <header className={h.head}>
          {/* The slate's title is the section heading ("act iv · one bag"). */}
          <div id="how-title">
            <Slate act="iv" title="one bag" />
          </div>
          <p className={h.title}>
            <span className={s.srOnly}>How servd works: </span>
            three kitchens, <em>one paper bag.</em>
          </p>
        </header>

        {/* The acts: a column on desktop, a sliding bottom sheet on phones. */}
        <motion.div className={h.sheet} style={vars({ '--out': sheetOut })}>
          <ol className={h.acts} style={{ ['--active' as string]: active } as CSSProperties}>
            {ACTS.map((a, i) => (
              <ActCard
                key={a.act}
                i={i}
                active={i === active && beat < ACTS.length}
                done={i < beat}
                t={ts[i]!}
                slotRef={(el) => { slotRefs.current[i] = el }}
              />
            ))}
          </ol>
          <div className={h.dots} aria-hidden>
            {ACTS.map((a, i) => (
              <span key={a.act} className={i === active ? h.dotOn : h.dot} />
            ))}
          </div>
        </motion.div>

        {/* The bag, with the crowd standing beside it. */}
        <div className={h.bagCell}>
          <div className={h.crowd} aria-hidden>
            <CrowdPoster
              id="onebag"
              cast={CAST}
              still={reduce}
              className={`${h.poster} ${crowdReady ? h.posterGone : ''}`}
            />
            {crowdOn && (
              <FoodCrowd
                cast={CAST}
                excitement={excited ? 1 : 0}
                className={h.crowdCanvas}
                onReady={() => setCrowdReady(true)}
              />
            )}
          </div>

          <div ref={bagRef} className={h.bagBox} aria-hidden>
            <motion.div className={h.bagBack} style={{ scaleY: squash, scaleX: squashX }}>
              <BagBack />
            </motion.div>
            <motion.div className={h.bagFront} style={{ scaleY: squash, scaleX: squashX }}>
              <BagFront />
              <motion.span className={`${h.tab} ${h.tabL}`} style={{ transform: tabL }}>
                <BagTab />
              </motion.span>
              <motion.span className={`${h.tab} ${h.tabR}`} style={{ transform: tabR }}>
                <BagTab />
              </motion.span>
              {stamped && (
                <motion.span
                  className={h.stamp}
                  initial={reduce ? false : { scale: 1.9, rotate: 8, opacity: 0.4 }}
                  animate={{ scale: 1, rotate: -10, opacity: 1 }}
                  transition={SPRING_POP}
                >
                  <StampArt />
                </motion.span>
              )}
            </motion.div>
          </div>
        </div>

        {/* Items in flight live above the cards and between the bag layers. */}
        <div className={h.flight} aria-hidden>
          {ACTS.map((a, i) => (
            <Flyer key={a.act} t={ts[i]!} i={i} geo={geo} tick={tick}>
              <a.Art />
            </Flyer>
          ))}
        </div>

        {/* Foot: a film-strip reel counter, then the torn ticket slides up over it. */}
        <div className={h.foot}>
          <div className={h.strip} aria-hidden>
            <span className={h.stripLabel}>reel iv</span>
            <span className={h.stripTrack}>
              <motion.span className={h.stripFill} style={{ scaleX: reel }} />
            </span>
            <span className={h.stripLabel}>{stamped ? 'packed.' : `${Math.min(beat, 3)}/3 in the bag`}</span>
          </div>
          <motion.div className={h.ticket} style={{ y: ticketY }}>
            <p className={h.ticketCopy}>
              <strong>three kitchens, one story — press play.</strong>
              <span>explore the brands and check out once.</span>
            </p>
            <Link
              href="/browse"
              className={`${s.btn} ${h.ticketBtn}`}
              onClick={() => emitCrowd({ type: 'cheer' })}
              onMouseEnter={() => setExcited(true)}
              onMouseLeave={() => setExcited(false)}
              onFocus={() => setExcited(true)}
              onBlur={() => setExcited(false)}
            >
              every kitchen, one order
              <ArrowRight aria-hidden size={20} strokeWidth={2.6} />
            </Link>
          </motion.div>
        </div>

        <SkipScene targetId="insiders" />
      </div>
    </section>
  )
}
