// Decorative scalloped/wavy top edge for the footer — a cream band that dips
// into the plum ground so the page above doesn't end on a hard straight line.
// Purely cosmetic (aria-hidden).
import s from './footer.module.css'

export function FooterWave() {
  return (
    <div className={s.waveWrap} aria-hidden>
      <svg className={s.wave} viewBox="0 0 1440 60" preserveAspectRatio="none">
        <path d="M0,30 C120,60 240,0 360,30 C480,60 600,0 720,30 C840,60 960,0 1080,30 C1200,60 1320,0 1440,30 L1440,60 L0,60 Z" />
      </svg>
    </div>
  )
}
