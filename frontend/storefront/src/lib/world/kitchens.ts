'use client'
// Live kitchen state for the whole storefront: one store, many readers.
//
// The server and the first client render see the three kitchens on their
// fallback hours with ready:false, so SSR and hydration agree. After mount the
// store recomputes on the client clock, fetches each brand's real hours once
// (module-level promise, 5-minute TTL), and re-ticks every 30 s and whenever
// the tab becomes visible. Subscribers are notified only when something a
// reader could see has changed.
//
// Visual state should come from the html[data-k-*] attributes WorldSync keeps
// current, not from this hook, so the first paint is already right.

import { useSyncExternalStore } from 'react'
import type { ServiceHourRow } from '../../components/brand/parts/OpenStatusBadge'
import {
  KITCHEN_SLUGS,
  fallbackKitchens,
  kitchenState,
  type KitchenSlug,
  type KitchenState,
} from './kitchenCore'

export interface KitchensSnapshot {
  ready: boolean
  list: KitchenState[]
  openCount: number
  total: 3
  bySlug: Record<KitchenSlug, KitchenState>
}

interface LiveHours { isActive: boolean; rows: ServiceHourRow[] }

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const TTL_MS = 5 * 60_000
const TICK_MS = 30_000
const FETCH_TIMEOUT_MS = 6_000

// ── Snapshot building ────────────────────────────────────────────────────────

function build(list: KitchenState[], ready: boolean): KitchensSnapshot {
  const bySlug = {} as Record<KitchenSlug, KitchenState>
  for (const k of list) bySlug[k.slug] = k
  return { ready, list, openCount: list.filter((k) => k.open).length, total: 3, bySlug }
}

function signature(s: KitchensSnapshot): string {
  return `${s.ready ? 1 : 0}|${s.list.map((k) => `${k.slug}:${k.phase}:${k.label}:${k.source}:${k.closesAt}:${k.opensAt}`).join(',')}`
}

// Server: a fresh fallback per minute (the module is shared across requests,
// so a single cached value would freeze at server start).
let serverSnap: { minute: number; snap: KitchensSnapshot } | null = null
function serverSnapshot(): KitchensSnapshot {
  const minute = Math.floor(Date.now() / 60_000)
  if (!serverSnap || serverSnap.minute !== minute) serverSnap = { minute, snap: build(fallbackKitchens(), false) }
  return serverSnap.snap
}

// Client: the hydration snapshot is frozen on first use so every component
// hydrating in this page load agrees with every other one.
let hydrationSnap: KitchensSnapshot | null = null
function getServerSnapshot(): KitchensSnapshot {
  if (typeof window === 'undefined') return serverSnapshot()
  if (!hydrationSnap) hydrationSnap = build(fallbackKitchens(), false)
  return hydrationSnap
}

let current: KitchensSnapshot | null = null
let currentSig = ''
function getSnapshot(): KitchensSnapshot {
  if (!current) {
    current = getServerSnapshot()
    currentSig = signature(current)
  }
  return current
}

// ── Live hours ───────────────────────────────────────────────────────────────

const live: Partial<Record<KitchenSlug, LiveHours>> = {}
let hoursPromise: Promise<void> | null = null
let fetchedAt = 0
let mounted = false

function isRow(v: unknown): v is ServiceHourRow {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r['dayOfWeek'] === 'number' && typeof r['openMin'] === 'number' && typeof r['closeMin'] === 'number'
}

async function fetchSlug(slug: KitchenSlug): Promise<void> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null
  try {
    const res = await fetch(`${API_BASE}/api/v1/storefront/brands/${slug}/hours`, {
      cache: 'no-store',
      signal: ctrl?.signal,
    })
    if (!res.ok) return
    const data = (await res.json()) as unknown
    if (!data || typeof data !== 'object') return
    const d = data as { isActive?: unknown; hours?: unknown }
    if (!Array.isArray(d.hours)) return
    live[slug] = {
      isActive: d.isActive !== false,
      rows: d.hours.filter(isRow).map((r) => ({
        dayOfWeek: r.dayOfWeek, openMin: r.openMin, closeMin: r.closeMin, isReservable: Boolean(r.isReservable),
      })),
    }
  } catch {
    // API down or slow: keep whatever we had (fallback on first failure).
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function ensureHours(): void {
  if (hoursPromise && Date.now() - fetchedAt < TTL_MS) return
  fetchedAt = Date.now()
  hoursPromise = Promise.all(KITCHEN_SLUGS.map(fetchSlug)).then(() => { recompute() })
}

// ── Ticking ──────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function stateFor(slug: KitchenSlug, now: Date): KitchenState {
  const l = live[slug]
  if (!l) return kitchenState(slug, null, true, now)
  // A brand with no hours configured returns an empty list, which the core
  // reads as "open, no times" — true to the API, but it would put a kitchen
  // awake at 4am. The world uses the house hours instead, still honouring an
  // operator's "temporarily closed" switch.
  if (l.rows.length === 0) return kitchenState(slug, null, l.isActive, now)
  return kitchenState(slug, l.rows, l.isActive, now)
}

function recompute(): void {
  if (!mounted) return
  const now = new Date()
  const next = build(KITCHEN_SLUGS.map((s) => stateFor(s, now)), true)
  const sig = signature(next)
  if (sig === currentSig) return
  current = next
  currentSig = sig
  for (const l of listeners) l()
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return
  ensureHours()
  recompute()
}

function tick(): void {
  ensureHours()
  recompute()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    mounted = true
    timer = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', onVisibility)
    // After hydration has committed: switch to the client clock at once, then
    // fold in live hours when they land.
    queueMicrotask(tick)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      if (timer) clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** Every kitchen's live state. ready:false on the server and first client render. */
export function useKitchens(): KitchensSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** One kitchen's live state. */
export function useKitchen(slug: KitchenSlug): KitchenState {
  return useKitchens().bySlug[slug]
}
