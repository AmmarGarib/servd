'use client'
// The last shot of the simmer take: the candle gutters out and the orange
// passes to the full stop of "simmer down.".
//
// Scrubbed by the section's own entry ('enter' progress: 0 as its top meets
// the bottom of the screen, 1 at 35% up): the flame is full as the sign-off
// arrives, shrinks and dies over the second half, and the snuffed curl rises
// off the wick. The full stop stays bone while the flame is lit and takes the
// orange as the flame goes, so there is one orange on screen at every offset.
// Reduced motion: progress is pinned at 1, so the candle is out, the full
// stop is orange, and nothing moves.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { motion, useMotionValueEvent, useTransform } from 'framer-motion'
import { seg, useScene } from '../../../lib/film/motion'
import { Candle } from './Candle'
import { useRegisterLitCandle } from './litCandles'
import { Line, Reveal } from './reveal'
import s from './simmer.module.css'

const BONE = '#EDE6D3'
const ORANGE = '#E94E1B'
const pad = 'clamp(1.25rem, 5vw, 3rem)'

export function SimmerSignOff() {
  const ref = useRef<HTMLElement>(null)
  const candleRef = useRef<HTMLSpanElement>(null)
  const enter = useScene(ref, 'enter')
  const gutter = useTransform(enter, (e) => seg(e, 0.5, 1))
  const [lit, setLit] = useState(true)
  useRegisterLitCandle(candleRef, lit)

  const paint = (g: number) => {
    const el = candleRef.current
    if (el) {
      el.style.setProperty('--gutter', g.toFixed(3))
      // Full at 1.1 as it arrives, then down to nothing at the wick.
      el.style.setProperty('--flame-scale', (1.1 * Math.max(0, 1 - g * 1.08)).toFixed(3))
      el.style.setProperty('--halo', Math.max(0, 1 - g * 1.4).toFixed(3))
    }
    const on = g < 0.92
    setLit((prev) => (prev === on ? prev : on))
  }
  useMotionValueEvent(gutter, 'change', paint)
  // First paint, and the fixed final value under reduced motion.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => paint(gutter.get()), [gutter])

  // The orange hands over only once the flame is all but gone.
  const stop = useTransform(gutter, [0, 0.86, 1], [BONE, BONE, ORANGE])

  return (
    <section
      ref={ref}
      aria-label="sign-off"
      style={{ padding: `clamp(5rem, 13vh, 8rem) ${pad} clamp(5rem, 12vh, 7rem)`, textAlign: 'center' }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2.2rem' }}>
        <span
          ref={candleRef}
          style={{ display: 'inline-block', lineHeight: 0, ['--gutter' as string]: 0 } as CSSProperties}
        >
          <Candle gutter height={110} />
        </span>
      </div>
      <Reveal>
        <p className={`${s.amarante} ${s.rise}`} style={{ ['--i' as string]: 1, fontSize: '1.4rem', margin: 0 } as CSSProperties}>
          simmer
        </p>
        <p className={s.amarante} style={{ fontSize: 'clamp(3.4rem, 11vw, 6.5rem)', lineHeight: 1, margin: '0.8rem 0 0' }}>
          <Line i={2}>
            simmer down<motion.span style={{ color: stop }}>.</motion.span>
          </Line>
        </p>
      </Reveal>
    </section>
  )
}
