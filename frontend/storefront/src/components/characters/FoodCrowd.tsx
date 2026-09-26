'use client'

/**
 * FoodCrowd — a row of procedural 3D food characters (three.js) whose eyes
 * follow the cursor anywhere on the page. Decorative only (aria-hidden).
 *
 * The component fills its parent box; the parent sets the size. The canvas
 * is transparent, so the stage colour behind it shows through.
 *
 * three.js is imported lazily inside an effect: nothing touches window or
 * WebGL during SSR, and without WebGL the component quietly renders nothing.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type * as React from 'react'
import { onCrowd } from './crowdBus'
import { isCharacterKind, type CharacterKind } from './types'
import type { CrowdEngine } from './engine'

export type { CharacterKind } from './types'

export interface FoodCrowdHandle {
  /** One character (or all when omitted) does a happy jump + squash. */
  cheer(kind?: CharacterKind): void
}

export interface FoodCrowdProps {
  /** Left→right order. Default ['fries','burger','coffee','sandwich','shake','croissant']. */
  cast?: CharacterKind[]
  /** 0..1 — lean toward the cursor harder, bounce faster, eyes widen. */
  excitement?: number
  className?: string
  /** The component fills its parent box (width/height 100%); the parent sizes it. */
  style?: React.CSSProperties
  /** Fired after the first frame renders. */
  onReady?: () => void
}

const DEFAULT_CAST: CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

export const FoodCrowd = forwardRef<FoodCrowdHandle, FoodCrowdProps>(function FoodCrowd(
  { cast, excitement = 0, className, style, onReady },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<CrowdEngine | null>(null)
  const castKey = (cast && cast.length ? cast : DEFAULT_CAST).filter(isCharacterKind).join(',')
  const latest = useRef({ castKey, excitement, onReady })
  latest.current = { castKey, excitement, onReady }

  // Mount the engine once; three.js is code-split and loaded client-side only.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    import('./engine')
      .then(({ createCrowdEngine }) => {
        if (cancelled) return
        try {
          engineRef.current = createCrowdEngine(host, {
            cast: latest.current.castKey.split(',').filter(isCharacterKind),
            excitement: latest.current.excitement,
            onFirstFrame: () => latest.current.onReady?.(),
          })
        } catch {
          engineRef.current = null
        }
      })
      .catch(() => {
        /* chunk failed to load — stay decorative-empty */
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
  }, [])

  useEffect(() => {
    engineRef.current?.setCast(castKey.split(',').filter(isCharacterKind))
  }, [castKey])

  useEffect(() => {
    engineRef.current?.setExcitement(excitement)
  }, [excitement])

  // Page-wide bus: add-to-cart etc. can make the crowd react.
  useEffect(
    () =>
      onCrowd((e) => {
        const engine = engineRef.current
        if (!engine) return
        if (e.type === 'cheer') engine.cheer(e.kind)
        else if (e.type === 'look' && Number.isFinite(e.x) && Number.isFinite(e.y)) engine.look(e.x, e.y)
      }),
    [],
  )

  useImperativeHandle(
    ref,
    () => ({
      cheer: (kind?: CharacterKind) => engineRef.current?.cheer(kind),
    }),
    [],
  )

  return <div ref={hostRef} aria-hidden="true" className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }} />
})

FoodCrowd.displayName = 'FoodCrowd'

export default FoodCrowd
