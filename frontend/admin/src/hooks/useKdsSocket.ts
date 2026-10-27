'use client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

// ── The new-order chime ──────────────────────────────────────────────────────
// ONE AudioContext for the whole page (a fresh one per order was never closed
// and Chrome caps live contexts). Browsers start it suspended until a tap, so a
// wall-mounted tablet nobody has touched is silent: the first pointerdown /
// keydown resumes it, and `useKdsAudioState` lets the header say so while it
// is still blocked (UX audit ERP-FOH-12).
export type KdsAudioState = 'running' | 'suspended' | 'unsupported'

let sharedCtx: AudioContext | null = null
let gestureBound = false
const audioListeners = new Set<() => void>()
const notifyAudio = () => audioListeners.forEach((l) => l())

function audioCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null
}

function getAudioContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx
  const Ctx = audioCtor()
  if (!Ctx) return null
  try {
    sharedCtx = new Ctx()
    sharedCtx.onstatechange = notifyAudio
  } catch { sharedCtx = null }
  return sharedCtx
}

/** Resume the shared context — call from a tap (the header's banner does). */
export function enableKdsSound() {
  const ctx = getAudioContext()
  if (ctx && ctx.state === 'suspended') void ctx.resume().then(notifyAudio).catch(() => { /* still blocked */ })
}

function bindGestureResume() {
  if (gestureBound || typeof window === 'undefined') return
  gestureBound = true
  const onGesture = () => {
    enableKdsSound()
    if (sharedCtx?.state === 'running') {
      window.removeEventListener('pointerdown', onGesture, true)
      window.removeEventListener('keydown', onGesture, true)
      gestureBound = false
    }
  }
  window.addEventListener('pointerdown', onGesture, true)
  window.addEventListener('keydown', onGesture, true)
}

function audioSnapshot(): KdsAudioState {
  if (!audioCtor()) return 'unsupported'
  return sharedCtx?.state === 'running' ? 'running' : 'suspended'
}

/** Whether the chime can play right now; mounts the first-tap resume. */
export function useKdsAudioState(): KdsAudioState {
  useEffect(() => { getAudioContext(); bindGestureResume(); notifyAudio() }, [])
  return useSyncExternalStore(
    (cb) => { audioListeners.add(cb); return () => { audioListeners.delete(cb) } },
    audioSnapshot,
    () => 'suspended' as KdsAudioState,
  )
}

// Louder, longer 4-tone alert chime designed to cut through kitchen noise.
// Two repeats of an ascending C-E-G-C arpeggio at 0.7 gain.
export function playNewOrderBeep() {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* blocked until a tap */ })
    const t0 = ctx.currentTime
    const beep = (start: number, freq: number, dur: number, gainPeak = 0.5) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'square'        // square = punchier, more "kitchen alarm"
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(gainPeak, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
      osc.start(start); osc.stop(start + dur + 0.05)
    }
    // Pattern: C5-E5-G5-C6, twice
    const pattern = [523, 659, 784, 1047]
    for (let rep = 0; rep < 2; rep++) {
      pattern.forEach((f, i) => beep(t0 + rep * 0.85 + i * 0.18, f, 0.16))
    }
  } catch { /* no audio context in non-browser envs */ }
}

import { getSocket } from '../lib/socket'
import { useKdsStore } from '../store/kds'
import { ordersApi, type Order } from '../lib/api'

interface UseKdsSocketOptions {
  stationId?: string
  conceptId?: string
  role?: string
  /** Owner 2026-10-27: "kitchen chime is ok, but expo only" — station screens pass false. */
  chime?: boolean
}

export interface KdsSocketState {
  connected: boolean                                      // is the socket currently open?
  lastOrderAt: Date | null                                // when did the last `order:new` arrive?
}

export function useKdsSocket(options: UseKdsSocketOptions = {}): KdsSocketState {
  const { addOrder, updateOrderStatus, updateItemStatus, mark86d, unmark86d, triggerNewOrderPulse } = useKdsStore()

  // F05: surface live connection state to the KDS header. The header shows a
  // green/red dot + the time of the last received order so a station can tell
  // in two seconds whether the socket dropped (vs. just a quiet 5-minute lull).
  // We also mirror these into the kds store so the header (which doesn't call
  // this hook itself) can read them without prop-drilling.
  useKdsAudioState() // mounts the first-tap resume for the chime
  const [connected, setConnected] = useState(false)
  const [lastOrderAt, setLastOrderAt] = useState<Date | null>(null)
  const setWsConnected   = useKdsStore((s) => s.setWsConnected)
  const setStoreLastOrder = useKdsStore((s) => s.setLastOrderAt)

  // Store actions get fresh references on every parent re-render. If we used
  // them directly inside `useEffect` deps, the effect would tear-down + re-attach
  // every render — and `socket.off('event')` only removes listeners registered
  // in *this* render, leaking the previous ones. Stash handlers behind a ref
  // and read the live store actions from inside the listeners. Effect runs once.
  const handlersRef = useRef({ addOrder, updateOrderStatus, updateItemStatus, mark86d, unmark86d, triggerNewOrderPulse })
  handlersRef.current = { addOrder, updateOrderStatus, updateItemStatus, mark86d, unmark86d, triggerNewOrderPulse }

  useEffect(() => {
    const socket = getSocket(options)

    setConnected(socket.connected)
    setWsConnected(socket.connected)

    const onConnect    = () => { setConnected(true); setWsConnected(true) }
    const onDisconnect = () => { setConnected(false); setWsConnected(false) }
    const onReconnectAttempt = () => { setConnected(false); setWsConnected(false) }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.io.on('reconnect_attempt', onReconnectAttempt)

    const onOrderNew = async (data: { orderId: string }) => {
      const now = new Date()
      setLastOrderAt(now)
      setStoreLastOrder(now)
      // Sound + visual flash, both gated by user prefs (read live from store)
      const { soundEnabled } = useKdsStore.getState()
      if (soundEnabled && options.chime !== false) playNewOrderBeep()
      handlersRef.current.triggerNewOrderPulse()
      try {
        const order = await ordersApi.get(data.orderId)
        handlersRef.current.addOrder(order)
      } catch (err) {
        console.error('Failed to fetch new order', err)
      }
    }
    const onOrderUpdated = (data: { orderId: string; status: string }) => {
      handlersRef.current.updateOrderStatus(data.orderId, data.status)
    }
    const onItemUpdated = (data: { itemId: string; status: string }) => {
      handlersRef.current.updateItemStatus(data.itemId, data.status)
    }
    const on86d = (data: { menuItemId: string; isAvailable: boolean }) => {
      if (data.isAvailable) handlersRef.current.unmark86d(data.menuItemId)
      else handlersRef.current.mark86d(data.menuItemId)
    }

    socket.on('order:new', onOrderNew)
    socket.on('order:updated', onOrderUpdated)
    socket.on('item:updated', onItemUpdated)
    socket.on('item:86d', on86d)

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.io.off('reconnect_attempt', onReconnectAttempt)
      socket.off('order:new', onOrderNew)
      socket.off('order:updated', onOrderUpdated)
      socket.off('item:updated', onItemUpdated)
      socket.off('item:86d', on86d)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.stationId, options.conceptId, options.role])

  return { connected, lastOrderAt }
}

export function useKdsActions() {
  const socket = getSocket()

  return {
    bump: (itemId: string) => {
      socket.emit('kds:bump', { itemId })
      return ordersApi.updateItemStatus(itemId, 'bumped')
    },
    hold: (itemId: string) => {
      socket.emit('kds:hold', { itemId })
      return ordersApi.updateItemStatus(itemId, 'held')
    },
    recall: (itemId: string) => {
      socket.emit('kds:recall', { itemId })
      return ordersApi.updateItemStatus(itemId, 'recalled')
    },
    fire: (itemId: string) => ordersApi.updateItemStatus(itemId, 'preparing'),
  }
}
