'use client'
// Act I casting — a session-seeded running order for the food crowd.
//
// Every visit to the home page in the same browser session gets the same
// line-up (so navigating back never reshuffles the cast), and a new session
// gets a new one. Coffee (stackd) and the burger (Flipd) lead the roll call,
// so they are always placed in slots 1-3: the engine shows the middle four
// on mid-width stages and the middle three on narrow ones (start index 1 in
// both cases), so those slots are on screen at every stage aspect.
//
// In one session in eight a surprise guest turns up: a party hat on the
// remaining middle character.

import { useEffect, useState } from 'react'
import type { CharacterKind } from '../../characters/types'

export const CAST_SEED_KEY = 'servd:cast-seed'

export const DEFAULT_CAST: CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

export interface SessionCast {
  cast: CharacterKind[]
  /** Index into `cast` of the character wearing the party hat, or null. */
  cameoSlot: number | null
}

const DEFAULT: SessionCast = { cast: DEFAULT_CAST, cameoSlot: null }

/** Small, fast, deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

export function castFromSeed(seed: number): SessionCast {
  const rnd = rng(seed)
  const leads = shuffled<CharacterKind>(['coffee', 'burger'], rnd)
  const rest = shuffled<CharacterKind>(['fries', 'sandwich', 'shake', 'croissant'], rnd)
  const middle = shuffled([1, 2, 3], rnd)
  const leadSlots = new Set(middle.slice(0, 2))
  const cast: CharacterKind[] = []
  let li = 0
  let ri = 0
  for (let i = 0; i < 6; i++) {
    const k = leadSlots.has(i) ? leads[li++] : rest[ri++]
    if (!k) return DEFAULT
    cast.push(k)
  }
  const cameo = (seed >>> 0) % 8 === 0 ? (middle[2] ?? null) : null
  return { cast, cameoSlot: cameo }
}

function readSeed(): number | null {
  try {
    const store = window.sessionStorage
    const raw = store.getItem(CAST_SEED_KEY)
    const parsed = raw == null ? NaN : Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed >>> 0
    const seed = Math.floor(Math.random() * 4294967296) >>> 0
    store.setItem(CAST_SEED_KEY, String(seed))
    return seed
  } catch {
    return null
  }
}

/** Server render and first client render use the default line-up (no
 *  hydration mismatch); the session's own line-up lands right after mount. */
export function useSessionCast(): SessionCast {
  const [cast, setCast] = useState<SessionCast>(DEFAULT)
  useEffect(() => {
    const seed = readSeed()
    if (seed != null) setCast(castFromSeed(seed))
  }, [])
  return cast
}

/** How many characters the engine shows for a stage aspect, and from which
 *  cast index (mirrors the engine's layout rule). */
export function visibleWindow(aspect: number, total: number): { start: number; count: number } {
  const count = Math.min(total, aspect < 0.95 ? 3 : aspect < 1.35 ? 4 : total)
  return { start: Math.max(0, Math.floor((total - count) / 2)), count }
}
