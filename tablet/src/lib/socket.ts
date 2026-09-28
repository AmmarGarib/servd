// Socket.IO client singleton + room helpers.
//
// This is now the FALLBACK transport: `../lib/realtime.ts` asks the backend
// (`GET /auth/realtime-token`) which driver to use, and when it says
// `socketio` it wraps the singleton exported from this file. When it says
// `supabase`, realtime.ts talks to Supabase Realtime directly and this file
// isn't touched at all. Screens should subscribe via
// `useRealtimeEvent`/`getRealtime` in realtime.ts, not the exports here —
// `useSocketEvent` below is kept only as a thin, drop-in-compatible wrapper
// so existing screens keep compiling.
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
// (Per the realtime-token contract, the server now auto-joins rooms by role
// from the token request, so these explicit join/leave emits are belt-and-
// suspenders — harmless if the server ignores them.)

import Constants from 'expo-constants'
import { io, Socket } from 'socket.io-client'
import { sessionStore } from '../store/session'
import { useRealtimeEvent } from './realtime'

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
 * @deprecated Thin wrapper over `useRealtimeEvent` (see realtime.ts) kept so
 * screens written against the old socket.io-only API keep compiling. New
 * code should call `useRealtimeEvent` directly. `options.room` is mapped to
 * `stationId`/`conceptId` scope — only `station:{id}` and `concept:{id}`
 * rooms carry meaning under the new driver-agnostic contract; anything else
 * (e.g. `reservations:all`) is just the default scope, already covered.
 */
export function useSocketEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
  options: { room?: string } = {},
) {
  const stationId = options.room?.startsWith('station:')
    ? options.room.slice('station:'.length)
    : undefined
  const conceptId = options.room?.startsWith('concept:')
    ? options.room.slice('concept:'.length)
    : undefined
  useRealtimeEvent<T>(event, handler, { stationId, conceptId })
}
