'use client'
// The sticker tin: a little plum can with a butter lid, fixed bottom-left.
// Tapping it opens the sticker book. It wobbles when a sticker lands, shows a
// streak flame from day two, and turns gold at 12/12.
//
// Presentational: PlayLayer owns the state and passes it in.

import { useEffect, useId, useRef, type Ref } from 'react'
import { StickerArt } from './StickerArt'
import type { StickerId } from '../../lib/play/stickers'
import s from './play.module.css'

const JELLY = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

export interface TinToast {
  key: number
  id: StickerId
  text: string
}

export interface StickerTinProps {
  count: number
  total: number
  streak: number
  gold: boolean
  /** Increment to play the landing wobble. */
  wobbleKey: number
  reduced: boolean
  toast: TinToast | null
  intro: boolean
  onDismissIntro: () => void
  onOpen: () => void
  buttonRef: Ref<HTMLButtonElement>
}

export function StickerTin(p: StickerTinProps) {
  const bodyRef = useRef<SVGGElement | null>(null)
  const lidRef = useRef<SVGGElement | null>(null)
  const clipId = `tin-clip-${useId().replace(/:/g, '')}`

  useEffect(() => {
    if (p.wobbleKey === 0 || p.reduced) return
    const body = bodyRef.current
    const lid = lidRef.current
    try {
      lid?.animate(
        [
          { transform: 'translateY(0) rotate(0deg)' },
          { transform: 'translateY(-6px) rotate(-8deg)', offset: 0.25 },
          { transform: 'translateY(0) rotate(0deg)' },
        ],
        { duration: 420, easing: JELLY },
      )
      body?.animate(
        [
          { transform: 'rotate(0deg)' },
          { transform: 'rotate(-12deg)', offset: 0.2 },
          { transform: 'rotate(10deg)', offset: 0.45 },
          { transform: 'rotate(-6deg)', offset: 0.7 },
          { transform: 'rotate(0deg)' },
        ],
        { duration: 520, easing: JELLY },
      )
    } catch {
      /* WAAPI missing: the count still updates */
    }
  }, [p.wobbleKey, p.reduced])

  const bodyFill = p.gold ? '#F4C22E' : '#4E2A4F'
  const bandFill = p.gold ? '#FFE68A' : '#FFF4D6'
  const label = `sticker tin, ${p.count} of ${p.total} found`

  return (
    <div className={s.tinWrap}>
      {p.intro && (
        <button type="button" className={s.bubble} onClick={p.onDismissIntro}>
          psst. {p.total} stickers are hidden around here.
        </button>
      )}

      <button
        ref={p.buttonRef}
        type="button"
        className={s.tin}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={p.onOpen}
      >
        <svg className={s.tinSvg} viewBox="0 0 56 56" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id={clipId}>
              <rect x="10" y="18" width="36" height="32" rx="6" />
            </clipPath>
          </defs>
          <ellipse cx="28" cy="52.5" rx="17" ry="2.6" fill="#2A1A2B" opacity="0.18" />
          <g ref={bodyRef} className={s.tinBody}>
            <rect x="10" y="18" width="36" height="32" rx="6" fill={bodyFill} stroke="#2A1A2B" strokeWidth="2" />
            <rect x="10" y="27" width="36" height="13" fill={bandFill} stroke="#2A1A2B" strokeWidth="1.5" />
            <path
              d="M28 29.2L29.6 32.3L33 32.8L30.5 35.1L31.1 38.4L28 36.8L24.9 38.4L25.5 35.1L23 32.8L26.4 32.3Z"
              fill={p.gold ? '#FF5A3C' : '#FFD447'}
              stroke="#2A1A2B"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M14 45.5H42" stroke={p.gold ? '#2A1A2B' : '#FFF4D6'} strokeOpacity="0.35" strokeWidth="1.5" strokeLinecap="round" />
            {p.gold && (
              <g clipPath={`url(#${clipId})`}>
                <rect className={s.shine} x="4" y="14" width="9" height="40" fill="#FFFFFF" opacity="0.55" />
              </g>
            )}
          </g>
          <g ref={lidRef} className={s.tinLid}>
            <rect x="24" y="8" width="8" height="5.5" rx="2" fill="#FFD447" stroke="#2A1A2B" strokeWidth="2" />
            <rect x="7" y="12.5" width="42" height="8" rx="4" fill="#FFD447" stroke="#2A1A2B" strokeWidth="2" />
          </g>
        </svg>

        <span key={p.count} className={`${s.badge} ${p.gold ? s.badgeGold : ''}`} aria-hidden="true">
          {p.count}/{p.total}
        </span>

        {p.streak >= 2 && (
          <span className={s.flame} aria-hidden="true" title={`${p.streak} day streak`}>
            <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" focusable="false">
              <path
                d="M5 0.8C6.4 3 8.8 4.4 8.8 7.4C8.8 9.6 7.1 11.2 5 11.2C2.9 11.2 1.2 9.6 1.2 7.5C1.2 5.9 2.1 4.9 3 4.2C3.1 5.4 3.6 6.1 4.2 6.3C4 4.3 4.4 2.4 5 0.8Z"
                fill="#FF5A3C"
                stroke="#2A1A2B"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
            {p.streak}
          </span>
        )}
      </button>

      {p.toast && (
        <div key={p.toast.key} className={s.toast} aria-hidden="true">
          <StickerArt id={p.toast.id} size={26} />
          <span>{p.toast.text}</span>
        </div>
      )}
    </div>
  )
}

export default StickerTin
