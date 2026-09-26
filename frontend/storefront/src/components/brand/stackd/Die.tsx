// The stackd die-cut seal, as a drawable. Every sticker, stamp and coaster
// on the page is stamped from this one die (lib/stackdDie.ts): a pale-blue
// outer band, a plum keyline, and a cream or white face. Keylines use
// non-scaling strokes so they stay even when the die is stretched.

import { STACKD_DIE } from '../../../lib/stackdDie'

interface DieProps {
  className?: string
  face?: string
  band?: string
  keyline?: string
  bandWidth?: number
  keylineWidth?: number
}

export function Die({
  className,
  face = '#FCE8CE',
  band = '#9BD3DD',
  keyline = '#7C2946',
  bandWidth = 14,
  keylineWidth = 6,
}: DieProps) {
  return (
    <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      {bandWidth > 0 && (
        <path d={STACKD_DIE} fill="none" stroke={band} strokeWidth={bandWidth} vectorEffect="non-scaling-stroke" />
      )}
      <path d={STACKD_DIE} fill={face} stroke={keyline} strokeWidth={keylineWidth} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export { STACKD_DIE }
