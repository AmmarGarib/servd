'use client'
// ScrollDock — the scrollbar, reimagined as a service rail.
//
// The native scrollbar is hidden (globals.css); in its place a slim
// rail floats on the right edge with a line-drawn dish riding it. The
// dish travels with scroll progress, tips into the direction of travel,
// and swaps to the next dish roughly every viewport of scroll — forward
// through the menu going down, backward going up.
//
// Blend-difference white so it reads on every surface. Hidden on touch
// (native momentum scrolling has its own indicator), for reduced-motion
// users, and on pages too short to scroll.

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { FoodGlyph } from './foodGlyphs'

export function ScrollDock() {
  const reduce = useReducedMotion()
  const [enabled, setEnabled] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dish, setDish] = useState(0)
  const [tilt, setTilt] = useState(0)
  const [scrollable, setScrollable] = useState(false)
  const raf = useRef(0)
  const lastY = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (reduce) return
    if (window.matchMedia?.('(pointer: coarse)').matches) return
    setEnabled(true)

    const update = () => {
      raf.current = 0
      const doc = document.documentElement
      const max = doc.scrollHeight - window.innerHeight
      setScrollable(max > 200)
      if (max <= 0) return
      const yNow = window.scrollY
      setProgress(Math.max(0, Math.min(1, yNow / max)))
      setDish(Math.floor(yNow / (window.innerHeight * 0.9)))
      const dy = yNow - lastY.current
      lastY.current = yNow
      if (dy !== 0) {
        setTilt(Math.max(-18, Math.min(18, dy * 0.5)))
        if (settle.current) clearTimeout(settle.current)
        settle.current = setTimeout(() => setTilt(0), 260)
      }
    }
    const onScroll = () => { if (!raf.current) raf.current = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf.current) cancelAnimationFrame(raf.current)
      if (settle.current) clearTimeout(settle.current)
    }
  }, [reduce])

  if (!enabled || !scrollable) return null

  return (
    <div aria-hidden style={{
      position: 'fixed',
      right: 'clamp(0.5rem, 1.4vw, 1.1rem)',
      top: '50%',
      transform: 'translateY(-50%)',
      height: 'min(42vh, 420px)',
      zIndex: 60,
      pointerEvents: 'none',
      mixBlendMode: 'difference',
      color: 'white',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    }}>
      {/* rail */}
      <span style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.35)' }} />
      {/* end caps */}
      <span style={{ position: 'absolute', top: -2, left: '50%', width: 9, height: 1.5, background: 'rgba(255,255,255,0.5)', transform: 'translateX(-50%)' }} />
      <span style={{ position: 'absolute', bottom: -2, left: '50%', width: 9, height: 1.5, background: 'rgba(255,255,255,0.5)', transform: 'translateX(-50%)' }} />
      {/* the travelling dish */}
      <span style={{
        position: 'absolute',
        top: `${progress * 100}%`,
        left: '50%',
        transform: `translate(-50%, -50%) rotate(${tilt}deg)`,
        transition: 'transform 200ms ease',
        background: 'black',
        borderRadius: '50%',
        padding: 5,
        display: 'inline-flex',
        border: '1px solid rgba(255,255,255,0.55)',
      }}>
        <FoodGlyph index={dish} size={17} strokeWidth={2} />
      </span>
    </div>
  )
}
