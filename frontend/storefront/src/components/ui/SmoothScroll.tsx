'use client'
// Inertial smooth scrolling (Lenis) for wheel and trackpad. Lenis keeps the
// document as the native scroller and only interpolates the position, so
// position:sticky sections, scroll-driven heroes (framer useScroll, the
// scroll-progress hooks) and anchor links all keep working unchanged.
//
// Off for prefers-reduced-motion. Touch devices keep native momentum
// scrolling (syncTouch is left off) — smoothing touch feels laggy.

import Lenis from 'lenis'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

export function SmoothScroll() {
  const lenisRef = useRef<Lenis | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const lenis = new Lenis({
      lerp: 0.1,           // lower = floatier; 0.1 is responsive but silky
      wheelMultiplier: 1,
      smoothWheel: true,
      anchors: true,       // in-page #links glide instead of jumping
    })
    lenisRef.current = lenis
    let raf = 0
    const loop = (time: number) => {
      lenis.raf(time)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      lenis.destroy()
      lenisRef.current = null
    }
  }, [])

  // A new route may be shorter or taller; let Lenis re-measure the page.
  useEffect(() => {
    lenisRef.current?.resize()
  }, [pathname])

  return null
}
