// UX-5 (owner, 2026-10-16): "only servd members have access to reservations..
// and can reserve as far ahead as they want, but accounts are limited to 5
// total bookings at one time."
//
//   - POST /reservations/public needs a signed-in customer (401 AUTH_REQUIRED);
//     the phone and email on the booking are the account's own.
//   - no "how far ahead" limit for a member; the past is still refused.
//   - at most 5 live upcoming bookings per account, counted across every
//     brand of every company, under a per-account lock (409
//     BOOKING_LIMIT_REACHED); cancelled / no-show / completed / ended ones
//     do not count.
//   - staff bookings (POST /reservations) are not capped.
//   - a banned account is still refused.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import jwt from 'jsonwebtoken'

vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendPhoneMessage: async () => {},
  sendEmail: async () => {},
}))

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { reservationRoutes, MAX_ACTIVE_BOOKINGS_PER_ACCOUNT } = await import('../src/modules/reservations/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')

const RUN = Math.random().toString(36).slice(2, 8)
const DIG = String(Math.floor(Math.random() * 900) + 100)
const HOUR = 3_600_000
const DAY = 86_400_000

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string
let slugA: string, slugB: string
let staffTokenA: string

let seq = 0
const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
async function member(verified = true) {
  seq += 1
  const phone = `+92302${DIG}${String(seq).padStart(4, '0')}`
  const c = await prisma.customer.create({
    data: { name: `Member ${seq}`, phone, email: `m${seq}.${RUN}@example.com`, ...(verified && { phoneVerifiedAt: new Date() }) },
  })
  return { id: c.id, phone, token: customerToken(c.id) }
}

/** A Karachi 19:00 sitting `days` from now, offset by `slot` half-hours. */
function at(days: number, slot = 0): string {
  const d = new Date(Date.now() + 5 * HOUR + days * DAY).toISOString().slice(0, 10)
  return new Date(new Date(`${d}T19:00:00+05:00`).getTime() + slot * 30 * 60_000).toISOString()
}

const book = (payload: Record<string, unknown>, token?: string) => app.inject({
  method: 'POST', url: '/reservations/public',
  payload: { conceptSlug: slugA, partySize: 2, ...payload } as never,
  headers: token ? { authorization: `Bearer ${token}` } : {},
})

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Members A', slug: `members-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Members B', slug: `members-b-${RUN}` } })).id
  slugA = `mem-a-${RUN}`; slugB = `mem-b-${RUN}`
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd', slug: slugA, type: 'restaurant', tenantId: tenantA, isActive: true, reservationsEnabled: true } as never })).id
  const conceptB = (await prisma.concept.create({ data: { name: 'Flipd', slug: slugB, type: 'restaurant', tenantId: tenantB, isActive: true, reservationsEnabled: true } as never })).id
  for (let i = 0; i < 12; i++) {
    await prisma.table.create({ data: { conceptId: conceptA, label: `A${i}`, capacity: 4 } })
    await prisma.table.create({ data: { conceptId: conceptB, label: `B${i}`, capacity: 4 } })
  }
  const u = await prisma.user.create({
    data: { name: 'Host A', email: `host.${RUN}@gsfoods.pk`, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId: tenantA } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId: tenantA, userId: u.id } })
  staffTokenA = (issueStaffSession(u) as { accessToken: string }).accessToken

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

afterAll(async () => { await app?.close() })

describe('UX-5: servd members only', () => {
  it('signed out: 401 AUTH_REQUIRED, nothing stored', async () => {
    const before = await prisma.reservation.count({ where: { conceptId: conceptA } })
    const r = await book({ startTime: at(3), guestName: 'Anon', guestPhone: '03335550101' })
    expect(r.statusCode).toBe(401)
    expect(r.json().error.code).toBe('AUTH_REQUIRED')
    expect(await prisma.reservation.count({ where: { conceptId: conceptA } })).toBe(before)
  })

  it('a staff token, a garbage token, or a deleted account is not a member: 401', async () => {
    expect((await book({ startTime: at(3) }, staffTokenA)).json().error.code).toBe('AUTH_REQUIRED')
    expect((await book({ startTime: at(3) }, 'not-a-jwt')).statusCode).toBe(401)
    const gone = await member()
    await prisma.customer.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
    expect((await book({ startTime: at(3) }, gone.token)).json().error.code).toBe('AUTH_REQUIRED')
  })

  it("the booking carries the account's own phone and email, never typed ones", async () => {
    const m = await member()
    const r = await book({ startTime: at(4), guestName: 'For my mother', guestPhone: '03335550999', guestEmail: 'stranger@example.com' }, m.token)
    expect(r.statusCode).toBe(201)
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row).toMatchObject({ customerId: m.id, guestPhone: m.phone, guestEmail: `m${seq}.${RUN}@example.com`, guestName: 'For my mother', source: 'website' })
  })

  it('no limit on how far ahead (two years out books); the past is still refused', async () => {
    const m = await member()
    const far = await book({ startTime: at(730) }, m.token)
    expect(far.statusCode).toBe(201)
    const past = await book({ startTime: new Date(Date.now() - DAY).toISOString() }, m.token)
    expect(past.statusCode).toBe(400)
    expect(past.json().error.code).toBe('TOO_SOON')
  })

  it('a banned account is still refused', async () => {
    const m = await member()
    await prisma.customerBan.create({ data: { customerId: m.id, phone: m.phone, reason: 'test', tenantId: tenantA } as never })
    const r = await book({ startTime: at(5) }, m.token)
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('BANNED')
  })
})

describe('UX-5: five live bookings per account, servd-wide', () => {
  it('the cap is five', () => {
    expect(MAX_ACTIVE_BOOKINGS_PER_ACCOUNT).toBe(5)
  })

  it('bookings at company A and company B both count; the sixth is 409 BOOKING_LIMIT_REACHED', async () => {
    const m = await member()
    const codes: number[] = []
    for (let i = 0; i < 5; i++) {
      codes.push((await book({ conceptSlug: i % 2 ? slugB : slugA, startTime: at(10 + i) }, m.token)).statusCode)
    }
    expect(codes).toEqual([201, 201, 201, 201, 201])
    const sixthA = await book({ startTime: at(20) }, m.token)
    expect(sixthA.statusCode).toBe(409)
    expect(sixthA.json().error).toMatchObject({ code: 'BOOKING_LIMIT_REACHED', details: { limit: 5, active: 5 } })
    expect(sixthA.json().error.message).toMatch(/Cancel one/)
    const sixthB = await book({ conceptSlug: slugB, startTime: at(21) }, m.token)
    expect(sixthB.json().error.code).toBe('BOOKING_LIMIT_REACHED')
    expect(await prisma.reservation.count({ where: { customerId: m.id } })).toBe(5)
    // Another member is not affected.
    const other = await member()
    expect((await book({ startTime: at(20) }, other.token)).statusCode).toBe(201)
  })

  it('parallel 5th and 6th bookings (two companies): exactly one wins', async () => {
    const m = await member()
    for (let i = 0; i < 4; i++) expect((await book({ startTime: at(30 + i) }, m.token)).statusCode).toBe(201)
    const res = await Promise.all([
      book({ startTime: at(40) }, m.token),
      book({ conceptSlug: slugB, startTime: at(41) }, m.token),
      book({ startTime: at(42) }, m.token),
    ])
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409, 409])
    expect(await prisma.reservation.count({ where: { customerId: m.id } })).toBe(5)
  })

  it('a cancelled booking frees a place (through the guest’s own cancel link); no-show, completed and ended ones do not count', async () => {
    const m = await member()
    const ids: string[] = []
    const tokens: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await book({ startTime: at(50 + i) }, m.token)
      expect(r.statusCode).toBe(201)
      ids.push(r.json().id); tokens.push(r.json().confirmToken)
    }
    expect((await book({ startTime: at(60) }, m.token)).statusCode).toBe(409)

    const cancel = await app.inject({ method: 'POST', url: `/reservations/public/${tokens[0]}`, payload: { action: 'cancel' } })
    expect(cancel.statusCode).toBe(200)
    expect((await book({ startTime: at(60) }, m.token)).statusCode).toBe(201)
    expect((await book({ startTime: at(61) }, m.token)).statusCode).toBe(409)

    await prisma.reservation.update({ where: { id: ids[1]! }, data: { status: 'no_show' } })
    await prisma.reservation.update({ where: { id: ids[2]! }, data: { status: 'completed', completedAt: new Date() } })
    // A sitting that has ended (still marked booked) is past, not upcoming.
    await prisma.reservation.update({ where: { id: ids[3]! }, data: { startTime: new Date(Date.now() - 3 * HOUR), endTime: new Date(Date.now() - HOUR) } })
    const more = [await book({ startTime: at(62) }, m.token), await book({ startTime: at(63) }, m.token), await book({ startTime: at(64) }, m.token)]
    expect(more.map((r) => r.statusCode)).toEqual([201, 201, 201])
    expect((await book({ startTime: at(65) }, m.token)).json().error.code).toBe('BOOKING_LIMIT_REACHED')
  })

  it('staff bookings are not capped: the host stand can book a member who is at five', async () => {
    const m = await member()
    for (let i = 0; i < 5; i++) expect((await book({ startTime: at(70 + i) }, m.token)).statusCode).toBe(201)
    const staff = await app.inject({
      method: 'POST', url: '/reservations',
      headers: { authorization: `Bearer ${staffTokenA}` },
      payload: { conceptId: conceptA, customerId: m.id, partySize: 2, startTime: at(6, 2), guestName: 'Phoned in', source: 'phone' },
    })
    expect(staff.statusCode).toBe(201)
    expect(await prisma.reservation.count({ where: { customerId: m.id } })).toBe(6)
    // …and the staff booking counts toward the member's own five.
    expect((await book({ startTime: at(80) }, m.token)).json().error.code).toBe('BOOKING_LIMIT_REACHED')
  })
})
