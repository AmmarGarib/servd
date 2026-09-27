import type { CSSProperties } from 'react'
import t from './tracker.module.css'

// Per-act set dressing inside the tracker hero.
//   preparing → six steam wisps rising behind the headline
//   ready     → a bag with a pulse ring
// Particles are hidden under reduced motion (the CSS handles it); the bag
// and its ring stay, still.

export function SteamWisps() {
  return (
    <div className={t.wisps} aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <span key={i} className={t.wisp} style={{ '--i': i } as CSSProperties} />
      ))}
    </div>
  )
}

export function ReadyBag({ size = 64 }: { size?: number }) {
  return (
    <span className={t.readyBag} style={{ width: size, height: size }}>
      <span className={t.pulseRing} aria-hidden="true" />
      <span className={t.pulseRing} aria-hidden="true" style={{ animationDelay: '0.9s' }} />
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={t.readyBagSvg}>
        <path d="M14 22h36l-3 32H17z" />
        <path d="M24 22v-4a8 8 0 0 1 16 0v4" />
        <path d="M25 36l5 5 9-10" />
      </svg>
    </span>
  )
}
