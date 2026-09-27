'use client'
import { useEffect, useState } from 'react'
import { usePrefersReducedMotion } from '../../lib/film/motion'
import t from './tracker.module.css'

// Curbside "I'm here" payoff: a 1.6s beat. A car sweeps in from the left
// with its headlight beam on and stops at the kerb, then the copy lands.
// Only plays when the customer tapped "I'm here" in this session; a reload
// (or reduced motion) goes straight to the copy.

const BEAT_MS = 1600

export function CurbsideBeat({ vehicle, play }: { vehicle: string | null | undefined; play: boolean }) {
  const reduced = usePrefersReducedMotion()
  const animate = play && !reduced
  const [landed, setLanded] = useState(!animate)

  useEffect(() => {
    if (!animate) { setLanded(true); return }
    setLanded(false)
    const id = window.setTimeout(() => setLanded(true), BEAT_MS)
    return () => window.clearTimeout(id)
  }, [animate])

  return (
    <div className={t.curb} data-play={animate ? 'true' : 'false'} role="status" aria-live="polite">
      <div className={t.curbStage} aria-hidden="true">
        <span className={t.curbKerb} />
        <span className={t.curbCar}>
          <svg className={t.curbBeam} viewBox="0 0 80 40" fill="currentColor">
            <polygon points="0,16 80,0 80,40 0,24" />
          </svg>
          <svg width="72" height="40" viewBox="0 0 72 40" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 26l6-12h36l12 12h10v8H4z" fill="var(--curb-car-fill)" />
            <path d="M16 14l-4 10h20V14M36 14v10h18" />
            <circle cx="18" cy="34" r="5" fill="var(--curb-car-fill)" />
            <circle cx="54" cy="34" r="5" fill="var(--curb-car-fill)" />
            <path d="M66 28h3" strokeWidth="3.5" />
          </svg>
        </span>
      </div>
      {landed ? (
        <div className={t.curbCopy}>
          <p className="font-black text-sm">we see you. bringing your food now.</p>
          {vehicle && <p className="text-xs mt-0.5 opacity-70">{vehicle}</p>}
        </div>
      ) : (
        <p className={t.curbWaiting}>pulling in&hellip;</p>
      )}
    </div>
  )
}

export default CurbsideBeat
