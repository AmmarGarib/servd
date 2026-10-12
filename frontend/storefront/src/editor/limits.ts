// Load limits and short caches for the editor frame's server action. The
// action is public (it renders only posted JSON + public data), so it is
// bounded in-process:
//   - at most MAX_IN_FLIGHT renders at a time across the whole server; over
//     that the call answers RATE_LIMITED at once (no queue). A slot covers the
//     action's own work (the composition data) AND the render of the tree it
//     returns: React renders that tree (every section and its data fetches)
//     while it streams the response, after the action has returned, so a
//     successful call keeps its slot (hold()) until the same client's next
//     call arrives (the frame is single flight, so the previous tree has
//     streamed by then) or HOLD_MS after it returned, whichever comes first.
//     A real editor session therefore holds at most one slot;
//   - PER_IP_PER_MINUTE renders per client IP per minute, in a map pruned
//     after 60 s and capped at MAX_KEYS keys.
// Every fetch the composition makes is bounded by FETCH_TIMEOUT_MS (a hung API
// gives the page its built-in design instead of holding a slot for minutes).
//
// The 30 s caches below are for the editor frame ONLY (live routes never use
// them): the live layouts of the parts NOT being edited and the brand list.
// The layout cache evicts its oldest entry when full, never the whole map.

import { fetchSiteLayout, type SiteLayoutRead } from '../lib/blocks'
import { fetchLiveConcepts } from '../lib/liveConcepts'
import type { Concept } from '../lib/concept'

export const MAX_IN_FLIGHT = 6
export const PER_IP_PER_MINUTE = 240
/** How long a returned tree may keep its slot while it streams. */
export const HOLD_MS = 3_000
/** Upper bound for each fetch the composition makes. */
export const FETCH_TIMEOUT_MS = 5_000
const WINDOW_MS = 60_000
const MAX_KEYS = 10_000

let inFlight = 0
const windows = new Map<string, { start: number; count: number }>()
/** ip -> release() of the slot its last returned tree still holds. Entries
 *  leave on release, so this never holds more than MAX_IN_FLIGHT keys. */
const holds = new Map<string, () => void>()

export interface RenderSlot {
  /** Give the slot back now (failure, nothing left to stream). Idempotent. */
  release: () => void
  /** The action returned a tree that React still renders while it streams:
   *  keep the slot until this client's next call or HOLD_MS, then release. */
  hold: () => void
}

type HeaderReader = { get(name: string): string | null }

/** The client's IP: Cloudflare's header when the request came through the
 *  tunnel (cf-ray present), else the first X-Forwarded-For hop, else 'local'. */
export function clientIp(h: HeaderReader): string {
  const cf = h.get('cf-connecting-ip')?.trim()
  if (cf && h.get('cf-ray')) return cf.slice(0, 64)
  const xff = h.get('x-forwarded-for')?.split(',')[0]?.trim()
  return xff ? xff.slice(0, 64) : 'local'
}

function prune(now: number) {
  for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k)
  // Still full of live keys: drop the oldest (insertion order).
  while (windows.size >= MAX_KEYS) {
    const oldest = windows.keys().next().value
    if (oldest === undefined) break
    windows.delete(oldest)
  }
}

/** Take a render slot, or null when the server or this IP is at its limit.
 *  Call release() or hold() once when the action's own work is done. */
export function acquireRenderSlot(ip: string, now = Date.now()): RenderSlot | null {
  // This client's previous tree has finished streaming (single flight).
  holds.get(ip)?.()
  if (inFlight >= MAX_IN_FLIGHT) return null
  let w = windows.get(ip)
  if (w && now - w.start >= WINDOW_MS) { windows.delete(ip); w = undefined }
  if (!w) {
    if (windows.size >= MAX_KEYS) prune(now)
    w = { start: now, count: 0 }
    windows.set(ip, w)
  }
  if (w.count >= PER_IP_PER_MINUTE) return null
  w.count += 1
  inFlight += 1
  let released = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const release = () => {
    if (released) return
    released = true
    if (timer) clearTimeout(timer)
    if (holds.get(ip) === release) holds.delete(ip)
    inFlight = Math.max(0, inFlight - 1)
  }
  const hold = () => {
    if (released || timer) return
    const prev = holds.get(ip)
    if (prev && prev !== release) prev()
    holds.set(ip, release)
    timer = setTimeout(release, HOLD_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return { release, hold }
}

/** Renders currently counted against MAX_IN_FLIGHT (tests, /health-style checks). */
export function rendersInFlight(): number {
  return inFlight
}

/** Test hook: forget every counter. */
export function resetRenderLimits(): void {
  for (const release of [...holds.values()]) release()
  holds.clear()
  inFlight = 0
  windows.clear()
}

/** `p`, or `fallback` when it has not settled within `ms` (or rejects). The
 *  underlying request is not cancelled, but nothing waits for it any more. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)   // cleared as soon as `p` settles
  })
  return Promise.race([p.catch(() => fallback), late]).finally(() => { if (timer) clearTimeout(timer) })
}

// ── 30 s caches (editor frame only) ────────────────────────────────────────

const TTL_MS = 30_000
const MISS_TTL_MS = 5_000   // an API blip should not stick for long
export const MAX_CACHED_LAYOUTS = 200

interface Entry<T> { at: number; ttl: number; value: Promise<T> }
const layouts = new Map<string, Entry<SiteLayoutRead | null>>()
let concepts: Entry<Concept[]> | null = null

function fresh<T>(e: Entry<T> | null | undefined, now: number): e is Entry<T> {
  return !!e && now - e.at < e.ttl
}

/** The LIVE layout of a part that is not being edited (chrome, the page
 *  behind a pop-up). Never a draft. */
export function cachedLiveLayout(slug: string): Promise<SiteLayoutRead | null> {
  const now = Date.now()
  const hit = layouts.get(slug)
  layouts.delete(slug)            // re-inserted below: most recently used last
  if (fresh(hit, now)) {
    layouts.set(slug, hit)
    return hit.value
  }
  const entry: Entry<SiteLayoutRead | null> = {
    at: now, ttl: TTL_MS, value: withTimeout(fetchSiteLayout(slug), FETCH_TIMEOUT_MS, null),
  }
  void entry.value.then((v) => { if (!v) entry.ttl = MISS_TTL_MS }, () => { entry.ttl = 0 })
  // Full: drop the least recently used entry, never the chrome every render uses.
  while (layouts.size >= MAX_CACHED_LAYOUTS) {
    const oldest = layouts.keys().next().value
    if (oldest === undefined) break
    layouts.delete(oldest)
  }
  layouts.set(slug, entry)
  return entry.value
}

/** The live brand list ([] when the API is down). */
export function cachedConcepts(): Promise<Concept[]> {
  const now = Date.now()
  if (fresh(concepts, now)) return concepts.value
  const entry: Entry<Concept[]> = { at: now, ttl: TTL_MS, value: withTimeout(fetchLiveConcepts(), FETCH_TIMEOUT_MS, []) }
  void entry.value.then((v) => { if (!v.length) entry.ttl = MISS_TTL_MS }, () => { entry.ttl = 0 })
  concepts = entry
  return entry.value
}

/** Test hook: forget the cached layouts and brand list. */
export function resetFrameCaches(): void {
  layouts.clear()
  concepts = null
}

/** Test hook: the cached layout slugs, least recently used first. */
export function cachedLayoutSlugs(): string[] {
  return [...layouts.keys()]
}
