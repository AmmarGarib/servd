// Divider — a wavy or scalloped seam between two colour bands. The shape
// tiles, so the track drifts sideways very slowly (CSS, paused for reduced
// motion). Purely decorative.
import s from './home.module.css'

const WAVE = 'M0 32 C100 8 200 8 300 32 S500 56 600 32 S800 8 900 32 S1100 56 1200 32 V60 H0 Z'

// 24 bumps across the tile, bulging up into the colour above.
const SCALLOP = `M0 60 V34 ${Array.from({ length: 24 }, () => 'a25 25 0 0 1 50 0').join(' ')} V60 Z`

export function Divider({ from, to, variant = 'wave', flip = false }: {
  from: string
  to: string
  variant?: 'wave' | 'scallop'
  flip?: boolean
}) {
  const d = variant === 'wave' ? WAVE : SCALLOP
  return (
    <div aria-hidden className={s.divider} style={{ background: from }}>
      <div
        className={s.dividerTrack}
        style={flip ? { animationDirection: 'reverse' } : undefined}
      >
        {[0, 1].map((k) => (
          <svg key={k} viewBox="0 0 1200 60" preserveAspectRatio="none">
            <path d={d} fill={to} />
          </svg>
        ))}
      </div>
    </div>
  )
}
