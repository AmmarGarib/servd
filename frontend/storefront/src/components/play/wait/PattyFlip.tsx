'use client'
// PattyFlip — Flipd's wait game.
//
// A marker sweeps back and forth across a doneness bar (1.6s a pass, 12%
// faster after every flip). Tap the pan, or press Space / Enter, to flip:
// the patty arcs up, turns over and lands with a squash. Three flips a round,
// each scored 0–100 by how close the marker sat to the centre of the golden
// zone (18% of the bar, moved after every flip). A far miss chars the patty
// and the round ends on a "Try again" ticket. Finishing a round records the
// score and finds the 'wait-game' sticker.
//
// Reduced motion: the marker runs at half speed and the patty cross-fades
// instead of flying.

import { useCallback, useEffect, useRef, useState } from 'react'
import { buzz, collect, sfx, usePlay, usePrefersReducedMotion } from '@/lib/play'
import s from './wait.module.css'

const FLIPS_PER_ROUND = 3
const BASE_PASS_S = 1.6
const SPEEDUP = 1.12
const ZONE_W = 0.18
const HALF = ZONE_W / 2
/** A flip this far from the zone centre (in bar widths) burns the patty. */
const BURNT_DIST = 0.3
const FLIP_MS = 560
const FADE_MS = 120

const PATTY_RAW = '#C9776C'
const PATTY_DONE = '#8A4B2A'
const PATTY_CHAR = '#2B1D18'

function scoreFor(dist: number): number {
  if (dist <= HALF) return Math.round(100 - (dist / HALF) * 20)
  return Math.max(0, Math.round(80 - ((dist - HALF) / (0.36 - HALF)) * 80))
}

function nextZoneCentre(prev: number): number {
  // Keep the whole zone on the bar and move it a noticeable distance.
  for (let i = 0; i < 8; i++) {
    const c = 0.24 + Math.random() * 0.52
    if (Math.abs(c - prev) > 0.2) return c
  }
  return prev > 0.5 ? 0.3 : 0.7
}

export function PattyFlip({
  paused, onRound,
}: {
  paused: boolean
  onRound?: (score: number, newBest: boolean) => void
}) {
  const reduced = usePrefersReducedMotion()
  const [scores, setScores] = useState<number[]>([])
  const [burnt, setBurnt] = useState(false)
  const [lastBurnt, setLastBurnt] = useState(false)
  const [centre, setCentre] = useState(0.62)
  const [flipping, setFlipping] = useState(false)
  const [flipKey, setFlipKey] = useState(0)
  const [round, setRound] = useState<{ score: number; newBest: boolean; burnt: boolean } | null>(null)
  const [announce, setAnnounce] = useState('')
  const best = usePlay((st) => st.best['patty'])

  const markerRef = useRef<HTMLDivElement>(null)
  const pos = useRef(0)          // 0..1 across the bar
  const dir = useRef(1)
  const panRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | null>(null)

  const flips = scores.length
  const roundOver = round !== null
  const running = !paused && !flipping && !roundOver

  // The sweeping marker. Driven by rAF and written straight to the DOM so
  // React doesn't re-render sixty times a second.
  useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    const pass = (BASE_PASS_S / Math.pow(SPEEDUP, flips)) * (reduced ? 2 : 1)
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      let p = pos.current + (dir.current * dt) / pass
      if (p >= 1) { p = 2 - p; dir.current = -1 }
      if (p <= 0) { p = -p; dir.current = 1 }
      pos.current = p
      if (markerRef.current) markerRef.current.style.transform = `translateX(${(p * 100).toFixed(2)}%)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, flips, reduced])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const finishRound = useCallback((all: number[], wasBurnt: boolean) => {
    const score = Math.round(all.reduce((a, b) => a + b, 0) / all.length)
    const newBest = usePlay.getState().recordScore('patty', score)
    const r = panRef.current?.getBoundingClientRect()
    collect('wait-game', r ? { x: r.left + r.width / 2, y: r.top + r.height / 3 } : undefined)
    if (!wasBurnt && score >= 70) sfx('ding')
    buzz(wasBurnt ? 20 : 40)
    setRound({ score, newBest, burnt: wasBurnt })
    setAnnounce(wasBurnt
      ? `Burnt. Round score ${score}. Try again.`
      : `Order up. Round score ${score}${newBest ? ', a new best' : ''}.`)
    onRound?.(score, newBest)
  }, [onRound])

  const flip = useCallback(() => {
    if (paused || flipping || roundOver) return
    const dist = Math.abs(pos.current - centre)
    const sc = scoreFor(dist)
    const isBurnt = dist > BURNT_DIST
    const all = [...scores, sc]
    const nowBurnt = burnt || isBurnt

    sfx('pop')
    buzz(12)
    setScores(all)
    setBurnt(nowBurnt)
    setLastBurnt(isBurnt)
    setFlipping(true)
    setFlipKey((k) => k + 1)
    setAnnounce(isBurnt ? `Flip ${all.length}: burnt.` : `Flip ${all.length}: ${sc}.`)

    timer.current = window.setTimeout(() => {
      setFlipping(false)
      if (all.length >= FLIPS_PER_ROUND) {
        finishRound(all, nowBurnt)
      } else {
        setCentre((c) => nextZoneCentre(c))
      }
    }, reduced ? FADE_MS : FLIP_MS)
  }, [paused, flipping, roundOver, centre, scores, burnt, reduced, finishRound])

  const again = useCallback(() => {
    setScores([])
    setBurnt(false)
    setLastBurnt(false)
    setRound(null)
    setCentre((c) => nextZoneCentre(c))
    pos.current = 0
    dir.current = 1
    setAnnounce('')
    // Hand focus back to the pan so the keyboard player can keep going.
    window.requestAnimationFrame(() => panRef.current?.focus())
  }, [])

  const last = scores[scores.length - 1]
  const pattyColour = burnt ? PATTY_CHAR : flips === 0 ? PATTY_RAW : (last ?? 0) >= 50 ? PATTY_DONE : '#A55E3C'

  return (
    <>
      <div className={s.meta}>
        <span className={s.pips} aria-hidden="true">
          {Array.from({ length: FLIPS_PER_ROUND }, (_, i) => (
            <span key={i} className={`${s.pip} ${i < flips ? s.pipOn : ''}`} />
          ))}
        </span>
        <span className={s.readout} aria-hidden="true">
          {flips > 0 && last !== undefined ? (lastBurnt ? `Flip ${flips}: burnt` : `Flip ${flips}: ${last}`) : best ? `Best ${best}` : 'Hit the gold.'}
        </span>
      </div>
      <span className="sr-only" aria-live="polite">{announce}</span>

      <button
        ref={panRef}
        type="button"
        className={s.panButton}
        onClick={flip}
        disabled={roundOver}
        aria-label="flip the patty"
        data-toy="flip"
      >
        <span className={s.panArea}>
          <PanArt />
          <span className={s.pattyLayer}>
            <span
              key={flipKey}
              className={`${s.patty} ${flipKey > 0 ? (reduced ? s.pattyFade : s.pattyFlip) : ''}`}
            >
              <PattyArt colour={pattyColour} charred={burnt} />
            </span>
          </span>
        </span>

        <span className={s.bar} aria-hidden="true">
          <span className={s.barBurnt} style={{ left: 0 }} />
          <span className={s.barBurnt} style={{ right: 0 }} />
          <span className={s.zone} style={{ left: `${((centre - HALF) * 100).toFixed(2)}%` }} />
          <span className={s.barLabel} style={{ left: 8 }}>raw</span>
          <span className={s.barLabel} style={{ right: 8 }}>char</span>
          <span ref={markerRef} className={s.markerTrack}>
            <span className={s.marker} />
          </span>
        </span>

        <span className={s.flipChip} aria-hidden="true">Flip</span>
      </button>

      {round && (
        <div className={s.ticketWrap}>
          <div className={`${s.ticket} ${round.burnt ? s.ticketRetry : ''}`} role="status">
            <p className={s.ticketKicker}>{round.burnt ? 'Try again' : 'Order up'}</p>
            <p className={s.ticketScore}>{round.score}</p>
            <p className={s.ticketNote}>
              {round.burnt ? 'That one caught. Watch the gold.' : round.newBest ? 'New best.' : best ? `Best ${best}.` : 'Nice flipping.'}
            </p>
            <button type="button" className={s.primary} onClick={again} autoFocus>
              Flip again
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Art: flat Flipd line-work, blue on bone with mustard heat ──────────────

function PanArt() {
  return (
    <svg className={s.panSvg} viewBox="0 0 280 120" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      {/* Burner flames */}
      <g>
        {[96, 118, 140, 162, 184].map((x) => (
          <path key={x} className={s.flameLick}
                d={`M${x} 118 C ${x - 7} 108, ${x - 2} 100, ${x} 94 C ${x + 2} 100, ${x + 7} 108, ${x} 118 Z`}
                fill="#FED561" stroke="#294375" strokeWidth="2" strokeLinejoin="round" />
        ))}
      </g>
      {/* Handle */}
      <rect x="214" y="80" width="62" height="11" rx="5.5" fill="#294375" />
      <circle cx="266" cy="85.5" r="2.6" fill="#F9F0E1" />
      {/* Pan body */}
      <path d="M44 78 H236 L226 98 C 222 104, 216 106, 208 106 H72 C 64 106, 58 104, 54 98 Z"
            fill="#294375" />
      <ellipse cx="140" cy="78" rx="96" ry="10" fill="#294375" />
      <ellipse cx="140" cy="78" rx="88" ry="6.5" fill="#1E3259" />
      {/* Sizzle */}
      <g stroke="#294375" strokeWidth="2.2" strokeLinecap="round" fill="none">
        <path className={s.sizzle} d="M104 62 c -4 -6, 4 -10, 0 -16" />
        <path className={s.sizzle} d="M176 62 c 4 -6, -4 -10, 0 -16" />
        <path className={s.sizzle} d="M190 66 c -3 -5, 3 -8, 0 -13" />
      </g>
    </svg>
  )
}

function PattyArt({ colour, charred }: { colour: string; charred: boolean }) {
  // Side profile, symmetric top-to-bottom so the turn-over reads cleanly.
  return (
    <svg viewBox="0 0 100 34" width="100%" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <rect x="3" y="4" width="94" height="26" rx="13" fill={colour} stroke="#294375" strokeWidth="3" />
      <path d="M16 12 H84 M16 22 H84" stroke={charred ? '#0F0A08' : '#294375'} strokeOpacity={charred ? 0.9 : 0.35}
            strokeWidth="2.5" strokeLinecap="round" strokeDasharray={charred ? '4 5' : '10 7'} />
      {charred && (
        <g fill="#0F0A08">
          <circle cx="24" cy="17" r="2.4" />
          <circle cx="52" cy="15" r="2" />
          <circle cx="74" cy="19" r="2.6" />
        </g>
      )}
    </svg>
  )
}
