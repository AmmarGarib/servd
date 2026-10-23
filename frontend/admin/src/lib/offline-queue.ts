// The till's offline order queue (IndexedDB) — offline orders must never vanish.
//
// Owner rule (2026-10-23): an order rung while the till has no internet is kept on
// this device until the server has it. The PAGE owns the queue: it stores the
// ring-up here when the network fails, and replays it with the normal api client
// (the cashier's own session — public/sw.js cannot read it and only nudges the
// page to replay). Rules:
//
//   * Only `POST /pos/orders` (a new ticket) is ever queued. Money writes — pay,
//     settle, Keenu push, comp, add items to a sent ticket — are NEVER queued:
//     offline they fail with NO_INTERNET_MESSAGE.
//   * Each entry keeps the ring-up's idempotencyKey, so a replay of an order the
//     server did receive (the reply was lost) returns that order — never a second.
//   * An entry leaves the queue ONLY when the server accepted it (2xx, incl. an
//     idempotent replay) or a manager discards it on the till. A refusal (4xx)
//     stays, marked `refused` with the server's code and message, and is never
//     retried by itself (it would only be refused again). A 5xx / 429 / lost
//     connection stays `waiting` and is retried.
//   * Nothing expires: no age limit deletes an entry.
//   * Auto-replay sends only the entries the signed-in login rang (or old entries
//     with no login recorded); another login's entries wait for that login, or a
//     cashier sends them by hand with Resend (the server judges).
//   * An order carrying a manager PIN (discount) is NOT queued — a PIN is never
//     kept on the device; it fails loudly instead.

import { api, ApiError } from './api'
import { useAuthStore } from '../store/auth'

const DB_NAME = 'servd-offline'
const STORE = 'pos_queue'

/** The one line the till shows when a write could not reach the server. */
export const NO_INTERNET_MESSAGE = 'No internet — not sent. Check the connection and try again.'

/** Window event fired after any change to the queue (same tab). */
export const QUEUE_CHANGED_EVENT = 'servd:offline-queue-changed'

export interface OfflineOrderSummary {
  brandName?: string | null
  /** "Table 4", "Takeaway", "Delivery — <name>" */
  label?: string | null
  items: Array<{ name: string; quantity: number }>
  /** Σ (unit + modifiers) × qty — the menu prices of the lines, before discount and tax. */
  itemsCents: number
  discountCents?: number
  /** The server's total from the last quote the till had, when it had one. */
  totalCents?: number | null
}

export interface OfflineOrder {
  localId: string
  /** The POST /pos/orders body, exactly as the till would have sent it (idempotencyKey included). */
  body: Record<string, unknown>
  queuedAt: number
  /** The login that rang it (absent on entries stored by the old service worker). */
  userId?: string | null
  userName?: string | null
  summary?: OfflineOrderSummary
  /** waiting = will be sent; refused = the server said no, needs a person. Absent = waiting. */
  state?: 'waiting' | 'refused'
  error?: { status: number; code: string; message: string } | null
  attempts?: number
  lastTriedAt?: number | null
}

/** What a queued ring-up answers instead of an order. */
export interface QueuedPlaceholder { id: string; status: 'queued_offline'; localId: string }

// ─── IndexedDB ──────────────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'localId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      let result: T
      req.onsuccess = () => { result = req.result }
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('The offline queue could not be written'))
    })
  } finally {
    db.close()
  }
}

function changed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT))
}

export async function getQueuedOrders(): Promise<OfflineOrder[]> {
  if (typeof indexedDB === 'undefined') return []
  const all = await run<OfflineOrder[]>('readonly', (s) => s.getAll() as IDBRequest<OfflineOrder[]>)
  return all.sort((a, b) => a.queuedAt - b.queuedAt)
}

async function putQueued(entry: OfflineOrder): Promise<void> {
  await run('readwrite', (s) => s.put(entry))
  changed()
}

async function deleteQueued(localId: string): Promise<void> {
  await run('readwrite', (s) => s.delete(localId))
  changed()
}

// ─── Network failure vs a refusal ───────────────────────────────────────────

/** True when the request never got an answer: no internet, DNS, connection reset. */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof ApiError) return e.code === 'OFFLINE'
  if (!(e instanceof TypeError)) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  return /fetch|network|load failed|internet|connection/i.test(e.message)
}

/** Throws the till's "No internet — not sent" when the browser knows it is offline. */
export function requireOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError(0, 'OFFLINE', NO_INTERNET_MESSAGE)
  }
}

// ─── Store an order that could not be sent ─────────────────────────────────

function newLocalId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  return `offline_${c?.randomUUID ? c.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`
}

/** Summary of a ring-up's lines for the queue panel. */
export function summariseLines(
  items: Array<{ name: string; quantity: number; unitPriceCents: number; modifiers?: Array<{ priceDeltaCents: number }> }>,
  extra: Omit<OfflineOrderSummary, 'items' | 'itemsCents'> = {},
): OfflineOrderSummary {
  const merged = new Map<string, number>()
  let itemsCents = 0
  for (const l of items) {
    merged.set(l.name, (merged.get(l.name) ?? 0) + l.quantity)
    itemsCents += (l.unitPriceCents + (l.modifiers ?? []).reduce((s, m) => s + m.priceDeltaCents, 0)) * l.quantity
  }
  return { ...extra, items: [...merged].map(([name, quantity]) => ({ name, quantity })), itemsCents }
}

async function queueOrder(body: Record<string, unknown>, summary: OfflineOrderSummary): Promise<OfflineOrder> {
  const user = useAuthStore.getState().user
  const entry: OfflineOrder = {
    localId: newLocalId(),
    body,
    queuedAt: Date.now(),
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    summary,
    state: 'waiting',
    error: null,
    attempts: 0,
    lastTriedAt: null,
  }
  await putQueued(entry)
  return entry
}

/**
 * POST /pos/orders, or — when the network fails — keep it on this device and
 * answer a placeholder. A refusal from the server is thrown as usual (never
 * queued). A body with no idempotencyKey or carrying a manager PIN is never
 * queued: it fails with NO_INTERNET_MESSAGE.
 */
export async function postOrderOrQueue<T>(body: Record<string, unknown>, summary: OfflineOrderSummary): Promise<T | QueuedPlaceholder> {
  try {
    return await api.post<T>('/pos/orders', body)
  } catch (e) {
    if (!isNetworkFailure(e)) throw e
    const key = body['idempotencyKey']
    if (typeof key !== 'string' || !key || body['managerOverridePin']) {
      throw new ApiError(0, 'OFFLINE', body['managerOverridePin']
        ? 'No internet — not sent. An order with a manager-approved discount needs a connection; try again when the till is online.'
        : NO_INTERNET_MESSAGE)
    }
    let entry: OfflineOrder
    try {
      entry = await queueOrder(body, summary)
    } catch {
      // The device could not store it: say so — never a fake success.
      throw new ApiError(0, 'OFFLINE', 'No internet — not sent, and this device could not keep it. Write the order down and ring it again when online.')
    }
    return { id: entry.localId, status: 'queued_offline', localId: entry.localId }
  }
}

// ─── Replay ─────────────────────────────────────────────────────────────────

export type ReplayOutcome = 'sent' | 'refused' | 'waiting' | 'offline'

/** A refusal the server will repeat (a 4xx other than timeout / rate limit / session). */
function isRefusal(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)
}

/** Send one entry with the signed-in session. Removed only on success. */
export async function replayOne(entry: OfflineOrder, opts: { shiftId?: string | null } = {}): Promise<ReplayOutcome> {
  const body = { ...entry.body }
  // Resent by hand on a till whose drawer changed: the order goes on the drawer open now.
  if (opts.shiftId && body['shiftId'] && body['shiftId'] !== opts.shiftId) body['shiftId'] = opts.shiftId
  const tried = { ...entry, body, attempts: (entry.attempts ?? 0) + 1, lastTriedAt: Date.now() }
  try {
    await api.post<unknown>('/pos/orders', body)
  } catch (e) {
    if (isNetworkFailure(e)) {
      await putQueued({ ...tried, attempts: entry.attempts ?? 0 })
      return 'offline'
    }
    if (isRefusal(e)) {
      await putQueued({ ...tried, state: 'refused', error: { status: e.status, code: e.code, message: e.message || `Refused (${e.status})` } })
      return 'refused'
    }
    const err = e instanceof ApiError
      ? { status: e.status, code: e.code, message: e.message || `Server error (${e.status})` }
      : { status: 0, code: 'UNKNOWN', message: e instanceof Error ? e.message : 'Could not send' }
    await putQueued({ ...tried, state: 'waiting', error: err })
    return 'waiting'
  }
  await deleteQueued(entry.localId)
  return 'sent'
}

let replaying: Promise<{ sent: number; refused: number }> | null = null

/**
 * Send every WAITING entry the signed-in login rang (or that has no login on it),
 * oldest first. Stops at the first lost connection. One replay at a time per tab,
 * and per device where the browser has Web Locks (the idempotency key covers the rest).
 */
export function replayQueue(): Promise<{ sent: number; refused: number }> {
  if (replaying) return replaying
  const work = async () => {
    let sent = 0, refused = 0
    const me = useAuthStore.getState().user?.id ?? null
    if (!me) return { sent, refused }
    const entries = await getQueuedOrders().catch(() => [] as OfflineOrder[])
    for (const e of entries) {
      if (e.state === 'refused') continue
      if (e.userId && e.userId !== me) continue
      const r = await replayOne(e)
      if (r === 'sent') sent++
      else if (r === 'refused') refused++
      else if (r === 'offline') break
    }
    return { sent, refused }
  }
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: { request: (n: string, o: { ifAvailable: boolean }, cb: (l: unknown) => Promise<unknown>) => Promise<unknown> } }).locks
    : undefined
  const p = (locks
    ? locks.request('servd-offline-replay', { ifAvailable: true }, async (lock) => (lock ? work() : { sent: 0, refused: 0 })) as unknown as Promise<{ sent: number; refused: number }>
    : work())
  replaying = p.finally(() => { replaying = null })
  return replaying
}

/** A manager discarded the entry on the till. Recorded nowhere on the server. */
export async function discardQueued(localId: string): Promise<void> {
  await deleteQueued(localId)
}

/** The service worker asks the page to replay (Background Sync / its own wake-up). */
export function listenForReplayRequests(cb: () => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'REPLAY_OFFLINE_QUEUE') cb()
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}

/** Ask the browser to wake the page when the connection is back (Background Sync, where supported). */
export function requestSync(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof window === 'undefined' || !('SyncManager' in window)) return
  navigator.serviceWorker.ready.then((reg) => {
    ;(reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } })
      .sync?.register('pos-order-sync')
      .catch(() => {})
  }).catch(() => {})
}
