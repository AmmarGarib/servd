// WebSocket server — Socket.io with Redis adapter for multi-process fanout
// Rooms: station:{id}, concept:{id} (both ownership-checked at join),
// tenant:{id}, tenant:{id}:orders, tenant:{id}:reservations (company-wide
// fan-out), all-orders (brand-less id+status events only)
// Events match spec §6.3

import { Server as SocketIOServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { redisPub, redisSub } from './redis.js'
import { isAllowedOrigin } from './corsAllowlist.js'
import { parseCookieHeader, ACCESS_COOKIE } from './cookies.js'
import type { FastifyInstance } from 'fastify'
import { verifyStaffToken } from '../modules/auth/service.js'
import { prisma } from './prisma.js'

let io: SocketIOServer | null = null

interface SocketPrincipal {
  id: string
  role: string
  tenantId: string | null
  /** Every company the user belongs to (primary + memberships). */
  tenantIds: string[]
}

// concept → tenant lookups are hot (every order/reservation event) and
// brands never move between companies in practice, so cache for 5 minutes.
const conceptTenantCache = new Map<string, { tenantId: string | null; expiresAt: number }>()
export async function tenantOfConcept(conceptId: string): Promise<string | null> {
  const hit = conceptTenantCache.get(conceptId)
  if (hit && hit.expiresAt > Date.now()) return hit.tenantId
  const row = await prisma.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } }).catch(() => null)
  const tenantId = row?.tenantId ?? null
  conceptTenantCache.set(conceptId, { tenantId, expiresAt: Date.now() + 5 * 60_000 })
  return tenantId
}

/**
 * Join `${kind}:${id}` only if the station/concept belongs to one of the
 * socket's companies. Silently ignores foreign or unknown ids — a client
 * with a bad id simply gets no events, and learns nothing.
 */
async function joinIfOwned(
  socket: { join: (room: string) => void | Promise<void> },
  tenantIds: string[],
  kind: 'station' | 'concept',
  id: string,
): Promise<void> {
  if (tenantIds.length === 0) return
  try {
    let owner: string | null = null
    if (kind === 'concept') {
      owner = await tenantOfConcept(id)
    } else {
      const st = await prisma.station.findUnique({ where: { id }, select: { conceptId: true } })
      owner = st ? await tenantOfConcept(st.conceptId) : null
    }
    if (owner && tenantIds.includes(owner)) await socket.join(`${kind}:${id}`)
  } catch {
    /* no join on lookup failure */
  }
}

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
    // Manager web holds no token in JS — it connects withCredentials and the
    // access token rides in the httpOnly cookie.
    const cookieToken = parseCookieHeader(socket.handshake.headers.cookie, ACCESS_COOKIE)
    const token = auth?.token ?? queryToken ?? cookieToken
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
      // A valid signature is not the same as a live session. The HTTP guards
      // check the deny list and the account's current state on every request;
      // this handshake checked neither, so a token belonging to someone who has
      // logged out — or been let go — still opened a socket onto the live order
      // and reservation feed, and kept it open indefinitely.
      const { isRevoked } = await import('./tokenRevocation.js')
      if (await isRevoked(token, payload.sub, (payload as { iat?: number }).iat)) {
        return next(new Error('UNAUTHORIZED'))
      }

      // Re-resolve tenant so we know which company the socket can subscribe to.
      // A multi-company operator (CEO in "All companies") belongs to several —
      // collect them all so tenant rooms cover every company they may view.
      const [u, memberships] = await Promise.all([
        prisma.user.findUnique({
          where: { id: payload.sub },
          select: { tenantId: true, role: true, isActive: true, accountStatus: true, deletedAt: true },
        }),
        prisma.tenantMember.findMany({ where: { userId: payload.sub }, select: { tenantId: true } }),
      ])
      if (!u || u.deletedAt || !u.isActive || u.accountStatus !== 'active') {
        return next(new Error('UNAUTHORIZED'))
      }

      const tenantIds = new Set<string>(memberships.map((m) => m.tenantId))
      if (u.tenantId) tenantIds.add(u.tenantId)
      ;(socket.data as Record<string, unknown>).user = {
        // The LIVE role, not the one baked into the token. A demotion has to
        // take effect on the socket too, or the room-join checks below are
        // deciding on a role the person no longer holds.
        id: payload.sub, role: u.role, tenantId: u.tenantId ?? null,
        tenantIds: Array.from(tenantIds),
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
    const principal = (socket.data as { user?: SocketPrincipal }).user
    const role = principal?.role
    const tenantId = principal?.tenantId
    const tenantIds = principal?.tenantIds ?? []

    // B15: only kitchen-side roles may auto-register a KDS device. A cashier
    // socket should not appear in the device registry.
    let heartbeatHandle: NodeJS.Timeout | null = null
    const kdsAllowed = role === 'kitchen' || role === 'expediter' || role === 'manager' || role === 'admin' || role === 'owner'

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

    // Join appropriate rooms. Every room a client can name (station, concept)
    // is checked against the companies the socket belongs to before joining —
    // a guessed id must never subscribe a GSX Viva screen to GS Foods'
    // kitchen. Tenant rooms are the fan-out key for company-wide events
    // (`tenant:{id}:orders`, `tenant:{id}:reservations`); the legacy global
    // rooms are kept only for events that carry no brand (order:updated,
    // item:updated — id + status, nothing else).
    if (stationId) void joinIfOwned(socket, tenantIds, 'station', stationId)
    if (conceptId) void joinIfOwned(socket, tenantIds, 'concept', conceptId)
    for (const t of tenantIds) void socket.join(`tenant:${t}`)
    if (role === 'expediter' || role === 'admin' || role === 'owner' || role === 'manager') {
      void socket.join('all-orders')
      for (const t of tenantIds) void socket.join(`tenant:${t}:orders`)
    }
    // Reservation events go to managers, admins, cashiers (the host stand)
    // and kitchen/expediter (so the kitchen tracker page updates in real time).
    if (role === 'admin' || role === 'owner' || role === 'manager' || role === 'cashier' || role === 'expediter' || role === 'kitchen') {
      for (const t of tenantIds) void socket.join(`tenant:${t}:reservations`)
    }

    // Allow clients to opt-into a specific reservation room from the page
    // they're on (e.g. the admin reservation editor wants `concept:{id}`).
    socket.on('reservations:join', (data: { conceptId?: string }) => {
      if (data?.conceptId) void joinIfOwned(socket, tenantIds, 'concept', data.conceptId)
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
  void tenantOfConcept(order.conceptId).then((tenantId) => {
    safeEmit('emitOrderNew', (ws) => {
      if (tenantId) ws.to(`tenant:${tenantId}:orders`).emit('order:new', order)
      for (const stationId of order.stationIds) {
        ws.to(`station:${stationId}`).emit('order:new', order)
      }
      ws.to(`concept:${order.conceptId}`).emit('order:new', order)
    })
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
  void tenantOfConcept(conceptId).then((tenantId) => {
    safeEmit('emitItem86d', (ws) => {
      ws.to(`concept:${conceptId}`).emit('item:86d', { menuItemId, conceptId, isAvailable })
      if (tenantId) ws.to(`tenant:${tenantId}:orders`).emit('item:86d', { menuItemId, conceptId, isAvailable })
    })
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
    // Fallback for clients that haven't joined a concept room yet (e.g. brand
    // homepages that show the live availability strip across multiple brands)
    // — but only within the brand's own company.
    const tenantId = await tenantOfConcept(conceptId)
    if (tenantId) io.to(`tenant:${tenantId}:orders`).emit('item:availability', { menuItemId, conceptId, available })
  }
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
  void tenantOfConcept(payload.conceptId).then((tenantId) => {
    safeEmit(event, (ws) => {
      if (tenantId) ws.to(`tenant:${tenantId}:reservations`).emit(event, payload)
      ws.to(`concept:${payload.conceptId}`).emit(event, payload)
    })
  })
}
