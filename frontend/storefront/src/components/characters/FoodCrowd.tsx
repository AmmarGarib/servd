'use client'

/**
 * FoodCrowd — a row of procedural 3D food characters (three.js) whose eyes
 * follow the cursor anywhere on the page. Decorative only (aria-hidden).
 *
 * They live on Karachi time: the lighting follows the day-part, energy
 * drives how bouncy they are, and at night they doze (poke one and it jolts
 * awake, and its neighbours flinch). All of that comes from `useWorld()`;
 * before it is ready, the day-part stamped on <html> by the server is used,
 * so the very first frame is already lit right.
 *
 * The component fills its parent box; the parent sets the size. The canvas
 * is transparent, so the stage colour behind it shows through.
 *
 * three.js is imported lazily inside an effect: nothing touches window or
 * WebGL during SSR, and without WebGL the component quietly renders nothing.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type * as React from 'react'
import { useWorld } from '../../lib/world/useWorld'
import { moodFor, parseDayPart } from '../../lib/world/clock'
import { emitCrowd, onCrowd } from './crowdBus'
import { isCharacterKind, type CharacterKind, type Mood } from './types'
import type { CrowdEngine, CrowdWorld } from './engine'

export type { CharacterKind, Mood } from './types'

export interface FoodCrowdHandle {
  /** One character (or all when omitted) does a happy jump + squash. */
  cheer(kind?: CharacterKind): void
  /** Pull a face: one kind (or everyone) for `seconds` (default 1.6). */
  react(mood: Mood, kind?: CharacterKind, seconds?: number): void
  /** Play a signature quirk: one kind, or a random character. */
  quirk(kind?: CharacterKind): void
}

export interface FoodCrowdProps {
  /** Left→right order. Default ['fries','burger','coffee','sandwich','shake','croissant']. */
  cast?: CharacterKind[]
  /** 0..1 — lean toward the cursor harder, bounce faster, eyes widen. */
  excitement?: number
  className?: string
  /** The component fills its parent box (width/height 100%); the parent sizes it. */
  style?: React.CSSProperties
  /** Fired after the first frame that has a character in it. */
  onReady?: () => void
  /** When set, emits `{ type: 'stage', id, visible }` on the crowd bus as the stage crosses 30% visibility. */
  stageId?: string
  /** Follow the world clock (lighting, energy, sleep). Default true. */
  world?: boolean
  /** Manual sleepiness 0..1; effective = max(world, this). */
  sleepy?: number
}

const DEFAULT_CAST: CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']
const LUNCH: CrowdWorld = { dayPart: 'lunch', energy: 0.5, sleepy: 0 }

/** Pre-hydration fallback: the server-stamped html attributes. */
function worldFromHtml(): CrowdWorld | null {
  try {
    const el = document.documentElement
    const dayPart = parseDayPart(el.getAttribute('data-daypart'))
    if (!dayPart) return null
    const open = Number(el.getAttribute('data-kitchens-open'))
    const m = moodFor(dayPart, Number.isFinite(open) && el.hasAttribute('data-kitchens-open') ? open : 1)
    return { dayPart: m.dayPart, energy: m.energy, sleepy: m.sleepy }
  } catch {
    return null
  }
}

export const FoodCrowd = forwardRef<FoodCrowdHandle, FoodCrowdProps>(function FoodCrowd(
  { cast, excitement = 0, className, style, onReady, stageId, world = true, sleepy },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<CrowdEngine | null>(null)
  const castKey = (cast && cast.length ? cast : DEFAULT_CAST).filter(isCharacterKind).join(',')
  const w = useWorld()
  const followWorld = world !== false
  const worldReady = followWorld && w.ready
  const liveWorld: CrowdWorld | null = worldReady ? { dayPart: w.dayPart, energy: w.energy, sleepy: w.sleepy } : null
  const sleepyProp = typeof sleepy === 'number' && Number.isFinite(sleepy) ? Math.min(1, Math.max(0, sleepy)) : 0

  const latest = useRef({ castKey, excitement, onReady, liveWorld, followWorld, sleepyProp })
  latest.current = { castKey, excitement, onReady, liveWorld, followWorld, sleepyProp }

  // Mount the engine once; three.js is code-split and loaded client-side only.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    import('./engine')
      .then(({ createCrowdEngine }) => {
        if (cancelled) return
        const l = latest.current
        const initial = l.followWorld ? (l.liveWorld ?? worldFromHtml() ?? LUNCH) : LUNCH
        try {
          engineRef.current = createCrowdEngine(host, {
            cast: l.castKey.split(',').filter(isCharacterKind),
            excitement: l.excitement,
            world: initial,
            sleepy: l.sleepyProp,
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

  // World clock → lighting, energy, sleep. Only once useWorld is live; until
  // then the engine runs on the html-stamped day-part it started with.
  const wDay = liveWorld?.dayPart
  const wEnergy = liveWorld?.energy
  const wSleepy = liveWorld?.sleepy
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    if (!followWorld) e.setWorld(LUNCH)
    else if (wDay !== undefined && wEnergy !== undefined && wSleepy !== undefined) e.setWorld({ dayPart: wDay, energy: wEnergy, sleepy: wSleepy })
  }, [followWorld, wDay, wEnergy, wSleepy])

  useEffect(() => {
    engineRef.current?.setSleepy(sleepyProp)
  }, [sleepyProp])

  // Page-wide bus: add-to-cart etc. can make the crowd react.
  useEffect(
    () =>
      onCrowd((e) => {
        const engine = engineRef.current
        if (!engine) return
        switch (e.type) {
          case 'cheer':
            engine.cheer(e.kind)
            break
          case 'look':
            engine.look(e.x, e.y)
            break
          case 'react':
            engine.react(e.mood, e.kind, e.seconds)
            break
          case 'catch':
            engine.catchAt(e.x, e.y, e.kind)
            break
          default:
            break // 'say' and 'stage' belong to the buddy
        }
      }),
    [],
  )

  // Stage visibility → the bus (the buddy steps aside while a stage crowd is on screen).
  useEffect(() => {
    const host = hostRef.current
    if (!host || !stageId || typeof IntersectionObserver === 'undefined') return
    let visible: boolean | null = null
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (!entry) return
        const now = entry.isIntersecting && entry.intersectionRatio >= 0.29
        if (now !== visible) {
          visible = now
          emitCrowd({ type: 'stage', id: stageId, visible: now })
        }
      },
      { threshold: [0, 0.3] },
    )
    io.observe(host)
    return () => {
      io.disconnect()
      if (visible) emitCrowd({ type: 'stage', id: stageId, visible: false })
    }
  }, [stageId])

  useImperativeHandle(
    ref,
    () => ({
      cheer: (kind?: CharacterKind) => engineRef.current?.cheer(kind),
      react: (mood: Mood, kind?: CharacterKind, seconds?: number) => engineRef.current?.react(mood, kind, seconds),
      quirk: (kind?: CharacterKind) => engineRef.current?.quirk(kind),
    }),
    [],
  )

  return <div ref={hostRef} aria-hidden="true" className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }} />
})

FoodCrowd.displayName = 'FoodCrowd'

export default FoodCrowd
