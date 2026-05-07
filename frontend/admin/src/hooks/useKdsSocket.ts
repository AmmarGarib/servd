'use client'
import { useEffect, useRef } from 'react'

// Louder, longer 4-tone alert chime designed to cut through kitchen noise.
// Two repeats of an ascending C-E-G-C arpeggio at 0.7 gain.
function playNewOrderBeep() {
  try {
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    const ctx = new Ctx()
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
}

export function useKdsSocket(options: UseKdsSocketOptions = {}) {
  const { addOrder, updateOrderStatus, updateItemStatus, mark86d, unmark86d, triggerNewOrderPulse } = useKdsStore()

  // Store actions get fresh references on every parent re-render. If we used
  // them directly inside `useEffect` deps, the effect would tear-down + re-attach
  // every render — and `socket.off('event')` only removes listeners registered
  // in *this* render, leaking the previous ones. Stash handlers behind a ref
  // and read the live store actions from inside the listeners. Effect runs once.
  const handlersRef = useRef({ addOrder, updateOrderStatus, updateItemStatus, mark86d, unmark86d, triggerNewOrderPulse })
  handlersRef.current = { addOrder, updateOrderStatus, updateItemStatus, mark86d, unmark86d, triggerNewOrderPulse }

  useEffect(() => {
    const socket = getSocket(options)

    const onOrderNew = async (data: { orderId: string }) => {
      // Sound + visual flash, both gated by user prefs (read live from store)
      const { soundEnabled } = useKdsStore.getState()
      if (soundEnabled) playNewOrderBeep()
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
      socket.off('order:new', onOrderNew)
      socket.off('order:updated', onOrderUpdated)
      socket.off('item:updated', onItemUpdated)
      socket.off('item:86d', on86d)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.stationId, options.conceptId, options.role])
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
