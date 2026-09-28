'use client'

// Driver-agnostic live-updates client. The backend decides, per
// GET /auth/realtime-token, whether this session should speak Supabase
// Realtime (private broadcast channels) or fall back to the existing
// socket.io transport — see CLAUDE.md-adjacent contract in the task that
// produced this file. Callers (hooks, pages) never branch on the driver:
// they call `getRealtime(opts).on(event, cb)` / `.onStatus(cb)` and get the
// same event names + payload shapes either way.
//
// Both drivers converge on the same internal shape: a per-instance
// `Map<event, Set<callback>>` fed by exactly one wildcard subscription per
// underlying transport (socket.io's `onAny`, Supabase's
// `.on('broadcast', { event: '*' }, ...)`), so `on()` never has to know
// whether the transport is ready yet — it just registers into the map and
// the next matching broadcast finds it.

import {
  createClient,
  REALTIME_SUBSCRIBE_STATES,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js'
import type { Socket } from 'socket.io-client'
import { getSocket, disconnectSocket } from './socket'
import { authApi, type RealtimeTokenResponse } from './api'
import { useAuthStore } from '../store/auth'

export interface RealtimeHandle {
  /** Subscribe to a named event (e.g. 'order:new'). Returns an unsubscribe fn. */
  on(event: string, cb: (payload: any) => void): () => void
  /** Subscribe to connect/disconnect transitions. Fires once immediately with the current state. */
  onStatus(cb: (connected: boolean) => void): () => void
  readonly connected: boolean
}

interface RealtimeOpts {
  stationId?: string
  conceptId?: string
}

// Refresh the realtime token this long before it expires (server issues
// tokens valid ~55 min).
const REFRESH_MARGIN_MS = 2 * 60 * 1000
const MIN_REFRESH_DELAY_MS = 5_000
// Backoff before retrying a failed token fetch, so a transient API blip
// doesn't permanently strand the client with no live updates.
const FETCH_RETRY_DELAY_MS = 5_000
// Fallback refresh interval when the server sends no usable `expiresAt`
// (e.g. the socket.io branch, which mints no short-lived credential and may
// send null) — matches the documented ~55 min token TTL, refreshed a couple
// of minutes early. Without this fallback, `new Date(null)` → epoch 0 would
// make scheduleRefresh() re-fetch every few seconds forever.
const DEFAULT_REFRESH_DELAY_MS = 53 * 60 * 1000

function keyFor(opts: RealtimeOpts): string {
  return JSON.stringify({ stationId: opts.stationId ?? null, conceptId: opts.conceptId ?? null })
}

class RealtimeInstance {
  private opts: RealtimeOpts
  driver: 'supabase' | 'socketio' | null = null

  // socket.io driver state
  private socket: Socket | null = null

  // supabase driver state
  private supabaseClient: SupabaseClient | null = null
  private channelsByTopic = new Map<string, RealtimeChannel>()
  private channelSubscribed = new Map<string, boolean>()
  private currentToken: string | null = null

  // shared
  private eventListeners = new Map<string, Set<(payload: any) => void>>()
  private statusListeners = new Set<(connected: boolean) => void>()
  private _connected = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private lastAuthToken: string | null
  private unsubscribeAuthStore: () => void
  private destroyed = false

  constructor(opts: RealtimeOpts) {
    this.opts = opts
    this.lastAuthToken = useAuthStore.getState().token
    // F43-style: watch the auth store the same way lib/socket.ts does. The
    // realtime token is minted from the staff session, so a rotated access
    // token (background refresh) invalidates it — fetch a brand new realtime
    // token rather than trying to patch the old one in place.
    this.unsubscribeAuthStore = useAuthStore.subscribe((state) => {
      if (state.token !== this.lastAuthToken) {
        this.lastAuthToken = state.token
        void this.fetchAndConnect()
      }
    })
    void this.fetchAndConnect()
  }

  get connected(): boolean {
    return this._connected
  }

  on(event: string, cb: (payload: any) => void): () => void {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    set.add(cb)
    return () => {
      this.eventListeners.get(event)?.delete(cb)
    }
  }

  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusListeners.add(cb)
    cb(this._connected)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.unsubscribeAuthStore()

    if (this.socket) {
      this.socket.offAny(this.onSocketAny)
      this.socket.off('connect', this.onSocketConnect)
      this.socket.off('disconnect', this.onSocketDisconnect)
      this.socket.io.off('reconnect_attempt', this.onSocketDisconnect)
      this.socket = null
    }

    if (this.supabaseClient) {
      for (const channel of this.channelsByTopic.values()) {
        void this.supabaseClient.removeChannel(channel)
      }
      this.channelsByTopic.clear()
      this.channelSubscribed.clear()
      this.supabaseClient = null
    }

    this.eventListeners.clear()
    this.statusListeners.clear()
  }

  // ─── internals ────────────────────────────────────────────────────────

  private dispatch(event: string, payload: any): void {
    const cbs = this.eventListeners.get(event)
    if (!cbs || cbs.size === 0) return
    for (const cb of cbs) {
      try {
        cb(payload)
      } catch (err) {
        console.error(`[Realtime] listener for "${event}" threw`, err)
      }
    }
  }

  private notifyStatus(): void {
    for (const cb of this.statusListeners) {
      try {
        cb(this._connected)
      } catch (err) {
        console.error('[Realtime] status listener threw', err)
      }
    }
  }

  private async fetchAndConnect(): Promise<void> {
    if (this.destroyed) return
    let res: RealtimeTokenResponse
    try {
      res = await authApi.realtimeToken(this.opts)
    } catch (err) {
      console.error('[Realtime] failed to fetch realtime token, retrying', err)
      if (!this.destroyed) {
        this.refreshTimer = setTimeout(() => void this.fetchAndConnect(), FETCH_RETRY_DELAY_MS)
      }
      return
    }
    if (this.destroyed) return

    this.driver = res.driver
    if (res.driver === 'socketio') {
      this.connectSocketio()
    } else {
      this.connectSupabase(res)
    }
    this.scheduleRefresh(res.expiresAt)
  }

  private scheduleRefresh(expiresAt: string | null | undefined): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN
    const delay = Number.isFinite(expiresMs)
      ? Math.max(expiresMs - Date.now() - REFRESH_MARGIN_MS, MIN_REFRESH_DELAY_MS)
      : DEFAULT_REFRESH_DELAY_MS
    this.refreshTimer = setTimeout(() => void this.fetchAndConnect(), delay)
  }

  // ── socket.io ───────────────────────────────────────────────────────

  private onSocketAny = (event: string, ...args: any[]) => this.dispatch(event, args[0])
  private onSocketConnect = () => {
    this._connected = true
    this.notifyStatus()
  }
  private onSocketDisconnect = () => {
    this._connected = false
    this.notifyStatus()
  }

  private connectSocketio(): void {
    // A token refresh re-fetch re-enters here; the socket itself doesn't
    // need rebuilding — lib/socket.ts is already a standing singleton that
    // manages its own reconnection and auth-store-driven token refresh.
    if (this.socket) return
    const socket = getSocket(this.opts)
    this.socket = socket

    socket.on('connect', this.onSocketConnect)
    socket.on('disconnect', this.onSocketDisconnect)
    socket.io.on('reconnect_attempt', this.onSocketDisconnect)
    socket.onAny(this.onSocketAny)

    this._connected = socket.connected
    this.notifyStatus()
    console.info('[Realtime] socket.io driver active')
  }

  // ── supabase ─────────────────────────────────────────────────────────

  private recomputeSupabaseConnected(): void {
    const statuses = Array.from(this.channelSubscribed.values())
    const next = statuses.length > 0 && statuses.every(Boolean)
    if (next !== this._connected) {
      this._connected = next
      this.notifyStatus()
    }
  }

  private connectSupabase(res: RealtimeTokenResponse): void {
    this.currentToken = res.token

    if (!this.supabaseClient) {
      this.supabaseClient = createClient(res.url, res.anonKey, {
        // Never pass the JWT as a custom Authorization header — the
        // `accessToken` option is how supabase-js authenticates the
        // Realtime websocket (and keeps it current across reconnects).
        accessToken: async () => this.currentToken,
      })
      console.info('[Realtime] supabase driver active', res.topics)
    } else {
      // Refresh path: push the new token at the already-open socket
      // immediately rather than waiting for the next reconnect to pick up
      // the `accessToken` callback's return value.
      void this.supabaseClient.realtime.setAuth(this.currentToken)
    }

    const nextTopics = new Set(res.topics)

    // Drop channels for topics we're no longer granted.
    for (const [topic, channel] of Array.from(this.channelsByTopic.entries())) {
      if (nextTopics.has(topic)) continue
      void this.supabaseClient.removeChannel(channel)
      this.channelsByTopic.delete(topic)
      this.channelSubscribed.delete(topic)
    }

    // Add channels for newly granted topics.
    for (const topic of res.topics) {
      if (this.channelsByTopic.has(topic)) continue
      const channel = this.supabaseClient.channel(topic, { config: { private: true } })
      channel.on('broadcast', { event: '*' }, (msg: { event: string; payload: any }) => {
        this.dispatch(msg.event, msg.payload)
      })
      channel.subscribe((status) => {
        this.channelSubscribed.set(topic, status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED)
        if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
          console.error(`[Realtime] channel "${topic}" ${status}`)
        }
        this.recomputeSupabaseConnected()
      })
      this.channelsByTopic.set(topic, channel)
      this.channelSubscribed.set(topic, false)
    }

    this.recomputeSupabaseConnected()
  }
}

let currentKey: string | null = null
let currentInstance: RealtimeInstance | null = null
let currentHandle: RealtimeHandle | null = null

/**
 * Returns the live-updates handle for this session, keyed by `opts`. Calling
 * this with a different `stationId`/`conceptId` than the last call tears
 * down the previous transport (channels or socket wiring) and builds a new
 * one — there's exactly one live instance at a time, matching how
 * lib/socket.ts's own singleton has always behaved. Pass the same opts (or
 * call with no args) from every consumer active on the same screen.
 */
export function getRealtime(opts: RealtimeOpts = {}): RealtimeHandle {
  const key = keyFor(opts)
  if (currentInstance && currentKey === key) {
    return currentHandle as RealtimeHandle
  }

  currentInstance?.destroy()
  const instance = new RealtimeInstance(opts)
  currentInstance = instance
  currentKey = key
  currentHandle = {
    on: (event, cb) => instance.on(event, cb),
    onStatus: (cb) => instance.onStatus(cb),
    get connected() {
      return instance.connected
    },
  }
  return currentHandle
}

/** Full teardown — call on logout. Also drops the shared socket.io singleton. */
export function disconnectRealtime(): void {
  const wasSocketio = currentInstance?.driver === 'socketio'
  currentInstance?.destroy()
  if (wasSocketio) disconnectSocket()
  currentInstance = null
  currentKey = null
  currentHandle = null
}
