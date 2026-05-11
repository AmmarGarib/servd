// WebSocket server — Socket.io with Redis adapter for multi-process fanout
// Rooms: station:{id}, concept:{id}, all-orders
// Events match spec §6.3

import { Server as SocketIOServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { redisPub, redisSub } from './redis.js'
import type { FastifyInstance } from 'fastify'
import { verifyStaffToken } from '../modules/auth/service.js'
import { prisma } from './prisma.js'

let io: SocketIOServer | null = null

export function initWebSocket(fastify: FastifyInstance): SocketIOServer {
  io = new SocketIOServer(fastify.server, {
    cors: {
      origin: [
        process.env['WEB_URL'] ?? 'http://localhost:3000',
        process.env['STOREFRONT_URL'] ?? 'http://localhost:3002',
      ],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 20000,
    pingInterval: 25000,
  })

  // Redis adapter enables multi-instance fanout — only attach if Redis is reachable.
  // Falls back to in-memory adapter (perfectly fine for single-server deployments).
  redisPub.ping()
    .then(() => {
      io!.adapter(createAdapter(redisPub, redisSub))
      fastify.log.info('WebSocket Redis adapter enabled')
    })
    .catch(() => {
      fastify.log.warn('Redis unavailable — WebSocket running in single-instance mode (in-memory adapter)')
    })

  io.on('connection', (socket) => {
    const { stationId, conceptId, token, deviceFingerprint, deviceName } = socket.handshake.auth as {
      stationId?: string
      conceptId?: string
      token?: string
      deviceFingerprint?: string  // KDS sends a stable per-browser UUID from localStorage
      deviceName?: string
    }

    // Verify JWT — disconnect unauthenticated clients
    let role: string | undefined
    if (token) {
      try {
        const payload = verifyStaffToken(token)
        role = payload.role
      } catch {
        socket.disconnect(true)
        return
      }
    }

    // KDS device auto-registration. If a fingerprint is supplied (only the KDS
    // client sends it), upsert a KdsDevice row keyed on fingerprint. Heartbeat
    // updates lastSeenAt every 30s while the connection is alive so the device
    // registry shows a live "last seen" stamp.
    let heartbeatHandle: NodeJS.Timeout | null = null
    if (deviceFingerprint) {
      const ipAddress = socket.handshake.address
      void (async () => {
        try {
          await prisma.kdsDevice.upsert({
            where: { deviceFingerprint },
            create: {
              deviceFingerprint,
              name: deviceName ?? `KDS ${deviceFingerprint.slice(0, 8)}`,
              stationId: stationId ?? null,
              conceptId: conceptId ?? null,
              ipAddress,
              lastSeenAt: new Date(),
            },
            update: {
              lastSeenAt: new Date(),
              ipAddress,
              ...(stationId && { stationId }),
              ...(conceptId && { conceptId }),
            },
          })
          heartbeatHandle = setInterval(() => {
            prisma.kdsDevice.update({
              where: { deviceFingerprint },
              data: { lastSeenAt: new Date() },
            }).catch(() => {})
          }, 30_000)
        } catch (err) {
          fastify.log.warn(`[kds-device] auto-register failed: ${(err as Error).message}`)
        }
      })()
    }

    // Join appropriate rooms
    if (stationId) void socket.join(`station:${stationId}`)
    if (conceptId) void socket.join(`concept:${conceptId}`)
    if (role === 'expediter' || role === 'admin' || role === 'manager') {
      void socket.join('all-orders')
    }
    // Reservation events go to managers, admins, cashiers (the host stand)
    // and kitchen/expediter (so the kitchen tracker page updates in real time).
    if (role === 'admin' || role === 'manager' || role === 'cashier' || role === 'expediter' || role === 'kitchen') {
      void socket.join('reservations:all')
    }

    // Allow clients to opt-into a specific reservation room from the page
    // they're on (e.g. the admin reservation editor wants `concept:{id}`).
    socket.on('reservations:join', (data: { conceptId?: string }) => {
      if (data?.conceptId) void socket.join(`concept:${data.conceptId}`)
    })

    // Client → Server events (KDS interactions)
    socket.on('kds:bump', (data: { itemId: string }) => {
      // Handled in orders module; socket just receives it
      socket.to('all-orders').emit('kds:bump', data)
    })

    socket.on('kds:hold', (data: { itemId: string }) => {
      socket.to('all-orders').emit('kds:hold', data)
    })

    socket.on('kds:recall', (data: { itemId: string }) => {
      socket.to('all-orders').emit('kds:recall', data)
    })

    socket.on('disconnect', (reason) => {
      if (heartbeatHandle) clearInterval(heartbeatHandle)
      fastify.log.info({ socketId: socket.id, reason }, 'WebSocket client disconnected')
    })
  })

  fastify.log.info('WebSocket server initialised')
  return io
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error('WebSocket server not initialised')
  return io
}

// Returns the IO instance if available, otherwise null. Use this in code paths
// that may run before initWebSocket() (smoke tests, scripts, hot-reload edge
// cases) — never let a missing socket take down an order.
function getIOSafe(): SocketIOServer | null {
  return io
}

// ─── Event emitters (called from order/menu modules) ──────────────────────────
//
// All emitters are best-effort: if the WS server isn't up yet (or Redis adapter
// has a transient failure), we log and continue. An order must never fail
// because we couldn't broadcast to the KDS — clients will catch up via the
// 30-second polling fallback.

function safeEmit(label: string, fn: (ws: SocketIOServer) => void) {
  const ws = getIOSafe()
  if (!ws) {
    // Visible log so missing WS in prod isn't silent — but no throw
    console.warn(`[ws] ${label} skipped — WebSocket server not initialised`)
    return
  }
  try {
    fn(ws)
  } catch (err) {
    console.error(`[ws] ${label} failed:`, (err as Error).message)
  }
}

export function emitOrderNew(order: {
  orderId: string
  conceptId: string
  source: string
  stationIds: string[]
  placedAt: string
}) {
  safeEmit('emitOrderNew', (ws) => {
    ws.to('all-orders').emit('order:new', order)
    for (const stationId of order.stationIds) {
      ws.to(`station:${stationId}`).emit('order:new', order)
    }
    ws.to(`concept:${order.conceptId}`).emit('order:new', order)
  })
}

export function emitOrderUpdated(orderId: string, status: string) {
  safeEmit('emitOrderUpdated', (ws) => {
    ws.to('all-orders').emit('order:updated', { orderId, status })
  })
}

export function emitItemUpdated(itemId: string, status: string, stationId: string | null) {
  safeEmit('emitItemUpdated', (ws) => {
    if (stationId) ws.to(`station:${stationId}`).emit('item:updated', { itemId, status, stationId })
    ws.to('all-orders').emit('item:updated', { itemId, status, stationId })
  })
}

export function emitItem86d(menuItemId: string, conceptId: string, isAvailable: boolean) {
  safeEmit('emitItem86d', (ws) => {
    ws.to(`concept:${conceptId}`).emit('item:86d', { menuItemId, conceptId, isAvailable })
    ws.to('all-orders').emit('item:86d', { menuItemId, conceptId, isAvailable })
  })
}

// Broadcast live availability changes to all storefront clients
export function emitAvailabilityChange(menuItemId: string, available: number) {
  if (!io) {
    console.warn('[ws] emitAvailabilityChange called before WebSocket server initialised — skipping')
    return
  }
  io.emit('item:availability', { menuItemId, available })
}

// ─── Reservation events ───────────────────────────────────────────────────────
//
// Fired from the reservation routes whenever a booking changes. Admin clients
// subscribe via the `reservations:all` room (joined automatically for staff
// roles) plus the per-concept room `concept:{id}` if they specified one.
//
// Payload is intentionally minimal — clients refetch the list on receipt
// instead of trying to merge incremental updates locally. That keeps the
// event volume tiny and the client logic dumb.

export type ReservationEvent =
  | 'reservation:created'
  | 'reservation:updated'
  | 'reservation:cancelled'
  | 'reservation:seated'
  | 'reservation:no-show'
  | 'reservation:confirmed'
  | 'reservation:waitlist-promoted'

export function emitReservationEvent(
  event: ReservationEvent,
  payload: { reservationId: string; conceptId: string; startTime?: string; status?: string },
) {
  safeEmit(event, (ws) => {
    ws.to('reservations:all').emit(event, payload)
    ws.to(`concept:${payload.conceptId}`).emit(event, payload)
  })
}
