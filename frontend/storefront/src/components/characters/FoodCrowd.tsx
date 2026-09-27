'use client'

/**
 * FoodCrowd — a row of procedural 3D food characters (three.js) whose eyes
 * follow the cursor anywhere on the page. Decorative only (aria-hidden).
 *
 * The cast acts: they hop on from the wings, idle with little solo bits,
 * and answer directions (cheer, focus, wave, gasp, catch) from the page-wide
 * crowd bus or from the handle. The camera can be driven per scroll frame
 * with `setShot` (dolly / orbit / lift), no React state involved.
 *
 * The component fills its parent box; the parent sets the size. The canvas
 * is transparent, so the stage colour behind it shows through.
 *
 * three.js is imported lazily inside an effect: nothing touches window or
 * WebGL during SSR, and without WebGL the component quietly renders nothing.
 *
 * next/dynamic does not forward refs, so dynamic callers get the handle via
 * `onApi`. The ref still works for static imports.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type * as React from 'react'
import { onCrowd } from './crowdBus'
import { isCharacterKind, type CharacterKind } from './types'
import type { CrowdEngine, CrowdEntrance, CrowdShot } from './engine'
import { sfx } from '@/lib/film/sfx'

export type { CharacterKind } from './types'
export type { CrowdEntrance, CrowdShot } from './engine'

export interface FoodCrowdHandle {
  /** One character (or all when omitted) does a happy jump + squash. */
  cheer(kind?: CharacterKind): void
  /** That character steps forward and waves; the others turn to it. null = back in line. */
  focus(kind: CharacterKind | null): void
  /** An arm wave in place. */
  wave(kind?: CharacterKind): void
  /** A small hop back, eyes wide, arms up (empty / closed states). */
  gasp(kind?: CharacterKind): void
  /** Arms up, a happy squash and a small jump (an item landed in the bag). */
  catch(kind?: CharacterKind): void
  /** Camera move, damped. Cheap: call it per scroll frame. */
  setShot(shot: Partial<CrowdShot>): void
  /** This crowd only glances at a viewport point (CSS px); the next pointer move takes over. */
  look(clientX: number, clientY: number): void
}

export interface FoodCrowdProps {
  /** Left→right order. Default ['fries','burger','coffee','sandwich','shake','croissant']. */
  cast?: CharacterKind[]
  /** 0..1 — lean toward the cursor harder, bounce faster, eyes widen. */
  excitement?: number
  className?: string
  /** The component fills its parent box (width/height 100%); the parent sizes it. */
  style?: React.CSSProperties
  /** Fired after the first frame renders (fade any poster out then). */
  onReady?: () => void
  /** Receives the imperative handle once mounted, and null on unmount. */
  onApi?: (api: FoodCrowdHandle | null) => void
  /** How the cast arrives. Default 'walk' (hop on from the wings). */
  entrance?: CrowdEntrance
}

const DEFAULT_CAST: CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

function play(name: 'cheer' | 'catch'): void {
  try {
    sfx(name)
  } catch {
    /* sound is garnish */
  }
}

export const FoodCrowd = forwardRef<FoodCrowdHandle, FoodCrowdProps>(function FoodCrowd(
  { cast, excitement = 0, className, style, onReady, onApi, entrance = 'walk' },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<CrowdEngine | null>(null)
  /** Shot requested before the engine chunk landed; applied on creation. */
  const pendingShot = useRef<Partial<CrowdShot> | null>(null)
  /** A focus requested before the engine landed. */
  const pendingFocus = useRef<CharacterKind | null | undefined>(undefined)
  const castKey = (cast && cast.length ? cast : DEFAULT_CAST).filter(isCharacterKind).join(',')
  const latest = useRef({ castKey, excitement, onReady, onApi, entrance })
  latest.current = { castKey, excitement, onReady, onApi, entrance }

  // One stable handle; methods proxy to the engine once it exists.
  const handle = useMemo<FoodCrowdHandle>(
    () => ({
      cheer: (kind) => engineRef.current?.cheer(kind),
      focus: (kind) => {
        if (engineRef.current) engineRef.current.focus(kind)
        else pendingFocus.current = kind
      },
      wave: (kind) => engineRef.current?.wave(kind),
      gasp: (kind) => engineRef.current?.gasp(kind),
      catch: (kind) => engineRef.current?.catch(kind),
      setShot: (shot) => {
        if (engineRef.current) engineRef.current.setShot(shot)
        else pendingShot.current = { ...pendingShot.current, ...shot }
      },
      look: (x, y) => {
        if (Number.isFinite(x) && Number.isFinite(y)) engineRef.current?.look(x, y)
      },
    }),
    [],
  )

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
            entrance: latest.current.entrance,
            shot: pendingShot.current ?? undefined,
            onFirstFrame: () => latest.current.onReady?.(),
          })
          pendingShot.current = null
          if (engineRef.current && pendingFocus.current !== undefined) engineRef.current.focus(pendingFocus.current)
          pendingFocus.current = undefined
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

  // Hand the API out (next/dynamic drops refs, so this is the reliable path).
  useEffect(() => {
    try {
      latest.current.onApi?.(handle)
    } catch {
      /* caller's problem */
    }
    return () => {
      try {
        latest.current.onApi?.(null)
      } catch {
        /* ignore */
      }
    }
  }, [handle])

  useEffect(() => {
    engineRef.current?.setCast(castKey.split(',').filter(isCharacterKind))
  }, [castKey])

  useEffect(() => {
    engineRef.current?.setExcitement(excitement)
  }, [excitement])

  // Page-wide bus: add-to-cart, scenes and empty states direct the cast.
  useEffect(
    () =>
      onCrowd((e) => {
        const engine = engineRef.current
        switch (e.type) {
          case 'cheer':
            play('cheer')
            engine?.cheer(e.kind)
            break
          case 'catch':
            play('catch')
            engine?.catch(e.kind)
            break
          case 'focus':
            if (engine) engine.focus(e.kind)
            else pendingFocus.current = e.kind
            break
          case 'wave':
            engine?.wave(e.kind)
            break
          case 'gasp':
            engine?.gasp(e.kind)
            break
          case 'look':
            if (engine && Number.isFinite(e.x) && Number.isFinite(e.y)) engine.look(e.x, e.y)
            break
        }
      }),
    [],
  )

  useImperativeHandle(ref, () => handle, [handle])

  return <div ref={hostRef} aria-hidden="true" className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }} />
})

FoodCrowd.displayName = 'FoodCrowd'

export default FoodCrowd
