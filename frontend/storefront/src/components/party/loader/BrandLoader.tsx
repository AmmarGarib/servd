// BrandLoader — route loading for the brand microsites (/brand/<slug>).
// The servd butter party stays off brand pages; each brand loads in its own
// language, pure SVG + CSS so it paints before any JS:
//   simmer — a single candle on forest green: the flame is the one orange
//            signal, a bone wisp of smoke rises. No gradients, no white,
//            no characters, lowercase, tagline below the wordmark.
//   stackd — the layers of a sandwich drop in and stack on the red plum field.
//   flipd  — a line-art patty flips over the griddle in Flipd Blue on mustard.
// Unknown slugs fall back to the neutral servd ripple.

import { Loader } from '../../ui/Loader'
import s from './brand.module.css'

function Simmer() {
  return (
    <>
      <svg className={s.art} viewBox="0 0 60 120" aria-hidden="true" focusable="false">
        <path className={s.smoke} d="M30 26C26 20 34 14 30 8S26 0 30 -6" fill="none" stroke="#EDE6D3" strokeWidth="1.2" strokeLinecap="round" />
        <path className={s.flame} d="M30 28C36 38 38 45 30 53C22 45 24 38 30 28Z" fill="#E94E1B" />
        <line x1="30" y1="51" x2="30" y2="58" stroke="#3D2817" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M21 58H39V110H21Z" fill="#EDE6D3" />
        <path d="M21 58H39V63Q35 66 34 72Q33 64 29 63Q25 62 21 66Z" fill="#DCD3BC" />
        <line x1="4" y1="110.5" x2="56" y2="110.5" stroke="#EDE6D3" strokeOpacity=".35" />
      </svg>
      <p className={s.simmerMark}>simmer</p>
      <p className={s.simmerTag}>simmer down.</p>
    </>
  )
}

function Stackd() {
  return (
    <>
      <svg className={s.art} viewBox="0 0 120 100" aria-hidden="true" focusable="false">
        <g className={s.stack}>
          <rect className={s.l0} x="14" y="78" width="92" height="14" rx="7" fill="#FCE8CE" />
          <path className={s.l1} d="M12 72q5 6 10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0V78H12Z" fill="#9BD3DD" />
          <rect className={s.l2} x="16" y="62" width="88" height="10" rx="5" fill="#E4A3B4" />
          <path className={s.l3} d="M14 62C14 44 34 36 60 36S106 44 106 62Z" fill="#FCE8CE" />
        </g>
      </svg>
      <p className={s.stackdMark}>stackd</p>
      <p className={s.stackdLine}>cooked here. wrapping it up…</p>
    </>
  )
}

function Flipd() {
  return (
    <>
      <svg className={s.art} viewBox="0 0 120 110" aria-hidden="true" focusable="false">
        {[34, 60, 86].map((x, i) => (
          <path key={x} className={s.sizzle} style={{ animationDelay: `${i * 0.35}s` }} d={`M${x} 88c-4-5 4-8 0-13s4-8 0-13`} fill="none" stroke="#294375" strokeWidth="2.4" strokeLinecap="round" />
        ))}
        <g className={s.patty}>
          <rect x="30" y="80" width="60" height="14" rx="7" fill="#F9F0E1" stroke="#294375" strokeWidth="3" />
          <path d="M42 84l6 6M56 84l6 6M70 84l6 6" stroke="#294375" strokeWidth="2" strokeLinecap="round" />
        </g>
        <rect x="10" y="96" width="100" height="6" rx="3" fill="#294375" />
      </svg>
      <p className={s.flipdMark}>Flipd</p>
      <p className={s.flipdLine}>same burger, every time.</p>
    </>
  )
}

const VARIANTS: Record<string, { cls: string; art: () => JSX.Element; name: string }> = {
  simmer: { cls: s.simmer!, art: Simmer, name: 'simmer' },
  stackd: { cls: s.stackd!, art: Stackd, name: 'stackd' },
  flipd: { cls: s.flipd!, art: Flipd, name: 'Flipd' },
}

export function BrandLoader({ slug }: { slug?: string | null }) {
  const v = slug ? VARIANTS[slug] : undefined
  if (!v) {
    return (
      <div className={s.wrap}>
        <Loader size={30} />
      </div>
    )
  }
  const Art = v.art
  return (
    <div className={`${s.wrap} ${v.cls}`} role="status" aria-live="polite">
      <span className="sr-only">Loading {v.name}…</span>
      <div className={s.col} aria-hidden="true"><Art /></div>
    </div>
  )
}

export default BrandLoader
