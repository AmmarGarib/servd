// Online-ordering audit (2026-10-10) — public table booking, regression suite.
//
//   ONL-08  a public booking is given a table under the brand's booking lock,
//           and only if one fits once every overlapping booking (with or
//           without a table) is placed; availability counts unassigned
//           bookings too. (Five parties of six were accepted for one six-top.)
//   ONL-09  the unauthenticated form no longer makes servd WhatsApp / email
//           whatever number and address it is handed. Only a contact the
//           signed-in customer has verified on their own account is messaged
//           — at booking time and by the reminder worker.
//
// Two companies: the booking brand's company A, and company B whose own brand
// shares nothing with A's tables.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import jwt from 'jsonwebtoken'

// Capture outbound messages instead of sending them.
const sentPhone: Array<{ to: string; text: string }> = []
const sentEmail: Array<{ to: string; subject: string }> = []
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendPhoneMessage: async (to: string, text: string) => { sentPhone.push({ to, text }) },
  sendEmail: async (to: string, subject: string) => { sentEmail.push({ to, subject }) },
}))
vi.mock('../src/lib/whatsapp.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/whatsapp.js')>()),
  sendText: async (to: string, text: string) => { sentPhone.push({ to, text }); return {} },
}))

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { reservationRoutes } = await import('../src/modules/reservations/routes.js')
const { planSeat } = await import('../src/modules/reservations/capacity.js')
const { runReminderSweep } = await import('../src/workers/reservationReminders.js')
const { unverifiedCap } = await import('../src/modules/reservations/capacity.js')
const { pktDayOfWeek, sittingInHours } = await import('../src/modules/reservations/hours.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')

const RUN = Math.random().toString(36).slice(2, 8)
/** A phone unique to this run: +92300 + 7 digits. */
const RUN_DIGITS = String(Math.floor(Math.random() * 900) + 100)
const runPhone = (n: number) => `+92300${RUN_DIGITS}${String(n).padStart(4, '0')}`
const HOUR = 3_600_000
const DAY = 86_400_000

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let slugA: string, slugB: string
let sixTop: string, twoTop: string, sixTopB: string

/** "YYYY-MM-DD" of the Karachi day `days` from today. */
function pktDate(days: number): string {
  return new Date(Date.now() + 5 * HOUR + days * DAY).toISOString().slice(0, 10)
}
/** ISO instant of HH:MM Karachi time, `days` from today. */
function pktAt(days: number, hhmm: string): string {
  return new Date(`${pktDate(days)}T${hhmm}:00+05:00`).toISOString()
}

let phoneSeq = 0
const nextPhone = () => `0333${RUN.replace(/\D/g, '').padEnd(3, '7').slice(0, 3)}${String(++phoneSeq).padStart(4, '0')}`

// UX-5 (owner, 2026-10-16): every customer booking needs a signed-in servd
// account. With no bearer given, the helper books as a fresh signed-in member
// whose phone is NOT verified — the old "anonymous guest" of these suites.
const book = async (payload: Record<string, unknown>, bearer?: string) => {
  let token = bearer
  if (!token) {
    const c = await prisma.customer.create({ data: { name: 'Guest', phone: `+92${nextPhone().slice(1)}` } })
    token = customerToken(c.id)
  }
  return app.inject({
    method: 'POST', url: '/reservations/public',
    payload: { conceptSlug: slugA, partySize: 2, guestName: 'Guest', ...payload } as never,
    headers: { authorization: `Bearer ${token}` },
  })
}
const availability = (slug: string, days: number, partySize: number, bearer?: string) => app.inject({
  method: 'GET', url: `/reservations/availability?conceptSlug=${slug}&date=${pktDate(days)}&partySize=${partySize}`,
  headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
})
const slotAt = (res: { json: () => { slots: Array<{ time: string; available: boolean; tablesAvailable?: number }> } }, iso: string) =>
  res.json().slots.find((s) => s.time === iso)

const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })

/** A signed-in customer with a verified phone, and a booking in their own name. */
let vSeq = 0
async function verifiedGuest() {
  vSeq += 1
  const phone = `+92301${RUN.replace(/\D/g, '').padEnd(3, '5').slice(0, 3)}${String(vSeq).padStart(4, '0')}`
  const c = await prisma.customer.create({ data: { name: `Verified ${vSeq}`, phone, phoneVerifiedAt: new Date() } })
  return { id: c.id, phone, token: customerToken(c.id) }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Booking A', slug: `booking-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Booking B', slug: `booking-b-${RUN}` } })).id
  slugA = `book-a-${RUN}`; slugB = `book-b-${RUN}`
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd', slug: slugA, type: 'restaurant', tenantId: tenantA, isActive: true, reservationsEnabled: true } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'KGC', slug: slugB, type: 'restaurant', tenantId: tenantB, isActive: true, reservationsEnabled: true } as never })).id
  sixTop = (await prisma.table.create({ data: { conceptId: conceptA, label: 'T6', capacity: 6 } })).id
  twoTop = (await prisma.table.create({ data: { conceptId: conceptA, label: 'T2', capacity: 2 } })).id
  sixTopB = (await prisma.table.create({ data: { conceptId: conceptB, label: 'B6', capacity: 6 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

beforeEach(() => {
  sentPhone.length = 0
  sentEmail.length = 0
})

// ─── ONL-08 — capacity ───────────────────────────────────────────────────────

describe('planSeat — the one capacity rule', () => {
  const tables = [{ id: 't6', capacity: 6 }, { id: 't2', capacity: 2 }, { id: 't4', capacity: 4 }]

  it('gives the smallest table that fits', () => {
    expect(planSeat(tables, [], 2)).toEqual({ tableId: 't2', tablesAvailable: 3 })
    expect(planSeat(tables, [], 3)).toEqual({ tableId: 't4', tablesAvailable: 2 })
    expect(planSeat(tables, [], 7)).toEqual({ tableId: null, tablesAvailable: 0 })
  })

  it('a booking with a table holds it; one without still needs one', () => {
    expect(planSeat(tables, [{ tableId: 't6', partySize: 6 }], 5)).toEqual({ tableId: null, tablesAvailable: 0 })
    // An unplaced party of 5 can only take the six-top: a new party of 5 cannot sit.
    expect(planSeat(tables, [{ tableId: null, partySize: 5 }], 5).tableId).toBeNull()
    // …but a party of 4 still can (the four-top), and is not handed the six-top.
    expect(planSeat(tables, [{ tableId: null, partySize: 5 }], 4)).toEqual({ tableId: 't4', tablesAvailable: 1 })
    // A waiting-list entry without a table holds nothing.
    expect(planSeat(tables, [{ tableId: null, partySize: 6, waitlist: true }], 6).tableId).toBe('t6')
  })

  it('places larger unplaced parties first, so a smaller one never strands them', () => {
    // Unplaced 2 and 6; new party of 4. Largest first: 6→t6, 4→t4, 2→t2.
    expect(planSeat(tables, [{ tableId: null, partySize: 2 }, { tableId: null, partySize: 6 }], 4).tableId).toBe('t4')
    // Unplaced 4 and 4: the new 4 would need a third table that fits.
    expect(planSeat(tables, [{ tableId: null, partySize: 4 }, { tableId: null, partySize: 4 }], 4).tableId).toBeNull()
  })
})

describe('ONL-08: a public booking needs a free table', () => {
  it('five parties of six for one six-top: the first is seated, the rest are refused, availability agrees', async () => {
    const at = pktAt(1, '20:00')
    const statuses: number[] = []
    let first: { id: string } | null = null
    for (let i = 0; i < 5; i++) {
      const r = await book({ partySize: 6, startTime: at, guestName: `Party ${i}` })
      statuses.push(r.statusCode)
      if (r.statusCode === 201 && !first) first = r.json()
      if (r.statusCode !== 201) expect(r.json().error.code).toBe('SLOT_FULL')
    }
    expect(statuses).toEqual([201, 409, 409, 409, 409])
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: first!.id } })).tableId).toBe(sixTop)

    const six = await availability(slugA, 1, 6)
    expect(slotAt(six, at)).toMatchObject({ available: false, tablesAvailable: 0 })
    // The two-top is still free for a couple — a signed-in, verified one. An
    // anonymous guest is past the unverified share (ONLINE-R2: one of A's two
    // tables) and is asked to sign in.
    const v = await verifiedGuest()
    const two = await availability(slugA, 1, 2, v.token)
    expect(slotAt(two, at)).toMatchObject({ available: true, tablesAvailable: 1 })
    expect(slotAt(await availability(slugA, 1, 2), at)).toMatchObject({ available: false, reason: 'sign_in' })
    // Company B's identical slot is untouched by A's bookings.
    expect(slotAt(await availability(slugB, 1, 6), at)).toMatchObject({ available: true })
  })

  it('a staff booking with no table yet still takes a table out of the count', async () => {
    const staffAt = pktAt(2, '18:00')
    await prisma.reservation.create({
      data: {
        conceptId: conceptA, partySize: 6, startTime: new Date(staffAt), endTime: new Date(new Date(staffAt).getTime() + 90 * 60_000),
        guestName: 'Phoned in', source: 'phone', status: 'confirmed',
      },
    })
    const at = pktAt(2, '18:30')
    expect(slotAt(await availability(slugA, 2, 6), at)).toMatchObject({ available: false })
    const r = await book({ partySize: 6, startTime: at })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('SLOT_FULL')
    // A couple fits the two-top beside it.
    const couple = await book({ partySize: 2, startTime: at })
    expect(couple.statusCode).toBe(201)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: couple.json().id } })).tableId).toBe(twoTop)
  })

  it('couples fill the smallest table first, then the next; a third is refused', async () => {
    const at = pktAt(3, '20:00')
    const [va, vb, vc] = [await verifiedGuest(), await verifiedGuest(), await verifiedGuest()]
    const a = await book({ partySize: 2, startTime: at, guestPhone: va.phone }, va.token)
    const b = await book({ partySize: 2, startTime: at, guestPhone: vb.phone }, vb.token)
    const c = await book({ partySize: 2, startTime: at, guestPhone: vc.phone }, vc.token)
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([201, 201, 409])
    const tablesUsed = await prisma.reservation.findMany({ where: { id: { in: [a.json().id, b.json().id] } }, select: { tableId: true } })
    expect(tablesUsed.map((t) => t.tableId).sort()).toEqual([sixTop, twoTop].sort())
  })

  it('simultaneous bookings for the last table: exactly one wins', async () => {
    const at = pktAt(4, '20:00')
    const res = await Promise.all([0, 1, 2, 3].map((i) => book({ partySize: 5, startTime: at, guestName: `Race ${i}` })))
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409])
    expect(await prisma.reservation.count({ where: { conceptId: conceptA, startTime: new Date(at), status: 'booked' } })).toBe(1)
  })

  it('a slot after the sitting ends is free again', async () => {
    const r = await book({ partySize: 6, startTime: pktAt(1, '21:30') })   // 20:00 + 90 min
    expect(r.statusCode).toBe(201)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })).tableId).toBe(sixTop)
  })

  it("never seats a party at another company's table", async () => {
    const at = pktAt(5, '20:00')
    const r = await book({ partySize: 6, startTime: at })
    expect(r.statusCode).toBe(201)
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row.tableId).not.toBe(sixTopB)
    expect(row.conceptId).toBe(conceptA)
  })
})

// ─── ONL-09 — who is messaged ────────────────────────────────────────────────

describe('ONL-09: only a verified contact of the signed-in customer is messaged', () => {
  let verified: { id: string; phone: string; email: string }
  let unverified: { id: string; phone: string }

  beforeAll(async () => {
    verified = await prisma.customer.create({
      data: { name: 'Sana', phone: runPhone(1), email: `sana.${RUN}@example.com`, phoneVerifiedAt: new Date(), emailVerifiedAt: new Date() },
    }) as never
    unverified = await prisma.customer.create({
      data: { name: 'Omar', phone: runPhone(2), email: `omar.${RUN}@example.com` },
    }) as never
  })

  it('a member without a verified contact is booked but messaged nobody, now or as a reminder', async () => {
    const r = await book({ startTime: pktAt(6, '20:00'), guestPhone: '03335550101', guestEmail: `victim.${RUN}@example.com` }, customerToken(unverified.id))
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ notified: { whatsapp: false, email: false, reminders: false } })
    expect(r.json().confirmUrl).toContain(`/reserve/confirm/${r.json().confirmToken}`)
    await new Promise((res) => setTimeout(res, 50))
    expect(sentPhone).toEqual([])
    expect(sentEmail).toEqual([])
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    // The typed phone / email are ignored: the row carries the account's own.
    expect(row).toMatchObject({ guestPhone: unverified.phone, guestEmail: `omar.${RUN}@example.com`, customerId: unverified.id })
    expect(row.reminder24hSentAt).not.toBeNull()
  })

  it('a member with a verified phone and email is messaged on their own contacts', async () => {
    const r = await book({ startTime: pktAt(6, '18:00') }, customerToken(verified.id))
    expect(r.statusCode).toBe(201)
    expect(r.json().notified).toEqual({ whatsapp: true, email: true, reminders: true })
    await new Promise((res) => setTimeout(res, 50))
    expect(sentPhone.map((m) => m.to)).toEqual([verified.phone])
    expect(sentEmail.map((m) => m.to)).toEqual([verified.email])
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row.customerId).toBe(verified.id)
    expect(row.reminder24hSentAt).toBeNull()
  })

  it("a member typing someone else's number: the stranger is never stored or messaged", async () => {
    const r = await book({ startTime: pktAt(7, '20:00'), guestPhone: '03335550202', guestEmail: `stranger.${RUN}@example.com` }, customerToken(verified.id))
    expect(r.statusCode).toBe(201)
    await new Promise((res) => setTimeout(res, 50))
    expect(sentPhone.some((m) => m.to.includes('3335550202'))).toBe(false)
    expect(sentEmail.some((m) => m.to.startsWith('stranger.'))).toBe(false)
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row).toMatchObject({ customerId: verified.id, guestPhone: verified.phone, guestEmail: verified.email })
  })

  it('the reminder worker reminds the verified booking and never the anonymous one', async () => {
    // At company B's brand (its own table), two sittings apart, both inside
    // the 24 h reminder lead at the sweep time below.
    const minute = (t: number) => new Date(Math.ceil(t / 60_000) * 60_000).toISOString()
    const anonC = await prisma.customer.create({ data: { name: 'Unverified', phone: '+923335550404', email: `victim2.${RUN}@example.com` } })
    const anon = await book({ conceptSlug: slugB, startTime: minute(Date.now() + 30 * HOUR), partySize: 2 }, customerToken(anonC.id))
    const mine = await book({ conceptSlug: slugB, startTime: minute(Date.now() + 32 * HOUR), partySize: 2 }, customerToken(verified.id))
    expect([anon.statusCode, mine.statusCode]).toEqual([201, 201])
    sentPhone.length = 0
    sentEmail.length = 0

    const res = await runReminderSweep(new Date(Date.now() + 9 * HOUR))
    expect(res.reminded).toContain(mine.json().id)
    expect(res.reminded).not.toContain(anon.json().id)
    expect(sentPhone.some((m) => m.to.endsWith('3335550404'))).toBe(false)
    expect(sentEmail.some((m) => m.to === `victim2.${RUN}@example.com`)).toBe(false)
    expect(sentPhone.some((m) => m.to.replace(/\D/g, '').endsWith(verified.phone.slice(-10)))).toBe(true)
  })
})

// ─── ONLINE-R2 — unverified bookings take a share, sittings are policy-length ─

describe('ONLINE-R2: anonymous bookings cannot fill the book', () => {
  let slugC: string
  let slugCB: string
  beforeAll(async () => {
    // Company A: a brand with six four-tops. Company B: the same, untouched.
    slugC = `book-c-${RUN}`; slugCB = `book-cb-${RUN}`
    const c = await prisma.concept.create({ data: { name: 'Flipd', slug: slugC, type: 'restaurant', tenantId: tenantA, isActive: true, reservationsEnabled: true } as never })
    const cb = await prisma.concept.create({ data: { name: 'Simmer', slug: slugCB, type: 'restaurant', tenantId: tenantB, isActive: true, reservationsEnabled: true } as never })
    for (let i = 0; i < 6; i++) {
      await prisma.table.create({ data: { conceptId: c.id, label: `C${i}`, capacity: 4 } })
      await prisma.table.create({ data: { conceptId: cb.id, label: `CB${i}`, capacity: 4 } })
    }
  })

  it('unverifiedCap: a third of the tables, at least one', () => {
    expect([1, 2, 3, 6, 7, 12].map(unverifiedCap)).toEqual([1, 1, 1, 2, 2, 4])
  })

  it('a client-chosen 240-minute sitting is ignored: the booking holds the policy length', async () => {
    const at = pktAt(9, '19:00')
    const r = await book({ startTime: at, durationMin: 240 })
    expect(r.statusCode).toBe(201)
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row.endTime.getTime() - row.startTime.getTime()).toBe(90 * 60_000)
  })

  it('six tables: two anonymous bookings per sitting, then sign-in; verified guests fill the rest; company B is untouched', async () => {
    const at = pktAt(10, '19:00')
    const anon = [] as number[]
    for (let i = 0; i < 3; i++) anon.push((await book({ conceptSlug: slugC, startTime: at, partySize: 2, guestName: `Anon ${i}` })).statusCode)
    expect(anon).toEqual([201, 201, 409])
    const third = await book({ conceptSlug: slugC, startTime: at, partySize: 2 })
    expect(third.json().error).toMatchObject({ code: 'SLOT_FULL', details: { signInToBook: true } })

    // Availability says the same: sign in (anonymous), free (verified).
    const v1 = await verifiedGuest()
    expect(slotAt(await availability(slugC, 10, 2), at)).toMatchObject({ available: false, reason: 'sign_in' })
    expect(slotAt(await availability(slugC, 10, 2, v1.token), at)).toMatchObject({ available: true, tablesAvailable: 4 })

    // Verified guests take the other four tables; the fifth finds it full.
    const verified: number[] = []
    for (let i = 0; i < 5; i++) {
      const v = i === 0 ? v1 : await verifiedGuest()
      verified.push((await book({ conceptSlug: slugC, startTime: at, partySize: 2, guestPhone: v.phone }, v.token)).statusCode)
    }
    expect(verified).toEqual([201, 201, 201, 201, 409])

    // A signed-in guest whose phone is not verified is still "unverified".
    const unv = await prisma.customer.create({ data: { name: 'Unverified', phone: runPhone(3) } })
    const later = pktAt(10, '21:00')
    await book({ conceptSlug: slugC, startTime: later, partySize: 2 })
    await book({ conceptSlug: slugC, startTime: later, partySize: 2 })
    const u = await book({ conceptSlug: slugC, startTime: later, partySize: 2, guestPhone: unv.phone }, customerToken(unv.id))
    expect(u.statusCode).toBe(409)

    // Company B's identical brand and sitting: A's anonymous bookings do not count there.
    expect(slotAt(await availability(slugCB, 10, 2), at)).toMatchObject({ available: true })
    expect((await book({ conceptSlug: slugCB, startTime: at, partySize: 2 })).statusCode).toBe(201)
  })

  it('a seated website booking (the guest turned up) no longer counts against the share', async () => {
    const at = pktAt(11, '19:00')
    const a = await book({ conceptSlug: slugC, startTime: at, partySize: 2 })
    const b = await book({ conceptSlug: slugC, startTime: at, partySize: 2 })
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    await prisma.reservation.update({ where: { id: a.json().id }, data: { status: 'seated', seatedAt: new Date() } })
    expect((await book({ conceptSlug: slugC, startTime: at, partySize: 2 })).statusCode).toBe(201)
  })
})

// ─── ONLINE-R3 — the requested Karachi day's hours ───────────────────────────

describe("ONLINE-R3: availability and booking use the requested day's hours", () => {
  let slugH: string
  const LUNCH_DAYS = 12
  beforeAll(async () => {
    slugH = `book-h-${RUN}`
    const h = await prisma.concept.create({ data: { name: 'Stackd', slug: slugH, type: 'restaurant', tenantId: tenantB, isActive: true, reservationsEnabled: true } as never })
    await prisma.table.create({ data: { conceptId: h.id, label: 'H4', capacity: 4 } })
    // Lunch 12:00–15:00 on ONE weekday only: the weekday of that date in Karachi.
    await prisma.serviceHours.create({ data: { conceptId: h.id, dayOfWeek: pktDayOfWeek(pktDate(LUNCH_DAYS)), openMin: 12 * 60, closeMin: 15 * 60 } })
  })

  it('pktDayOfWeek reads the Karachi calendar day (2026-10-12 is a Monday)', () => {
    expect(pktDayOfWeek('2026-10-12')).toBe(1)
    expect(pktDayOfWeek('2026-10-11')).toBe(0)
  })

  it('sittingInHours: inside, overlapping the close, overnight, and no hours set', () => {
    const mon = [{ dayOfWeek: 1, openMin: 720, closeMin: 900, isReservable: true }]
    expect(sittingInHours(mon, new Date('2026-10-12T12:00:00+05:00'), 90)).toBe(true)
    expect(sittingInHours(mon, new Date('2026-10-12T14:00:00+05:00'), 90)).toBe(false)
    expect(sittingInHours(mon, new Date('2026-10-13T12:00:00+05:00'), 90)).toBe(false)
    const late = [{ dayOfWeek: 5, openMin: 20 * 60, closeMin: 2 * 60, isReservable: true }]   // Fri 20:00 → Sat 02:00
    expect(sittingInHours(late, new Date('2026-10-09T23:30:00+05:00'), 90)).toBe(true)
    expect(sittingInHours(late, new Date('2026-10-10T00:15:00+05:00'), 90)).toBe(true)
    expect(sittingInHours([], new Date('2026-10-10T04:00:00+05:00'), 90)).toBe(true)
    const walkInOnly = [{ dayOfWeek: 1, openMin: 720, closeMin: 900, isReservable: false }]
    expect(sittingInHours(walkInOnly, new Date('2026-10-12T12:00:00+05:00'), 90)).toBe(false)
  })

  it('only the lunch weekday has slots — the day after (which used to read them) has none', async () => {
    const lunch = (await availability(slugH, LUNCH_DAYS, 2)).json()
    const times = lunch.slots.map((x: { time: string }) => x.time)
    expect(times).toEqual(['12:00', '12:30', '13:00', '13:30'].map((t) => pktAt(LUNCH_DAYS, t)))
    expect((await availability(slugH, LUNCH_DAYS + 1, 2)).json().slots).toEqual([])
    expect((await availability(slugH, LUNCH_DAYS - 1, 2)).json().slots).toEqual([])
  })

  it('a booking outside the day’s hours is refused; inside is accepted', async () => {
    const ok = await book({ conceptSlug: slugH, startTime: pktAt(LUNCH_DAYS, '12:30') })
    expect(ok.statusCode).toBe(201)
    const nextDay = await book({ conceptSlug: slugH, startTime: pktAt(LUNCH_DAYS + 1, '12:30') })
    expect(nextDay.statusCode).toBe(409)
    expect(nextDay.json().error.code).toBe('CLOSED')
    const evening = await book({ conceptSlug: slugH, startTime: pktAt(LUNCH_DAYS, '18:00') })
    expect(evening.statusCode).toBe(409)
    const pastClose = await book({ conceptSlug: slugH, startTime: pktAt(LUNCH_DAYS, '14:00') })   // 14:00 + 90 > 15:00
    expect(pastClose.statusCode).toBe(409)
  })
})

// ─── F6 — the completion bonus books its liability ───────────────────────────

describe('completing a reservation: the 100-point bonus is a booked liability of the brand’s company', () => {
  it('credits the account at A, books Dr 6060 / Cr 2060 in A’s books, and only once', async () => {
    await ensureChartOfAccounts(tenantA)
    await ensureChartOfAccounts(tenantB)
    const u = await prisma.user.create({
      data: { name: 'Host A', email: `host.${RUN}@gsfoods.pk`, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId: tenantA } as never,
    })
    await prisma.tenantMember.create({ data: { tenantId: tenantA, userId: u.id } })
    const staffToken = (issueStaffSession(u) as { accessToken: string }).accessToken
    const guest = await verifiedGuest()
    // An account at company B already exists — it must not be the one credited.
    await prisma.loyaltyAccount.create({ data: { tenantId: tenantB, customerId: guest.id, pointsBalance: 0 } })
    const start = new Date(Date.now() - HOUR)
    const r = await prisma.reservation.create({
      data: { conceptId: conceptA, customerId: guest.id, partySize: 2, startTime: start, endTime: new Date(start.getTime() + 90 * 60_000), guestName: 'Bonus', source: 'website', status: 'seated' },
    })
    const complete = () => app.inject({ method: 'POST', url: `/reservations/${r.id}/complete`, headers: { authorization: `Bearer ${staffToken}` } })
    expect((await complete()).statusCode).toBe(200)
    expect((await complete()).statusCode).toBe(200)

    const accA = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { tenantId_customerId: { tenantId: tenantA, customerId: guest.id } } })
    const accB = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { tenantId_customerId: { tenantId: tenantB, customerId: guest.id } } })
    expect(accA.pointsBalance).toBe(100)
    expect(accB.pointsBalance).toBe(0)
    const earns = await prisma.loyaltyTransaction.findMany({ where: { loyaltyAccountId: accA.id, type: 'earn' } })
    expect(earns).toHaveLength(1)
    const je = await prisma.journalEntry.findFirst({
      where: { tenantId: tenantA, reference: `loyalty.earn:${earns[0]!.id}` },
      include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
    })
    expect(je).not.toBeNull()
    const lines = je!.lines.map((l) => [l.account.code, l.type, l.account.tenantId])
    expect(lines).toEqual(expect.arrayContaining([['6060', 'debit', tenantA], ['2060', 'credit', tenantA]]))
    const sum = (t: string) => je!.lines.filter((l) => l.type === t).reduce((a, l) => a + l.amountCents, 0)
    expect(sum('debit')).toBe(sum('credit'))
    expect(sum('debit')).toBeGreaterThan(0)
  })
})
