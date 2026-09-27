'use client'
// WaitGame — the order tracker's "while you wait" toy.
//
// A sticker card with a collapse toggle that picks the kitchen's own game:
//   flipd   → PattyFlip     (flip the patty into the golden zone)
//   stackd  → PourToLine    (pour a mocktail to the line in the mascot cup)
//   simmer  → LightTheCandle (hold to light; no score, no stickers)
//   others  → PourToLine in the servd palette, no mascot
//
// The card is at most 320px tall on phones, every control is ≥44px and works
// from the keyboard (Space / Enter), and the game pauses whenever the tab is
// hidden or the card is collapsed. The collapsed state is remembered for the
// session. The tracker mounts this only while the order is received,
// confirmed or preparing, and unmounts it at "ready".

import { useCallback, useEffect, useId, useState } from 'react'
import s from './wait.module.css'
import { PattyFlip } from './PattyFlip'
import { PourToLine } from './PourToLine'
import { LightTheCandle } from './LightTheCandle'

export type WaitGameKey = 'patty' | 'pour'

export interface WaitRound {
  /** Which scored game finished a round (simmer's candle never reports). */
  game: WaitGameKey
  /** 0–100 for the round just played. */
  score: number
  /** True when that round set a new personal best. */
  newBest: boolean
}

type Skin = 'flipd' | 'stackd' | 'simmer' | 'servd'

const COLLAPSE_KEY = 'servd-wait-collapsed'

function skinFor(slug: string | null | undefined): Skin {
  const k = (slug ?? '').trim().toLowerCase()
  if (k === 'flipd' || k === 'stackd' || k === 'simmer') return k
  return 'servd'
}

const COPY: Record<Skin, { eyebrow: string; title: string }> = {
  flipd:  { eyebrow: 'play while you wait', title: 'Flip the patty.' },
  stackd: { eyebrow: 'play while you wait', title: 'pour to the line' },
  servd:  { eyebrow: 'play while you wait', title: 'pour to the line' },
  simmer: { eyebrow: 'while you wait',      title: 'light the candle' },
}

function readCollapsed(): boolean {
  try { return window.sessionStorage.getItem(COLLAPSE_KEY) === '1' } catch { return false }
}
function writeCollapsed(v: boolean) {
  try { window.sessionStorage.setItem(COLLAPSE_KEY, v ? '1' : '0') } catch { /* private mode */ }
}

export function WaitGame({
  slug, status, onRound,
}: {
  slug: string | null | undefined
  /** The live order status — used only for the small status line. */
  status: string
  onRound?: (r: WaitRound) => void
}) {
  const skin = skinFor(slug)
  const copy = COPY[skin]
  const bodyId = useId()

  // The tracker only mounts this on the client after the order loads, so
  // reading sessionStorage in the initializer cannot cause a hydration
  // mismatch. Still guarded for SSR.
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readCollapsed())
  const [hidden, setHidden] = useState<boolean>(() =>
    typeof document === 'undefined' ? false : document.visibilityState === 'hidden')

  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((c) => { writeCollapsed(!c); return !c })
  }, [])

  const paused = collapsed || hidden

  const reportPatty = useCallback((score: number, newBest: boolean) => {
    onRound?.({ game: 'patty', score, newBest })
  }, [onRound])
  const reportPour = useCallback((score: number, newBest: boolean) => {
    onRound?.({ game: 'pour', score, newBest })
  }, [onRound])

  const statusNote = skin === 'simmer'
    ? null
    : status === 'preparing'
      ? (skin === 'flipd' ? 'On the grill.' : 'it’s cooking')
      : (skin === 'flipd' ? 'Ticket in.' : 'waiting on the kitchen')

  return (
    <section className={s.card} data-skin={skin} aria-label={copy.eyebrow}>
      <div className={s.head}>
        <div className={s.headText}>
          <p className={s.eyebrow}>
            {copy.eyebrow}
            {statusNote && <span aria-hidden="true"> · {statusNote}</span>}
          </p>
          <h2 className={s.title}>{copy.title}</h2>
        </div>
        <button
          type="button"
          className={s.toggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? 'show the game' : 'hide the game'}
          onClick={toggle}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
      </div>

      <div id={bodyId} className={s.body} data-collapsed={collapsed ? 'true' : 'false'} aria-hidden={collapsed || undefined}>
        <div className={s.bodyInner}>
          <div className={s.stage}>
            {skin === 'flipd' && <PattyFlip paused={paused} onRound={reportPatty} />}
            {(skin === 'stackd' || skin === 'servd') && (
              <PourToLine skin={skin} paused={paused} onRound={reportPour} />
            )}
            {skin === 'simmer' && <LightTheCandle paused={paused} />}
          </div>
        </div>
      </div>
    </section>
  )
}
