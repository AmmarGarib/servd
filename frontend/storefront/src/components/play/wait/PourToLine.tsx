'use client'
// PourToLine — stackd's wait game (and the servd fallback for other kitchens).
//
// A branded stackd cold cup, the packaging-as-vessel way: clear body, plum
// rim and sleeve, and the hand-drawn mascot printed LARGE on the front (he
// goes on the cups, so he is shown at size). A dashed fill line sits at a
// different height each pour. Press and hold (pointer, Space or Enter) to
// pour a sky-blue mocktail — the stream speeds up the longer you hold —
// and let go to stop. Scored on closeness to the line; past the rim it
// spills over and drips down the cup. Three pours a round; the best pour is
// recorded and the round finds the 'wait-game' sticker.
//
// The servd skin is the same toy in the servd party palette, with no mascot.
// Lowercase copy throughout. Reduced motion: no stream, no drips in motion —
// only the fill level changes.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { buzz, collect, sfx, usePlay, usePrefersReducedMotion } from '@/lib/play'
import s from './wait.module.css'

const POURS_PER_ROUND = 3
/** Fill speed (cup heights per second) at the first instant of a pour… */
const RATE_START = 0.1
/** …and how quickly it accelerates the longer the pour is held. */
const RATE_ACCEL = 0.62
const OVERFLOW_CAP = 1.1
const NOTE_MS = 950
const DRAIN_MS = 360

// Cup geometry (viewBox 0 0 160 196).
const RIM_Y = 32
const BASE_Y = 186
const SPAN = BASE_Y - RIM_Y
const CUP_PATH = 'M26 28 H134 L118 184 Q117.4 190 111 190 H49 Q42.6 190 42 184 Z'
const INNER_PATH = 'M30 30 H130 L115 183 Q114.5 187 110 187 H50 Q45.5 187 45 183 Z'

type Skin = 'stackd' | 'servd'
type Phase = 'ready' | 'pouring' | 'settling' | 'over'

const PALETTE: Record<Skin, { ink: string; glass: string; liquid: string; liquidDeep: string; band: string; bandInk: string }> = {
  stackd: { ink: '#7C2946', glass: '#FFF6EA', liquid: '#9BD3DD', liquidDeep: '#7FC2CE', band: '#7C2946', bandInk: '#FCE8CE' },
  servd:  { ink: '#4E2A4F', glass: '#FFFBF0', liquid: '#FF5A3C', liquidDeep: '#E84A2E', band: '#4E2A4F', bandInk: '#FFD447' },
}

function yFor(level: number): number {
  return BASE_Y - Math.min(1, Math.max(0, level)) * SPAN
}
function nextTarget(prev: number | null): number {
  for (let i = 0; i < 8; i++) {
    const t = 0.52 + Math.random() * 0.34
    if (prev === null || Math.abs(t - prev) > 0.09) return t
  }
  return 0.7
}
function scoreFor(level: number, target: number): number {
  if (level > 1) return 0
  return Math.max(0, Math.round(100 - Math.abs(level - target) * 400))
}
function noteFor(level: number, target: number): string {
  if (level > 1) return 'over the rim'
  const d = level - target
  if (Math.abs(d) <= 0.02) return 'right on the line'
  if (d < 0) return d < -0.12 ? 'barely a sip' : 'a touch shy'
  return d > 0.1 ? 'a bit generous' : 'a touch over'
}

export function PourToLine({
  skin, paused, onRound,
}: {
  skin: Skin
  paused: boolean
  onRound?: (score: number, newBest: boolean) => void
}) {
  const reduced = usePrefersReducedMotion()
  const pal = PALETTE[skin]
  const best = usePlay((st) => st.best['pour'])

  const [phase, setPhase] = useState<Phase>('ready')
  const [target, setTarget] = useState(0.72)
  const [pours, setPours] = useState<number[]>([])
  const [spill, setSpill] = useState(false)
  const [note, setNote] = useState<{ text: string; score: number; key: number } | null>(null)
  const [round, setRound] = useState<{ score: number; newBest: boolean } | null>(null)
  const [announce, setAnnounce] = useState('')

  const level = useRef(0)
  const pourStart = useRef(0)
  const raf = useRef(0)
  const timers = useRef<number[]>([])
  const phaseRef = useRef<Phase>('ready')
  const spillRef = useRef(false)
  const stopRef = useRef<() => void>(() => {})
  const btnRef = useRef<HTMLButtonElement>(null)
  const liquidRef = useRef<SVGRectElement>(null)
  const surfaceRef = useRef<SVGLineElement>(null)
  const streamRef = useRef<SVGLineElement>(null)
  const splashRef = useRef<SVGEllipseElement>(null)

  // Phase lives in state (for rendering) and in a ref (for input handlers
  // that fire faster than React re-renders — a quick tap is down and up
  // before the next render).
  const go = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p) }, [])

  const draw = useCallback(() => {
    const y = yFor(level.current)
    liquidRef.current?.setAttribute('y', y.toFixed(2))
    liquidRef.current?.setAttribute('height', (BASE_Y + 6 - y).toFixed(2))
    surfaceRef.current?.setAttribute('y1', y.toFixed(2))
    surfaceRef.current?.setAttribute('y2', y.toFixed(2))
    surfaceRef.current?.setAttribute('opacity', level.current > 0.01 ? '1' : '0')
    streamRef.current?.setAttribute('y2', (y - 1).toFixed(2))
    splashRef.current?.setAttribute('cy', (y - 1).toFixed(2))
  }, [])

  useEffect(() => () => {
    cancelAnimationFrame(raf.current)
    timers.current.forEach((t) => window.clearTimeout(t))
  }, [])

  // The pour loop — runs only while held.
  useEffect(() => {
    if (phase !== 'pouring') return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const held = (now - pourStart.current) / 1000
      level.current = Math.min(OVERFLOW_CAP, level.current + (RATE_START + RATE_ACCEL * held) * dt)
      if (level.current > 1 && !spillRef.current) { spillRef.current = true; setSpill(true) }
      draw()
      // Held past the brim for good: stop the pour for them.
      if (level.current >= OVERFLOW_CAP) { stopRef.current(); return }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [phase, draw])

  const drain = useCallback((after: () => void) => {
    if (reduced) {
      level.current = 0
      draw()
      after()
      return
    }
    const from = level.current
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / DRAIN_MS)
      level.current = Math.min(1, from) * (1 - k * k)
      draw()
      if (k < 1) raf.current = requestAnimationFrame(step)
      else after()
    }
    raf.current = requestAnimationFrame(step)
  }, [reduced, draw])

  const start = useCallback(() => {
    if (paused || phaseRef.current !== 'ready') return
    pourStart.current = performance.now()
    setNote(null)
    go('pouring')
    sfx('whoosh')
  }, [paused, go])

  const stop = useCallback(() => {
    if (phaseRef.current !== 'pouring') return
    cancelAnimationFrame(raf.current)
    const lvl = level.current
    const sc = scoreFor(lvl, target)
    const all = [...pours, sc]
    const text = noteFor(lvl, target)
    setPours(all)
    go('settling')
    setNote({ text, score: sc, key: all.length })
    setAnnounce(`pour ${all.length}: ${sc}, ${text}.`)
    if (sc >= 90) sfx('ding')
    buzz(lvl > 1 ? 30 : 12)

    timers.current.push(window.setTimeout(() => {
      if (all.length >= POURS_PER_ROUND) {
        const bestPour = Math.max(...all)
        const newBest = usePlay.getState().recordScore('pour', bestPour)
        const r = btnRef.current?.getBoundingClientRect()
        collect('wait-game', r ? { x: r.left + r.width / 2, y: r.top - 60 } : undefined)
        buzz(40)
        setRound({ score: bestPour, newBest })
        go('over')
        setAnnounce(`round done. best pour ${bestPour}${newBest ? ', a new best' : ''}.`)
        onRound?.(bestPour, newBest)
        return
      }
      drain(() => {
        spillRef.current = false
        setSpill(false)
        setNote(null)
        setTarget((t) => nextTarget(t))
        go('ready')
      })
    }, NOTE_MS))
  }, [target, pours, drain, onRound, go])

  stopRef.current = stop

  // Hidden tab or collapsed card: a held pour stops where it is.
  useEffect(() => { if (paused) stop() }, [paused, stop])

  const again = useCallback(() => {
    drain(() => {
      spillRef.current = false
      setSpill(false)
      setNote(null)
      setPours([])
      setRound(null)
      setTarget((t) => nextTarget(t))
      go('ready')
      setAnnounce('')
      window.requestAnimationFrame(() => btnRef.current?.focus())
    })
  }, [drain, go])

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ok */ }
    e.currentTarget.focus({ preventScroll: true })
    start()
  }
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    if (!e.repeat) start()
  }
  function onKeyUp(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    stop()
  }

  const pouring = phase === 'pouring'
  const targetY = yFor(target)
  // Cup wall x at a given y, so the fill line tucks inside the walls.
  const wallAt = (y: number) => {
    const k = (y - 30) / (183 - 30)
    return { l: 30 + (45 - 30) * k, r: 130 - (130 - 115) * k }
  }
  const tw = wallAt(targetY)
  const clipId = `pour-clip-${skin}`

  const label = pouring ? 'pouring…' : phase === 'settling' ? 'next cup…' : 'hold to pour'

  return (
    <>
      <div className={s.meta}>
        <span className={s.pips} aria-hidden="true">
          {Array.from({ length: POURS_PER_ROUND }, (_, i) => (
            <span key={i} className={`${s.pip} ${i < pours.length ? s.pipOn : ''}`} />
          ))}
        </span>
        <span className={s.readout} aria-hidden="true">
          {pours.length > 0 ? `pour ${pours.length}: ${pours[pours.length - 1] ?? 0}` : best ? `best pour ${best}` : 'fill it to the line'}
        </span>
      </div>
      <span className="sr-only" aria-live="polite">{announce}</span>

      <div className={s.cupArea} aria-hidden="true">
        {note && <span key={note.key} className={s.pourNote}>{note.text} · {note.score}</span>}
        <svg className={s.cupSvg} viewBox="0 -8 160 204" focusable="false">
          <defs>
            <clipPath id={clipId}><path d={INNER_PATH} /></clipPath>
          </defs>

          {/* Stream from the jug, behind the printed front of the cup. */}
          {pouring && !reduced && (
            <>
              <line ref={streamRef} className={s.stream} x1="80" y1="-8" x2="80" y2={yFor(level.current)}
                    stroke={pal.liquid} strokeWidth="7" strokeLinecap="round" />
              <ellipse ref={splashRef} className={s.splash} cx="80" cy={yFor(level.current)} rx="11" ry="3.5"
                       fill={pal.liquidDeep} />
            </>
          )}

          {/* Clear cup body */}
          <path d={CUP_PATH} fill={pal.glass} opacity="0.75" />

          {/* The drink */}
          <g clipPath={`url(#${clipId})`}>
            <rect ref={liquidRef} x="20" y={yFor(level.current)} width="120" height={BASE_Y + 6 - yFor(level.current)} fill={pal.liquid} />
            <line ref={surfaceRef} x1="20" x2="140" y1={yFor(level.current)} y2={yFor(level.current)}
                  stroke={pal.liquidDeep} strokeWidth="3" opacity={level.current > 0.01 ? 1 : 0} />
            {/* Sleeve band, printed on the cup */}
            <rect x="20" y="160" width="120" height="18" fill={pal.band} />
            {skin === 'stackd' && (
              <text x="80" y="173" textAnchor="middle" fill={pal.bandInk}
                    style={{ font: 'italic 700 11px var(--stackd-display, Georgia, serif)', letterSpacing: '0.04em' }}>
                stackd
              </text>
            )}
            {skin === 'servd' && (
              <g fill={pal.bandInk}>
                {[52, 66, 80, 94, 108].map((x) => <circle key={x} cx={x} cy="169" r="2.4" />)}
              </g>
            )}
          </g>

          {/* The mascot, printed large on the front of the vessel. */}
          {skin === 'stackd' && (
            <image href="/brand/stackd-mascot.png" x="41" y="48" width="78" height="108"
                   preserveAspectRatio="xMidYMid meet" />
          )}

          {/* Fill line */}
          <line x1={tw.l + 2} x2={tw.r - 2} y1={targetY} y2={targetY}
                stroke={pal.ink} strokeWidth="2.2" strokeDasharray="5 4" strokeLinecap="round" />
          <path d={`M${tw.l - 12} ${targetY - 5} L${tw.l - 4} ${targetY} L${tw.l - 12} ${targetY + 5} Z`} fill={pal.ink} />

          {/* Rim + outline */}
          <path d={CUP_PATH} fill="none" stroke={pal.ink} strokeWidth="3" strokeLinejoin="round" />
          <rect x="22" y="24" width="116" height="7" rx="3.5" fill={pal.ink} />

          {/* Overfill: it spills over the rim and drips down the outside. */}
          {spill && (
            <g fill={pal.liquid} stroke={pal.liquidDeep} strokeWidth="1">
              <path d="M22 26 C 22 20, 138 20, 138 26 Z" />
              <path className={s.drip} d="M25 30 C 22 36, 22 40, 25 42 C 28 40, 28 36, 25 30 Z" />
              <path className={s.drip} d="M135 30 C 132 36, 132 40, 135 42 C 138 40, 138 36, 135 30 Z" />
              <ellipse cx="80" cy="193" rx="46" ry="3.5" opacity="0.8" />
            </g>
          )}
        </svg>
      </div>

      <div className={s.holdRow}>
        <button
          ref={btnRef}
          type="button"
          className={`${s.primary} ${s.hold}`}
          data-held={pouring ? 'true' : 'false'}
          data-toy="tap"
          aria-label="press and hold to pour"
          aria-disabled={phase !== 'ready' && phase !== 'pouring'}
          onPointerDown={onPointerDown}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={stop}
          onContextMenu={(e) => e.preventDefault()}
        >
          {label}
        </button>
      </div>

      {round && (
        <div className={s.ticketWrap}>
          <div className={`${s.ticket} ${round.score < 40 ? s.ticketRetry : ''}`} role="status">
            <p className={s.ticketKicker}>{round.score < 40 ? 'try again' : 'best pour'}</p>
            <p className={s.ticketScore}>{round.score}</p>
            <p className={s.ticketNote}>
              {round.score < 40 ? 'watch the line, ease off early.' : round.newBest ? 'a new best.' : best ? `your best is ${best}.` : 'steady hands.'}
            </p>
            <button type="button" className={s.primary} onClick={again} autoFocus>
              pour again
            </button>
          </div>
        </div>
      )}
    </>
  )
}
