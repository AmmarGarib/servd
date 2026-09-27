// Slate — a chapter title card ("act ii · the kitchens"), and TitleCard — the
// full-frame card the cut holds on and every route loader renders.
//
// Both are static and server-renderable: the parent scrubs a Slate with scroll,
// and the cut animates around a TitleCard. Keeping one TitleCard for both the
// cut and the loaders is what makes a reveal onto a loader seamless: the same
// field, the same type, the same composition.

import type { ReactNode } from 'react'
import type { CutTheme } from '../../lib/film/cut'
import s from './film.module.css'

export function Slate({
  act,
  title,
  tone = 'light',
  align = 'left',
}: {
  act: string
  title: string
  tone?: 'light' | 'dark' | 'simmer'
  align?: 'left' | 'center'
}) {
  const simmer = tone === 'simmer'
  return (
    <div className={`${s.slate} ${s[tone] ?? ''} ${align === 'center' ? s.alignCenter : s.alignLeft}`}>
      <div className={s.slateHead}>
        {/* simmer carries no gradients: a bone hairline stands in for the clapper stripes. */}
        <span className={simmer ? s.hairline : s.clapper} aria-hidden="true" />
        <p className={s.act}>act {act}</p>
      </div>
      <h2 className={s.slateTitle}>{simmer ? title.toLowerCase() : title}</h2>
    </div>
  )
}

const STAR = 'M0 -12L3 -3L12 0L3 3L0 12L-3 3L-12 0L-3 -3Z'

function ServdDecor() {
  return (
    <>
      <div className={s.burst} aria-hidden="true" />
      <svg className={`${s.doodle} ${s.dStar}`} aria-hidden="true" viewBox="-13 -13 26 26"><path d={STAR} /></svg>
      <svg className={`${s.doodle} ${s.dDot}`} aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" /></svg>
      <svg className={`${s.doodle} ${s.dSquig}`} aria-hidden="true" viewBox="0 0 80 24"><path d="M2 12C12 2 22 22 32 12S52 2 62 12S76 20 78 12" /></svg>
    </>
  )
}

export interface TitleCardProps {
  theme: CutTheme
  kicker: string
  title: string
  /** Brand art above the kicker (candle, sandwich layers, patty). */
  art?: ReactNode
  /** servd only: the crowd standing on the floor of the frame. */
  floor?: ReactNode
  /** A rendered stamp (the cut animates it with a spring). */
  stamp?: ReactNode
  /** Loader status line, placed below the block without moving it. */
  status?: ReactNode
  /** Apply the cover's settle-up on the title block. */
  rise?: boolean
  className?: string
}

export function TitleCard({ theme, kicker, title, art, floor, stamp, status, rise, className }: TitleCardProps) {
  const hasFloor = theme === 'servd' && !!floor
  const text = (
    <>
      {theme === 'simmer' && !art && <span className={s.simmerDot} aria-hidden="true" />}
      {kicker && <p className={s.kicker}>{kicker}</p>}
      {title && <p className={s.title}>{title}</p>}
      {stamp}
    </>
  )
  return (
    <div
      className={[s.card, s[theme], hasFloor ? s.hasFloor : '', rise ? s.rise : '', className ?? ''].filter(Boolean).join(' ')}
      data-film-theme={theme}
    >
      {theme === 'servd' && <ServdDecor />}
      {theme === 'flipd' && (
        <>
          <span className={`${s.band} ${s.bandTop}`} aria-hidden="true" />
          <span className={`${s.band} ${s.bandBottom}`} aria-hidden="true" />
        </>
      )}
      <div className={s.center}>
        {art && <div className={s.art} aria-hidden="true">{art}</div>}
        {theme === 'stackd' ? (
          <div className={`${s.block} ${s.sticker}`}>{text}</div>
        ) : (
          <div className={s.block}>{text}</div>
        )}
        {status && <p className={s.status}>{status}</p>}
      </div>
      {hasFloor && <div className={s.floor} aria-hidden="true">{floor}</div>}
    </div>
  )
}

export default Slate
