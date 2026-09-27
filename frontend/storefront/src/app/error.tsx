'use client'

// Global error boundary for the storefront — "the reel snapped." Renders when
// any client-side rendering throws below the layout. Never a blank page: the
// servd butter field, a snapped film strip, a retry, and a way back.

import { useEffect } from 'react'
import Link from 'next/link'
import s from '../components/film/film.module.css'

function SnappedReel() {
  const holes = [0, 1, 2, 3]
  return (
    <svg className={s.reel} viewBox="0 0 220 90" aria-hidden="true" focusable="false">
      <g className={s.reelL}>
        <path d="M4 22H96L90 34L100 44L88 56L96 68H4Z" fill="#4E2A4F" />
        {holes.map((i) => (
          <g key={i}>
            <rect x={12 + i * 20} y="26" width="9" height="6" rx="1.5" fill="#FFD447" />
            <rect x={12 + i * 20} y="58" width="9" height="6" rx="1.5" fill="#FFD447" />
          </g>
        ))}
        <rect x="14" y="36" width="30" height="18" rx="2" fill="#FFF4D6" opacity=".9" />
        <rect x="52" y="36" width="28" height="18" rx="2" fill="#FFF4D6" opacity=".9" />
      </g>
      <g className={s.reelR} transform="rotate(9 170 45)">
        <path d="M124 22H216V68H124L132 56L120 44L130 34Z" fill="#4E2A4F" />
        {holes.map((i) => (
          <g key={i}>
            <rect x={140 + i * 19} y="26" width="9" height="6" rx="1.5" fill="#FFD447" />
            <rect x={140 + i * 19} y="58" width="9" height="6" rx="1.5" fill="#FFD447" />
          </g>
        ))}
        <rect x="140" y="36" width="30" height="18" rx="2" fill="#FFF4D6" opacity=".9" />
        <rect x="178" y="36" width="30" height="18" rx="2" fill="#FFF4D6" opacity=".9" />
      </g>
      <path d="M106 30l4 -8M112 50l6 -2M104 62l3 7" stroke="#FF5A3C" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // In production this is where we'd ship the error to Sentry / Datadog.
    console.error('[storefront] uncaught error:', error)
  }, [error])

  return (
    <section className={s.scene} role="alert" aria-live="assertive" style={{ paddingBottom: 'clamp(3rem, 8vh, 5rem)' }}>
      <SnappedReel />
      <p className={s.sceneKicker}>
        <span className={s.clapper} aria-hidden="true" />
        take two
      </p>
      <h1 className={s.sceneTitle}>the reel snapped.</h1>
      <p className={s.sceneBody}>
        something broke on our side, not yours. give it another take, or head back to the opening.
        {error.digest && <span className={s.sceneRef}>reference: {error.digest}</span>}
      </p>
      <div className={s.ctaRow}>
        <button type="button" onClick={reset} className={s.cta}>try again</button>
        <Link href="/" className={s.ctaGhost}>back to the opening</Link>
      </div>
    </section>
  )
}
