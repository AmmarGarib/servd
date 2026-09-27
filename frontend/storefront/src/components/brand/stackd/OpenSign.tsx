'use client'
// The café door sign. Two sizes:
//  - `pill`: a small status line for the hero (cream on plum, 7.77:1)
//  - `sign`: a board hanging from a nail on two strings, swinging gently —
//    plum-dark lettering on cream (13.5:1).
// When the kitchen opens or closes while you're on the page, the board flips
// over on its strings (a 400 ms swing) — the way someone turns the real one.
// Status is announced politely so a flip at closing time is read out.

import type { OpenStatus } from './hours'
import { statusText } from './hours'
import { useChangePulse } from './hooks'
import s from './sign.module.css'

function kickerFor(status: OpenStatus): string {
  if (status.inactive) return 'sorry, we’re'
  if (status.open) return status.phase === 'closing' ? 'last orders, we’re' : 'come in, we’re'
  return status.phase === 'opening' ? 'ovens are on, we’re' : 'sorry, we’re'
}

function wordFor(status: OpenStatus): string {
  if (status.open) return 'open.'
  return status.phase === 'opening' ? 'nearly open.' : 'closed.'
}

export function OpenSign({ status, variant = 'sign', fallback }: { status: OpenStatus | null; variant?: 'pill' | 'sign'; fallback?: string }) {
  const flipKey = status ? `${status.open}-${status.inactive}` : 'none'
  const flipping = useChangePulse(flipKey, 400)

  if (variant === 'pill') {
    if (!status) return null
    const t = statusText(status)
    return (
      <p className={s.pill} data-open={status.open ? 'true' : 'false'} data-phase={status.phase} data-flip={flipping ? 'true' : undefined} role="status">
        <span className={s.dot} aria-hidden />
        <span className={s.pillHead}>{t.head}</span>
        {t.sub && <span className={s.pillSub}>· {t.sub}</span>}
      </p>
    )
  }

  const t = status ? statusText(status) : null
  return (
    <div className={s.hang} data-open={status?.open ? 'true' : 'false'} data-phase={status?.phase} data-flip={flipping ? 'true' : undefined}>
      <svg className={s.strings} viewBox="0 0 200 60" aria-hidden focusable="false">
        <circle cx="100" cy="6" r="5" />
        <path d="M100 8 L28 58 M100 8 L172 58" />
      </svg>
      <div className={s.board} role="status">
        {status && t ? (
          <>
            <span className={s.kicker}>{kickerFor(status)}</span>
            <span className={s.word}>{wordFor(status)}</span>
            {t.sub && <span className={s.sub}>{t.sub}</span>}
            {status.inactive && <span className={s.sub}>for now</span>}
          </>
        ) : (
          <>
            <span className={s.kicker}>you know where we are.</span>
            <span className={s.word}>come by.</span>
            {fallback && <span className={s.sub}>{fallback}</span>}
          </>
        )}
      </div>
    </div>
  )
}
