// PartyLoader — the servd hub route loader, and the servd title card's
// "loading" take.
//
// `screen` renders the exact frame the cut holds on for a servd route —
// butter field, sunburst, doodles, the chapter's kicker + title in plum — so a
// cut that reveals onto it is seamless. The difference is the crowd: on the
// cut it stands and breathes, here it runs a stadium wave (each character
// crouches, springs up with its arms in the air and lands with a squash), and
// a status line sits under the title.
//
// `inline` is the compact crowd + wordmark for in-page loading states.
//
// Pure SVG + CSS, server-renderable: it paints from the first byte of HTML.
// Reduced motion shows the crowd standing still with the first status line.

import type { CSSProperties } from 'react'
import { CrowdPoster } from './CrowdPoster'
import { TitleCard } from '../../film/Slate'
import film from '../../film/film.module.css'
import s from './loader.module.css'

const LINES = ['firing the grill…', 'warming the croissants…', 'salting the fries…', 'whipping the shake…', 'plating up…']

type V = CSSProperties & Record<`--${string}`, string | number>

function Cycle() {
  return (
    <span className={s.cycle}>
      {LINES.map((t, i) => (
        <span key={t} style={{ '--n': i } as V}>{t}</span>
      ))}
    </span>
  )
}

function Wordmark() {
  return (
    <p className={s.wordmark}>
      {'servd'.split('').map((ch, i) => (
        <span key={i} style={{ '--l': i } as V}>{ch}</span>
      ))}
      <span className={s.dot} style={{ '--l': 5 } as V} />
    </p>
  )
}

/** The loader. `screen` = full-viewport butter title card (route loading).
 *  `inline` = compact crowd on whatever surface it sits on. `chapter` sets the
 *  title card (default: the servd wordmark); `status`/`label` replace the
 *  cycling status lines. */
export function PartyLoader({
  variant = 'screen',
  label,
  chapter,
  status,
}: {
  variant?: 'screen' | 'inline'
  label?: string
  chapter?: { kicker: string; title: string }
  status?: string
}) {
  const line = status ?? label

  if (variant === 'inline') {
    return (
      <div className={s.inline} role="status" aria-live="polite">
        <span className="sr-only">{line ?? 'Loading…'}</span>
        <div className={s.stage} aria-hidden="true">
          <CrowdPoster motion="wave" id="pli" className={s.crowd} />
        </div>
        <div className={s.brand} aria-hidden="true">
          <Wordmark />
          <p className={s.status}>{line ? <span className={s.fixed}>{line}</span> : <Cycle />}</p>
        </div>
      </div>
    )
  }

  const sr = chapter ? `${chapter.kicker} ${chapter.title}`.trim() : 'servd'
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading {sr}…</span>
      <div className={film.screen} aria-hidden="true">
        {chapter && (chapter.kicker || chapter.title) ? (
          <TitleCard
            theme="servd"
            kicker={chapter.kicker}
            title={chapter.title}
            status={line ?? <Cycle />}
            floor={<CrowdPoster motion="wave" id="pls" />}
          />
        ) : (
          <TitleCard
            theme="servd"
            kicker="servd presents"
            title=""
            art={<Wordmark />}
            status={line ?? <Cycle />}
            floor={<CrowdPoster motion="wave" id="pls" />}
          />
        )}
      </div>
      <div className={film.spacer} />
    </div>
  )
}

export default PartyLoader
