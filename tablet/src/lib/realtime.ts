// Realtime transport for the tablet — the backend picks the driver per
// request via `GET /auth/realtime-token` and we obey: `supabase` uses
// private Supabase Realtime broadcast channels, `socketio` falls back to
// the existing socket.io singleton in `./socket.ts`. Screens don't know or
// care which one is live — they subscribe through `useRealtimeEvent` /
// `getRealtime()` and get the same event stream either way.
//
// react-native-url-polyfill: supabase-js (via realtime-js/postgrest-js)
// constructs `URL` and `URLSearchParams` instances for its websocket and
// REST endpoints. Hermes on React Native only partially implements the
// `URL` global (notably `URLSearchParams` iteration and relative-URL
// resolution are known gaps on some RN/Hermes builds), and Supabase's own
// React Native guidance is to install this polyfill unconditionally rather
// than special-case engine versions. Importing it here, once, at the top of
// the one module that touches supabase-js, is cheap and side-effect-free if
// the engine already has a complete implementation.
import 'react-native-url-polyfill/auto'

import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native'
import {
  createClient,
  REALTIME_SUBSCRIBE_STATES,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js'

import { api } from './api'
import { sessionStore } from '../store/session'
import { getSocket } from './socket'
import type { Socket } from 'socket.io-client'

// ─── Public API ──────────────────────────────────────────────────────────

export interface RealtimeHandle {
  on(event: string, cb: (payload: any) => void): () => void
  onStatus(cb: (connected: boolean) => void): () => void
  readonly connected: boolean
}

export interface RealtimeScope {
  stationId?: string
  conceptId?: string
}

export function getRealtime(opts?: RealtimeScope): RealtimeHandle {
  if (!singleton) singleton = new RealtimeManager()
  singleton.configure(opts)
  return singleton
}

export function disconnectRealtime(): void {
  if (!singleton) return
  const mgr = singleton
  singleton = null
  void mgr.destroy()
}

/**
 * Subscribe to a realtime event. Replaces `useSocketEvent` — same shape,
 * driver-agnostic. `opts.stationId` / `opts.conceptId` widen the token scope
 * (and, for the supabase driver, which channels get joined); omit both for
 * the default company-wide scope (`tenant:{id}:orders`, `all-orders`, etc).
 */
export function useRealtimeEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
  opts?: RealtimeScope,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const handle = getRealtime(opts)
    const off = handle.on(event, (payload: T) => handlerRef.current(payload))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, opts?.stationId, opts?.conceptId])
}

// ─── Token contract (backend: GET /auth/realtime-token) ────────────────────

interface RealtimeTokenResponse {
  driver: 'supabase' | 'socketio'
  url: string
  anonKey: string
  token: string
  topics: string[]
  expiresAt: string // ISO, ~55 min out
}

const REFRESH_MARGIN_MS = 2 * 60_000 // refresh ~2 min before expiry, per spec
const RETRY_DELAY_MS = 10_000
const REFRESH_RETRY_DELAY_MS = 30_000
const DEFAULT_REFRESH_DELAY_MS = 50 * 60_000 // fallback if expiresAt is unparseable

let singleton: RealtimeManager | null = null

// ─── Manager ─────────────────────────────────────────────────────────────
//
// One connection for the whole app (mirrors the old socket.ts singleton).
// `configure()` widens the requested scope (station/concept) and (re)connects
// on first use or when the scope grows; the driver, and everything about how
// it's wired up, is decided fresh from each token response.

class RealtimeManager implements RealtimeHandle {
  private started = false
  private destroyed = false

  private stationId: string | undefined
  private conceptId: string | undefined

  private driver: 'supabase' | 'socketio' | null = null
  private tokenInfo: RealtimeTokenResponse | null = null
  private connectPromise: Promise<void> | null = null

  // socket.io driver
  private socket: Socket | null = null
  private readonly handleSocketConnect = () => this.setConnected(true)
  private readonly handleSocketDisconnect = () => this.setConnected(false)
  private readonly handleSocketAny = (event: string, payload: any) => this.dispatch(event, payload)

  // supabase driver
  private supabase: SupabaseClient | null = null
  private supabaseUrl: string | null = null
  private channels = new Map<string, RealtimeChannel>()
  private channelSubscribed = new Map<string, boolean>()

  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  private _connected = false
  private eventHandlers = new Map<string, Set<(payload: any) => void>>()
  private statusHandlers = new Set<(connected: boolean) => void>()

  private readonly unsubscribeSession: () => void
  private readonly appStateSub: NativeEventSubscription

  constructor() {
    this.unsubscribeSession = sessionStore.subscribe((state, prev) => {
      if (state.token === prev.token) return
      if (state.token) {
        if (this.started) void this.connect()
      } else {
        void this.teardownDriver()
      }
    })
    this.appStateSub = AppState.addEventListener('change', this.handleAppStateChange)
  }

  private readonly handleAppStateChange = (next: AppStateStatus) => {
    if (next === 'active' && this.started && !this._connected) {
      void this.connect()
    }
  }

  // ─── Public: RealtimeHandle ────────────────────────────────────────────

  get connected(): boolean {
    return this._connected
  }

  on(event: string, cb: (payload: any) => void): () => void {
    let set = this.eventHandlers.get(event)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(event, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }

  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusHandlers.add(cb)
    cb(this._connected)
    return () => {
      this.statusHandlers.delete(cb)
    }
  }

  // ─── Public: lifecycle ─────────────────────────────────────────────────

  configure(opts?: RealtimeScope): void {
    let scopeGrew = false
    if (opts?.stationId && opts.stationId !== this.stationId) {
      this.stationId = opts.stationId
      scopeGrew = true
    }
    if (opts?.conceptId && opts.conceptId !== this.conceptId) {
      this.conceptId = opts.conceptId
      scopeGrew = true
    }
    if (!this.started) {
      this.started = true
      void this.connect()
    } else if (scopeGrew) {
      void this.connect()
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.started = false
    this.clearTimers()
    this.unsubscribeSession()
    this.appStateSub.remove()
    await this.teardownDriver()
    this.eventHandlers.clear()
    this.statusHandlers.clear()
  }

  // ─── Internal: dispatch ────────────────────────────────────────────────

  private dispatch(event: string, payload: any): void {
    const set = this.eventHandlers.get(event)
    if (!set || set.size === 0) return
    for (const cb of Array.from(set)) {
      try {
        cb(payload)
      } catch (err) {
        console.warn(`[realtime] handler for "${event}" threw:`, err)
      }
    }
  }

  private setConnected(v: boolean): void {
    if (this._connected === v) return
    this._connected = v
    for (const cb of Array.from(this.statusHandlers)) cb(v)
  }

  private clearTimers(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  // ─── Internal: token fetch + connect ────────────────────────────────────

  private tokenPath(): string {
    const qs = new URLSearchParams()
    if (this.stationId) qs.set('stationId', this.stationId)
    if (this.conceptId) qs.set('conceptId', this.conceptId)
    const query = qs.toString()
    return `/auth/realtime-token${query ? `?${query}` : ''}`
  }

  private connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  private async doConnect(): Promise<void> {
    if (this.destroyed) return
    if (!sessionStore.getState().token) {
      await this.teardownDriver()
      return
    }

    let res: RealtimeTokenResponse
    try {
      res = await api.get<RealtimeTokenResponse>(this.tokenPath())
    } catch (err) {
      console.warn('[realtime] token fetch failed, retrying in 10s:', (err as Error).message)
      this.scheduleRetry()
      return
    }
    if (this.destroyed) return

    this.tokenInfo = res
    this.scheduleRefresh(res.expiresAt)

    if (res.driver === 'socketio') {
      await this.connectSocketIo()
    } else {
      await this.connectSupabase(res)
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, RETRY_DELAY_MS)
  }

  private scheduleRefresh(expiresAt: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const parsed = new Date(expiresAt).getTime()
    const delay = Number.isFinite(parsed)
      ? Math.max(parsed - Date.now() - REFRESH_MARGIN_MS, 5_000)
      : DEFAULT_REFRESH_DELAY_MS
    this.refreshTimer = setTimeout(() => {
      void this.refresh()
    }, delay)
  }

  private async refresh(): Promise<void> {
    if (this.destroyed || !sessionStore.getState().token) return
    let res: RealtimeTokenResponse
    try {
      res = await api.get<RealtimeTokenResponse>(this.tokenPath())
    } catch (err) {
      console.warn('[realtime] token refresh failed, retrying in 30s:', (err as Error).message)
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_RETRY_DELAY_MS)
      return
    }
    if (this.destroyed) return

    this.tokenInfo = res
    this.scheduleRefresh(res.expiresAt)

    if (res.driver !== this.driver) {
      // Backend flipped the driver under us — full reconnect.
      await this.teardownDriver()
      if (res.driver === 'socketio') await this.connectSocketIo()
      else await this.connectSupabase(res)
      return
    }

    if (res.driver === 'supabase' && this.supabase) {
      // Same client, same channels — just re-arm auth. Per spec, no need to
      // recreate anything for a same-scope refresh.
      await this.supabase.realtime.setAuth(res.token)
      // Topics can still change (e.g. a concept was re-assigned) — reconcile.
      await this.reconcileSupabaseChannels(res.topics)
    }
    // socketio: nothing to do — the singleton re-authenticates on its own
    // reconnects by reading the current staff token straight from the
    // session store (see socket.ts).
  }

  // ─── Internal: socket.io driver ─────────────────────────────────────────

  private async connectSocketIo(): Promise<void> {
    if (this.driver === 'socketio' && this.socket) {
      this.setConnected(this.socket.connected)
      return
    }
    await this.teardownDriver()
    this.driver = 'socketio'
    const sock = getSocket()
    this.socket = sock
    sock.on('connect', this.handleSocketConnect)
    sock.on('disconnect', this.handleSocketDisconnect)
    sock.onAny(this.handleSocketAny)
    this.setConnected(sock.connected)
  }

  // ─── Internal: supabase driver ──────────────────────────────────────────

  private async connectSupabase(res: RealtimeTokenResponse): Promise<void> {
    const reuseClient = this.driver === 'supabase' && this.supabase && this.supabaseUrl === res.url
    if (!reuseClient) {
      await this.teardownDriver()
      this.driver = 'supabase'
      this.supabaseUrl = res.url
      this.supabase = createClient(res.url, res.anonKey, {
        accessToken: async () => this.tokenInfo?.token ?? res.token,
      })
    }
    await this.reconcileSupabaseChannels(res.topics)
  }

  /** Joins channels for topics we don't have yet, leaves ones we no longer need. */
  private async reconcileSupabaseChannels(topics: string[]): Promise<void> {
    if (!this.supabase) return
    const client = this.supabase
    const desired = new Set(topics)

    for (const [topic, channel] of Array.from(this.channels.entries())) {
      if (desired.has(topic)) continue
      try {
        await client.removeChannel(channel)
      } catch (err) {
        console.warn(`[realtime] failed to remove channel "${topic}":`, err)
      }
      this.channels.delete(topic)
      this.channelSubscribed.delete(topic)
    }

    for (const topic of topics) {
      if (this.channels.has(topic)) continue
      const channel = client.channel(topic, { config: { private: true } })
      channel.on('broadcast', { event: '*' }, (msg) => {
        this.dispatch(msg.event, msg.payload)
      })
      channel.subscribe((status) => {
        this.channelSubscribed.set(topic, status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED)
        this.recomputeSupabaseConnected()
      })
      this.channels.set(topic, channel)
      this.channelSubscribed.set(topic, false)
    }

    this.recomputeSupabaseConnected()
  }

  private recomputeSupabaseConnected(): void {
    if (this.channels.size === 0) {
      this.setConnected(false)
      return
    }
    let allSubscribed = true
    for (const subscribed of this.channelSubscribed.values()) {
      if (!subscribed) {
        allSubscribed = false
        break
      }
    }
    this.setConnected(allSubscribed)
  }

  // ─── Internal: teardown ──────────────────────────────────────────────────

  private async teardownDriver(): Promise<void> {
    if (this.socket) {
      this.socket.off('connect', this.handleSocketConnect)
      this.socket.off('disconnect', this.handleSocketDisconnect)
      this.socket.offAny(this.handleSocketAny)
      this.socket = null
    }
    if (this.supabase) {
      const client = this.supabase
      for (const channel of this.channels.values()) {
        try {
          await client.removeChannel(channel)
        } catch {
          // best-effort — channel may already be gone
        }
      }
      this.channels.clear()
      this.channelSubscribed.clear()
      this.supabase = null
      this.supabaseUrl = null
    }
    this.driver = null
    this.setConnected(false)
  }
}
