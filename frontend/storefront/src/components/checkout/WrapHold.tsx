'use client'
import type { CSSProperties } from 'react'
import { voice } from '../../lib/voice'
import { Companion, companionKindFor } from '../characters/Companion'
import { finaleTheme } from './brandTheme'
import s from './wrap.module.css'

// "that's a wrap" — the frame checkout holds on between placing the order
// and the tracker loading. The cart is already cleared at this point, so
// without it the page would flash the empty bag under the cut. When the
// SceneCut is mounted it covers this frame; when it is not (reduced motion,
// cut busy), this frame IS the beat: a clapper, the brand's wrap line, and
// the order total stamped on it.

export function WrapHold({ slug, stamp }: { slug?: string | null; stamp: string }) {
  const t = finaleTheme(slug)
  const v = voice(slug)
  const kind = t.brand === 'simmer' ? null : companionKindFor(t.brand)
  const vars = {
    '--wr-bg': t.bg,
    '--wr-ink': t.ink,
    '--wr-mute': t.mute,
    '--wr-accent': t.accent,
    '--wr-display': t.display,
    '--wr-body': t.body,
  } as CSSProperties

  return (
    <main className={s.hold} data-brand={t.brand} style={vars} aria-live="polite">
      <div className={s.card}>
        {t.brand === 'simmer' ? (
          <span className={s.rule} aria-hidden="true" />
        ) : (
          <span className={s.clapper} aria-hidden="true" />
        )}
        <p className={s.kicker}>{v.wrapKicker}</p>
        <h1 className={s.title}>{v.wrapTitle}</h1>
        <p className={s.stamp}>
          <span className={s.srOnly}>order total </span>
          {stamp}
        </p>
        {kind && (
          <div className={s.companion} aria-hidden="true">
            <Companion kind={kind} placement="inline" mood="cheer" size={96} />
          </div>
        )}
      </div>
    </main>
  )
}

export default WrapHold
