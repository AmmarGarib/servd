// Confetti, lazily. canvas-confetti is only fetched the first time something
// actually celebrates, and never on a quiet route, under reduced motion, or in
// a hidden tab (those resolve immediately as a no-op).
//
// This function does NOT emit a play event; the PlayLayer turns
// `{ type: 'celebrate' }` bus events into calls to it.

import type { Palette } from './bus'
import { prefersReducedMotion } from './motion'
import { isQuietNow } from './quiet'

export const PALETTES: Record<Palette, string[]> = {
  servd: ['#FFD447', '#FF5A3C', '#4E2A4F', '#FFF4D6'],
  stackd: ['#7C2946', '#FCE8CE', '#9BD3DD'],
  flipd: ['#294375', '#FED561', '#F9F0E1'],
}

type ConfettiFn = typeof import('canvas-confetti')
let loader: Promise<ConfettiFn | null> | null = null

function load(): Promise<ConfettiFn | null> {
  if (!loader) {
    loader = import('canvas-confetti')
      .then((m) => (m as unknown as { default?: ConfettiFn }).default ?? (m as unknown as ConfettiFn))
      .catch(() => {
        loader = null // allow a retry after a transient chunk failure
        return null
      })
  }
  return loader
}

export async function celebrate(o?: {
  x?: number
  y?: number
  palette?: Palette
  power?: 'small' | 'big'
}): Promise<void> {
  if (typeof window === 'undefined') return
  if (prefersReducedMotion() || isQuietNow() || document.hidden) return
  const confetti = await load()
  if (!confetti) return
  const colors = PALETTES[o?.palette ?? 'servd']
  const base = { colors, disableForReducedMotion: true, zIndex: 70 }
  try {
    if (o?.power === 'big') {
      await Promise.all([
        confetti({ ...base, particleCount: 120, angle: 60, spread: 70, startVelocity: 55, origin: { x: 0, y: 0.75 } }),
        confetti({ ...base, particleCount: 120, angle: 120, spread: 70, startVelocity: 55, origin: { x: 1, y: 0.75 } }),
      ])
      return
    }
    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    const x = o?.x != null ? clamp01(o.x / w) : 0.5
    const y = o?.y != null ? clamp01(o.y / h) : 0.5
    await confetti({ ...base, particleCount: 40, spread: 60, startVelocity: 28, scalar: 0.8, origin: { x, y } })
  } catch {
    /* decorative */
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}
