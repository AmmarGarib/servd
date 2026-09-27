'use client'
// LightTheCandle — simmer's "while you wait".
//
// Not a game, quite: press and hold for 1.2s to strike. A thin orange arc
// fills around the wick while you hold (it eases back if you let go early);
// when it closes, the lit candle fades in over the snuffed one and a single
// line appears: "there. we'll bring it when it's ready."
//
// Brand bible: lowercase, Amarante + Times, flat shapes, no white, no
// gradients, no exclamation marks, no characters. One orange signal — the
// arc before the flame, the flame after it. No score, no stickers, no
// confetti: simmer stays out of the sticker economy, so this never calls
// collect().

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Candle } from '@/components/brand/simmer/Candle'
import s from './wait.module.css'

const HOLD_MS = 1200
const RELEASE_MS = 300
const R = 28
const CIRC = 2 * Math.PI * R

export function LightTheCandle({ paused }: { paused: boolean }) {
  const [lit, setLit] = useState(false)
  const [holding, setHolding] = useState(false)
  const arcRef = useRef<SVGCircleElement>(null)
  const progress = useRef(0)
  const holdingRef = useRef(false)
  const litRef = useRef(false)
  const raf = useRef(0)
  const btnRef = useRef<HTMLButtonElement>(null)

  const paint = useCallback(() => {
    arcRef.current?.setAttribute('stroke-dashoffset', (CIRC * (1 - progress.current)).toFixed(2))
  }, [])

  // One loop handles both the fill while held and the ease-back on release.
  const loop = useCallback(() => {
    cancelAnimationFrame(raf.current)
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (holdingRef.current) {
        progress.current = Math.min(1, progress.current + dt / HOLD_MS)
      } else {
        progress.current = Math.max(0, progress.current - dt / RELEASE_MS)
      }
      paint()
      if (progress.current >= 1 && holdingRef.current) {
        holdingRef.current = false
        litRef.current = true
        setHolding(false)
        setLit(true)
        return
      }
      if (holdingRef.current || progress.current > 0) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [paint])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const press = useCallback(() => {
    if (litRef.current || paused || holdingRef.current) return
    holdingRef.current = true
    setHolding(true)
    loop()
  }, [paused, loop])

  const release = useCallback(() => {
    if (!holdingRef.current) return
    holdingRef.current = false
    setHolding(false)
    loop()
  }, [loop])

  useEffect(() => { if (paused) release() }, [paused, release])

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ok */ }
    e.currentTarget.focus({ preventScroll: true })
    press()
  }
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    if (!e.repeat) press()
  }
  function onKeyUp(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    release()
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={s.strike}
        aria-label={lit ? 'the candle is lit' : 'press and hold to light the candle'}
        aria-disabled={lit || undefined}
        data-toy={lit ? undefined : 'tap'}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={release}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className={s.candleBox} aria-hidden="true">
          <span className={s.candleLayer} style={{ opacity: lit ? 0 : 1 }}>
            <Candle lit={false} height={150} />
          </span>
          <span className={s.candleLayer} style={{ opacity: lit ? 1 : 0 }}>
            {lit && <Candle lit height={150} />}
          </span>
          <svg className={s.arc} viewBox="0 0 64 64" style={{ opacity: lit ? 0 : 1 }} focusable="false">
            <circle cx="32" cy="32" r={R} fill="none" stroke="var(--simmer-bone)" strokeOpacity={holding ? 0.28 : 0.14} strokeWidth="1" />
            <circle
              ref={arcRef}
              cx="32" cy="32" r={R}
              fill="none"
              stroke="var(--simmer-orange)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeDasharray={CIRC.toFixed(2)}
              strokeDashoffset={CIRC.toFixed(2)}
              transform="rotate(-90 32 32)"
            />
          </svg>
        </span>
      </button>
      <p
        key={lit ? 'lit' : 'unlit'}
        className={`${s.strikeLine} ${lit ? s.strikeLineIn : ''}`}
        aria-live="polite"
      >
        {lit
          ? 'there. we’ll bring it when it’s ready.'
          : holding
            ? 'keep holding.'
            : 'press and hold to light the candle.'}
      </p>
    </>
  )
}
