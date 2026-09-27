'use client'
// The lucky-pull lever that sits next to the /browse search box: a butter
// knob on a plum stick, slot-machine style. Drag the knob down (pointer), or
// tap / Enter / Space anywhere on it. It snaps down, springs back
// (stiffness 400, damping 14) and clacks; the page runs the card roulette.
//
// Only the knob takes `touch-action: none`, so a thumb that lands on the
// housing still scrolls the page.

import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { sfx, usePrefersReducedMotion } from '@/lib/play'
import s from './browse.module.css'

/** Knob travel, px. The stick foreshortens as the knob comes down. */
const TRAVEL = 30
/** Past this fraction of the travel, letting go counts as a pull. */
const COMMIT = 0.55

interface Props {
  /** Called once per pull, as the lever hits the bottom. */
  onPull: () => void
  /** A roulette is running (or there's nothing to pick from). */
  busy?: boolean
  disabled?: boolean
}

export function LuckyPull({ onPull, busy = false, disabled = false }: Props) {
  const reduce = usePrefersReducedMotion()
  const y = useMotionValue(0)
  const stickScale = useTransform(y, [0, TRAVEL], [1, 0.3])
  const knobScale = useTransform(y, [0, TRAVEL], [1, 1.14])
  const slotGlow = useTransform(y, [0, TRAVEL], [0, 1])

  const drag = useRef<{ id: number; startY: number; moved: boolean } | null>(null)
  const swallowClick = useRef(false)

  const inert = busy || disabled

  function springBack() {
    if (reduce) { y.set(0); return }
    animate(y, 0, { type: 'spring', stiffness: 400, damping: 14 })
  }

  function fire() {
    if (inert) return
    sfx('clack')
    if (reduce) {
      y.set(0)
      onPull()
      return
    }
    // Snap to the bottom, then let the spring throw it back up.
    animate(y, TRAVEL, { duration: 0.08, ease: 'easeIn' }).then(springBack)
    onPull()
  }

  function onKnobDown(e: ReactPointerEvent<HTMLSpanElement>) {
    if (inert || e.button !== 0) return
    drag.current = { id: e.pointerId, startY: e.clientY, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* old browsers */ }
  }

  function onKnobMove(e: ReactPointerEvent<HTMLSpanElement>) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dy = e.clientY - d.startY
    if (Math.abs(dy) > 4) d.moved = true
    // A little resistance near the bottom, like a real spring.
    const raw = Math.max(0, dy)
    y.set(raw < TRAVEL ? raw : TRAVEL + (raw - TRAVEL) * 0.08)
  }

  function onKnobUp(e: ReactPointerEvent<HTMLSpanElement>) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (!d.moved) return // a plain tap: the button's click handles it
    swallowClick.current = true
    if (y.get() >= TRAVEL * COMMIT) fire()
    else springBack()
  }

  function onKnobCancel() {
    if (!drag.current) return
    drag.current = null
    springBack()
  }

  return (
    <button
      type="button"
      className={s.lever}
      data-toy="pull"
      aria-label="feeling lucky, pick a kitchen for me"
      aria-disabled={inert || undefined}
      data-off={disabled || undefined}
      onClick={() => {
        if (swallowClick.current) { swallowClick.current = false; return }
        fire()
      }}
    >
      <span aria-hidden className={s.leverHousing}>
        <motion.span className={s.leverSlot} style={{ opacity: slotGlow }} />
      </span>
      <motion.span aria-hidden className={s.leverStick} style={{ scaleY: stickScale }} />
      <motion.span
        aria-hidden
        className={s.leverKnob}
        style={{ y, scale: knobScale }}
        onPointerDown={onKnobDown}
        onPointerMove={onKnobMove}
        onPointerUp={onKnobUp}
        onPointerCancel={onKnobCancel}
        onLostPointerCapture={onKnobCancel}
      >
        <span className={s.leverShine} />
      </motion.span>
      <span aria-hidden className={s.leverTag}>lucky</span>
    </button>
  )
}
