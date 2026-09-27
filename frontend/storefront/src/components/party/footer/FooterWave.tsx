// Decorative scalloped/wavy top edge for the footer — a cream band that dips
// into the plum ground so the page above doesn't end on a hard straight line.
// The path covers two footer widths and drifts sideways by one, so the curtain
// ripples; it only moves while the footer is in view (see footer.module.css,
// data-live). Purely cosmetic (aria-hidden).
import s from './footer.module.css'

const HALF = 'C120,60 240,0 360,30 C480,60 600,0 720,30 C840,60 960,0 1080,30 C1200,60 1320,0 1440,30'
const SHIFTED = HALF.replace(/(\d+),/g, (_m: string, x: string) => `${Number(x) + 1440},`)

export function FooterWave() {
  return (
    <div className={s.waveWrap} aria-hidden>
      <svg className={s.wave} viewBox="0 0 2880 60" preserveAspectRatio="none">
        <path d={`M0,30 ${HALF} ${SHIFTED} L2880,60 L0,60 Z`} />
      </svg>
    </div>
  )
}
