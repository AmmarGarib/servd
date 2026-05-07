'use client'
import { io, type Socket } from 'socket.io-client'

const WS_URL = process.env['NEXT_PUBLIC_WS_URL'] ?? 'http://localhost:3001'

let socket: Socket | null = null

export function getSocket(opts?: { stationId?: string; conceptId?: string; role?: string }): Socket {
  if (!socket) {
    const token = typeof window !== 'undefined' ? localStorage.getItem('servd_token') : null

    socket = io(WS_URL, {
      auth: { token, ...opts },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    })

    socket.on('connect', () => console.info('[WS] Connected'))
    socket.on('disconnect', (reason) => console.warn('[WS] Disconnected:', reason))
    socket.on('connect_error', (err) => console.error('[WS] Connect error:', err.message))
  }

  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
