'use client'
// PartyHero — the home hero for the playful "food crowd" direction.
//
// A warm butter-yellow stage with the food crowd standing on its floor. The
// crowd paints as a flat poster first (FoodCrowd owns that) and cross-fades
// into 3D, so the stage is never empty. The crowd watches the cursor
// everywhere on the page; hovering the main CTA gets them excited, clicking
// it makes them cheer while the rubber button holds its pressed squash and
// the arrow whooshes until we navigate. Headline + overview stay
// operator-editable (Admin → Marketing → Landing Hero); the headline splits
// on its comma so "Every kitchen, one place" lands as two beats.
//
// FoodCrowd server-renders its SVG poster and code-splits three.js inside
// an effect; the page is fully usable (and readable) before the 3D crowd
// arrives and if WebGL is unavailable.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { HeroConfig } from '../../lib/heroConfig'
import { tick } from '../../lib/tactile'
import { emitCrowd, onCrowd } from '../characters/crowdBus'
// Direct import (not next/dynamic): FoodCrowd is SSR-safe and loads three.js
// itself, so its flat poster is in the server-rendered first paint.
import { FoodCrowd } from '../characters/FoodCrowd'
import s from './party.module.css'

const HINT_KEY = 'servd:crowd-hint'
const NAV_DELAY_MS = 520
const EXCITED_MS = 900

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

/** First-visit hint: once per browser session. Storage can throw (private
 *  mode, blocked site data) — then we simply skip the hint. */
function claimHint(): boolean {
  try {
    if (window.sessionStorage.getItem(HINT_KEY)) return false
    window.sessionStorage.setItem(HINT_KEY, '1')
    return true
  } catch {
    return false
  }
}

export function PartyHero({ config }: { config: HeroConfig }) {
  const router = useRouter()
  const [excited, setExcited] = useState(false)
  const [burst, setBurst] = useState(false)
  const [pending, setPending] = useState(false)
  const [lead, tail] = splitTitle(config.title)
  const leadCount = lead.split(' ').length

  const stageRef = useRef<HTMLDivElement>(null)
  const burstTimer = useRef<number | undefined>(undefined)
  const hintTimer = useRef<number | undefined>(undefined)
  const navTimer = useRef<number | undefined>(undefined)
  const ready = useRef(false)
  const waveQueued = useRef(false)
  const waved = useRef(false)

  // Doodles get excited for a beat whenever anybody cheers the crowd.
  useEffect(() => {
    const off = onCrowd((e) => {
      if (e.type !== 'cheer') return
      setBurst(true)
      window.clearTimeout(burstTimer.current)
      burstTimer.current = window.setTimeout(() => setBurst(false), EXCITED_MS)
    })
    return () => {
      off()
      window.clearTimeout(burstTimer.current)
      window.clearTimeout(hintTimer.current)
      window.clearTimeout(navTimer.current)
    }
  }, [])

  const fireWave = useCallback(() => {
    if (waved.current) return
    waved.current = true
    emitCrowd({ type: 'wave' })
  }, [])

  // Touch arrival: the first time the stage is on screen on a hover-less
  // device, the crowd does a stadium wave (after it is ready to be seen).
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let touch = false
    try {
      touch = window.matchMedia('(hover: none)').matches
    } catch {
      touch = false
    }
    if (!touch) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((en) => en.isIntersecting)) return
        io.disconnect()
        if (ready.current) fireWave()
        else waveQueued.current = true
      },
      { threshold: 0.2 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [fireWave])

  const onReady = useCallback(() => {
    if (ready.current) return
    ready.current = true
    if (waveQueued.current) fireWave()
    hintTimer.current = window.setTimeout(() => {
      if (claimHint()) emitCrowd({ type: 'hint' })
    }, 1600)
  }, [fireWave])

  function onOrder(e: MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new tab, etc.) behave natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    if (pending) return
    setPending(true)
    tick('light')
    emitCrowd({ type: 'cheer' })
    navTimer.current = window.setTimeout(() => router.push('/browse'), NAV_DELAY_MS)
  }

  function lookAt(el: HTMLElement) {
    const r = el.getBoundingClientRect()
    emitCrowd({ type: 'look', x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }

  const heroClass = `${s.hero} ${excited || burst ? s.stageExcited : ''}`

  return (
    <section className={heroClass} aria-labelledby="party-hero-title">
      {/* Floating doodles — decoration only. They get excited with the crowd. */}
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
            className={`${s.cta} ${pending ? s.pending : ''}`}
            aria-busy={pending || undefined}
            onClick={onOrder}
            onMouseEnter={() => setExcited(true)}
            onMouseLeave={() => setExcited(false)}
            onFocus={() => setExcited(true)}
            onBlur={() => setExcited(false)}
          >
            Order now
            <svg aria-hidden viewBox="0 0 24 24" width="20" height="20"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
          <a
            href="#brands"
            className={s.ctaGhost}
            onMouseEnter={(e) => lookAt(e.currentTarget)}
            onFocus={(e) => lookAt(e.currentTarget)}
          >
            Meet the kitchens
          </a>
        </div>
      </div>

      <div ref={stageRef} className={s.stage} aria-hidden>
        <div className={s.floor} />
        <FoodCrowd excitement={excited || pending ? 1 : 0} onReady={onReady} />
      </div>
    </section>
  )
}
