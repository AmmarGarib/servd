'use client'
// CursorFX — a springy trailing ring that follows the pointer sitewide.
//
// The native cursor stays (usability first); this adds a small dot that
// tracks 1:1 plus a larger ring that lags on a spring. Over anything
// clickable the ring blooms and softens. mix-blend-difference keeps it
// legible on every surface — bone, concrete, obsidian, turf.
//
// Renders nothing on coarse pointers (touch) and for reduced-motion.

import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import { useEffect, useState } from 'react'

const INTERACTIVE = 'a, button, [role="button"], input, select, textarea, label, summary, [data-cursor]'

export function CursorFX() {
  const reduce = useReducedMotion()
  const [enabled, setEnabled] = useState(false)
  const [visible, setVisible] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [pressed, setPressed] = useState(false)

  const x = useMotionValue(-100)
  const y = useMotionValue(-100)
  const ringX = useSpring(x, { stiffness: 350, damping: 30, mass: 0.6 })
  const ringY = useSpring(y, { stiffness: 350, damping: 30, mass: 0.6 })

  useEffect(() => {
    if (reduce) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return
    setEnabled(true)

    const onMove = (e: MouseEvent) => {
      x.set(e.clientX)
      y.set(e.clientY)
      setVisible(true)
      const el = e.target instanceof Element ? e.target.closest(INTERACTIVE) : null
      setHovering(!!el)
    }
    const onLeave = () => setVisible(false)
    const onDown = () => setPressed(true)
    const onUp = () => setPressed(false)

    window.addEventListener('mousemove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
    }
  }, [reduce, x, y])

  if (!enabled) return null

  const ringSize = hovering ? 52 : 34
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999 }}>
      {/* trailing ring */}
      <motion.div
        style={{
          x: ringX, y: ringY,
          position: 'absolute', top: 0, left: 0,
          width: ringSize, height: ringSize,
          marginLeft: -ringSize / 2, marginTop: -ringSize / 2,
          borderRadius: '50%',
          border: '1.5px solid white',
          background: hovering ? 'rgba(255,255,255,0.14)' : 'transparent',
          mixBlendMode: 'difference',
          opacity: visible ? 1 : 0,
          scale: pressed ? 0.8 : 1,
          transition: 'width 260ms cubic-bezier(0.22,1,0.36,1), height 260ms cubic-bezier(0.22,1,0.36,1), margin 260ms cubic-bezier(0.22,1,0.36,1), background 200ms ease, opacity 200ms ease, scale 150ms ease',
        }}
      />
      {/* dot — tracks 1:1 */}
      <motion.div
        style={{
          x, y,
          position: 'absolute', top: 0, left: 0,
          width: 7, height: 7, marginLeft: -3.5, marginTop: -3.5,
          borderRadius: '50%',
          background: 'white',
          mixBlendMode: 'difference',
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease',
        }}
      />
    </div>
  )
}
