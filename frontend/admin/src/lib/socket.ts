'use client'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore } from '../store/auth'

const WS_URL = process.env['NEXT_PUBLIC_WS_URL'] ?? 'http://localhost:3001'

let socket: Socket | null = null
let lastToken: string | null = null

/**
 * F43: read the JWT from the auth store on every call (and on every reconnect)
 * so a refresh-token rotation propagates without a page reload. We also
 * subscribe to store changes — when the token swaps, the socket reconnects
 * with the new credentials.
 */
export function getSocket(opts?: { stationId?: string; conceptId?: string; role?: string }): Socket {
  if (!socket) {
    const token = useAuthStore.getState().token
    lastToken = token
    socket = io(WS_URL, {
      // withCredentials sends the httpOnly cookie at the handshake; token is
      // still passed when present (fresh login), and the server falls back to
      // the cookie after a reload when there's no in-memory token.
      withCredentials: true,
      auth: (cb) => cb({ token: useAuthStore.getState().token, ...opts }),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    })

    socket.on('connect', () => console.info('[WS] Connected'))
    socket.on('disconnect', (reason) => console.warn('[WS] Disconnected:', reason))
    socket.on('connect_error', (err) => console.error('[WS] Connect error:', err.message))

    // Watch the auth store for token changes. When the access token rotates
    // (background refresh) we kick the socket so it picks up the new value on
    // the next handshake.
    useAuthStore.subscribe((state) => {
      if (state.token !== lastToken) {
        lastToken = state.token
        socket?.disconnect()
        socket?.connect()
      }
    })
  }
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}

/**
 * The bell's live ping (server: emitToUser -> 'notification:new', id + kind only).
 * Returns the unsubscribe. The caller refetches; the payload carries no text.
 */
export function onNotificationNew(cb: (e: { id?: string; kind?: string }) => void): () => void {
  const s = getSocket()
  s.on('notification:new', cb)
  return () => { s.off('notification:new', cb) }
}
