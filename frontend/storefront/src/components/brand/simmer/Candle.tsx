'use client'
// simmer — a candle, drawn flat.
//
// Wax, wick, an orange outer flame and a bone core, each a single flat shape.
// It flickers by scaling those shapes from their base on two out-of-step
// loops, so it never repeats visibly. The light on the wall is three flat
// bone discs at 3–6% opacity (a stepped halo, like a screenprint — never a
// gradient). Smoke is bone ribbon. Embers are two flat orange specks that
// belong to the same flame, so the candle stays ONE orange signal.
//
// `lit={false}` is the sign-off: the flame is out and a curl of smoke rises
// off the wick.
//
// `interactive` (only meaningful when unlit) turns the snuffed candle into a
// quiet egg: it becomes a real <button> ("relight the candle"). A tap strikes
// the flame for four seconds (it grows from nothing with a short flicker and
// the wick glows), then it goes out again and the existing smoke curl
// returns. No score, no sound, no confetti — simmer stays out of the sticker
// economy.
//
// Decorative otherwise, and aria-hidden. Reduced motion (simmer.module.css)
// holds the flame still, drops embers and steam, and leaves smoke as a faint
// trace; relight.module.css makes the relit flame simply appear and vanish.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import s from './simmer.module.css'
import r from './relight.module.css'

/** How long a relit flame burns before it goes out again. */
const RELIGHT_MS = 4000
/** The going-out fade at the end of that window. */
const SNUFF_MS = 380

type RelightPhase = 'off' | 'lit' | 'out'

export function Candle({
  height = 140, lit = true, halo = true, fluid = false, className, style,
  interactive = false, onRelight,
}: {
  height?: number
  /** Fill the parent's width instead of a fixed pixel height. */
  fluid?: boolean
  lit?: boolean
  halo?: boolean
  className?: string
  style?: CSSProperties
  /** Unlit only: the candle becomes a button that relights for a moment. */
  interactive?: boolean
  /** Called each time the visitor relights the candle. */
  onRelight?: () => void
}) {
  const width = (height * 60) / 140
  const [phase, setPhase] = useState<RelightPhase>('off')
  const timers = useRef<number[]>([])

  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)) }, [])

  const canRelight = interactive && !lit
  const relit = canRelight && phase !== 'off'
  const burning = lit || relit

  function relight() {
    if (phase !== 'off') return
    timers.current.forEach((t) => window.clearTimeout(t))
    setPhase('lit')
    timers.current = [
      window.setTimeout(() => setPhase('out'), RELIGHT_MS - SNUFF_MS),
      window.setTimeout(() => setPhase('off'), RELIGHT_MS),
    ]
    onRelight?.()
  }

  const svg = (
    <svg
      {...(fluid ? { style: { width: '100%', height: 'auto' } } : { width, height })}
      viewBox="0 0 60 140"
      focusable="false"
      aria-hidden="true"
    >
      {burning && halo && (
        <g className={`${s.halo} ${relit ? r.haloIn : ''} ${phase === 'out' ? r.goOut : ''}`}>
          <circle cx="30" cy="42" r="46" fill="var(--simmer-bone)" opacity="0.03" />
          <circle cx="30" cy="42" r="31" fill="var(--simmer-bone)" opacity="0.04" />
          <circle cx="30" cy="42" r="19" fill="var(--simmer-bone)" opacity="0.055" />
        </g>
      )}

      {/* Smoke — lit: thin wisps off the flame tip; out: the snuffed curl. */}
      {[0, 1, 2].map((i) => (
        <path
          key={`${burning ? 'lit' : 'out'}-${i}`}
          className={burning ? s.smoke : s.snuff}
          style={{ ['--i' as string]: i } as CSSProperties}
          d={
            i === 0 ? 'M30 18 C 26 8, 35 0, 30 -10 C 26 -18, 33 -26, 29 -34'
            : i === 1 ? 'M30 18 C 34 9, 25 1, 31 -8 C 35 -15, 27 -23, 32 -31'
            : 'M30 18 C 28 10, 33 4, 29 -4 C 26 -11, 32 -19, 28 -27'
          }
          transform={burning ? undefined : 'translate(0 36)'}
          fill="none"
          stroke="var(--simmer-bone)"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      ))}

      {burning && (
        <g className={relit ? `${r.ignite} ${phase === 'out' ? r.goOut : ''}` : undefined}>
          {/* Embers — part of the flame, not a second signal. */}
          <circle className={s.ember} style={{ ['--i' as string]: 0, ['--dx' as string]: '7px' } as CSSProperties}
                  cx="31" cy="24" r="1.1" fill="var(--simmer-orange)" />
          <circle className={s.ember} style={{ ['--i' as string]: 1, ['--dx' as string]: '-5px' } as CSSProperties}
                  cx="29" cy="26" r="0.9" fill="var(--simmer-orange)" />

          {/* Flame: flat orange body, flat bone core. */}
          <path className={s.flame}
                d="M30 20 C 36 31, 40 41, 37 50 C 35 57, 25 57, 23 50 C 20 41, 24 31, 30 20 Z"
                fill="var(--simmer-orange)" />
          <path className={s.core}
                d="M30 37 C 33 43, 34.5 48, 32.8 52.5 C 31.8 55, 28.2 55, 27.2 52.5 C 25.5 48, 27 43, 30 37 Z"
                fill="var(--simmer-bone)" />
        </g>
      )}

      {/* Wick */}
      <line x1="30" y1={burning ? 52 : 54} x2="30" y2="61" stroke="var(--simmer-black)" strokeWidth="1.6" strokeLinecap="round" />
      {/* A relit wick glows at the tip — the same orange as the flame it feeds. */}
      {relit && (
        <circle className={`${r.wickGlow} ${phase === 'out' ? r.goOut : ''}`}
                cx="30" cy="54.5" r="1.6" fill="var(--simmer-orange)" />
      )}

      {/* Wax: a bone pillar with one frozen drip and a flat shadow side. */}
      <path d="M19 61 H41 V128 H19 Z" fill="var(--simmer-bone)" />
      <path d="M34 61 H41 V128 H34 Z" fill="var(--simmer-green)" opacity="0.14" />
      <path d="M19 61 H41 V64 C 36 64, 35 70, 33 70 C 31 70, 31 65, 27 65 C 24 65, 23 76, 21 76 C 19.5 76, 19 72, 19 70 Z"
            fill="var(--simmer-green)" opacity="0.08" />
      {/* Holder */}
      <rect x="11" y="127" width="38" height="6" fill="var(--simmer-walnut)" />
      <rect x="11" y="127" width="38" height="6" fill="none" stroke="var(--simmer-bone)" strokeOpacity="0.35" strokeWidth="0.8" />
    </svg>
  )

  const boxStyle: CSSProperties | undefined = fluid ? { display: 'block', width: '100%', ...style } : style

  if (canRelight) {
    return (
      <button
        type="button"
        aria-label="relight the candle"
        data-toy="tap"
        onClick={relight}
        className={`${s.candle} ${r.relight} ${className ?? ''}`}
        style={boxStyle}
      >
        {svg}
      </button>
    )
  }

  return (
    <span aria-hidden="true" className={`${s.candle} ${className ?? ''}`} style={boxStyle}>
      {svg}
    </span>
  )
}
