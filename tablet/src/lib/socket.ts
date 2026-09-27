// Socket.IO client singleton + room helpers. The tablet is highly real-time
// (KDS tickets, curbside arrivals, reservation state) so a persistent socket
// makes more sense than polling. We surface a thin `useSocketEvent` hook for
// screens to subscribe ergonomically.
//
// Rooms the backend emits to (see backend/src/lib/ws.ts):
//   - tenant:{id}:orders   (every order of the signed-in company — the server
//                           joins us on connect; there is no cross-company room)
//   - station:{id}         (single KDS station)
//   - concept:{id}         (single brand)
//   - reservations:all     (every reservation across all brands)
//
// We join `reservations:all` automatically on connect, then per-station /
// per-concept rooms are joined imperatively by the screen that needs them.

import Constants from 'expo-constants'
import { io, Socket } from 'socket.io-client'
import { useEffect, useRef } from 'react'
import { sessionStore } from '../store/session'

const WS_URL = (Constants.expoConfig?.extra?.wsUrl as string | undefined)
  ?? (Constants.expoConfig?.extra?.apiUrl as string | undefined)
  ?? 'http://10.0.2.2:4000'

let socket: Socket | null = null
const joinedRooms = new Set<string>()

export function getSocket(): Socket {
  if (socket) return socket
  socket = io(WS_URL, {
    transports:   ['websocket'],
    reconnection: true,
    reconnectionDelay:    1_000,
    reconnectionDelayMax: 10_000,
    auth: (cb) => cb({ token: sessionStore.getState().token ?? '' }),
  })
  socket.on('connect', () => {
    // Re-join all rooms we asked for. Server is dumb about reconnects.
    socket?.emit('join', 'reservations:all')
    for (const room of joinedRooms) socket?.emit('join', room)
  })
  return socket
}

export function joinRoom(room: string) {
  joinedRooms.add(room)
  getSocket().emit('join', room)
}

export function leaveRoom(room: string) {
  joinedRooms.delete(room)
  getSocket().emit('leave', room)
}

/**
 * Hook for subscribing to a socket event. Cleans up on unmount. If you pass
 * a `room`, the client joins on mount and leaves on unmount.
 */
export function useSocketEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
  options: { room?: string } = {},
) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const sock = getSocket()
    const cb   = (p: T) => handlerRef.current(p)
    if (options.room) joinRoom(options.room)
    sock.on(event, cb)
    return () => {
      sock.off(event, cb)
      if (options.room) leaveRoom(options.room)
    }
  }, [event, options.room])
}
