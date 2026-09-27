// The sticker economy. One small persisted zustand store.
//
// SSR and hydration: the store is created with `skipHydration`, so the server
// render and the first client render both see the defaults and cannot
// mismatch. Persisted state is pulled in by hydratePlay(), which useHydrated()
// calls after mount and every action calls before it touches state (so an
// award made from an early effect is never overwritten by a late rehydrate).
//
// Storage: localStorage behind try/catch. Private windows, blocked site data
// and quota errors fall back to an in-memory map for the rest of the session.
//
// Rewards are cosmetic only. Nothing here touches the cart or money.

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import type { StickerId } from './stickers'
import { collect } from './collect'

export const PLAY_STORAGE_KEY = 'servd-play'

const KITCHENS = ['stackd', 'simmer', 'flipd'] as const
type Kitchen = (typeof KITCHENS)[number]

export interface PlayData {
  /** Found stickers, keyed by id, valued by the epoch ms they were found. */
  stickers: Partial<Record<StickerId, number>>
  kitchens: string[]
  pokes: number
  streak: { count: number; lastDay: string }
  best: Record<string, number>
  sound: boolean
  haptics: boolean
  /** The one-time "psst" bubble has been shown. */
  introSeen: boolean
  /** The 12/12 party has fired (it fires once, ever). */
  partied: boolean
}

export interface PlayActions {
  /** True only the first time a sticker is awarded. */
  award: (id: StickerId) => boolean
  /** stackd | simmer | flipd. All three visited awards 'grand-tour'. */
  markKitchen: (slug: string) => void
  bumpPokes: () => number
  /** Keeps the higher score. True when this is a new best. */
  recordScore: (game: string, score: number) => boolean
  touchStreak: () => void
  setSound: (b: boolean) => void
  setHaptics: (b: boolean) => void
  markIntroSeen: () => void
  markPartied: () => void
  reset: () => void
}

export type PlayState = PlayData & PlayActions

function defaults(): PlayData {
  return {
    stickers: {},
    kitchens: [],
    pokes: 0,
    streak: { count: 0, lastDay: '' },
    best: {},
    sound: false,
    haptics: true,
    introSeen: false,
    partied: false,
  }
}

// ── storage ─────────────────────────────────────────────────────────────────

const memory = new Map<string, string>()
let storageBroken = false

function local(): Storage | null {
  if (storageBroken || typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    storageBroken = true
    return null
  }
}

const safeStorage: StateStorage = {
  getItem(name) {
    const ls = local()
    if (ls) {
      try {
        return ls.getItem(name) ?? memory.get(name) ?? null
      } catch {
        storageBroken = true
      }
    }
    return memory.get(name) ?? null
  },
  setItem(name, value) {
    memory.set(name, value)
    const ls = local()
    if (!ls) return
    try {
      ls.setItem(name, value)
    } catch {
      storageBroken = true
    }
  },
  removeItem(name) {
    memory.delete(name)
    const ls = local()
    if (!ls) return
    try {
      ls.removeItem(name)
    } catch {
      storageBroken = true
    }
  },
}

// ── dates ───────────────────────────────────────────────────────────────────

/** Local calendar day as YYYY-MM-DD. */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function yesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return localDay(d)
}

// ── store ───────────────────────────────────────────────────────────────────

export const usePlay = create<PlayState>()(
  persist(
    (set, get) => ({
      ...defaults(),

      award(id) {
        hydratePlay()
        if (get().stickers[id] != null) return false
        set((s) => ({ stickers: { ...s.stickers, [id]: Date.now() } }))
        return true
      },

      markKitchen(slug) {
        hydratePlay()
        const k = String(slug ?? '').trim().toLowerCase()
        if (!(KITCHENS as readonly string[]).includes(k)) return
        const cur = get().kitchens
        if (!cur.includes(k)) set({ kitchens: [...cur, k] })
        const all = KITCHENS.every((x: Kitchen) => get().kitchens.includes(x))
        if (all && get().stickers['grand-tour'] == null) collect('grand-tour')
      },

      bumpPokes() {
        hydratePlay()
        const n = get().pokes + 1
        set({ pokes: n })
        return n
      },

      recordScore(game, score) {
        hydratePlay()
        if (!Number.isFinite(score)) return false
        const prev = get().best[game]
        if (prev != null && score <= prev) return false
        set((s) => ({ best: { ...s.best, [game]: score } }))
        return true
      },

      touchStreak() {
        hydratePlay()
        const today = localDay()
        const { lastDay, count } = get().streak
        if (lastDay === today) return
        const next = lastDay === yesterday() ? count + 1 : 1
        set({ streak: { count: next, lastDay: today } })
      },

      setSound(b) {
        hydratePlay()
        set({ sound: b })
      },

      setHaptics(b) {
        hydratePlay()
        set({ haptics: b })
      },

      markIntroSeen() {
        hydratePlay()
        set({ introSeen: true })
      },

      markPartied() {
        hydratePlay()
        set({ partied: true })
      },

      reset() {
        hydratePlay()
        // "start over" clears the hunt. The one-time intro bubble stays seen:
        // someone who just wiped their book does not need to be told again.
        set({ ...defaults(), introSeen: true })
      },
    }),
    {
      name: PLAY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s): PlayData => ({
        stickers: s.stickers,
        kitchens: s.kitchens,
        pokes: s.pokes,
        streak: s.streak,
        best: s.best,
        sound: s.sound,
        haptics: s.haptics,
        introSeen: s.introSeen,
        partied: s.partied,
      }),
      // Tolerate a hand-edited or partial blob: anything missing falls back
      // to the defaults rather than leaving `undefined` in typed state.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PlayData>
        const d = defaults()
        return {
          ...current,
          stickers: p.stickers && typeof p.stickers === 'object' ? p.stickers : d.stickers,
          kitchens: Array.isArray(p.kitchens) ? p.kitchens.filter((k) => typeof k === 'string') : d.kitchens,
          pokes: typeof p.pokes === 'number' ? p.pokes : d.pokes,
          streak:
            p.streak && typeof p.streak.count === 'number' && typeof p.streak.lastDay === 'string'
              ? p.streak
              : d.streak,
          best: p.best && typeof p.best === 'object' ? p.best : d.best,
          sound: typeof p.sound === 'boolean' ? p.sound : d.sound,
          haptics: typeof p.haptics === 'boolean' ? p.haptics : d.haptics,
          introSeen: typeof p.introSeen === 'boolean' ? p.introSeen : d.introSeen,
          partied: typeof p.partied === 'boolean' ? p.partied : d.partied,
        }
      },
    },
  ),
)

let hydrated = false

/**
 * Pull persisted state in, once. Synchronous (localStorage is synchronous, so
 * zustand's persist resolves in the same tick). Safe to call anywhere; a no-op
 * on the server and after the first call.
 */
export function hydratePlay(): void {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  try {
    void usePlay.persist.rehydrate()
  } catch {
    /* storage unreadable: keep the defaults */
  }
}

/** Re-read persisted state (another tab changed it). */
export function rehydratePlayFromStorage(): void {
  if (typeof window === 'undefined') return
  hydrated = true
  try {
    void usePlay.persist.rehydrate()
  } catch {
    /* ignore */
  }
}

export function isPlayHydrated(): boolean {
  return hydrated
}
