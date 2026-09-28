// Socket.io server (Docker deployment) + the typed event emitters every module
// calls. The emitters no longer talk to socket.io directly: they publish
// through lib/realtime.ts, which fans out to whichever transports are
// configured (socket.io in-process, Supabase Realtime over REST, or both).
//
// Rooms / topics: station:{id}, concept:{id} (both ownership-checked),
// tenant:{id}, tenant:{id}:orders, tenant:{id}:reservations (company-wide
// fan-out), all-orders (brand-less id+status events only). Which of these a
// principal may join is decided in lib/realtimeTopics.ts — the same function
// that lists the topics in a Supabase token, so both transports agree.

import { Server as SocketIOServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { redisPub, redisSub } from './redis.js'
import { isAllowedOrigin } from './corsAllowlist.js'
import { parseCookieHeader, ACCESS_COOKIE } from './cookies.js'
import type { FastifyInstance } from 'fastify'
import { verifyStaffToken } from '../modules/auth/service.js'
import { prisma } from './prisma.js'
import { publish, setSocketIoPublisher } from './realtime.js'
import {
  loadRealtimePrincipal,
  resolveRealtimeTopics,
  tenantOfConcept,
  type RealtimePrincipal,
} from './realtimeTopics.js'

export { tenantOfConcept }

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
  const server = io
  setSocketIoPublisher((topic, event, payload) => { server.to(topic).emit(event, payload) })

  // Redis adapter enables multi-instance fanout — only attach if Redis is reachable.
  // Falls back to in-memory adapter (perfectly fine for single-server deployments).
  redisPub.ping()
    .then(() => {
      server.adapter(createAdapter(redisPub, redisSub))
      fastify.log.info('WebSocket Redis adapter enabled')
    })
    .catch(() => {
      fastify.log.warn('Redis unavailable — WebSocket running in single-instance mode (in-memory adapter)')
    })

  // B05: strict auth gate. No token → connection refused at the handshake.
  // This runs once per connect; we stash the principal on `socket.data` so the
  // connection handler below (and any application code) can read it.
  server.use(async (socket, next) => {
    const auth = socket.handshake.auth as { token?: string }
    const queryToken = (socket.handshake.query as { token?: string })?.token
    // Manager web holds no token in JS — it connects withCredentials and the
    // access token rides in the httpOnly cookie.
    const cookieToken = parseCookieHeader(socket.handshake.headers.cookie, ACCESS_COOKIE)
    const token = auth?.token ?? queryToken ?? cookieToken
    if (!token) return next(new Error('UNAUTHORIZED'))
    try {
      // Every client — KDS screens included — holds a normal access token.
      // The whole io.use body is wrapped in a catch that collapses any failure
      // to UNAUTHORIZED, so a mistake here shows up as an unexplained socket
      // reconnect loop on the KDS screens rather than an error anyone would see.
      const payload = verifyStaffToken(token, 'access')
      // A valid signature is not the same as a live session. The HTTP guards
      // check the deny list and the account's current state on every request;
      // the handshake must too, or a token belonging to someone who has logged
      // out — or been let go — would keep a socket onto the live order feed.
      const { isRevoked } = await import('./tokenRevocation.js')
      if (await isRevoked(token, payload.sub, (payload as { iat?: number }).iat)) {
        return next(new Error('UNAUTHORIZED'))
      }
      // The LIVE role and company list, not the ones baked into the token. A
      // demotion has to take effect on the socket too.
      const principal = await loadRealtimePrincipal(payload.sub)
      if (!principal) return next(new Error('UNAUTHORIZED'))
      ;(socket.data as Record<string, unknown>).user = principal
      return next()
    } catch {
      return next(new Error('UNAUTHORIZED'))
    }
  })

  // B15 in-memory throttle: each (userId, fingerprint) pair can only re-upsert
  // its KdsDevice row at most once per second. Stops a chatty client from
  // hammering the DB if it reconnects rapidly.
  const lastUpsertAt = new Map<string, number>()

  server.on('connection', (socket) => {
    const { stationId, conceptId, deviceFingerprint, deviceName } = socket.handshake.auth as {
      stationId?: string
      conceptId?: string
      deviceFingerprint?: string  // KDS sends a stable per-browser UUID from localStorage
      deviceName?: string
    }

    // `io.use` populated this.
    const principal = (socket.data as { user?: RealtimePrincipal }).user
    const role = principal?.role
    const tenantId = principal?.tenantId

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

    // Join exactly the rooms the principal may hear. A guessed station or
    // concept id must never subscribe a GSX Viva screen to GS Foods' kitchen;
    // resolveRealtimeTopics drops anything the principal's companies don't own.
    if (principal) {
      void resolveRealtimeTopics(principal, { stationId, conceptId })
        .then((topics) => { for (const t of topics) void socket.join(t) })
    }

    // Allow clients to opt-into a specific reservation room from the page
    // they're on (e.g. the admin reservation editor wants `concept:{id}`).
    socket.on('reservations:join', (data: { conceptId?: string }) => {
      if (!principal || !data?.conceptId) return
      void resolveRealtimeTopics(principal, { conceptId: data.conceptId })
        .then((topics) => { for (const t of topics) void socket.join(t) })
    })

    socket.on('disconnect', (reason) => {
      if (heartbeatHandle) clearInterval(heartbeatHandle)
      fastify.log.info({ socketId: socket.id, reason }, 'WebSocket client disconnected')
    })
  })

  fastify.log.info('WebSocket server initialised')
  return server
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
// All emitters are best-effort: publishing never throws into the caller. An
// order must never fail because we couldn't broadcast to the KDS — clients
// catch up via their polling fallback.

export function emitOrderNew(order: {
  orderId: string
  conceptId: string
  source: string
  stationIds: string[]
  placedAt: string
}) {
  void tenantOfConcept(order.conceptId).then((tenantId) => {
    if (tenantId) publish(`tenant:${tenantId}:orders`, 'order:new', order)
    for (const stationId of order.stationIds) publish(`station:${stationId}`, 'order:new', order)
    publish(`concept:${order.conceptId}`, 'order:new', order)
  })
}

export function emitOrderUpdated(orderId: string, status: string) {
  publish('all-orders', 'order:updated', { orderId, status })
}

export function emitItemUpdated(itemId: string, status: string, stationId: string | null) {
  if (stationId) publish(`station:${stationId}`, 'item:updated', { itemId, status, stationId })
  publish('all-orders', 'item:updated', { itemId, status, stationId })
}

export function emitItem86d(menuItemId: string, conceptId: string, isAvailable: boolean) {
  void tenantOfConcept(conceptId).then((tenantId) => {
    publish(`concept:${conceptId}`, 'item:86d', { menuItemId, conceptId, isAvailable })
    if (tenantId) publish(`tenant:${tenantId}:orders`, 'item:86d', { menuItemId, conceptId, isAvailable })
  })
}

// Broadcast live availability changes to the concept's room. We look up the
// menu item's conceptId on the fly because the callers (cart-release worker,
// reservation settle) don't carry it. Cached in-process for 5min to dodge a
// per-event DB round-trip — availability changes are bursty.
const conceptIdCache = new Map<string, { conceptId: string; expiresAt: number }>()

export async function emitAvailabilityChange(menuItemId: string, available: number) {
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
    publish(`concept:${conceptId}`, 'item:availability', { menuItemId, available })
    // Fallback for clients that haven't joined a concept room yet (e.g. brand
    // homepages that show the live availability strip across multiple brands)
    // — but only within the brand's own company.
    const tenantId = await tenantOfConcept(conceptId)
    if (tenantId) publish(`tenant:${tenantId}:orders`, 'item:availability', { menuItemId, conceptId, available })
  }
}

// Customer marked "I'm here" on a curbside order — light up the kitchen and
// front-of-house of that brand's company only.
export function emitCurbsideArrived(payload: {
  orderId: string
  conceptId: string
  vehicle: string | null
  spot: string | null
  arrivedAt: Date | null
}) {
  void tenantOfConcept(payload.conceptId).then((tenantId) => {
    if (tenantId) publish(`tenant:${tenantId}:orders`, 'order:curbsideArrived', payload)
    publish(`concept:${payload.conceptId}`, 'order:curbsideArrived', payload)
  })
}

// Expo fired a course/step to a station.
export function emitExpoFire(stationId: string, payload: unknown) {
  publish(`station:${stationId}`, 'expo:fire', payload)
}

// ─── Reservation events ───────────────────────────────────────────────────────
//
// Fired from the reservation routes whenever a booking changes. Admin clients
// receive them on `tenant:{id}:reservations` (joined automatically for staff
// roles) plus the per-concept room `concept:{id}` if they asked for one.
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
    if (tenantId) publish(`tenant:${tenantId}:reservations`, event, payload)
    publish(`concept:${payload.conceptId}`, event, payload)
  })
}
