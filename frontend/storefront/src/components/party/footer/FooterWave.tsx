'use client'
// Decorative scalloped/wavy top edge for the footer — a cream band that dips
// into the plum ground so the page above doesn't end on a hard straight line.
// Purely cosmetic (aria-hidden).
//
// The first time it scrolls into view it gives one rubbery wobble (scaleY
// 1 → 1.15 → 0.95 → 1 over 700ms), then stays still for good. The resting
// state is the finished wave, so nothing is ever blank before it fires, and
// under reduced motion the class does nothing (see footer.module.css).
import { useEffect, useRef, useState } from 'react'
import s from './footer.module.css'

export function FooterWave() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [wobble, setWobble] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setWobble(true)
          io.disconnect()
        }
      },
      { threshold: 0.2 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div ref={ref} className={s.waveWrap} aria-hidden>
      <svg
        className={wobble ? `${s.wave} ${s.waveWobble}` : s.wave}
        viewBox="0 0 1440 60"
        preserveAspectRatio="none"
      >
        <path d="M0,30 C120,60 240,0 360,30 C480,60 600,0 720,30 C840,60 960,0 1080,30 C1200,60 1320,0 1440,30 L1440,60 L0,60 Z" />
      </svg>
    </div>
  )
}
