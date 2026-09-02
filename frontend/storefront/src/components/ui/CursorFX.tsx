'use client'
// CursorFX — the pointer as part of the design.
//
// Three layers:
//   1. Ambient glow — a large, soft plum light that trails the pointer
//      on a slow spring and blends into whatever surface is beneath.
//   2. Trailing ring — springy, blooms over anything clickable.
//   3. The dot — tracks 1:1. While the user is actively SCROLLING it
//      morphs into a random line-drawn dish (burger, fries, taco…) from
//      the shared glyph set, tipping in the scroll direction, then
//      settles back to a dot when the scroll rests.
//
// mix-blend-difference keeps ring/dot/dish legible on every surface.
// Renders nothing on coarse pointers and for reduced-motion.

import { motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { FoodGlyph, FOOD_GLYPHS } from './foodGlyphs'

const INTERACTIVE = 'a, button, [role="button"], input, select, textarea, label, summary, [data-cursor]'

export function CursorFX() {
  const reduce = useReducedMotion()
  const [enabled, setEnabled] = useState(false)
  const [visible, setVisible] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const [dish, setDish] = useState(0)
  const [tilt, setTilt] = useState(0)

  const x = useMotionValue(-100)
  const y = useMotionValue(-100)
  const ringX = useSpring(x, { stiffness: 350, damping: 30, mass: 0.6 })
  const ringY = useSpring(y, { stiffness: 350, damping: 30, mass: 0.6 })
  const glowX = useSpring(x, { stiffness: 90, damping: 22, mass: 1 })
  const glowY = useSpring(y, { stiffness: 90, damping: 22, mass: 1 })

  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrollY = useRef(0)
  const wasScrolling = useRef(false)

  useEffect(() => {
    if (reduce) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return
    setEnabled(true)
    lastScrollY.current = window.scrollY

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
    const onScroll = () => {
      const dy = window.scrollY - lastScrollY.current
      lastScrollY.current = window.scrollY
      if (!wasScrolling.current) {
        // a fresh scroll burst — deal a new dish
        setDish(Math.floor(Math.random() * FOOD_GLYPHS.length))
        wasScrolling.current = true
        setScrolling(true)
      }
      setTilt(Math.max(-16, Math.min(16, dy * 0.6)))
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => {
        wasScrolling.current = false
        setScrolling(false)
        setTilt(0)
      }, 320)
    }

    window.addEventListener('mousemove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('scroll', onScroll)
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
    }
  }, [reduce, x, y])

  if (!enabled) return null

  const ringSize = hovering ? 52 : 34
  return (
    <>
      {/* ── ambient glow — beneath the blend layers, above backgrounds */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
        <motion.div style={{
          x: glowX, y: glowY,
          position: 'absolute', top: 0, left: 0,
          width: 520, height: 520, marginLeft: -260, marginTop: -260,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(201,164,242,0.4) 0%, rgba(154,106,184,0.14) 38%, transparent 68%)',
          mixBlendMode: 'soft-light',
          opacity: visible ? 1 : 0,
          transition: 'opacity 300ms ease',
        }} />
      </div>

      {/* ── ring + dot / dish ── */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999 }}>
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
            opacity: visible && !scrolling ? 1 : 0,
            scale: pressed ? 0.8 : 1,
            transition: 'width 260ms cubic-bezier(0.22,1,0.36,1), height 260ms cubic-bezier(0.22,1,0.36,1), margin 260ms cubic-bezier(0.22,1,0.36,1), background 200ms ease, opacity 200ms ease, scale 150ms ease',
          }}
        />
        {/* dot at rest */}
        <motion.div
          style={{
            x, y,
            position: 'absolute', top: 0, left: 0,
            width: 7, height: 7, marginLeft: -3.5, marginTop: -3.5,
            borderRadius: '50%',
            background: 'white',
            mixBlendMode: 'difference',
            opacity: visible && !scrolling ? 1 : 0,
            transition: 'opacity 160ms ease',
          }}
        />
        {/* dish while scrolling */}
        <motion.div
          style={{
            x, y,
            position: 'absolute', top: 0, left: 0,
            width: 30, height: 30, marginLeft: -15, marginTop: -15,
            color: 'white',
            mixBlendMode: 'difference',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: visible && scrolling ? 1 : 0,
            rotate: tilt,
            scale: scrolling ? 1 : 0.5,
            transition: 'opacity 160ms ease, scale 220ms cubic-bezier(0.22,1,0.36,1), rotate 180ms ease',
          }}
        >
          <FoodGlyph index={dish} size={28} />
        </motion.div>
      </div>
    </>
  )
}
