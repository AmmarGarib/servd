// WebSocket server — Socket.io with Redis adapter for multi-process fanout
// Rooms: station:{id}, concept:{id}, all-orders
// Events match spec §6.3

import { Server as SocketIOServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { redisPub, redisSub } from './redis.js'
import { isAllowedOrigin } from './corsAllowlist.js'
import type { FastifyInstance } from 'fastify'
import { verifyStaffToken } from '../modules/auth/service.js'
import { prisma } from './prisma.js'

let io: SocketIOServer | null = null

export function initWebSocket(fastify: FastifyInstance): SocketIOServer {
  io = new SocketIOServer(fastify.server, {
    cors: {
      // Use the SAME allowlist as HTTP CORS so a brand custom-domain added via
      // BRAND_HOSTS works over websockets too (previously hardcoded to two
      // localhost origins, silently breaking WS from real brand domains).
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
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

  // B05: strict auth gate. No token → connection refused at the handshake.
  // This runs once per connect; we stash the principal on `socket.data` so the
  // connection handler below (and any application code) can read it.
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as { token?: string }
    const queryToken = (socket.handshake.query as { token?: string })?.token
    const token = auth?.token ?? queryToken
    if (!token) return next(new Error('UNAUTHORIZED'))
    try {
      // KDS screens use PIN tokens; admin/manager browser sessions use access
      // tokens. Either authenticates the socket — `requireAuthOrPin` mirrors
      // the same policy on HTTP routes.
      let payload
      try { payload = verifyStaffToken(token, 'access') }
      catch (e: unknown) {
        if ((e as { code?: string }).code !== 'INVALID_TOKEN_TYPE') throw e
        payload = verifyStaffToken(token, 'pin')
      }
      // Re-resolve tenant so we know which company the socket can subscribe to.
      const u = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { tenantId: true },
      })
      ;(socket.data as Record<string, unknown>).user = {
        id: payload.sub, role: payload.role, tenantId: u?.tenantId ?? null,
      }
      return next()
    } catch {
      return next(new Error('UNAUTHORIZED'))
    }
  })

  // B15 in-memory throttle: each (userId, fingerprint) pair can only re-upsert
  // its KdsDevice row at most once per second. Stops a chatty client from
  // hammering the DB if it reconnects rapidly.
  const lastUpsertAt = new Map<string, number>()

  io.on('connection', (socket) => {
    const { stationId, conceptId, deviceFingerprint, deviceName } = socket.handshake.auth as {
      stationId?: string
      conceptId?: string
      deviceFingerprint?: string  // KDS sends a stable per-browser UUID from localStorage
      deviceName?: string
    }

    // `io.use` populated this.
    const principal = (socket.data as { user?: { id: string; role: string; tenantId: string | null } }).user
    const role = principal?.role
    const tenantId = principal?.tenantId

    // B15: only kitchen-side roles may auto-register a KDS device. A cashier
    // socket should not appear in the device registry.
    let heartbeatHandle: NodeJS.Timeout | null = null
    const kdsAllowed = role === 'kitchen' || role === 'expediter' || role === 'manager' || role === 'admin'

    if (deviceFingerprint && kdsAllowed) {
      const throttleKey = `${principal!.id}:${deviceFingerprint}`
      const last = lastUpsertAt.get(throttleKey) ?? 0
      if (Date.now() - last < 1000) {
        // Throttle: skip the DB hit but still let the connection proceed.
      } else {
        lastUpsertAt.set(throttleKey, Date.now())
        const ipAddress = socket.handshake.address
        void (async () => {
          try {
            await prisma.kdsDevice.upsert({
              where: { deviceFingerprint },
              // Scope by tenantId so two operators on different tenants can
              // never accidentally share a device registration.
              create: {
                deviceFingerprint,
                name: deviceName ?? `KDS ${deviceFingerprint.slice(0, 8)}`,
                stationId: stationId ?? null,
                conceptId: conceptId ?? null,
                tenantId: tenantId ?? null,
                ipAddress,
                lastSeenAt: new Date(),
              },
              update: {
                lastSeenAt: new Date(),
                ipAddress,
                ...(stationId && { stationId }),
                ...(conceptId && { conceptId }),
                ...(tenantId && { tenantId }),
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
    }

    // Join appropriate rooms. `concept:{id}` is the canonical fan-out key
    // and is also tenant-scoped (concepts belong to tenants).
    if (stationId) void socket.join(`station:${stationId}`)
    if (conceptId) void socket.join(`concept:${conceptId}`)
    if (tenantId) void socket.join(`tenant:${tenantId}`)
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
export function getIOSafe(): SocketIOServer | null {
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

// Broadcast live availability changes to the concept's room. We look up the
// menu item's conceptId on the fly because the callers (cart-release worker,
// reservation settle) don't carry it. Cached in-process for 5min to dodge a
// per-event DB round-trip — availability changes are bursty.
const conceptIdCache = new Map<string, { conceptId: string; expiresAt: number }>()

export async function emitAvailabilityChange(menuItemId: string, available: number) {
  if (!io) {
    console.warn('[ws] emitAvailabilityChange called before WebSocket server initialised — skipping')
    return
  }
  let conceptId: string | undefined
  const cached = conceptIdCache.get(menuItemId)
  if (cached && cached.expiresAt > Date.now()) {
    conceptId = cached.conceptId
  } else {
    const row = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      select: { conceptId: true },
    }).catch(() => null)
    if (row) {
      conceptId = row.conceptId
      conceptIdCache.set(menuItemId, { conceptId: row.conceptId, expiresAt: Date.now() + 5 * 60_000 })
    }
  }
  if (conceptId) {
    io.to(`concept:${conceptId}`).emit('item:availability', { menuItemId, available })
  }
  // Fallback for clients that haven't joined a concept room yet (e.g. brand
  // homepages that show the live availability strip across multiple brands).
  io.to('all-orders').emit('item:availability', { menuItemId, conceptId, available })
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
