'use client'

/**
 * FoodCrowd — a row of procedural 3D food characters (three.js) whose eyes
 * follow the cursor anywhere on the page. Decorative only (aria-hidden).
 *
 * The component fills its parent box; the parent sets the size. The canvas
 * is transparent, so the stage colour behind it shows through.
 *
 * The crowd is never an empty box: a flat SVG poster of the same cast
 * (CrowdPoster) paints first and breathes while three.js loads, then
 * cross-fades into the 3D crowd on its first real frame and unmounts.
 * The poster stays — still, and three.js is never booted — when reduced
 * motion is on, WebGL is missing or the chunk fails to load. If reduced
 * motion switches on mid-session the engine is disposed and the still poster
 * returns; switching it off again boots the 3D crowd back.
 *
 * three.js is imported lazily inside an effect: nothing touches window or
 * WebGL during SSR.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type * as React from 'react'
import { onCrowd } from './crowdBus'
import { CrowdPoster, type CrowdPosterMode } from './CrowdPoster'
import { DEFAULT_CAST, isCharacterKind, type CharacterKind } from './types'
import type { CrowdEngine } from './engine'

export type { CharacterKind } from './types'

export interface FoodCrowdHandle {
  /** One character, several, or all when omitted: a happy jump + its own flourish. */
  cheer(kind?: CharacterKind | CharacterKind[]): void
  /** Named characters (or all) lean in and hop; keen for `ms` (default 1200). */
  perk(kinds?: CharacterKind[], ms?: number): void
  /** The leftmost character hops, turns to you and winks. */
  hint(): void
  /** Left-to-right stadium wave. */
  wave(): void
}

export interface FoodCrowdProps {
  /** Left→right order. Default ['fries','burger','coffee','sandwich','shake','croissant']. */
  cast?: CharacterKind[]
  /** 0..1 — lean toward the cursor harder, bounce faster, eyes widen. */
  excitement?: number
  className?: string
  /** The component fills its parent box (width/height 100%); the parent sizes it. */
  style?: React.CSSProperties
  /** Fired once: after the first 3D frame, or once settled on the poster. */
  onReady?: () => void
  /**
   * Paint the flat SVG poster under the canvas until the 3D crowd is live
   * (default true). With false the box is empty until three.js renders, and
   * under reduced motion the engine renders static frames instead.
   */
  poster?: boolean
}

type Phase = 'poster' | 'fading' | 'live'

const FADE_MS = 420
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

const fill: React.CSSProperties = { position: 'absolute', inset: 0 }

export const FoodCrowd = forwardRef<FoodCrowdHandle, FoodCrowdProps>(function FoodCrowd(
  { cast, excitement = 0, className, style, onReady, poster = true },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<CrowdEngine | null>(null)
  const castKey = (cast && cast.length ? cast : DEFAULT_CAST).filter(isCharacterKind).join(',')
  const latest = useRef({ castKey, excitement, onReady })
  latest.current = { castKey, excitement, onReady }

  const [phase, setPhase] = useState<Phase>('poster')
  const [posterMode, setPosterMode] = useState<CrowdPosterMode>('waking')
  // null until read on the client (SSR paints the waking poster; its CSS is
  // already still under reduced motion).
  const [reduced, setReduced] = useState<boolean | null>(null)

  const readyFired = useRef(false)
  const fireReady = () => {
    if (readyFired.current) return
    readyFired.current = true
    try {
      latest.current.onReady?.()
    } catch {
      /* caller's problem */
    }
  }

  // Track reduced motion in both directions.
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined
    setReduced(mq?.matches ?? false)
    if (!mq) return
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // Boot (or re-boot) the engine; three.js is code-split and client-only.
  useEffect(() => {
    if (reduced === null) return
    const host = hostRef.current
    if (!host) return

    const settle = () => {
      setPosterMode('still')
      setPhase('poster')
      fireReady()
    }
    if (reduced && poster) {
      settle()
      return
    }

    let cancelled = false
    setPhase('poster')
    setPosterMode('waking')
    import('./engine')
      .then(({ createCrowdEngine }) => {
        if (cancelled) return
        let engine: CrowdEngine | null = null
        try {
          engine = createCrowdEngine(host, {
            cast: latest.current.castKey.split(',').filter(isCharacterKind),
            excitement: latest.current.excitement,
            entrance: !poster,
            onFirstFrame: () => {
              if (cancelled) return
              fireReady()
              if (poster) setPhase('fading')
            },
            onReducedMotion: poster
              ? () => {
                  if (!cancelled) setReduced(true)
                }
              : undefined,
          })
        } catch {
          engine = null
        }
        engineRef.current = engine
        if (!engine && poster) settle()
        else if (!engine) fireReady()
      })
      .catch(() => {
        // chunk failed to load: the poster is the crowd
        if (!cancelled) settle()
      })
    return () => {
      cancelled = true
      try {
        engineRef.current?.dispose()
      } catch {
        /* ignore */
      }
      engineRef.current = null
    }
  }, [reduced, poster])

  // Cross-fade done: unmount the poster.
  useEffect(() => {
    if (phase !== 'fading') return
    const id = window.setTimeout(() => setPhase('live'), FADE_MS + 40)
    return () => window.clearTimeout(id)
  }, [phase])

  useEffect(() => {
    engineRef.current?.setCast(castKey.split(',').filter(isCharacterKind))
  }, [castKey])

  useEffect(() => {
    engineRef.current?.setExcitement(excitement)
  }, [excitement])

  // Page-wide bus: add-to-cart, brand picks, the tracker… make the crowd react.
  useEffect(
    () =>
      onCrowd((e) => {
        const engine = engineRef.current
        if (!engine) return
        switch (e.type) {
          case 'cheer':
            engine.cheer(e.kinds ? e.kinds.filter(isCharacterKind) : e.kind && isCharacterKind(e.kind) ? e.kind : undefined)
            break
          case 'perk':
            engine.perk(e.kinds?.filter(isCharacterKind), e.ms)
            break
          case 'hint':
            engine.hint()
            break
          case 'wave':
            engine.wave()
            break
          case 'look':
            if (Number.isFinite(e.x) && Number.isFinite(e.y)) engine.look(e.x, e.y)
            break
        }
      }),
    [],
  )

  useImperativeHandle(
    ref,
    () => ({
      cheer: (kind) => engineRef.current?.cheer(kind),
      perk: (kinds, ms) => engineRef.current?.perk(kinds, ms),
      hint: () => engineRef.current?.hint(),
      wave: () => engineRef.current?.wave(),
    }),
    [],
  )

  const showPoster = poster && phase !== 'live'
  const canvasVisible = !poster || phase !== 'poster'
  const castList = castKey.split(',').filter(isCharacterKind)

  return (
    <div aria-hidden="true" className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      {showPoster && (
        <div
          style={{
            ...fill,
            pointerEvents: 'none',
            opacity: phase === 'fading' ? 0 : 1,
            transition: `opacity ${FADE_MS}ms ${EASE_OUT}`,
          }}
        >
          <CrowdPoster cast={castList} mode={posterMode} />
        </div>
      )}
      <div
        ref={hostRef}
        style={{
          ...fill,
          opacity: canvasVisible ? 1 : 0,
          transition: poster ? `opacity ${FADE_MS}ms ${EASE_OUT}` : undefined,
        }}
      />
    </div>
  )
})

FoodCrowd.displayName = 'FoodCrowd'

export default FoodCrowd
