'use client'
// PartyHero is the home hero: a sky that knows the hour, over the food crowd.
//
// The sky and ground follow the Karachi day-part the server stamps on <html>
// (--world-* tokens). There's a sun or moon at the day-part's position, stars
// at night and drifting motes by day. All of it is CSS, so the first paint is
// already right and nothing waits for JS.
//
// The crowd paints instantly. A CSS-animated SVG cast (CrowdStage) stands
// exactly where the 3D crowd will stand. When the WebGL crowd renders its
// first frame, the SVG cast cross-fades out and the canvas in. If WebGL never
// arrives, or the viewer prefers reduced motion, the SVG cast stays. At night
// both casts doze: the SVG through a CSS rule on html[data-world-dark], the
// 3D through its own world wiring. Poking an SVG character jolts it awake,
// and its neighbours flinch.
//
// Headline and overview stay operator-editable (Admin → Marketing → Landing
// Hero). The eyebrow reads the live clock once the world is ready, with a
// 180 ms cross-fade from the static SSR line.

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { HeroConfig } from '../../lib/heroConfig'
import { useWorld } from '../../lib/world/useWorld'
import { useKitchens } from '../../lib/world/kitchens'
import { worldEyebrow } from '../../lib/world/voice'
import { emitCrowd } from '../characters/crowdBus'
import type { CharacterKind } from '../characters/types'
import { Motes, Stars } from '../world/Ambient'
import { CrowdCameo, type CameoPose } from '../world/cast/CrowdCameo'
import s from './party.module.css'

const FoodCrowd = dynamic(
  () => import('../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

/** FoodCrowd's default cast, same order, so the SVG row stands where the 3D one will. */
export const HERO_CAST: CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

// Each character idles in its own way until the 3D crowd takes over.
const IDLE_POSE: Partial<Record<CharacterKind, CameoPose>> = {
  coffee: 'sip',
  shake: 'wave',
}

/* ── DozyCameo ──────────────────────────────────────────────────────────────
   A cast member that falls asleep after dark. The cast's `nightPose` switches
   it from CSS on html[data-world-dark='1'], so SSR is already right at 2am.
   `awake` drops the night pose, for a character that has just been poked. */
export function DozyCameo({
  kind,
  pose = 'idle',
  size,
  delay,
  look,
  className,
  awake = false,
}: {
  kind: CharacterKind
  pose?: CameoPose
  size: number
  delay?: number
  look?: 'center' | 'left' | 'right' | 'up' | 'down'
  className?: string
  awake?: boolean
}) {
  return (
    <CrowdCameo
      kind={kind}
      pose={pose}
      size={size}
      delay={delay}
      look={look}
      className={className}
      nightPose={awake ? undefined : 'sleep'}
    />
  )
}

/* ── CrowdStage ─────────────────────────────────────────────────────────────
   Fills its parent box. Mirrors the 3D engine's layout rules closely enough
   that the cross-fade reads as the same crowd coming to life:
   - how many stand: aspect < .95 → 3, < 1.35 → 4, else the whole cast
     (centre slice);
   - how big: height-bound at ~72% of the stage (a cameo's `size` includes
     headroom for the shake's straw), or width-bound when narrow;
   - where: feet ~14% off the floor when height-bound, and vertically
     centred when width-bound.
   The SSR defaults for each variant live in party.module.css, and after mount
   the ResizeObserver refines them. */
type Fit = { k: number; bottom: number; n: number }

function fitFor(w: number, h: number, count: number): Fit {
  const aspect = w / h
  const n = Math.min(count, aspect < 0.95 ? 3 : aspect < 1.35 ? 4 : count)
  const byHeight = h * 0.72
  const byWidth = (w * 1.4) / n
  const size = Math.min(byHeight, byWidth)
  const bottom = byHeight <= byWidth ? h * 0.14 : Math.max(h * 0.14, (h - size) / 2)
  return { k: Math.max(0.3, size / 100), bottom, n }
}

export function CrowdStage({
  cast,
  excited = false,
  stageId,
  variant,
}: {
  cast: CharacterKind[]
  excited?: boolean
  stageId?: string
  variant: 'hero' | 'how'
}) {
  const reduce = useReducedMotion()
  const world = useWorld()
  const hostRef = useRef<HTMLDivElement>(null)
  const palsRef = useRef<Array<HTMLSpanElement | null>>([])
  const [mounted, setMounted] = useState(false)
  const [live, setLive] = useState(false)
  const [fit, setFit] = useState<Fit | null>(null)
  const [poked, setPoked] = useState<number | null>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w > 2 && h > 2) setFit(fitFor(w, h, cast.length))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [cast.length])

  const onReady = useCallback(() => setLive(true), [])

  // Poke: the SVG character hops and cheers, or, at night, jolts awake with
  // a startled face before dozing back off. Its neighbours flinch a beat
  // later (attribute flips, and CSS does the hop).
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
  function poke(i: number) {
    const flip = (el: HTMLSpanElement | null | undefined, attr: string, ms: number) => {
      if (!el) return
      el.setAttribute(attr, '1')
      timers.current.push(window.setTimeout(() => el.removeAttribute(attr), ms))
    }
    const me = palsRef.current[i]
    if (me?.hasAttribute('data-poked')) return
    flip(me, 'data-poked', 1400)
    flip(palsRef.current[i - 1], 'data-flinch', 520)
    flip(palsRef.current[i + 1], 'data-flinch', 520)
    setPoked(i)
    timers.current.push(window.setTimeout(() => setPoked((p) => (p === i ? null : p)), 1400))
  }

  const start = fit ? Math.max(0, Math.floor((cast.length - fit.n) / 2)) : 0
  const hostStyle = fit
    ? ({ '--ck': fit.k.toFixed(3), '--cb': `${Math.round(fit.bottom)}px` } as CSSProperties)
    : undefined

  return (
    <div
      ref={hostRef}
      className={`${s.crowdHost} ${variant === 'hero' ? s.crowdHero : s.crowdHow}`}
      data-live={live ? '1' : '0'}
      data-excited={excited ? '1' : undefined}
      style={hostStyle}
      aria-hidden
    >
      <div className={s.instant}>
        {cast.map((kind, i) => {
          const shown = fit ? i >= start && i < start + fit.n : undefined
          return (
            <span
              key={`${kind}-${i}`}
              ref={(el) => { palsRef.current[i] = el }}
              className={s.pal}
              data-edge={cast.length > 4 && (i === 0 || i === cast.length - 1) ? '1' : undefined}
              data-shown={shown === undefined ? undefined : shown ? '1' : '0'}
              style={{ '--pi': i } as CSSProperties}
              onPointerDown={() => poke(i)}
            >
              <DozyCameo
                kind={kind}
                pose={poked === i ? (world.dark ? 'worried' : 'cheer') : IDLE_POSE[kind] ?? 'idle'}
                awake={poked === i}
                size={100}
                delay={i * 170}
              />
            </span>
          )
        })}
      </div>
      <div className={s.live}>
        {mounted && !reduce && (
          <FoodCrowd cast={cast} excitement={excited ? 1 : 0} stageId={stageId} world onReady={onReady} />
        )}
      </div>
    </div>
  )
}

/* ── Hero ─────────────────────────────────────────────────────────────── */

function splitTitle(title: string): [string, string | null] {
  const i = title.indexOf(',')
  if (i <= 0 || i >= title.length - 2) return [title, null]
  return [title.slice(0, i + 1), title.slice(i + 1).trim()]
}

// Each word drops in on its own beat; --i drives the stagger in CSS.
function BouncyWords({ text, offset = 0 }: { text: string; offset?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className={s.word} style={{ '--i': i + offset } as CSSProperties}>
          {w}
        </span>
      ))}
    </>
  )
}

const STATIC_EYEBROW = 'servd · karachi · three kitchens'

export function PartyHero({ config }: { config: HeroConfig }) {
  const router = useRouter()
  const world = useWorld()
  const kitchens = useKitchens()
  const [excited, setExcited] = useState(false)
  const [lead, tail] = splitTitle(config.title)
  const leadCount = lead.split(' ').length

  const eyebrow = world.ready ? worldEyebrow(world.clock, kitchens.openCount, world.dayPart) : ''

  function onOrder(e: MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new tab, etc.) behave natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    emitCrowd({ type: 'cheer' })
    window.setTimeout(() => router.push('/browse'), 520)
  }

  return (
    <section className={s.hero} aria-labelledby="party-hero-title">
      {/* The sky: orb, stars (night) and motes (day). Decoration only. */}
      <div className={s.orb} aria-hidden>
        <span className={s.orbGlow} />
        <span className={s.orbDisc} />
      </div>
      <Stars className={s.skyLayer} count={30} seed={11} />
      <Motes className={s.skyLayer} count={12} seed={5} />

      {/* Floating doodles, tinted by the hour. */}
      <svg aria-hidden className={`${s.doodle} ${s.doodleStar}`} viewBox="0 0 40 40">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleSquiggle}`} viewBox="0 0 80 24">
        <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleDot}`} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" />
      </svg>

      <div className={s.copy}>
        <p className={s.eyebrow} data-live={world.ready ? '1' : '0'}>
          <span className={s.eyebrowStatic} aria-hidden={world.ready || undefined}>{STATIC_EYEBROW}</span>
          <span className={s.eyebrowLive} aria-hidden={!world.ready || undefined}>{eyebrow}</span>
        </p>
        <h1 id="party-hero-title" className={s.title}>
          <BouncyWords text={lead} />
          {tail && (
            <span className={s.tail}>
              <BouncyWords text={tail} offset={leadCount} />
              <svg aria-hidden className={s.underline} viewBox="0 0 300 20" preserveAspectRatio="none">
                <path d="M4 14 C 60 4, 120 18, 180 9 S 280 6, 296 12" />
              </svg>
            </span>
          )}
        </h1>
        {config.overview && <p className={s.lead}>{config.overview}</p>}
        <div className={s.ctas}>
          <Link
            href="/browse"
            className={s.cta}
            onClick={onOrder}
            onMouseEnter={() => setExcited(true)}
            onMouseLeave={() => setExcited(false)}
            onFocus={() => setExcited(true)}
            onBlur={() => setExcited(false)}
          >
            Order now
            <svg aria-hidden viewBox="0 0 24 24" width="20" height="20"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
          {/* Both ghost CTAs are server-rendered, and CSS on
              html[data-kitchens-open] shows the right one, so the night
              nudge is right on the first paint. */}
          <a href="#brands" className={`${s.ctaGhost} ${s.ghostDay}`}>Meet the kitchens</a>
          <a href="#right-now" className={`${s.ctaGhost} ${s.ghostNight}`}>see who opens first</a>
        </div>
      </div>

      <div className={s.stage}>
        <div className={s.floor} aria-hidden />
        <CrowdStage cast={HERO_CAST} excited={excited} stageId="hero" variant="hero" />
      </div>
    </section>
  )
}
