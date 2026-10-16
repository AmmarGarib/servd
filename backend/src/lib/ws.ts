// WebSocket server — Socket.io with Redis adapter for multi-process fanout
// Rooms: station:{id}, concept:{id} (both ownership-checked at join),
// tenant:{id}, tenant:{id}:orders, tenant:{id}:reservations,
// tenant:{id}:till (company-wide fan-out; till = Raast QR intents and bank
// alerts, managers + cashier + foh). There is no global room any more: the old `all-orders` room
// carried every company's order/item ids and statuses to every expediter and
// manager socket, so each event now resolves its company and goes to
// `tenant:{id}:orders` only.
// Events match spec §6.3

import { Server as SocketIOServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { redisPub, redisSub } from './redis.js'
import { isAllowedOrigin } from './corsAllowlist.js'
import { parseCookieHeader, ACCESS_COOKIE } from './cookies.js'
import type { FastifyInstance } from 'fastify'
import { verifyStaffToken } from '../modules/auth/service.js'
import { prisma, serviceClient } from './prisma.js'
import { MANAGEMENT_TIER } from './roles.js'
// Every management tier (incl. legacy 'manager' until it is migrated away) —
// the literal ['admin','owner','manager'] left GMs, floor managers and head
// chefs out of the KDS, company order and reservation rooms.
const MANAGER_TIER: readonly string[] = MANAGEMENT_TIER

let io: SocketIOServer | null = null

/** Non-manager roles that work a till and join `tenant:{id}:till`. */
const TILL_ROLES: readonly string[] = ['cashier', 'foh']

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

/** The company an order belongs to (its brand's company), or null. */
async function tenantOfOrder(orderId: string): Promise<string | null> {
  const o = await serviceClient.order.findUnique({ where: { id: orderId }, select: { conceptId: true } }).catch(() => null)
  return o ? tenantOfConcept(o.conceptId) : null
}

/** The company an order line belongs to (via its order's brand), or null. */
async function tenantOfOrderItem(itemId: string): Promise<string | null> {
  const it = await serviceClient.orderItem.findUnique({
    where: { id: itemId },
    select: { order: { select: { conceptId: true } } },
  }).catch(() => null)
  return it?.order ? tenantOfConcept(it.order.conceptId) : null
}

/** The company a station belongs to (via its brand), or null. */
async function tenantOfStation(stationId: string): Promise<string | null> {
  const st = await serviceClient.station.findUnique({ where: { id: stationId }, select: { conceptId: true } }).catch(() => null)
  return st ? tenantOfConcept(st.conceptId) : null
}

/**
 * Register (or refresh) a KDS device for the connecting socket.
 *
 * `deviceFingerprint` is globally unique, so a plain upsert on it let any
 * kitchen/manager socket that presented another company's fingerprint re-home
 * that company's device row to its own company (and repoint its station).
 * Now a device keeps the company it was registered under: a socket may only
 * refresh a device of a company it belongs to, a legacy company-less row is
 * claimed by the socket's active company, and anything else is refused.
 * stationId / conceptId from the handshake are written only when they belong
 * to the device's company.
 *
 * Returns the device's company when the socket may heartbeat it, else null.
 */
export async function registerKdsDevice(opts: {
  deviceFingerprint: string
  deviceName?: string
  stationId?: string
  conceptId?: string
  tenantId: string | null
  tenantIds: string[]
  ipAddress: string
}): Promise<string | null> {
  const { deviceFingerprint, tenantIds, ipAddress } = opts
  const existing = await prisma.kdsDevice.findUnique({
    where: { deviceFingerprint },
    select: { id: true, tenantId: true },
  })
  // The company this registration belongs to: an existing device keeps its
  // own; a new (or legacy company-less) one takes the socket's active company.
  const deviceTenant = existing?.tenantId ?? opts.tenantId
  if (!deviceTenant || !tenantIds.includes(deviceTenant)) return null

  const stationId = opts.stationId && (await tenantOfStation(opts.stationId)) === deviceTenant ? opts.stationId : undefined
  const conceptId = opts.conceptId && (await tenantOfConcept(opts.conceptId)) === deviceTenant ? opts.conceptId : undefined

  if (!existing) {
    await prisma.kdsDevice.create({
      data: {
        deviceFingerprint,
        name: opts.deviceName ?? `KDS ${deviceFingerprint.slice(0, 8)}`,
        stationId: stationId ?? null,
        conceptId: conceptId ?? null,
        tenantId: deviceTenant,
        ipAddress,
        lastSeenAt: new Date(),
      },
    })
    return deviceTenant
  }

  // Conditional on the company still being what we checked (or still unset,
  // for a legacy claim) so a concurrent claim can't be overwritten.
  const res = await prisma.kdsDevice.updateMany({
    where: { id: existing.id, tenantId: existing.tenantId },
    data: {
      lastSeenAt: new Date(),
      ipAddress,
      ...(stationId && { stationId }),
      ...(conceptId && { conceptId }),
      ...(existing.tenantId ? {} : { tenantId: deviceTenant }),
    },
  })
  return res.count > 0 ? deviceTenant : null
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
      // Every client — KDS screens included — now holds a normal access token;
      // PIN tokens are no longer minted. The old fallback to `verifyStaffToken(
      // token, 'pin')` is gone with them. Note the whole io.use body is wrapped
      // in a catch that collapses any failure to UNAUTHORIZED, so a mistake
      // here shows up as an unexplained socket reconnect loop on the KDS
      // screens rather than an error anyone would see.
      const payload = verifyStaffToken(token, 'access')
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
    const kdsAllowed = role === 'kitchen' || role === 'expediter' || role === 'boh' || MANAGER_TIER.includes(role ?? '')

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
            const deviceTenant = await registerKdsDevice({
              deviceFingerprint, deviceName, stationId, conceptId,
              tenantId: tenantId ?? null, tenantIds, ipAddress,
            })
            if (!deviceTenant) {
              fastify.log.warn(`[kds-device] registration refused for fingerprint ${deviceFingerprint.slice(0, 8)}… — device belongs to another company (or the socket has none)`)
              return
            }
            heartbeatHandle = setInterval(() => {
              prisma.kdsDevice.updateMany({
                where: { deviceFingerprint, tenantId: deviceTenant },
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
    // (`tenant:{id}:orders`, `tenant:{id}:reservations`). There is no global
    // room: even id + status events are resolved to their company first.
    if (stationId) void joinIfOwned(socket, tenantIds, 'station', stationId)
    if (conceptId) void joinIfOwned(socket, tenantIds, 'concept', conceptId)
    for (const t of tenantIds) void socket.join(`tenant:${t}`)
    // The bell (2026-10-16): a personal room per verified, live-checked login.
    // Only id-only pings go here (`notification:new`); the client refetches.
    if (principal?.id) void socket.join(userRoom(principal.id))
    if (role === 'expediter' || MANAGER_TIER.includes(role ?? '')) {
      for (const t of tenantIds) void socket.join(`tenant:${t}:orders`)
    }
    // Reservation events go to managers, admins, cashiers (the host stand)
    // and kitchen/expediter (so the kitchen tracker page updates in real time).
    if (MANAGER_TIER.includes(role ?? '') || ['cashier', 'foh', 'expediter', 'kitchen', 'boh'].includes(role ?? '')) {
      for (const t of tenantIds) void socket.join(`tenant:${t}:reservations`)
    }

    // The till room (Raast QR, 2026-10-12): an SMS completing a bill, an
    // intent expiring, a bank alert to attach. Per company, never global.
    if (MANAGER_TIER.includes(role ?? '') || TILL_ROLES.includes(role ?? '')) {
      for (const t of tenantIds) void socket.join(`tenant:${t}:till`)
    }

    // Allow clients to opt-into a specific reservation room from the page
    // they're on (e.g. the admin reservation editor wants `concept:{id}`).
    socket.on('reservations:join', (data: { conceptId?: string }) => {
      if (data?.conceptId) void joinIfOwned(socket, tenantIds, 'concept', data.conceptId)
    })

    // Client → Server events (KDS interactions). Handled in the orders module;
    // the socket only relays them to the other screens of the item's OWN
    // company, and only when the sender belongs to that company — a guessed
    // item id from another company is dropped. Only the item id is relayed.
    const relayKds = (event: 'kds:bump' | 'kds:hold' | 'kds:recall') => (data: { itemId?: unknown }) => {
      const itemId = typeof data?.itemId === 'string' ? data.itemId : null
      if (!itemId) return
      void tenantOfOrderItem(itemId).then((owner) => {
        if (owner && tenantIds.includes(owner)) socket.to(`tenant:${owner}:orders`).emit(event, { itemId })
      })
    }
    socket.on('kds:bump', relayKds('kds:bump'))
    socket.on('kds:hold', relayKds('kds:hold'))
    socket.on('kds:recall', relayKds('kds:recall'))

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

// ─── The bell: per-user room (2026-10-16, lib/staffNotify.ts) ─────────────────
//
// `user:<id>` is joined at connect by the verified principal only. Payloads
// carry ids only — never a title, body or amount; the client refetches over
// HTTP (where the inbox scope applies). Fire-and-forget: never awaited, never
// throws, a no-op before initWebSocket().

export function userRoom(userId: string): string {
  return `user:${userId}`
}

export function emitToUser(userId: string, event: 'notification:new', payload: { id: string; kind: string }): void {
  const ws = getIOSafe()
  if (!ws || !userId) return
  try {
    ws.to(userRoom(userId)).emit(event, { id: payload.id, kind: payload.kind })
  } catch (err) {
    console.warn(`[ws] emitToUser failed: ${(err as Error).message}`)
  }
}

/** Drop every open socket of a login (offboarding / switch-off). Best-effort. */
export function disconnectUser(userId: string): void {
  const ws = getIOSafe()
  if (!ws || !userId) return
  try {
    ws.in(userRoom(userId)).disconnectSockets(true)
  } catch (err) {
    console.warn(`[ws] disconnectUser failed: ${(err as Error).message}`)
  }
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
  // Company fan-out only: an order whose company can't be resolved is not
  // broadcast (clients catch up via the polling fallback).
  void tenantOfOrder(orderId).then((tenantId) => {
    if (!tenantId) return
    safeEmit('emitOrderUpdated', (ws) => {
      ws.to(`tenant:${tenantId}:orders`).emit('order:updated', { orderId, status })
    })
  })
}

export function emitItemUpdated(itemId: string, status: string, stationId: string | null) {
  safeEmit('emitItemUpdated', (ws) => {
    if (stationId) ws.to(`station:${stationId}`).emit('item:updated', { itemId, status, stationId })
  })
  void tenantOfOrderItem(itemId).then((tenantId) => {
    if (!tenantId) return
    safeEmit('emitItemUpdated', (ws) => {
      ws.to(`tenant:${tenantId}:orders`).emit('item:updated', { itemId, status, stationId })
    })
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

// ─── Rider location ───────────────────────────────────────────────────────────
//
// `rider:location` (docs/rider-app.md) goes to the rider's OWN company
// (`tenant:{riderCompany}`) and, while the rider is carrying orders, to each
// order company's order room (`tenant:{orderCompany}:orders`). Under a fleet
// agreement those differ — and then the client company is told only about its
// own order: each company's copy carries an order id of THAT company (or null),
// never another company's.

export interface RiderLocationFix {
  riderId: string
  lat: number
  lng: number
  heading: number | null
  recordedAt: string
}

export interface RiderLocationInput {
  fix: RiderLocationFix
  riderTenantId: string | null
  /** The order the fix was pinned to, if any, with its company. */
  fixOrder: { id: string; tenantId: string | null } | null
  /** The orders the rider has in hand (orderId + company) — who else should see the pin. */
  jobs: Array<{ id: string; tenantId: string | null }>
}

/**
 * Who gets which copy of a `rider:location` (pure — the emit below sends it).
 * Rooms are grouped by the payload they get, so a socket in several rooms of
 * the SAME company (a manager is in tenant:X and tenant:X:orders) gets it once.
 */
export function riderLocationFanout(opts: RiderLocationInput): Array<{ rooms: string[]; payload: RiderLocationFix & { orderId: string | null } }> {
  const { fix, riderTenantId, fixOrder, jobs } = opts
  const orderFor = (tenantId: string): string | null => {
    if (fixOrder && fixOrder.tenantId === tenantId) return fixOrder.id
    return jobs.find((j) => j.tenantId === tenantId)?.id ?? null
  }
  const byCompany = new Map<string, string[]>()
  const add = (tenantId: string | null, room: string) => {
    if (!tenantId) return
    const rooms = byCompany.get(tenantId) ?? []
    rooms.push(room)
    byCompany.set(tenantId, rooms)
  }
  add(riderTenantId, `tenant:${riderTenantId}`)
  const companies = new Set<string>()
  if (fixOrder?.tenantId) companies.add(fixOrder.tenantId)
  for (const j of jobs) if (j.tenantId) companies.add(j.tenantId)
  for (const t of companies) add(t, `tenant:${t}:orders`)
  return [...byCompany].map(([tenantId, rooms]) => ({ rooms, payload: { ...fix, orderId: orderFor(tenantId) } }))
}

export function emitRiderLocation(opts: RiderLocationInput) {
  safeEmit('emitRiderLocation', (ws) => {
    for (const { rooms, payload } of riderLocationFanout(opts)) {
      ws.to(rooms).emit('rider:location', payload)
    }
  })
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

// ─── Till events (Raast QR, 2026-10-12) ───────────────────────────────────────
//
// `raast:intent` {receiptId, orderId, status, amountCents, refLast4?, reason?}
// and `raast:alert` {alertId, status, amountCents, occurredAt, locationId} go
// to `tenant:{id}:till` of the company that owns the receipt / the SMS — never
// another company's till. Best effort: the till also polls.

export type TillEvent = 'raast:intent' | 'raast:alert'

/** Rooms a till event for `tenantId` goes to (pure). */
export function tillRooms(tenantId: string | null | undefined): string[] {
  return tenantId ? [`tenant:${tenantId}:till`] : []
}

type TillSpy = (rooms: string[], event: TillEvent, payload: Record<string, unknown>) => void
let tillSpy: TillSpy | null = null

/** Tests only: observe till emits (null removes the spy). */
export function setTillEmitSpy(fn: TillSpy | null): void {
  tillSpy = fn
}

export function emitTill(tenantId: string | null | undefined, event: TillEvent, payload: Record<string, unknown>) {
  const rooms = tillRooms(tenantId)
  if (rooms.length === 0) return
  tillSpy?.(rooms, event, payload)
  if (!io) return // no socket server (scripts, tests) — the till polls
  safeEmit(event, (ws) => {
    ws.to(rooms).emit(event, payload)
  })
}
