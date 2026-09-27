// BrandLoader — route loading for the brand surfaces (/brand/<slug>, and the
// /<slug> ordering pages). It renders the same title card the cut holds on
// for that brand, so a cut that reveals onto a loader is one continuous shot:
//   simmer — a bone candle on solid tiber; its 6px flame is the one orange
//            signal. No gradients, no white, no characters, lowercase, the
//            tagline below the name.
//   stackd — the layers of a café sandwich drop and stack on the red plum
//            field, above the cream die-cut title sticker.
//   flipd  — a line-art patty flips over the griddle, Flipd blue on mustard,
//            checker bands top and bottom.
// Unknown slugs fall back to the neutral servd ripple.
//
// Pure SVG + CSS, server-renderable, paints before any JS.

import type { ReactNode } from 'react'
import { Loader } from '../../ui/Loader'
import { TitleCard } from '../../film/Slate'
import type { CutTheme } from '../../../lib/film/cut'
import film from '../../film/film.module.css'
import s from './brand.module.css'

function SimmerArt() {
  return (
    <svg className={`${s.art} ${s.simmerArt}`} viewBox="0 0 60 120" aria-hidden="true" focusable="false">
      <path className={s.smoke} d="M30 36C26 30 34 24 30 18S26 10 30 4" fill="none" stroke="#EDE6D3" strokeWidth="1.2" strokeLinecap="round" />
      {/* The flame: a single 6px orange dot — simmer's one signal. */}
      <circle className={s.flame} cx="30" cy="45" r="3" fill="#E94E1B" />
      <line x1="30" y1="49" x2="30" y2="58" stroke="#EDE6D3" strokeOpacity=".7" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M21 58H39V110H21Z" fill="#EDE6D3" />
      <path d="M21 58H39V63Q35 66 34 72Q33 64 29 63Q25 62 21 66Z" fill="#DCD3BC" />
      <line x1="4" y1="110.5" x2="56" y2="110.5" stroke="#EDE6D3" strokeOpacity=".35" />
    </svg>
  )
}

function StackdArt() {
  return (
    <svg className={`${s.art} ${s.stackdArt}`} viewBox="0 0 120 100" aria-hidden="true" focusable="false">
      <g className={s.stack}>
        <rect className={s.l0} x="14" y="80" width="92" height="12" rx="4" fill="#FCE8CE" />
        <path className={s.l1} d="M12 74q5 6 10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0V80H12Z" fill="#9BD3DD" />
        <rect className={s.l2} x="16" y="64" width="88" height="10" rx="5" fill="#E4A3B4" />
        {/* the top slice: a flat, scored sourdough, not a bun */}
        <path className={s.l3} d="M14 64V54Q14 46 22 46H98Q106 46 106 54V64Z" fill="#FCE8CE" />
        <path className={s.l3} d="M34 52l8 6M56 52l8 6M78 52l8 6" stroke="#7C2946" strokeOpacity=".35" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  )
}

function FlipdArt() {
  return (
    <svg className={`${s.art} ${s.flipdArt}`} viewBox="0 0 120 110" aria-hidden="true" focusable="false">
      {[34, 60, 86].map((x, i) => (
        <path key={x} className={s.sizzle} style={{ animationDelay: `${i * 0.35}s` }} d={`M${x} 88c-4-5 4-8 0-13s4-8 0-13`} fill="none" stroke="#294375" strokeWidth="2.4" strokeLinecap="round" />
      ))}
      <g className={s.patty}>
        <rect x="30" y="80" width="60" height="14" rx="7" fill="#F9F0E1" stroke="#294375" strokeWidth="3" />
        <path d="M42 84l6 6M56 84l6 6M70 84l6 6" stroke="#294375" strokeWidth="2" strokeLinecap="round" />
      </g>
      <rect x="10" y="96" width="100" height="6" rx="3" fill="#294375" />
    </svg>
  )
}

/** The brand's own art for its title card (cut + loader). null for servd. */
export function BrandArt({ theme }: { theme: CutTheme }): JSX.Element | null {
  if (theme === 'simmer') return <SimmerArt />
  if (theme === 'stackd') return <StackdArt />
  if (theme === 'flipd') return <FlipdArt />
  return null
}

const VARIANTS: Record<string, { theme: Exclude<CutTheme, 'servd'>; name: string; line: string }> = {
  simmer: { theme: 'simmer', name: 'simmer', line: 'simmer down.' },
  stackd: { theme: 'stackd', name: 'stackd', line: 'baked here. wrapping it up…' },
  flipd: { theme: 'flipd', name: 'Flipd', line: 'same burger, every time.' },
}

export function BrandLoader({
  slug,
  chapter,
  status,
}: {
  slug?: string | null
  /** The title card to hold on; defaults to the brand's name. */
  chapter?: { kicker: string; title: string }
  /** Status line under the card; defaults to the brand's own line. */
  status?: ReactNode
}) {
  const v = slug ? VARIANTS[slug] : undefined
  if (!v) {
    return (
      <div className={s.wrap}>
        <Loader size={30} />
      </div>
    )
  }
  const kicker = chapter?.kicker ?? 'now showing'
  const title = chapter?.title || v.name
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading {v.name}…</span>
      <div className={film.screen} aria-hidden="true">
        <TitleCard theme={v.theme} kicker={kicker} title={title} art={<BrandArt theme={v.theme} />} status={status ?? v.line} />
      </div>
      <div className={film.spacer} />
    </div>
  )
}

export default BrandLoader
