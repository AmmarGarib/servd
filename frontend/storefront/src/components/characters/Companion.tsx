'use client'

/**
 * Companion — the sidekick. One character from the brand's cast (stackd:
 * coffee, Flipd: burger, the hub: fries; simmer never gets one) docks in a
 * corner and follows the customer through ordering, checkout and the tracker.
 *
 * - An SVG poster paints from the first byte; the WebGL character mounts in
 *   an idle callback (never on the LCP path) and crossfades in over 200ms.
 * - It hears the page-wide crowd bus through its FoodCrowd: `catch` when an
 *   item lands in the bag, `cheer`, `gasp` on empty / closed states.
 * - Tapping it cheers, with a small haptic tick.
 * - Decorative: aria-hidden, and only the character box takes pointer events.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import dynamic from 'next/dynamic'
import { CrowdPoster } from '@/components/party/loader/CrowdPoster'
import { haptic } from '@/lib/haptics'
import type { FoodCrowdHandle } from './FoodCrowd'
import type { CharacterKind } from './types'
import styles from './companion.module.css'

const FoodCrowd = dynamic(() => import('./FoodCrowd').then((m) => m.FoodCrowd), { ssr: false })

export type CompanionMood = 'idle' | 'watch' | 'cheer' | 'wave' | 'gasp'
export type CompanionPlacement = 'bottom-left' | 'bottom-right' | 'inline'

export interface CompanionProps {
  /** Falsy renders nothing (so `companionKindFor(slug)` can be passed straight in). */
  kind: CharacterKind | null | undefined
  placement?: CompanionPlacement
  /** Desktop edge length in px (default 96); phones get three quarters of it (72). */
  size?: number
  mood?: CompanionMood
}

/** Which cast member rides along for a brand. simmer never gets a character. */
export function companionKindFor(slug: string | null | undefined): CharacterKind | null {
  const s = (slug ?? '').trim().toLowerCase()
  if (s.includes('simmer')) return null
  if (s === 'stackd') return 'coffee'
  if (s === 'flipd') return 'burger'
  return 'fries'
}

/** Walk-on takes ≤ 1.4s; mood beats start once the character has landed. */
const AFTER_ENTRANCE_MS = 1300

function prefersReduced(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function Companion({ kind, placement = 'bottom-left', size, mood = 'idle' }: CompanionProps): JSX.Element | null {
  const [live, setLive] = useState(false)
  const [ready, setReady] = useState(false)
  const apiRef = useRef<FoodCrowdHandle | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  // Mount WebGL only when the main thread is idle, so it never delays LCP.
  useEffect(() => {
    if (!kind) return
    let cancelled = false
    const go = () => {
      if (!cancelled) setLive(true)
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(go, { timeout: 2500 })
      return () => {
        cancelled = true
        w.cancelIdleCallback?.(id)
      }
    }
    const id = window.setTimeout(go, 700)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [kind])

  const onApi = useCallback((api: FoodCrowdHandle | null) => {
    apiRef.current = api
  }, [])
  const onReady = useCallback(() => setReady(true), [])

  // Mood beats, once the character is on stage.
  useEffect(() => {
    if (!ready || !kind) return
    const reduced = prefersReduced()
    const timers: number[] = []
    const every = (ms: number, fn: () => void) => {
      if (reduced) return
      timers.push(window.setInterval(fn, ms))
    }
    const glanceUpRight = () => {
      const r = stageRef.current?.getBoundingClientRect()
      if (!r) return
      // up and toward the content: right of the dock for the left corner, left of it for the right corner
      const dir = placement === 'bottom-right' ? -1 : 1
      apiRef.current?.look(r.left + r.width / 2 + dir * Math.max(240, r.width * 3), r.top - Math.max(220, r.height * 2.5))
    }
    const start = window.setTimeout(() => {
      const api = apiRef.current
      if (!api) return
      switch (mood) {
        case 'watch':
          glanceUpRight()
          every(5000, glanceUpRight)
          break
        case 'cheer':
          api.cheer()
          every(6000, () => apiRef.current?.cheer())
          break
        case 'wave':
          api.wave()
          break
        case 'gasp':
          api.gasp()
          break
        default:
          break
      }
    }, reduced ? 0 : AFTER_ENTRANCE_MS)
    return () => {
      window.clearTimeout(start)
      timers.forEach((id) => window.clearInterval(id))
    }
  }, [ready, mood, kind, placement])

  const onTap = useCallback(() => {
    haptic(8)
    apiRef.current?.cheer()
  }, [])

  if (!kind) return null

  const place =
    placement === 'inline' ? styles.inline : placement === 'bottom-right' ? styles.bottomRight : styles.bottomLeft
  const sizeStyle = size && Number.isFinite(size) && size > 0 ? ({ '--companion-size': `${Math.round(size)}px` } as React.CSSProperties) : undefined

  return (
    <div className={`${styles.dock} ${place}`} style={sizeStyle} aria-hidden="true" data-companion={kind}>
      <div ref={stageRef} className={styles.stage} onPointerDown={onTap}>
        <CrowdPoster cast={[kind]} still id={`companion-${kind}`} className={`${styles.layer} ${styles.poster} ${ready ? styles.hidden : ''}`} />
        {live && (
          <div className={`${styles.layer} ${styles.crowd} ${ready ? '' : styles.hidden}`}>
            <FoodCrowd cast={[kind]} entrance="walk" onReady={onReady} onApi={onApi} />
          </div>
        )}
      </div>
    </div>
  )
}

export default Companion
