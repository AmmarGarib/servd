// Customer identity + "invite your table" (owner, 2026-10-26).
//
//   - every customer gets an internal memberCode 'SV' + 10 digits on ANY insert path (DB default), unique;
//   - the servd name (nickname): rules, reserved words, unique servd-wide case-insensitive, 409 / 422;
//   - phones: international numbers kept as E.164 digits, Pakistan normalisation unchanged;
//   - group orders: a member shows under their nickname;
//   - booking invites: link (hashed), preview, join (account needed), BOOKING_FULL, BOOKING_CLOSED, revoke,
//     the guest row carries the BRAND's company; staff guest list company-scoped (company B 404);
//   - CRM guest card carries the member code (company B 404).
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
const { reservationRoutes } = await import('../src/modules/reservations/routes.js')
const { groupOrderRoutes } = await import('../src/modules/groupOrders/routes.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const identityRoutes = (await import('../src/modules/storefront/identityRoutes.js')).default
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { normalisePhone } = await import('../src/modules/auth/otp.js')
const { whatsappNumber } = await import('../src/lib/notify.js')
const { checkNickname } = await import('../src/lib/nickname.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')

const RUN = Math.random().toString(36).slice(2, 8)
const DIG = String(Math.floor(Math.random() * 900) + 100)
const DAY = 86_400_000

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, slugA: string
let staffA: string, staffB: string

let seq = 0
const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
async function member(extra: Record<string, unknown> = {}) {
  seq += 1
  const c = await prisma.customer.create({
    data: { name: `Member ${seq} Khan`, phone: `92303${DIG}${String(seq).padStart(4, '0')}`, email: `ci${seq}.${RUN}@example.com`, phoneVerifiedAt: new Date(), ...extra } as never,
  })
  return { id: c.id, token: customerToken(c.id), memberCode: (c as { memberCode: string }).memberCode }
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` })

function sitting(days: number): string {
  const d = new Date(Date.now() + 5 * 3_600_000 + days * DAY).toISOString().slice(0, 10)
  return new Date(`${d}T19:00:00+05:00`).toISOString()
}

async function staffOf(tenantId: string, tag: string) {
  const u = await prisma.user.create({
    data: { name: `Host ${tag}`, email: `ci.${tag}.${RUN}@gsfoods.pk`, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  return (issueStaffSession(u) as { accessToken: string }).accessToken
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Ident A', slug: `ident-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Ident B', slug: `ident-b-${RUN}` } })).id
  slugA = `ident-a-${RUN}`
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer', slug: slugA, type: 'restaurant', tenantId: tenantA, isActive: true, reservationsEnabled: true } as never })).id
  await prisma.concept.create({ data: { name: 'Flipd', slug: `ident-b-${RUN}`, type: 'restaurant', tenantId: tenantB, isActive: true } as never })
  for (let i = 0; i < 6; i++) await prisma.table.create({ data: { conceptId: conceptA, label: `T${i}`, capacity: 4 } })
  staffA = await staffOf(tenantA, 'a')
  staffB = await staffOf(tenantB, 'b')

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.register(groupOrderRoutes, { prefix: '/group-orders' })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(identityRoutes, { prefix: '/storefront' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('member code', () => {
  it('is set on every new customer, SV + 10 digits, unique', async () => {
    const a = await member()
    const b = await prisma.customer.create({ data: { name: 'Till guest' } })
    expect(a.memberCode).toMatch(/^SV\d{10}$/)
    expect(b.memberCode).toMatch(/^SV\d{10}$/)
    expect(a.memberCode).not.toBe(b.memberCode)
  })
})

describe('the servd name', () => {
  it('rules', () => {
    expect(checkNickname('ab').problem).toBe('invalid')
    expect(checkNickname('a'.repeat(21)).problem).toBe('invalid')
    expect(checkNickname('ammar garib').problem).toBe('invalid')
    expect(checkNickname('.ammar').problem).toBe('invalid')
    expect(checkNickname('am..mar').problem).toBe('invalid')
    expect(checkNickname('admin').problem).toBe('reserved')
    expect(checkNickname('Servd_1').problem).toBe('reserved')
    expect(checkNickname('simmer.official').problem).toBe('reserved')
    expect(checkNickname('the.goat_92').problem).toBeNull()
  })

  it('availability, set, taken case-insensitively, invalid', async () => {
    const a = await member(), b = await member()
    const name = `Goat${RUN}`
    let r = await app.inject({ method: 'GET', url: `/storefront/account/nickname-available?q=${name}`, headers: auth(a.token) })
    expect(r.json()).toMatchObject({ available: true, reason: null })
    r = await app.inject({ method: 'PUT', url: '/storefront/account/nickname', headers: auth(a.token), payload: { nickname: name } })
    expect(r.statusCode).toBe(200)
    r = await app.inject({ method: 'GET', url: `/storefront/account/nickname-available?q=${name.toLowerCase()}`, headers: auth(a.token) })
    expect(r.json()).toMatchObject({ available: true, reason: 'yours' })
    r = await app.inject({ method: 'GET', url: `/storefront/account/nickname-available?q=${name.toUpperCase()}`, headers: auth(b.token) })
    expect(r.json()).toMatchObject({ available: false, reason: 'taken' })
    r = await app.inject({ method: 'PUT', url: '/storefront/account/nickname', headers: auth(b.token), payload: { nickname: name.toLowerCase() } })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NICKNAME_TAKEN')
    r = await app.inject({ method: 'PUT', url: '/storefront/account/nickname', headers: auth(b.token), payload: { nickname: 'admin' } })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NICKNAME_INVALID')
    r = await app.inject({ method: 'PUT', url: '/storefront/account/nickname', payload: { nickname: 'whoever' } })
    expect(r.statusCode).toBe(401)
  })
})

describe('phones', () => {
  it('keeps Pakistan normalisation and accepts international E.164', () => {
    expect(normalisePhone('0300 1234567')).toBe('923001234567')
    expect(normalisePhone('+92 300 1234567')).toBe('923001234567')
    expect(normalisePhone('+92 (0)300 1234567')).toBe('923001234567')
    expect(normalisePhone('0092 300 1234567')).toBe('923001234567')
    expect(normalisePhone('3001234567')).toBe('923001234567')
    expect(normalisePhone('+971 50 123 4567')).toBe('971501234567')
    expect(normalisePhone('+44 7911 123456')).toBe('447911123456')
    expect(normalisePhone('+1 202 555 0123')).toBe('12025550123')
    expect(normalisePhone('00971501234567')).toBe('971501234567')
    expect(normalisePhone('+65 8123 4567')).toBe('6581234567')
    expect(whatsappNumber('971501234567')).toBe('971501234567')
    expect(whatsappNumber('6581234567')).toBe('6581234567')
    expect(whatsappNumber('3001234567')).toBe('923001234567')
  })
})

describe('group orders take the servd name', () => {
  it('a member with a nickname joins under it; without one the typed name is needed', async () => {
    const host = await member()
    const nick = `Nick${RUN}`
    await prisma.customer.update({ where: { id: host.id }, data: { nickname: nick } })
    const code = `G${RUN.toUpperCase().slice(0, 5)}`.slice(0, 6)
    await prisma.groupOrder.create({ data: { conceptId: conceptA, initiatorName: 'x', shareCode: code } })
    let r = await app.inject({ method: 'POST', url: `/group-orders/${code}/join`, headers: auth(host.token), payload: { displayName: 'Typed' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().displayName).toBe(nick)
    const other = await member()
    r = await app.inject({ method: 'POST', url: `/group-orders/${code}/join`, headers: auth(other.token), payload: {} })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NAME_REQUIRED')
    r = await app.inject({ method: 'POST', url: `/group-orders/${code}/join`, payload: {} })
    expect(r.statusCode).toBe(401)
  })
})

describe('invite your table', () => {
  let host: Awaited<ReturnType<typeof member>>
  let reservationId: string
  let token: string

  it('the booker makes a link (stored hashed); the preview needs no account', async () => {
    host = await member()
    await prisma.customer.update({ where: { id: host.id }, data: { nickname: `Host${RUN}` } })
    let r = await app.inject({ method: 'POST', url: '/reservations/public', headers: auth(host.token), payload: { conceptSlug: slugA, partySize: 3, startTime: sitting(5) } })
    expect(r.statusCode).toBe(201)
    reservationId = r.json().id
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).guestName).toMatch(/Khan$/) // the proper name

    const stranger = await member()
    r = await app.inject({ method: 'POST', url: `/reservations/mine/${reservationId}/invite`, headers: auth(stranger.token) })
    expect(r.statusCode).toBe(404)

    r = await app.inject({ method: 'POST', url: `/reservations/mine/${reservationId}/invite`, headers: auth(host.token) })
    expect(r.statusCode).toBe(201)
    token = r.json().token
    expect(r.json().inviteUrl).toContain(`/reserve/invite/${token}`)
    expect(r.json().seatsLeft).toBe(2)
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })
    expect(row.inviteTokenHash).not.toBe(token)
    expect(row.inviteTokenHash).toHaveLength(64)

    r = await app.inject({ method: 'GET', url: `/reservations/invites/${token}` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ partySize: 3, seatsLeft: 2, host: `Host${RUN}`, joined: false, isHost: false })
  })

  it('joining needs an account; the guest row is the brand company; full at partySize − 1', async () => {
    let r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join` })
    expect(r.statusCode).toBe(401)
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join`, headers: auth(host.token) })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('HOST_IS_BOOKER')

    const g1 = await member(), g2 = await member(), g3 = await member()
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join`, headers: auth(g1.token) })
    expect(r.statusCode).toBe(201)
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join`, headers: auth(g1.token) })
    expect(r.statusCode).toBe(200) // already in
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join`, headers: auth(g2.token) })
    expect(r.statusCode).toBe(201)
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join`, headers: auth(g3.token) })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('BOOKING_FULL')
    const rows = await prisma.reservationGuest.findMany({ where: { reservationId } })
    expect(rows).toHaveLength(2)
    expect(rows.every((g) => g.tenantId === tenantA)).toBe(true)

    // The booker sees them (no contacts), removes one; a guest leaves.
    r = await app.inject({ method: 'GET', url: `/reservations/mine/${reservationId}/invite`, headers: auth(host.token) })
    expect(r.json()).toMatchObject({ active: true, seatsLeft: 0 })
    expect(JSON.stringify(r.json())).not.toContain('@example.com')
    const g2Row = rows.find((g) => g.customerId === g2.id)!
    r = await app.inject({ method: 'DELETE', url: `/reservations/mine/${reservationId}/guests/${g2Row.id}`, headers: auth(g1.token) })
    expect(r.statusCode).toBe(404)
    r = await app.inject({ method: 'DELETE', url: `/reservations/mine/${reservationId}/guests/${g2Row.id}`, headers: auth(host.token) })
    expect(r.statusCode).toBe(204)
    r = await app.inject({ method: 'DELETE', url: `/reservations/joined/${reservationId}`, headers: auth(g1.token) })
    expect(r.statusCode).toBe(204)
    expect(await prisma.reservationGuest.count({ where: { reservationId } })).toBe(0)
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${token}/join`, headers: auth(g3.token) })
    expect(r.statusCode).toBe(201)
  })

  it('staff see the guest list in their company only (company B 404)', async () => {
    let r = await app.inject({ method: 'GET', url: `/reservations/${reservationId}/guests`, headers: auth(staffA) })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toHaveLength(1)
    expect(r.json().data[0].memberCode).toMatch(/^SV\d{10}$/)
    r = await app.inject({ method: 'GET', url: `/reservations/${reservationId}/guests`, headers: auth(staffB) })
    expect(r.statusCode).toBe(404)
    // The invited guest's card opens for the booking's company (they are at its table), not for company B.
    const guestId = (await app.inject({ method: 'GET', url: `/reservations/${reservationId}/guests`, headers: auth(staffA) })).json().data[0].customerId
    r = await app.inject({ method: 'GET', url: `/crm/customers/${guestId}/context`, headers: auth(staffA) })
    expect(r.statusCode).toBe(200)
    r = await app.inject({ method: 'GET', url: `/crm/customers/${guestId}/context`, headers: auth(staffB) })
    expect(r.statusCode).toBe(404)
  })

  it('a new link kills the old one; revoke → 404; a cancelled booking → 410', async () => {
    let r = await app.inject({ method: 'POST', url: `/reservations/mine/${reservationId}/invite`, headers: auth(host.token) })
    const fresh = r.json().token as string
    r = await app.inject({ method: 'GET', url: `/reservations/invites/${token}` })
    expect(r.statusCode).toBe(404)
    r = await app.inject({ method: 'DELETE', url: `/reservations/mine/${reservationId}/invite`, headers: auth(host.token) })
    expect(r.statusCode).toBe(204)
    r = await app.inject({ method: 'GET', url: `/reservations/invites/${fresh}` })
    expect(r.statusCode).toBe(404)
    r = await app.inject({ method: 'POST', url: `/reservations/mine/${reservationId}/invite`, headers: auth(host.token) })
    const third = r.json().token as string
    await prisma.reservation.update({ where: { id: reservationId }, data: { status: 'cancelled', cancelledAt: new Date() } })
    r = await app.inject({ method: 'GET', url: `/reservations/invites/${third}` })
    expect(r.statusCode).toBe(410)
    expect(r.json().error.code).toBe('BOOKING_CLOSED')
    const late = await member()
    r = await app.inject({ method: 'POST', url: `/reservations/invites/${third}/join`, headers: auth(late.token) })
    expect(r.statusCode).toBe(410)
  })

  it('CRM guest card carries the member code; company B 404', async () => {
    let r = await app.inject({ method: 'GET', url: `/crm/customers/${host.id}/context`, headers: auth(staffA) })
    expect(r.statusCode).toBe(200)
    expect(r.json().memberCode).toBe(host.memberCode)
    expect(r.json().nickname).toBe(`Host${RUN}`)
    r = await app.inject({ method: 'GET', url: `/crm/customers/${host.id}/context`, headers: auth(staffB) })
    expect(r.statusCode).toBe(404)
  })
})
