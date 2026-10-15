// Strikes and bans per company (owner 2026-10-13; CLAUDE.md: bans stay inside
// the company that issued them). Three strikes at company A block the customer
// at A's brands only; company B is unaffected. Two companies, one brand each,
// a customer who orders at both.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { crmRoutes } from '../src/modules/crm/routes.js'
import {
  recordStrike, maybePromoteToBan, reverseStrike, assertNotBannedAtCompany, activeBanAtCompany,
  bannedCustomerIdsAtCompany, activeStrikeWeightAt,
} from '../src/lib/strikes.js'
import { markNoShow } from '../src/modules/reservations/noShow.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@strikes.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

let seq = 0
async function customer(key: string, conceptIds: string[]) {
  const c = await prisma.customer.create({
    data: { name: key, email: `${key}.${RUN}@strikes.test`, phone: `+92301${String(Date.now() % 1e4).padStart(4, '0')}${String(++seq).padStart(3, '0')}` },
  })
  for (const conceptId of conceptIds) {
    await prisma.order.create({
      data: {
        conceptId, customerId: c.id, source: 'pos', status: 'completed', totalCents: 5_000, completedAt: new Date(),
        items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: 5_000 }] },
      } as never,
    })
  }
  return c
}

const activeBans = (customerId: string) =>
  prisma.customerBan.findMany({ where: { customerId, liftedAt: null }, orderBy: { bannedAt: 'asc' } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Strikes A Co', slug: `str-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Strikes B Co', slug: `str-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Brand A', slug: `str-brand-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Brand B', slug: `str-brand-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('mgrA', 'management', tenantA)
  await mkUser('mgrB', 'management', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('three strikes block per company', () => {
  let cust: { id: string; phone: string | null }
  const aStrikes: string[] = []

  it('2 strikes at A + 1 at B → no ban; the mirror sums both', async () => {
    cust = await customer('three', [conceptA, conceptB])
    for (let i = 0; i < 2; i++) {
      const r = await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantA, reason: `a${i}` })
      expect(r).toMatchObject({ recorded: true, duplicate: false })
      expect(r.banId).toBeUndefined()
    }
    await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantB, reason: 'b0' })
    expect(await activeBans(cust.id)).toHaveLength(0)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })
    expect(c.strikeCount).toBe(3)
    expect(c.bannedAt).toBeNull()
    const rows = await prisma.customerStrike.findMany({ where: { customerId: cust.id } })
    expect(rows.map((r) => r.tenantId).sort()).toEqual([tenantA, tenantA, tenantB].sort())
    aStrikes.push(...rows.filter((r) => r.tenantId === tenantA).map((r) => r.id))
  })

  it('a third at A → a ban with tenantId A; A refuses with details, B allows', async () => {
    const r = await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantA, reason: 'a2' })
    expect(r.recorded).toBe(true)
    expect(r.banId).toBeTruthy()
    const bans = await activeBans(cust.id)
    expect(bans).toHaveLength(1)
    expect(bans[0]).toMatchObject({ id: r.banId, tenantId: tenantA, bannedById: null, phone: cust.phone })

    const err = await assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA, intent: 'order' }).catch((e) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'BANNED', statusCode: 403 })
    expect(err.details).toEqual({ banId: r.banId, companyName: 'Strikes A Co', appeal: { status: 'none', at: null } })
    // A fresh account with the same number is refused at A too, never at B.
    expect(await activeBanAtCompany({ phone: cust.phone, tenantId: tenantA })).not.toBeNull()
    await expect(assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantB, intent: 'order' })).resolves.toBeUndefined()
    expect(await bannedCustomerIdsAtCompany(tenantA)).toContain(cust.id)
    expect(await bannedCustomerIdsAtCompany(tenantB)).not.toContain(cust.id)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).bannedAt).not.toBeNull()
    aStrikes.push((await prisma.customerStrike.findFirstOrThrow({ where: { customerId: cust.id, reason: 'a2' } })).id)
  })

  it('an open appeal shows in the BANNED details', async () => {
    const ban = (await activeBans(cust.id))[0]!
    const appeal = await prisma.orderComplaint.create({
      data: { conceptId: conceptA, customerId: cust.id, title: 'Ban appeal', description: 'please', category: 'other', kind: 'ban_appeal', banId: ban.id },
    })
    const err = await assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA }).catch((e) => e)
    expect(err.details.appeal.status).toBe('open')
    await prisma.orderComplaint.update({ where: { id: appeal.id }, data: { status: 'closed', resolvedAt: new Date(), resolution: 'kept' } })
    const err2 = await assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA }).catch((e) => e)
    expect(err2.details.appeal.status).toBe('declined')
  })

  it("reversing an A strike lifts A's auto ban only", async () => {
    // B reaches three too and gets its own auto ban.
    await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantB, reason: 'b1' })
    await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantB, reason: 'b2' })
    expect((await activeBans(cust.id)).map((b) => b.tenantId).sort()).toEqual([tenantA, tenantB].sort())

    const r = await reverseStrike(aStrikes[0]!, users.mgrA!.id, 'forgiven')
    expect(r.unbanned).toBe(true)
    const left = await activeBans(cust.id)
    expect(left.map((b) => b.tenantId)).toEqual([tenantB])
    await expect(assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA })).resolves.toBeUndefined()
    await expect(assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantB })).rejects.toMatchObject({ code: 'BANNED' })
    expect(await activeStrikeWeightAt(prisma, cust.id, tenantA)).toBe(2)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })
    expect(c.strikeCount).toBe(5)
    expect(c.bannedAt).not.toBeNull()   // B's ban still in force
  })
})

describe('promotion details', () => {
  it('racing promotions create one ban', async () => {
    const c = await customer('race', [conceptA])
    await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA })
    await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA })
    await Promise.all([
      recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA }),
      recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA }),
      maybePromoteToBan(c.id, tenantA),
      maybePromoteToBan(c.id, tenantA),
    ])
    const bans = await activeBans(c.id)
    expect(bans).toHaveLength(1)
    expect(bans[0]!.tenantId).toBe(tenantA)
  })

  it("a staff ban at B does not stop A's auto ban", async () => {
    const c = await customer('staffB', [conceptA, conceptB])
    const staff = await call('mgrB', 'POST', '/crm/bans', { customerId: c.id, reason: 'rude to staff' })
    expect(staff.statusCode).toBe(201)
    expect(staff.json().tenantId).toBe(tenantB)
    for (let i = 0; i < 3; i++) await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA })
    const bans = await activeBans(c.id)
    expect(bans.map((b) => [b.tenantId, b.bannedById === null]).sort()).toEqual([[tenantA, true], [tenantB, false]].sort())
  })

  it('a refused-at-door strike always weighs 1', async () => {
    const c = await customer('refused', [conceptA])
    const order = await prisma.order.findFirstOrThrow({ where: { customerId: c.id } })
    const r = await recordStrike({ customerId: c.id, kind: 'cod_refused', sourceType: 'order', sourceId: order.id, severity: 2 })
    expect(r.recorded).toBe(true)
    const s = await prisma.customerStrike.findFirstOrThrow({ where: { customerId: c.id } })
    expect(s.severity).toBe(1)
    expect(s.tenantId).toBe(tenantA)   // resolved from the order's brand
    // Same incident again → one strike.
    expect(await recordStrike({ customerId: c.id, kind: 'cod_refused', sourceType: 'order', sourceId: order.id })).toMatchObject({ recorded: false, duplicate: true })
  })

  it('a strike with no source and no company is not recorded (TENANT_REQUIRED)', async () => {
    const c = await customer('nocompany', [conceptA])
    expect(await recordStrike({ customerId: c.id, kind: 'other' })).toEqual({ recorded: false, duplicate: false })
    expect(await prisma.customerStrike.count({ where: { customerId: c.id } })).toBe(0)
  })

  it("a reservation no-show is the reservation's company's strike", async () => {
    const c = await customer('noshow', [conceptB])
    const res = await prisma.reservation.create({
      data: { conceptId: conceptB, customerId: c.id, partySize: 2, startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() - 1_800_000), guestName: 'NS', status: 'booked' } as never,
    })
    const r = await markNoShow(res.id, { reason: 'did not come', actorId: users.mgrB!.id })
    expect(r.marked).toBe(true)
    const s = await prisma.customerStrike.findFirstOrThrow({ where: { customerId: c.id } })
    expect(s).toMatchObject({ kind: 'reservation_no_show', tenantId: tenantB, sourceId: res.id })
  })
})

describe('CRM routes', () => {
  it("B's manual strike or ban on an A-only customer → 404; A's bind to A", async () => {
    const c = await customer('aonly', [conceptA])
    expect((await call('mgrB', 'POST', '/crm/strikes', { customerId: c.id, kind: 'other', reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', '/crm/bans', { customerId: c.id, reason: 'nope' })).statusCode).toBe(404)
    const s = await call('mgrA', 'POST', '/crm/strikes', { customerId: c.id, kind: 'other', severity: 2, reason: 'rude' })
    expect(s.statusCode).toBe(201)
    expect(s.json().customer.strikeCount).toBe(2)
    expect((await prisma.customerStrike.findFirstOrThrow({ where: { customerId: c.id } })).tenantId).toBe(tenantA)
    // 'cod_unpaid' is no longer a manual kind.
    expect((await call('mgrA', 'POST', '/crm/strikes', { customerId: c.id, kind: 'cod_unpaid', reason: 'x' })).statusCode).toBe(400)
    const b = await call('mgrA', 'POST', '/crm/bans', { customerId: c.id, reason: 'dine and dash' })
    expect(b.statusCode).toBe(201)
    expect(b.json().tenantId).toBe(tenantA)
    expect((await call('mgrB', 'POST', `/crm/bans/${b.json().id}/lift`, { reason: 'x' })).statusCode).toBe(404)
  })

  it('a non-admin lifting a legacy NULL-company ban → 403; the CEO can', async () => {
    const c = await customer('legacy', [conceptA])
    const ban = await prisma.customerBan.create({ data: { customerId: c.id, phone: c.phone, reason: 'old ban', tenantId: null, bannedById: null } })
    // A legacy NULL ban applies everywhere.
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantB })).rejects.toMatchObject({ code: 'BANNED' })
    const r = await call('mgrA', 'POST', `/crm/bans/${ban.id}/lift`, { reason: 'appeal granted' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('LEGACY_BAN_ADMIN_ONLY')
    expect((await call('ceoA', 'POST', `/crm/bans/${ban.id}/lift`, { reason: 'appeal granted' })).statusCode).toBe(200)
    expect((await prisma.customerBan.findUniqueOrThrow({ where: { id: ban.id } })).liftedAt).not.toBeNull()
  })

  it('lift resolves the open appeal and keeps the strikes', async () => {
    const c = await customer('liftkeep', [conceptA])
    for (let i = 0; i < 3; i++) await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA })
    const ban = (await activeBans(c.id))[0]!
    const appeal = await prisma.orderComplaint.create({
      data: { conceptId: conceptA, customerId: c.id, title: 'Ban appeal', description: 'sorry', category: 'other', kind: 'ban_appeal', banId: ban.id },
    })
    const r = await call('mgrA', 'POST', `/crm/bans/${ban.id}/lift`, { reason: 'first time, apologised' })
    expect(r.statusCode).toBe(200)
    expect(r.json().liftedAt).toBeTruthy()
    const a = await prisma.orderComplaint.findUniqueOrThrow({ where: { id: appeal.id } })
    expect(a.status).toBe('resolved')
    expect(a.resolution).toBe('Block lifted: first time, apologised')
    expect(await prisma.customerStrike.count({ where: { customerId: c.id, reversedAt: null } })).toBe(3)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).bannedAt).toBeNull()
    expect(await prisma.auditLog.count({ where: { action: 'customer_ban.lift', entityId: ban.id, tenantId: tenantA } })).toBe(1)
  })

  it('release-contact clears the phone on the ban and on the account', async () => {
    const c = await customer('recycled', [conceptA])
    const phone = c.phone!
    const b = await call('mgrA', 'POST', '/crm/bans', { customerId: c.id, reason: 'chargebacks' })
    const banId = b.json().id as string
    const appeal = await prisma.orderComplaint.create({
      data: { conceptId: conceptA, title: 'Ban appeal', description: 'new number', category: 'other', kind: 'ban_appeal', banId, contactPhone: phone },
    })
    expect((await call('mgrB', 'POST', `/crm/bans/${banId}/release-contact`, { contact: 'phone', reason: 'recycled number' })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/crm/bans/${banId}/release-contact`, { contact: 'phone', reason: 'x' })).statusCode).toBe(400)
    const r = await call('mgrA', 'POST', `/crm/bans/${banId}/release-contact`, { contact: 'phone', reason: 'recycled number' })
    expect(r.statusCode).toBe(200)
    expect(r.json().phone).toBeNull()
    expect(r.json().liftedAt).toBeNull()
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phone).toBeNull()
    // The number's new holder is not blocked; the old account still is.
    expect(await activeBanAtCompany({ phone, tenantId: tenantA })).toBeNull()
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantA })).rejects.toMatchObject({ code: 'BANNED' })
    expect((await prisma.orderComplaint.findUniqueOrThrow({ where: { id: appeal.id } })).status).toBe('resolved')
    expect(await prisma.auditLog.count({ where: { action: 'customer_ban.release_contact', entityId: banId, tenantId: tenantA } })).toBe(1)
    // Nothing left to release.
    expect((await call('mgrA', 'POST', `/crm/bans/${banId}/release-contact`, { contact: 'phone', reason: 'recycled number' })).statusCode).toBe(409)
  })

  it("the profile's open complaints leave out ban appeals", async () => {
    const c = await customer('profile', [conceptA])
    const b = await call('mgrA', 'POST', '/crm/bans', { customerId: c.id, reason: 'abuse' })
    await prisma.orderComplaint.create({ data: { conceptId: conceptA, customerId: c.id, title: 'Cold food', description: 'cold', category: 'quality' } })
    await prisma.orderComplaint.create({
      data: { conceptId: conceptA, customerId: c.id, title: 'Ban appeal', description: 'pls', category: 'other', kind: 'ban_appeal', banId: b.json().id },
    })
    const p = await call('mgrA', 'GET', `/crm/customers/${c.id}/context`)
    expect(p.statusCode).toBe(200)
    expect(p.json().recent.openComplaints.map((x: { title: string }) => x.title)).toEqual(['Cold food'])
  })
})
