'use client'
// simmer — a candle, drawn flat, that keeps the room's hours.
//
// Wax, wick, an orange outer flame and a bone core, each a single flat shape.
// It flickers by scaling those shapes from their base on two out-of-step
// loops, so it never repeats visibly. The light on the wall is three flat
// bone discs at 3–6% opacity (a stepped halo, like a screenprint — never a
// gradient). Embers are two flat orange specks that belong to the same flame,
// so the candle stays ONE orange signal.
//
// The candle is lit ONLY while the kitchen is serving (useService — the same
// hours as the world's kitchen state, so the home board, the doors scenes and
// this candle agree). When the room is closed the candle is out: no flame, a
// single thin bone wisp rising slowly off the wick, and one line under it —
// the room's own status ('doors at 7pm tonight' / 'closed tonight · back
// tuesday'). With the flame gone, the viewport's single orange becomes the
// small live dot in that line. Where the candle sits inside a drawing and
// carries no line (the walk-in hero), the dot is a dying ember on the wick.
//
// Lit on entering view (below the fold at mount only): a 600 ms ignite.
//
// `lit` overrides the room: `lit={false}` is the sign-off (the candle is out,
// the full stop of "simmer down." is that viewport's orange), `lit` forces it
// on. Reduced motion (simmer.module.css): a still flame or a still wisp.
//
// The drawing is aria-hidden; the status line is real text.

import { useEffect, useRef, type CSSProperties } from 'react'
import { useService } from './serviceClock'
import s from './simmer.module.css'

export function Candle({
  height = 140, lit, halo = true, fluid = false, status, className, style,
}: {
  height?: number
  /** Fill the parent's width instead of a fixed pixel height. */
  fluid?: boolean
  /** Force the flame on or off. Unset: follow tonight's service. */
  lit?: boolean
  halo?: boolean
  /** Show the room's status under an out candle. Default: on, except when
   *  `fluid` (a candle inside a drawing). Only applies when following service. */
  status?: boolean
  className?: string
  style?: CSSProperties
}) {
  const service = useService()
  const follows = lit === undefined
  const on = follows ? service.open : lit
  const showLine = follows && !on && (status ?? !fluid)
  const wickEmber = follows && !on && !showLine
  const width = (height * 60) / 140
  const ref = useIgnite<HTMLSpanElement>(on)

  const drawing = (
    <span
      ref={ref}
      aria-hidden="true"
      className={`${s.candle} ${showLine ? '' : className ?? ''}`}
      style={fluid ? { display: 'block', width: '100%', ...(showLine ? null : style) } : showLine ? undefined : style}
    >
      <svg
        {...(fluid ? { style: { width: '100%', height: 'auto' } } : { width, height })}
        viewBox="0 0 60 140"
        focusable="false"
      >
        {on && halo && (
          <g className={s.halo}>
            <circle cx="30" cy="42" r="46" fill="var(--simmer-bone)" opacity="0.03" />
            <circle cx="30" cy="42" r="31" fill="var(--simmer-bone)" opacity="0.04" />
            <circle cx="30" cy="42" r="19" fill="var(--simmer-bone)" opacity="0.055" />
          </g>
        )}

        {on ? (
          // Lit: thin wisps off the flame tip.
          [0, 1, 2].map((i) => (
            <path
              key={i}
              className={s.smoke}
              style={{ ['--i' as string]: i } as CSSProperties}
              d={
                i === 0 ? 'M30 18 C 26 8, 35 0, 30 -10 C 26 -18, 33 -26, 29 -34'
                : i === 1 ? 'M30 18 C 34 9, 25 1, 31 -8 C 35 -15, 27 -23, 32 -31'
                : 'M30 18 C 28 10, 33 4, 29 -4 C 26 -11, 32 -19, 28 -27'
              }
              fill="none"
              stroke="var(--simmer-bone)"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          ))
        ) : (
          // Out: one thin wisp off the wick.
          <path
            className={s.wisp}
            d="M30 52 C 26 44, 34 38, 30 30 C 27 23, 33 17, 29 9"
            fill="none"
            stroke="var(--simmer-bone)"
            strokeWidth="1"
            strokeLinecap="round"
          />
        )}

        {on && (
          <g className={s.flameGroup}>
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
        <line x1="30" y1={on ? 52 : 54} x2="30" y2="61" stroke="var(--simmer-black)" strokeWidth="1.6" strokeLinecap="round" />
        {wickEmber && <circle className={s.wickEmber} cx="30" cy="54" r="1.3" fill="var(--simmer-orange)" />}

        {/* Wax: a bone pillar with one frozen drip and a flat shadow side. */}
        <path d="M19 61 H41 V128 H19 Z" fill="var(--simmer-bone)" />
        <path d="M34 61 H41 V128 H34 Z" fill="var(--simmer-green)" opacity="0.14" />
        <path d="M19 61 H41 V64 C 36 64, 35 70, 33 70 C 31 70, 31 65, 27 65 C 24 65, 23 76, 21 76 C 19.5 76, 19 72, 19 70 Z"
              fill="var(--simmer-green)" opacity="0.08" />
        {/* Holder */}
        <rect x="11" y="127" width="38" height="6" fill="var(--simmer-walnut)" />
        <rect x="11" y="127" width="38" height="6" fill="none" stroke="var(--simmer-bone)" strokeOpacity="0.35" strokeWidth="0.8" />
      </svg>
    </span>
  )

  if (!showLine) return drawing
  return (
    <span className={`${s.candleWrap} ${className ?? ''}`} style={style}>
      {drawing}
      <span className={s.candleLine} suppressHydrationWarning>
        <span aria-hidden="true" className={s.liveDot} />
        {service.status}
      </span>
    </span>
  )
}

/**
 * The 600 ms ignite. Only a candle that is lit and still below the fold at
 * mount is held dark (`data-ignite="armed"`); it catches the moment it comes
 * within reach of the viewport. Anything already on screen, reduced motion,
 * or no IntersectionObserver: it is simply lit, as the server painted it.
 */
function useIgnite<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !on) return
    if (typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const vh = window.innerHeight || document.documentElement.clientHeight
    if (el.getBoundingClientRect().top < vh * 1.05) return
    el.dataset.ignite = 'armed'
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      el.dataset.ignite = 'go'
    }, { rootMargin: '0px 0px 5% 0px', threshold: 0.01 })
    io.observe(el)
    return () => {
      io.disconnect()
      if (el.dataset.ignite === 'armed') delete el.dataset.ignite
    }
  }, [on])
  return ref
}
