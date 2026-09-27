'use client'
// PartyHero — the home hero for the playful "food crowd" direction.
//
// A warm butter-yellow stage with the 3D food crowd standing on its floor.
// The crowd watches the cursor everywhere on the page; hovering the main
// CTA gets them excited (they lean in and bounce), and the first "Order
// now" of a session makes them cheer before navigating. Headline + overview
// stay operator-editable (Admin → Marketing → Landing Hero); the headline
// splits on its comma so "Every kitchen, one place" lands as two beats.
//
// The three doodles are toys: press one and it squashes, spins and pops
// into a burst of dots (doodlePop), then respawns nearby a moment later.
// They are real <button>s, so they are also the keyboard path to the
// 'doodle-pop' sticker (the ticker's doodles are pointer-only).
//
// FoodCrowd is WebGL and client-only, so it loads via next/dynamic with
// ssr:false; the page is fully usable (and readable) before it arrives
// and if WebGL is unavailable.

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { HeroConfig } from '../../lib/heroConfig'
import { emitCrowd } from '../characters/crowdBus'
import { centreOf, popDoodle } from './doodlePop'
import s from './party.module.css'

const FoodCrowd = dynamic(
  () => import('../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

const ORDER_CHEER_KEY = 'servd-order-cheered'
let orderCheeredInMemory = false

function hasOrderCheered(): boolean {
  if (orderCheeredInMemory) return true
  try {
    return window.sessionStorage.getItem(ORDER_CHEER_KEY) === '1'
  } catch {
    return false
  }
}

function markOrderCheered(): void {
  orderCheeredInMemory = true
  try {
    window.sessionStorage.setItem(ORDER_CHEER_KEY, '1')
  } catch {
    /* the in-memory flag covers this session */
  }
}

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

// ── Pokeable doodles ─────────────────────────────────────────────────────

type Phase = 'idle' | 'popping' | 'gone' | 'in'

interface DoodleSpec {
  id: 'star' | 'squiggle' | 'dot'
  label: string
  /** Burst colour — matches the doodle's own ink. */
  color: string
  place: string
  art: string
  svg: ReactNode
}

const POP_MS = 220
const POP_MS_CALM = 120
const RESPAWN_MS = 2400
const IN_MS = 420
const IN_MS_CALM = 120

function HeroDoodle({ spec }: { spec: DoodleSpec }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLButtonElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [jitter, setJitter] = useState({ x: 0, y: 0 })
  const timers = useRef<number[]>([])

  useEffect(() => {
    const list = timers.current
    return () => {
      list.forEach((t) => window.clearTimeout(t))
      list.length = 0
    }
  }, [])

  function later(fn: () => void, ms: number) {
    timers.current.push(window.setTimeout(fn, ms))
  }

  function onPress() {
    if (phase !== 'idle') return
    const popMs = reduce ? POP_MS_CALM : POP_MS
    setPhase('popping')
    later(() => {
      const el = ref.current
      if (el) popDoodle(centreOf(el), spec.color)
      setPhase('gone')
    }, popMs)
    later(() => {
      // Respawn within ±40px of home (tighter on phones, where the safe
      // margins around the crowd and the CTAs are narrow).
      const amp = window.innerWidth <= 640 ? 12 : 40
      setJitter({ x: Math.round((Math.random() * 2 - 1) * amp), y: Math.round((Math.random() * 2 - 1) * amp) })
      setPhase('in')
    }, popMs + RESPAWN_MS)
    later(() => {
      timers.current.length = 0
      setPhase('idle')
    }, popMs + RESPAWN_MS + (reduce ? IN_MS_CALM : IN_MS))
  }

  return (
    <button
      ref={ref}
      type="button"
      data-toy="poke"
      aria-label={spec.label}
      aria-disabled={phase !== 'idle' || undefined}
      data-phase={phase}
      className={`${s.doodleBtn} ${spec.place}`}
      style={{ '--jx': `${jitter.x}px`, '--jy': `${jitter.y}px` } as CSSProperties}
      onClick={onPress}
    >
      <span className={s.doodleInner}>
        <span className={`${s.doodleArt} ${spec.art}`}>{spec.svg}</span>
      </span>
    </button>
  )
}

const DOODLES: DoodleSpec[] = [
  {
    id: 'star',
    label: 'pop the star',
    color: '#4E2A4F',
    place: s.placeStar ?? '',
    art: s.artStar ?? '',
    svg: (
      <svg aria-hidden viewBox="0 0 40 40" focusable="false">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>
    ),
  },
  {
    id: 'squiggle',
    label: 'pop the squiggle',
    color: '#FF5A3C',
    place: s.placeSquiggle ?? '',
    art: s.artSquiggle ?? '',
    svg: (
      <svg aria-hidden viewBox="0 0 80 24" focusable="false">
        <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
      </svg>
    ),
  },
  {
    id: 'dot',
    label: 'pop the red dot',
    color: '#FF5A3C',
    place: s.placeDot ?? '',
    art: s.artDot ?? '',
    svg: (
      <svg aria-hidden viewBox="0 0 20 20" focusable="false">
        <circle cx="10" cy="10" r="8" />
      </svg>
    ),
  },
]

// ── Hero ─────────────────────────────────────────────────────────────────

export function PartyHero({ config }: { config: HeroConfig }) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [excited, setExcited] = useState(false)
  const [lead, tail] = splitTitle(config.title)
  const leadCount = lead.split(' ').length
  const navTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (navTimer.current !== null) window.clearTimeout(navTimer.current)
  }, [])

  function onOrder(e: MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new tab, etc.) behave natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    // A second tap during the cheer: stop waiting and let the link go now.
    if (navTimer.current !== null) {
      window.clearTimeout(navTimer.current)
      navTimer.current = null
      return
    }
    // Only the first tap of a session gets the cheer; everyone else (and
    // reduced-motion users) navigates straight away via the Link.
    if (reduce || hasOrderCheered()) return
    e.preventDefault()
    markOrderCheered()
    emitCrowd({ type: 'cheer', big: true })
    navTimer.current = window.setTimeout(() => {
      navTimer.current = null
      router.push('/browse')
    }, 240)
  }

  return (
    <section className={s.hero} aria-labelledby="party-hero-title">
      <div className={s.copy}>
        <p className={s.eyebrow}>servd · karachi · three kitchens</p>
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
          <a href="#brands" className={s.ctaGhost}>Meet the kitchens</a>
        </div>
      </div>

      <div className={s.stage} aria-hidden>
        <div className={s.floor} />
        <FoodCrowd excitement={excited ? 1 : 0} />
      </div>

      {/* Pokeable doodles — after the copy so the CTAs come first in tab order. */}
      {DOODLES.map((d) => <HeroDoodle key={d.id} spec={d} />)}
    </section>
  )
}
