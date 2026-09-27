// The footer's top edge: the ground of the page above runs on into the
// footer as a ledge and ends in a wavy lip over the plum. The closing-shift
// crew sits on that lip with their legs over the edge (StorefrontFooter).
//
// The ledge is seamless with the page above at its top edge (--wave-color)
// and picks up the hour's sky toward the lip (--wave-tint, see
// footer.module.css), so the crew sit in butter light at lunch and dusk after
// dark. Purely cosmetic (aria-hidden).
//
// crestY() is the lip's height at any x, shared with the crew so each one
// sits exactly on it (the SVG stretches with preserveAspectRatio="none", so
// the crest is a fixed percentage of the ledge's height at every width).

import s from './footer.module.css'

/** Lip height as a % of the ledge's height at x% across. */
export function crestY(xPct: number): number {
  return 80 + 6 * Math.sin((2 * Math.PI * xPct) / (100 / 3))
}

function lipPath(): string {
  const pts: string[] = []
  for (let x = 0; x <= 100; x += 1) pts.push(`${(x * 14.4).toFixed(1)},${crestY(x).toFixed(2)}`)
  return `M0,0 L1440,0 L${pts.reverse().join(' L')} Z`
}

const D = lipPath()

export function FooterWave() {
  return (
    <div className={s.waveWrap} aria-hidden>
      <svg className={s.wave} viewBox="0 0 1440 100" preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient id="servd-footer-ledge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={s.ledgeTop} />
            <stop offset="0.55" className={s.ledgeTop} />
            <stop offset="1" className={s.ledgeLip} />
          </linearGradient>
        </defs>
        <path d={D} fill="url(#servd-footer-ledge)" />
      </svg>
    </div>
  )
}
