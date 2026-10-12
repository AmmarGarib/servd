// Re-simulation, online ops stream (2026-10-12).
//
//   ONL-R2-03  a pre-order (scheduledFor ahead) is not auto-cancelled 30 min
//              after it was placed: both sweep clocks start at the LATER of
//              placedAt and scheduledFor. scheduledFor is capped at 7 days.
//   ONL-R2-04  a host's phone booking is held to the public capacity rule
//              (planSeat, under the brand's booking lock): a table is
//              assigned, or 409 SLOT_FULL — unless a manager overbooks
//              (own login or PIN of the brand's company; reason; audited).
//   ONL-R2-07  GET /orders?status=<unknown> → 400 VALIDATION_ERROR, not 500.
//   ONL-R2-08  the /health Redis probe fails when the configured DB index is
//              invalid (a bare PING still answered).
//   PPL-R2-05  /health: no WhatsApp → floor staff 'warn' naming the manager's
//              in-person sign-in code, not "cannot sign in at all".
//
// Two companies wherever scoping is involved: B never sees or books into A.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { Redis } from 'ioredis'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { orderRoutes, parseStatusFilter } from '../src/modules/orders/routes.js'
import { reservationRoutes, seatPlan, strandsTableless } from '../src/modules/reservations/routes.js'
import { runCancelSweep } from '../src/workers/orderAutoCancel.js'
import { orderTime, MAX_PREORDER_AHEAD_MS } from '../src/modules/storefront/serviceHours.js'
import { redisHealthProbe, staffCodeLoginHealth } from '../src/lib/healthProbes.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { prisma, mkCompany, mkUser, caller, type Company, type Who } from './connectorsFixtures.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let app: FastifyInstance
let A: Company, B: Company
let hostA: Who, mgrA: Who, hostB: Who, mgrB: Who
const PIN_A = '6143'
const PIN_B = '8257'

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

beforeAll(async () => {
  A = await mkCompany(`resim-on-a-${Date.now().toString(36)}`)
  B = await mkCompany(`resim-on-b-${Date.now().toString(36)}`)
  hostA = await mkUser('resim-host-a', 'foh', A.tenantId)
  mgrA = await mkUser('resim-mgr-a', 'foh_management', A.tenantId)
  hostB = await mkUser('resim-host-b', 'foh', B.tenantId)
  mgrB = await mkUser('resim-mgr-b', 'foh_management', B.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  await setManagerPin(mgrB.id, PIN_B)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── ONL-R2-03 — pre-orders ─────────────────────────────────────────────────

async function onlineOrder(co: Company, opts: { status: 'received' | 'confirmed'; placedAgoMs: number; scheduledInMs?: number | null }) {
  const now = Date.now()
  return prisma.order.create({
    data: {
      conceptId: co.conceptId,
      locationId: co.locationId,
      source: 'servd',
      fulfilmentType: 'takeout',
      status: opts.status,
      totalCents: 145_000,
      placedAt: new Date(now - opts.placedAgoMs),
      ...(opts.scheduledInMs != null && { scheduledFor: new Date(now + opts.scheduledInMs), isPreOrder: true }),
      items: { create: [{ menuItemId: co.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000 }] },
    },
    select: { id: true },
  })
}
const statusOf = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status

describe('ONL-R2-03 — the auto-cancel sweep waits for a pre-order’s own time', () => {
  it('a pre-order for tomorrow placed 35 min ago stays; an order for now placed 35 min ago is cancelled', async () => {
    const pre = await onlineOrder(A, { status: 'received', placedAgoMs: 35 * MIN, scheduledInMs: 23 * HOUR })
    const now = await onlineOrder(A, { status: 'received', placedAgoMs: 35 * MIN })
    await runCancelSweep()
    expect(await statusOf(pre.id)).toBe('received')
    expect(await statusOf(now.id)).toBe('cancelled')
  })

  it('a same-day pre-order 2.5 h out is not cancelled at 31 min', async () => {
    const pre = await onlineOrder(A, { status: 'received', placedAgoMs: 31 * MIN, scheduledInMs: 150 * MIN })
    await runCancelSweep()
    expect(await statusOf(pre.id)).toBe('received')
  })

  it('a confirmed pre-order placed 3 h ago for tomorrow is not cancelled by the 2-hour sweep', async () => {
    const pre = await onlineOrder(B, { status: 'confirmed', placedAgoMs: 3 * HOUR, scheduledInMs: DAY })
    await runCancelSweep()
    expect(await statusOf(pre.id)).toBe('confirmed')
  })

  it('a pre-order still unacknowledged 35 min after its own time IS swept', async () => {
    const late = await onlineOrder(A, { status: 'received', placedAgoMs: 5 * HOUR, scheduledInMs: -35 * MIN })
    await runCancelSweep()
    expect(await statusOf(late.id)).toBe('cancelled')
  })
})

describe('ONL-R2-03 — scheduledFor is bounded', () => {
  const now = new Date('2026-10-12T10:00:00Z')
  it('a time within 7 days is a pre-order at that time', () => {
    const at = new Date(now.getTime() + 2 * DAY)
    expect(orderTime(at.toISOString(), now)).toEqual({ at, scheduled: true })
  })
  it('a past time is "now"', () => {
    expect(orderTime(new Date(now.getTime() - HOUR).toISOString(), now)).toEqual({ at: now, scheduled: false })
  })
  it('more than 7 days ahead → 422 SCHEDULE_TOO_FAR', () => {
    const far = new Date(now.getTime() + MAX_PREORDER_AHEAD_MS + MIN).toISOString()
    expect(() => orderTime(far, now)).toThrowError(expect.objectContaining({ code: 'SCHEDULE_TOO_FAR', statusCode: 422 }))
    expect(() => orderTime(new Date(now.getTime() + 300 * DAY).toISOString(), now)).toThrow(/7 days/)
  })
  it('not a date → 400 INVALID_SCHEDULE', () => {
    expect(() => orderTime('tomorrow-ish', now)).toThrowError(expect.objectContaining({ code: 'INVALID_SCHEDULE', statusCode: 400 }))
  })
})

// ─── ONL-R2-07 — GET /orders?status ─────────────────────────────────────────

describe('ONL-R2-07 — GET /orders validates status', () => {
  it('parseStatusFilter: one, a comma list, an array; blanks ignored; unknown → 400', () => {
    expect(parseStatusFilter(undefined)).toBeNull()
    expect(parseStatusFilter('')).toBeNull()
    expect(parseStatusFilter('received')).toEqual(['received'])
    expect(parseStatusFilter('received, confirmed,,received')).toEqual(['received', 'confirmed'])
    expect(parseStatusFilter(['ready', 'completed'])).toEqual(['ready', 'completed'])
    expect(() => parseStatusFilter('out_for_delivery')).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }))
  })

  it('an unknown status answers 400 naming the allowed values (was 500)', async () => {
    const r = await call(mgrA, 'GET', '/orders?status=out_for_delivery')
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('VALIDATION_ERROR')
    expect(r.json().error.message).toMatch(/out_for_delivery/)
    expect(r.json().error.message).toMatch(/received/)
    const mixed = await call(mgrA, 'GET', '/orders?status=received,nope')
    expect(mixed.statusCode).toBe(400)
  })

  it('a valid status list filters — and only inside the caller’s company', async () => {
    const a = await onlineOrder(A, { status: 'received', placedAgoMs: MIN })
    const b = await onlineOrder(B, { status: 'received', placedAgoMs: MIN })
    const ra = await call(mgrA, 'GET', '/orders?status=received,confirmed&limit=200')
    expect(ra.statusCode).toBe(200)
    const idsA = (ra.json().data as Array<{ id: string; status: string }>).map((o) => o.id)
    expect(idsA).toContain(a.id)
    expect(idsA).not.toContain(b.id)
    expect((ra.json().data as Array<{ status: string }>).every((o) => o.status === 'received' || o.status === 'confirmed')).toBe(true)
    const rb = await call(mgrB, 'GET', '/orders?status=received&limit=200')
    const idsB = (rb.json().data as Array<{ id: string }>).map((o) => o.id)
    expect(idsB).toContain(b.id)
    expect(idsB).not.toContain(a.id)
    // A's brand named explicitly by B → 404, never A's orders.
    expect((await call(mgrB, 'GET', `/orders?status=received&conceptId=${A.conceptId}`)).statusCode).toBe(404)
  })
})

// ─── ONL-R2-04 — host bookings and capacity ──────────────────────────────────

describe('ONL-R2-04 — staff bookings are held to capacity', () => {
  let t4: string, t2: string
  // Tomorrow 15:00 UTC (20:00 PKT), well inside the default 2 h – 60 d window.
  const slot = () => {
    const d = new Date(Date.now() + DAY)
    d.setUTCHours(15, 0, 0, 0)
    return d.toISOString()
  }
  const hostBook = (who: Who, extra: Record<string, unknown> = {}, co: Company = A) =>
    call(who, 'POST', '/reservations', { conceptId: co.conceptId, partySize: 4, startTime: slot(), guestName: 'Ali Raza', guestPhone: '03004445556', ...extra })

  beforeAll(async () => {
    t4 = (await prisma.table.create({ data: { conceptId: A.conceptId, label: 'T4', capacity: 4 } })).id
    t2 = (await prisma.table.create({ data: { conceptId: A.conceptId, label: 'T2', capacity: 2 } })).id
    await prisma.table.create({ data: { conceptId: B.conceptId, label: 'B8', capacity: 8 } })
    await prisma.table.create({ data: { conceptId: B.conceptId, label: 'B6', capacity: 6 } })
  })

  it('the first party of 4 is given the free 4-top; the second gets 409 SLOT_FULL with nothing stored', async () => {
    const first = await hostBook(hostA)
    expect(first.statusCode).toBe(201)
    expect(first.json().tableId).toBe(t4)

    const before = await prisma.reservation.count({ where: { conceptId: A.conceptId } })
    const second = await hostBook(hostA, { guestName: 'Usman Tariq', guestPhone: '03004445557' })
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('SLOT_FULL')
    expect(second.json().error.details).toMatchObject({ overbookAllowed: true, managerRequired: true })
    expect(await prisma.reservation.count({ where: { conceptId: A.conceptId } })).toBe(before)
  })

  it('a party of 2 still fits the 2-top; a waiting-list entry needs no table', async () => {
    const two = await hostBook(hostA, { partySize: 2, guestName: 'Two' })
    expect(two.statusCode).toBe(201)
    expect(two.json().tableId).toBe(t2)
    const wl = await hostBook(hostA, { guestName: 'Waiting', waitlist: true })
    expect(wl.statusCode).toBe(201)
    expect(wl.json().tableId).toBeNull()
  })

  it('a party bigger than any table → SLOT_FULL', async () => {
    const big = await hostBook(hostA, { partySize: 12, guestName: 'Big' })
    expect(big.statusCode).toBe(409)
    expect(big.json().error.message).toMatch(/No table seats 12/)
  })

  it('a host cannot overbook alone; another company’s PIN does not count; a wrong reason-less request is refused', async () => {
    const alone = await hostBook(hostA, { guestName: 'Over', overbook: true, overbookReason: 'regular, tables pushed' })
    expect(alone.statusCode).toBe(403)
    expect(alone.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    const foreignPin = await hostBook(hostA, { guestName: 'Over', overbook: true, overbookReason: 'regular', managerOverridePin: PIN_B })
    expect(foreignPin.statusCode).toBe(403)
    expect(foreignPin.json().error.code).toBe('INVALID_MANAGER_PIN')
    const noReason = await hostBook(mgrA, { guestName: 'Over', overbook: true })
    expect(noReason.statusCode).toBe(400)
  })

  it('a host with the manager’s PIN overbooks: stored without a table, flagged, audited with the approver', async () => {
    const r = await hostBook(hostA, { guestName: 'Squeeze', overbook: true, overbookReason: 'regular, tables pushed', managerOverridePin: PIN_A })
    expect(r.statusCode).toBe(201)
    const body = r.json()
    expect(body.tableId).toBeNull()
    expect(body.overbooked).toBe(true)
    expect(body.notes).toMatch(/Overbooked: regular, tables pushed/)
    const log = await prisma.auditLog.findFirst({ where: { action: 'reservation.overbook', entityId: body.id } })
    expect(log).not.toBeNull()
    expect(log!.tenantId).toBe(A.tenantId)
    expect(log!.metadata).toMatchObject({ approverId: mgrA.id, viaPin: true, reason: 'regular, tables pushed' })
  })

  it('a manager overbooks on their own login', async () => {
    const r = await hostBook(mgrA, { guestName: 'Mgr', overbook: true, overbookReason: 'birthday group' })
    expect(r.statusCode).toBe(201)
    const log = await prisma.auditLog.findFirst({ where: { action: 'reservation.overbook', entityId: r.json().id } })
    expect(log!.metadata).toMatchObject({ approverId: mgrA.id, viaPin: false })
  })

  it('an overbook that was not needed is an ordinary booking (no flag, no overbook audit)', async () => {
    const r = await hostBook(mgrB, { overbook: true, overbookReason: 'just in case' }, B)
    expect(r.statusCode).toBe(201)
    expect(r.json().overbooked).toBe(false)
    expect(r.json().tableId).not.toBeNull()
    expect(await prisma.auditLog.findFirst({ where: { action: 'reservation.overbook', entityId: r.json().id } })).toBeNull()
  })

  it('company B: A’s brand is 404, A’s full slot does not touch B, and B’s table is never assigned to A', async () => {
    const intoA = await hostBook(hostB)
    expect(intoA.statusCode).toBe(404)
    const own = await hostBook(hostB, { guestName: 'B guest' }, B)
    expect(own.statusCode).toBe(201)
    const tbl = await prisma.table.findUniqueOrThrow({ where: { id: own.json().tableId } })
    expect(tbl.conceptId).toBe(B.conceptId)
  })

  it('two concurrent host bookings for the last table: one table, one SLOT_FULL', async () => {
    const d = new Date(Date.now() + 2 * DAY); d.setUTCHours(10, 0, 0, 0)
    const at = d.toISOString()
    const [x, y] = await Promise.all([
      call(hostA, 'POST', '/reservations', { conceptId: A.conceptId, partySize: 3, startTime: at, guestName: 'X' }),
      call(hostA, 'POST', '/reservations', { conceptId: A.conceptId, partySize: 3, startTime: at, guestName: 'Y' }),
    ])
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409])
  })
})

// ─── ONL-R2-08 — the Redis health probe ──────────────────────────────────────

describe('ONL-R2-08 — /health Redis probe', () => {
  const base = new URL(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6390/6')
  const mk = (db: number | null, port = base.port || '6379') =>
    new Redis(`redis://${base.hostname}:${port}${db == null ? '' : `/${db}`}`, {
      maxRetriesPerRequest: 1, enableOfflineQueue: false, enableReadyCheck: false,
      retryStrategy: () => null, lazyConnect: false,
    })
  const settle = (c: Redis) => new Promise<void>((res) => {
    if (c.status === 'ready' || c.status === 'end') return res()
    c.once('ready', () => res()); c.once('end', () => res()); setTimeout(res, 1_000)
  })

  it('passes on a valid DB index', async () => {
    const c = mk(Number(base.pathname.slice(1) || 0))
    c.on('error', () => {})
    await settle(c)
    await expect(redisHealthProbe(c)).resolves.toBeUndefined()
    c.disconnect()
  })

  it('fails when the DB index is out of range, although PING still answers', async () => {
    const c = mk(9_999)
    c.on('error', () => {})
    await settle(c)
    await new Promise((r) => setTimeout(r, 100))
    await expect(c.ping()).resolves.toBe('PONG') // the old check
    await expect(redisHealthProbe(c)).rejects.toThrow(/DB index/i)
    c.disconnect()
  })

  it('fails fast when Redis is unreachable', async () => {
    const c = mk(0, '1')
    c.on('error', () => {})
    await settle(c)
    const t0 = Date.now()
    await expect(redisHealthProbe(c, 500)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(1_500)
    c.disconnect()
  })
})

// ─── PPL-R2-05 — /health floor-staff sign-in ────────────────────────────────

describe('PPL-R2-05 — staffCodeLogin health', () => {
  it('no WhatsApp with floor staff → warn naming the in-person code, never "cannot sign in at all"', () => {
    const h = staffCodeLoginHealth({ whatsappConfigured: false, floorStaff: 4, floorStaffWithoutPhone: 0 })
    expect(h.check).toBe('warn')
    expect(h.detail).toMatch(/in-person code from Workforce/)
    expect(h.detail).not.toMatch(/cannot sign in at all/)
  })
  it('no WhatsApp and no floor staff → warn', () => {
    expect(staffCodeLoginHealth({ whatsappConfigured: false, floorStaff: 0, floorStaffWithoutPhone: 0 }).check).toBe('warn')
  })
  it('WhatsApp configured → ok', () => {
    expect(staffCodeLoginHealth({ whatsappConfigured: true, floorStaff: 4, floorStaffWithoutPhone: 0 })).toEqual({ check: 'ok' })
  })
  it('a floor login with no phone stays an error (both paths key the code on the phone)', () => {
    const h = staffCodeLoginHealth({ whatsappConfigured: true, floorStaff: 4, floorStaffWithoutPhone: 1 })
    expect(h.check).toBe('error')
    expect(h.detail).toMatch(/no phone number/)
  })
})

// ─── Review fixes O-RV-1 / O-RV-2 — capacity with overbooks and named tables ─
//
//   O-RV-1  a booking already past capacity (a manager's overbook, an older
//           staff booking with no table) is set aside on paper: it no longer
//           closes the whole window — host stand, public form, availability.
//   O-RV-2  a booking that names a table takes the brand's booking lock and
//           may not strand an overlapping booking without a table that needs
//           that table (create and PATCH); a manager may still overbook.

describe('O-RV-1 / O-RV-2 — capacity: set aside what is already over, named tables count', () => {
  let C: Company, D: Company
  let hostC: Who, mgrC: Who, hostD: Who, mgrD: Who
  let d4: string, d2: string
  const PIN_D = '7391'
  const at = (days: number, hourUtc = 15) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(hourUtc, 0, 0, 0); return d.toISOString() }
  const book = (who: Who, co: Company, body: Record<string, unknown>) =>
    call(who, 'POST', '/reservations', { conceptId: co.conceptId, partySize: 4, guestName: 'Guest', ...body })
  const patch = (who: Who, id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/reservations/${id}`, payload: body, headers: { authorization: `Bearer ${who.token}` } })
  const legacy = (co: Company, startIso: string, partySize: number, tableId: string | null = null) =>
    prisma.reservation.create({
      data: {
        conceptId: co.conceptId, tableId, partySize, guestName: 'Legacy', source: 'staff', status: 'booked',
        startTime: new Date(startIso), endTime: new Date(new Date(startIso).getTime() + 90 * MIN),
      },
    })

  beforeAll(async () => {
    C = await mkCompany(`rv-on-c-${Date.now().toString(36)}`)
    D = await mkCompany(`rv-on-d-${Date.now().toString(36)}`)
    hostC = await mkUser('rv-host-c', 'foh', C.tenantId)
    mgrC = await mkUser('rv-mgr-c', 'foh_management', C.tenantId)
    hostD = await mkUser('rv-host-d', 'foh', D.tenantId)
    mgrD = await mkUser('rv-mgr-d', 'foh_management', D.tenantId)
    await setManagerPin(mgrD.id, PIN_D)
    // C: two six-tops and six four-tops.
    for (const [label, capacity] of [['S1', 6], ['S2', 6], ['F1', 4], ['F2', 4], ['F3', 4], ['F4', 4], ['F5', 4], ['F6', 4]] as const) {
      await prisma.table.create({ data: { conceptId: C.conceptId, label, capacity } })
    }
    await prisma.concept.update({ where: { id: C.conceptId }, data: { reservationsEnabled: true } })
    // D: one four-top and one two-top.
    d4 = (await prisma.table.create({ data: { conceptId: D.conceptId, label: 'B4', capacity: 4 } })).id
    d2 = (await prisma.table.create({ data: { conceptId: D.conceptId, label: 'B2', capacity: 2 } })).id
  })

  it('pure rule: an over-capacity party is set aside; real fullness still refuses', () => {
    const t = [{ id: 's6', capacity: 6 }, { id: 'f4', capacity: 4 }, { id: 't2', capacity: 2 }]
    // A party of 12 fits nothing: it no longer closes the window.
    expect(seatPlan(t, [{ tableId: null, partySize: 12 }], 2).tableId).toBe('t2')
    // A party of 4 when the 4- and 6-tops are taken (an overbook onto 2-tops pushed together).
    expect(seatPlan(t, [{ tableId: 'f4', partySize: 4 }, { tableId: 's6', partySize: 6 }, { tableId: null, partySize: 4 }], 2).tableId).toBe('t2')
    // Placeable tableless parties still hold their table on paper.
    expect(seatPlan(t, [{ tableId: null, partySize: 4 }, { tableId: null, partySize: 6 }], 4).tableId).toBeNull()
    expect(seatPlan([{ id: 'a', capacity: 4 }, { id: 'b', capacity: 4 }], [{ tableId: null, partySize: 4 }, { tableId: null, partySize: 4 }, { tableId: null, partySize: 4 }], 4).tableId).toBeNull()
    // A named table a tableless party needs strands it; one it does not need does not.
    expect(strandsTableless(t, [{ tableId: null, partySize: 5 }], 's6')).toBe(true)
    expect(strandsTableless(t, [{ tableId: null, partySize: 5 }], 'f4')).toBe(false)
    expect(strandsTableless(t, [{ tableId: null, partySize: 4 }], 'f4')).toBe(false)   // the 6-top still seats them
    // A party already past capacity is never "stranded".
    expect(strandsTableless(t, [{ tableId: null, partySize: 12 }], 's6')).toBe(false)
  })

  it('O-RV-1: after a manager overbooks 12 with 8 tables, a host books 2 and the public slot stays open', async () => {
    const slot = at(2)
    const big = await book(mgrC, C, { partySize: 12, startTime: slot, guestName: 'Big', overbook: true, overbookReason: 'two six-tops pushed together' })
    expect(big.statusCode).toBe(201)
    expect(big.json()).toMatchObject({ tableId: null, overbooked: true })

    const two = await book(hostC, C, { partySize: 2, startTime: slot, guestName: 'Two' })
    expect(two.statusCode).toBe(201)
    expect(two.json().tableId).not.toBeNull()

    const concept = await prisma.concept.findUniqueOrThrow({ where: { id: C.conceptId }, select: { slug: true } })
    const av = await app.inject({ method: 'GET', url: `/reservations/availability?conceptSlug=${concept.slug}&date=${slot.slice(0, 10)}&partySize=2` })
    expect(av.statusCode).toBe(200)
    const s = av.json().slots.find((x: { time: string }) => x.time === slot)
    expect(s).toMatchObject({ available: true })
    expect(s.tablesAvailable).toBeGreaterThanOrEqual(6)
  })

  it('O-RV-1: the window still fills — the 8 tables take 8 parties, the 9th gets SLOT_FULL', async () => {
    const slot = at(2, 9)
    await legacy(C, slot, 20)   // an older staff booking past capacity: set aside
    for (let i = 0; i < 8; i++) {
      const r = await book(hostC, C, { partySize: 4, startTime: slot, guestName: `P${i}` })
      expect(r.statusCode).toBe(201)
    }
    const ninth = await book(hostC, C, { partySize: 2, startTime: slot, guestName: 'Ninth' })
    expect(ninth.statusCode).toBe(409)
    expect(ninth.json().error.code).toBe('SLOT_FULL')
  })

  it('O-RV-2: naming the only 4-top that a tableless party of 4 needs → 409 SLOT_FULL, nothing stored', async () => {
    const slot = at(3)
    await legacy(D, slot, 4)
    const tableless = await book(hostD, D, { startTime: slot, guestName: 'Second' })
    expect(tableless.statusCode).toBe(409)
    const before = await prisma.reservation.count({ where: { conceptId: D.conceptId } })
    const named = await book(hostD, D, { startTime: slot, guestName: 'Named', tableId: d4 })
    expect(named.statusCode).toBe(409)
    expect(named.json().error.code).toBe('SLOT_FULL')
    expect(named.json().error.details).toMatchObject({ overbookAllowed: true, managerRequired: true })
    expect(await prisma.reservation.count({ where: { conceptId: D.conceptId } })).toBe(before)
    // A table the tableless party does not need is fine.
    const onTwo = await book(hostD, D, { partySize: 2, startTime: slot, guestName: 'Pair', tableId: d2 })
    expect(onTwo.statusCode).toBe(201)
    expect(onTwo.json().tableId).toBe(d2)
  })

  it('O-RV-2: a host with the manager’s PIN may overbook a named table — flagged and audited', async () => {
    const slot = at(4)
    await legacy(D, slot, 4)
    const r = await book(hostD, D, { startTime: slot, guestName: 'Pushed', tableId: d4, overbook: true, overbookReason: 'regular, will share', managerOverridePin: PIN_D })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ tableId: d4, overbooked: true })
    const log = await prisma.auditLog.findFirst({ where: { action: 'reservation.overbook', entityId: r.json().id } })
    expect(log!.tenantId).toBe(D.tenantId)
    expect(log!.metadata).toMatchObject({ approverId: mgrD.id, viaPin: true })
  })

  it('O-RV-2: PATCH onto a needed table, or a bigger party into a full window → 409; harmless edits pass', async () => {
    const slot = at(5)
    const later = at(5, 12)
    await legacy(D, slot, 4)
    const onTwo = await legacy(D, later, 2, d2)
    // Move the 2 onto B4 at the legacy party's time → strands the legacy 4.
    const strand = await patch(hostD, onTwo.id, { startTime: slot, tableId: d4 })
    expect(strand.statusCode).toBe(409)
    expect(strand.json().error.code).toBe('SLOT_FULL')
    // Same move keeping the 2-top: fine.
    const keep = await patch(hostD, onTwo.id, { startTime: slot })
    expect(keep.statusCode).toBe(200)
    expect(new Date(keep.json().startTime).toISOString()).toBe(slot)

    // A tableless 2 grows to 4 at the legacy party's time: no 4-top left.
    const y = await legacy(D, later, 2)
    const grow = await patch(hostD, y.id, { partySize: 4, startTime: slot })
    expect(grow.statusCode).toBe(409)
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: y.id }, select: { partySize: true } })).toMatchObject({ partySize: 2 })
    // A manager overbooks the change on their own login.
    const ok = await patch(mgrD, y.id, { partySize: 4, startTime: slot, overbook: true, overbookReason: 'birthday, tables pushed' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ partySize: 4, overbooked: true })
    expect(ok.json().notes).toMatch(/Overbooked: birthday, tables pushed/)
    // A name change on that over-capacity row is never refused.
    const rename = await patch(hostD, y.id, { guestName: 'Renamed' })
    expect(rename.statusCode).toBe(200)
  })

  it('two companies: C cannot book D’s brand (404), name D’s table (422) or edit D’s booking (404)', async () => {
    const slot = at(6)
    expect((await book(hostC, D, { startTime: slot })).statusCode).toBe(404)
    const foreignTable = await book(hostC, C, { startTime: slot, tableId: d4 })
    expect(foreignTable.statusCode).toBe(422)
    expect(foreignTable.json().error.code).toBe('TABLE_NOT_IN_BRAND')
    const dRow = await legacy(D, slot, 2, d2)
    expect((await patch(hostC, dRow.id, { guestName: 'Hijack' })).statusCode).toBe(404)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: dRow.id } })).guestName).toBe('Legacy')
  })
})
