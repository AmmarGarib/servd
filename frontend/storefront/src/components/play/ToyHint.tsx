'use client'
// Toy hint: a little sticker label ("poke", "flip", "pull"…) that trails the
// cursor while it is over anything marked [data-toy]. Fine pointers with hover
// only, never on a quiet route. It never hides or replaces the OS cursor and
// never takes pointer events.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useMotionValue, useSpring } from 'framer-motion'
import { TOY_ATTR, TOY_VERBS, type ToyVerb } from '../../lib/play/bus'
import s from './play.module.css'

const OFFSET_X = 16
const OFFSET_Y = 18
const SPRING = { stiffness: 600, damping: 40 }
const FINE = '(hover: hover) and (pointer: fine)'

function verbOf(el: Element | null): ToyVerb | null {
  const toy = el?.closest?.(`[${TOY_ATTR}]`)
  if (!toy) return null
  const v = (toy.getAttribute(TOY_ATTR) ?? '').trim().toLowerCase() as ToyVerb
  return TOY_VERBS.includes(v) ? v : null
}

export function ToyHint({ reduced }: { reduced: boolean }) {
  const [fine, setFine] = useState(false)
  const [verb, setVerb] = useState<ToyVerb | null>(null)
  const x = useMotionValue(-100)
  const y = useMotionValue(-100)
  const sx = useSpring(x, SPRING)
  const sy = useSpring(y, SPRING)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(FINE)
    setFine(mq.matches)
    const on = (e: MediaQueryListEvent) => setFine(e.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])

  useEffect(() => {
    if (!fine) {
      setVerb(null)
      return
    }
    let current: ToyVerb | null = null
    const place = (e: PointerEvent, jump: boolean) => {
      const nx = e.clientX + OFFSET_X
      const ny = e.clientY + OFFSET_Y
      x.set(nx)
      y.set(ny)
      if (jump || reduced) {
        sx.jump(nx)
        sy.jump(ny)
      }
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
      const next = verbOf(e.target as Element | null)
      if (next !== current) {
        place(e, current === null)
        current = next
        setVerb(next)
      }
    }
    const move = (e: PointerEvent) => {
      if (current) place(e, false)
    }
    const leaveDoc = (e: PointerEvent) => {
      if (!e.relatedTarget) {
        current = null
        setVerb(null)
      }
    }
    const hide = () => {
      current = null
      setVerb(null)
    }
    document.addEventListener('pointerover', over, { passive: true })
    document.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerout', leaveDoc, { passive: true })
    // A pressed toy is being played with; the label would just be in the way.
    document.addEventListener('pointerdown', hide, { passive: true })
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', leaveDoc)
      document.removeEventListener('pointerdown', hide)
      window.removeEventListener('blur', hide)
    }
  }, [fine, reduced, x, y, sx, sy])

  if (!fine) return null

  return (
    <motion.div className={s.hint} style={{ x: sx, y: sy }} aria-hidden="true">
      <AnimatePresence>
        {verb && (
          <motion.span
            key={verb}
            className={s.hintLabel}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0% 0%' }}
          >
            {verb}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default ToyHint
