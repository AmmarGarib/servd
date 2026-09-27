'use client'
// The sticker book: a cream sheet of scattered die-cut slots. Found stickers
// show in full with the day they were found; locked ones are dashed outlines
// with their hint. Also the streak, poke count, best scores, sound and haptics
// toggles, and "start over" behind a confirm.
//
// Accessible dialog: role=dialog + aria-modal, focus trapped inside, Esc and a
// backdrop click close it, and focus goes back to the tin.

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { StickerArt } from './StickerArt'
import { STICKERS, STICKER_COUNT } from '../../lib/play/stickers'
import { usePlay } from '../../lib/play/store'
import { sfx, unlockAudio } from '../../lib/play/feedback'
import s from './play.module.css'

const SETTLE = { type: 'spring' as const, stiffness: 260, damping: 22 }
const TILTS = [-2.5, 2, -1, 3, -3, 1.5, -2, 2.5, -1.5, 3, -2.5, 1]

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function foundOn(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toLowerCase()
  } catch {
    return ''
  }
}

export interface StickerBookProps {
  open: boolean
  onClose: () => void
  reduced: boolean
  returnFocusRef: RefObject<HTMLElement>
}

export function StickerBook({ open, onClose, reduced, returnFocusRef }: StickerBookProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const descId = useId()
  const [confirming, setConfirming] = useState(false)
  const keepRef = useRef<HTMLButtonElement | null>(null)
  const startOverRef = useRef<HTMLButtonElement | null>(null)
  const confirmTouched = useRef(false)

  // Keep keyboard focus on the swapped-in control when the confirm toggles.
  useEffect(() => {
    if (!confirmTouched.current) return
    if (confirming) keepRef.current?.focus()
    else startOverRef.current?.focus()
  }, [confirming])

  const stickers = usePlay((st) => st.stickers)
  const streak = usePlay((st) => st.streak.count)
  const pokes = usePlay((st) => st.pokes)
  const best = usePlay((st) => st.best)
  const sound = usePlay((st) => st.sound)
  const haptics = usePlay((st) => st.haptics)
  const setSound = usePlay((st) => st.setSound)
  const setHaptics = usePlay((st) => st.setHaptics)
  const reset = usePlay((st) => st.reset)

  const found = STICKERS.filter((d) => stickers[d.id] != null).length

  // Focus in on open; back to the tin on close.
  useEffect(() => {
    if (!open) return
    confirmTouched.current = false
    setConfirming(false)
    const t = window.setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 30)
    const html = document.documentElement
    const prevOverflow = html.style.overflow
    html.style.overflow = 'hidden'
    const returnTo = returnFocusRef.current
    return () => {
      window.clearTimeout(t)
      html.style.overflow = prevOverflow
      returnTo?.focus({ preventScroll: true })
    }
  }, [open, returnFocusRef])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = sheetRef.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (items.length === 0) {
        e.preventDefault()
        root.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  const bestPatty = best['patty']
  const bestPour = best['pour']

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="sticker-book"
          className={s.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.12 : 0.18, ease: 'easeOut' }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
          onKeyDown={onKeyDown}
        >
          <motion.div
            ref={sheetRef}
            className={s.sheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={-1}
            data-lenis-prevent=""
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
            transition={reduced ? { duration: 0.12 } : SETTLE}
          >
            <div className={s.bookHead}>
              <div>
                <h2 id={titleId} className={s.bookTitle}>
                  sticker book
                </h2>
                <p id={descId} className={s.bookSub}>
                  {found === STICKER_COUNT
                    ? `all ${STICKER_COUNT} found. the tin is gold now.`
                    : `${found} of ${STICKER_COUNT} found. the rest are hiding in things you can poke.`}
                </p>
              </div>
              <button ref={closeRef} type="button" className={s.close} onClick={onClose} aria-label="close sticker book">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <ul className={s.stats} aria-label="your stats">
              <li className={s.stat}>
                <span className={s.statNum}>{streak}</span> day streak
              </li>
              <li className={s.stat}>
                <span className={s.statNum}>{pokes}</span> {pokes === 1 ? 'poke' : 'pokes'}
              </li>
              <li className={s.stat}>
                best flip <span className={s.statNum}>{bestPatty != null ? bestPatty : '–'}</span>
              </li>
              <li className={s.stat}>
                best pour <span className={s.statNum}>{bestPour != null ? bestPour : '–'}</span>
              </li>
            </ul>

            <ul className={s.slots} aria-label="stickers">
              {STICKERS.map((d, i) => {
                const at = stickers[d.id]
                const got = at != null
                const no = String(i + 1).padStart(2, '0')
                return (
                  <li
                    key={d.id}
                    className={`${s.slot} ${got ? s.slotFound : s.slotLocked}`}
                    style={{ ['--tilt' as string]: `${TILTS[i] ?? 0}deg` }}
                  >
                    <span className={s.slotNo} aria-hidden="true">
                      {no}
                    </span>
                    <StickerArt id={d.id} size={64} muted={!got} />
                    {got ? (
                      <>
                        <span className={s.slotName}>{d.name}</span>
                        <span className={s.slotMeta}>found {foundOn(at)}</span>
                      </>
                    ) : (
                      <>
                        <span className="sr-only">sticker {no}, locked. hint:</span>
                        <span className={s.slotHint}>{d.hint}</span>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>

            <div className={s.settings}>
              <button
                type="button"
                role="switch"
                aria-checked={sound}
                className={s.toggle}
                onClick={() => {
                  const next = !sound
                  setSound(next)
                  if (next) {
                    unlockAudio(true)
                    sfx('pop')
                  }
                }}
              >
                <span className={s.knob} aria-hidden="true" />
                sound
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={haptics}
                className={s.toggle}
                onClick={() => setHaptics(!haptics)}
              >
                <span className={s.knob} aria-hidden="true" />
                haptics
              </button>
              <span className={s.spacer} />
              {confirming ? (
                <span className={s.confirm} role="group" aria-label="confirm start over">
                  clear every sticker?
                  <button
                    type="button"
                    className={s.danger}
                    onClick={() => {
                      reset()
                      confirmTouched.current = false
                      setConfirming(false)
                      closeRef.current?.focus()
                    }}
                  >
                    yes, start over
                  </button>
                  <button ref={keepRef} type="button" className={s.ghost} onClick={() => setConfirming(false)}>
                    keep them
                  </button>
                </span>
              ) : (
                <button
                  ref={startOverRef}
                  type="button"
                  className={s.ghost}
                  onClick={() => {
                    confirmTouched.current = true
                    setConfirming(true)
                  }}
                >
                  start over
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default StickerBook
