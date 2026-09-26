'use client'
// The café door sign. Two sizes:
//  - `pill`: a small status line for the hero (cream on plum, 7.77:1)
//  - `sign`: a board hanging from a nail on two strings, swinging gently —
//    plum-dark lettering on cream (13.5:1).
// Status is announced politely so a flip at closing time is read out.

import type { OpenStatus } from './hours'
import { statusText } from './hours'
import s from './sign.module.css'

export function OpenSign({ status, variant = 'sign', fallback }: { status: OpenStatus | null; variant?: 'pill' | 'sign'; fallback?: string }) {
  if (variant === 'pill') {
    if (!status) return null
    const t = statusText(status)
    return (
      <p className={s.pill} data-open={status.open ? 'true' : 'false'}>
        <span className={s.dot} aria-hidden />
        <span className={s.pillHead}>{t.head}</span>
        {t.sub && <span className={s.pillSub}>· {t.sub}</span>}
      </p>
    )
  }

  const t = status ? statusText(status) : null
  return (
    <div className={s.hang} data-open={status?.open ? 'true' : 'false'}>
      <svg className={s.strings} viewBox="0 0 200 60" aria-hidden focusable="false">
        <circle cx="100" cy="6" r="5" />
        <path d="M100 8 L28 58 M100 8 L172 58" />
      </svg>
      <div className={s.board} role="status">
        {t ? (
          <>
            <span className={s.kicker}>{status?.open ? 'come in, we’re' : 'sorry, we’re'}</span>
            <span className={s.word}>{status?.open ? 'open.' : 'closed.'}</span>
            {t.sub && <span className={s.sub}>{t.sub}</span>}
            {status?.inactive && <span className={s.sub}>for now</span>}
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
