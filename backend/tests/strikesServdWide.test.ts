// Strikes and bans are SERVD-WIDE (owner decision 2026-10-15: "If strikes and
// bans is about customers accounts then its ok, let it be across servd."). A
// strike at company A and one at company B count together; a ban raised in A
// blocks the customer at B too. Each strike / ban still records the company
// whose incident it is; another company sees those incidents only as
// "Another servd kitchen". Two companies, one brand each, a customer who
// orders at both.
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
  bannedCustomerIdsAtCompany, activeStrikeWeight,
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

describe('three strikes block servd-wide', () => {
  let cust: { id: string; phone: string | null }
  const aStrikes: string[] = []

  it('1 strike at A + 1 at B count together (weight 2, no ban); each row keeps its company', async () => {
    cust = await customer('three', [conceptA, conceptB])
    const r1 = await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantA, reason: 'a0' })
    expect(r1).toMatchObject({ recorded: true, duplicate: false })
    const r2 = await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantB, reason: 'b0' })
    expect(r2.banId).toBeUndefined()
    expect(await activeBans(cust.id)).toHaveLength(0)
    expect(await activeStrikeWeight(prisma, cust.id)).toBe(2)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })
    expect(c.strikeCount).toBe(2)
    expect(c.bannedAt).toBeNull()
    const rows = await prisma.customerStrike.findMany({ where: { customerId: cust.id } })
    expect(rows.map((r) => r.tenantId).sort()).toEqual([tenantA, tenantB].sort())
    aStrikes.push(rows.find((r) => r.tenantId === tenantA)!.id)
  })

  it('a third at B → one ban stamped B (the raising company); refused at A AND B, never naming a company', async () => {
    const r = await recordStrike({ customerId: cust.id, kind: 'other', tenantId: tenantB, reason: 'b1' })
    expect(r.recorded).toBe(true)
    expect(r.banId).toBeTruthy()
    const bans = await activeBans(cust.id)
    expect(bans).toHaveLength(1)
    expect(bans[0]).toMatchObject({ id: r.banId, tenantId: tenantB, bannedById: null, phone: cust.phone })

    for (const t of [tenantA, tenantB]) {
      const err = await assertNotBannedAtCompany({ customerId: cust.id, tenantId: t, intent: 'order' }).catch((e) => e)
      expect(err).toBeInstanceOf(AppError)
      expect(err).toMatchObject({ code: 'BANNED', statusCode: 403 })
      expect(err.details).toEqual({ banId: r.banId, companyName: null, appeal: { status: 'none', at: null } })
    }
    // A fresh account with the same number is refused everywhere.
    expect(await activeBanAtCompany({ phone: cust.phone, tenantId: tenantA })).not.toBeNull()
    expect(await bannedCustomerIdsAtCompany(tenantA)).toContain(cust.id)
    expect(await bannedCustomerIdsAtCompany(tenantB)).toContain(cust.id)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).bannedAt).not.toBeNull()
  })

  it('an open appeal shows in the BANNED details', async () => {
    const ban = (await activeBans(cust.id))[0]!
    const appeal = await prisma.orderComplaint.create({
      data: { conceptId: conceptB, customerId: cust.id, title: 'Ban appeal', description: 'please', category: 'other', kind: 'ban_appeal', banId: ban.id },
    })
    const err = await assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA }).catch((e) => e)
    expect(err.details.appeal.status).toBe('open')
    await prisma.orderComplaint.update({ where: { id: appeal.id }, data: { status: 'closed', resolvedAt: new Date(), resolution: 'kept' } })
    const err2 = await assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA }).catch((e) => e)
    expect(err2.details.appeal.status).toBe('declined')
  })

  it("reversing A's strike drops the servd-wide weight below 3 and lifts B's auto ban", async () => {
    const r = await reverseStrike(aStrikes[0]!, users.mgrA!.id, 'forgiven')
    expect(r.unbanned).toBe(true)
    expect(await activeBans(cust.id)).toHaveLength(0)
    await expect(assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantA })).resolves.toBeUndefined()
    await expect(assertNotBannedAtCompany({ customerId: cust.id, tenantId: tenantB })).resolves.toBeUndefined()
    expect(await activeStrikeWeight(prisma, cust.id)).toBe(2)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })
    expect(c.strikeCount).toBe(2)
    expect(c.bannedAt).toBeNull()
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

  it('a staff ban at B already blocks everywhere: three strikes at A add no second ban', async () => {
    const c = await customer('staffB', [conceptA, conceptB])
    const staff = await call('mgrB', 'POST', '/crm/bans', { customerId: c.id, reason: 'rude to staff' })
    expect(staff.statusCode).toBe(201)
    expect(staff.json().tenantId).toBe(tenantB)
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantA })).rejects.toMatchObject({ code: 'BANNED' })
    let last: { banId?: string } = {}
    for (let i = 0; i < 3; i++) last = await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA })
    expect(last.banId).toBe(staff.json().id)
    const bans = await activeBans(c.id)
    expect(bans.map((b) => [b.tenantId, b.bannedById === null])).toEqual([[tenantB, false]])
  })

  it('racing strikes at TWO companies create one ban', async () => {
    const c = await customer('race2', [conceptA, conceptB])
    await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA })
    await recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantB })
    await Promise.all([
      recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantA }),
      recordStrike({ customerId: c.id, kind: 'other', tenantId: tenantB }),
    ])
    expect(await activeBans(c.id)).toHaveLength(1)
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

  it("B sees A's incidents only as 'Another servd kitchen'; A's ban blocks at B; only A or the CEO lifts it", async () => {
    const c = await customer('shared', [conceptA, conceptB])
    expect((await call('mgrA', 'POST', '/crm/strikes', { customerId: c.id, kind: 'other', reason: 'secret note at A' })).statusCode).toBe(201)
    const sB = await call('mgrB', 'POST', '/crm/strikes', { customerId: c.id, kind: 'chargeback', reason: 'B note' })
    expect(sB.statusCode).toBe(201)
    expect(sB.json().customer.strikeCount).toBe(2)   // servd-wide: A's + B's
    const aStrike = await prisma.customerStrike.findFirstOrThrow({ where: { customerId: c.id, tenantId: tenantA } })

    type Row = { customer: { id: string; strikeCount: number; bannedAt: string | null }; activeBanId: string | null; banRaisedHere: boolean; strikes: Array<{ id: string; reason: string | null; otherKitchen: boolean; where: string | null }> }
    const rowAt = async (who: string) => ((await call(who, 'GET', '/crm/naughty-list')).json() as Row[]).find((r) => r.customer.id === c.id)!
    const atB = await rowAt('mgrB')
    expect(atB.customer.strikeCount).toBe(2)
    const aSeenAtB = atB.strikes.find((st) => st.id === aStrike.id)!
    expect(aSeenAtB).toMatchObject({ reason: null, otherKitchen: true, where: 'Another servd kitchen' })
    expect(JSON.stringify(atB)).not.toContain('secret note at A')
    expect(atB.strikes.find((st) => st.id !== aStrike.id)).toMatchObject({ reason: 'B note', otherKitchen: false })
    // B cannot forgive A's strike.
    expect((await call('mgrB', 'POST', `/crm/strikes/${aStrike.id}/reverse`, { reason: 'x' })).statusCode).toBe(404)

    // A blocks: the block applies at B's brands too.
    const ban = await call('mgrA', 'POST', '/crm/bans', { customerId: c.id, reason: 'secret block reason A' })
    expect(ban.statusCode).toBe(201)
    const banId = ban.json().id as string
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantB, intent: 'order' })).rejects.toMatchObject({ code: 'BANNED' })

    // B sees the standing (blocked, count) but not A's ban id or reason.
    const atB2 = await rowAt('mgrB')
    expect(atB2.customer.bannedAt).not.toBeNull()
    expect(atB2.activeBanId).toBeNull()
    expect(atB2.banRaisedHere).toBe(false)
    const profB = (await call('mgrB', 'GET', `/crm/customers/${c.id}`)).json()
    expect(profB.activeBan).toMatchObject({ id: null, otherKitchen: true })
    const ctxB = (await call('mgrB', 'GET', `/crm/customers/${c.id}/context`)).json()
    expect(ctxB.bannedAt).not.toBeNull()
    expect(ctxB.activeBan.id).toBeNull()
    expect(JSON.stringify(ctxB)).not.toMatch(/secret (note|block reason) at A|secret block reason A/)
    const bansB = (await call('mgrB', 'GET', '/crm/bans')).json() as Array<{ id: string | null; customerId: string; reason: string; otherKitchen: boolean }>
    expect(bansB.map((b) => b.id)).not.toContain(banId)
    expect(bansB.find((b) => b.customerId === c.id)).toMatchObject({ id: null, otherKitchen: true })
    expect(JSON.stringify(bansB)).not.toContain('secret block reason A')
    // A sees its own in full.
    expect((await call('mgrA', 'GET', `/crm/customers/${c.id}`)).json().activeBan).toMatchObject({ id: banId, raisedHere: true })
    // A's CEO sees A's block in full.
    const atCeo = (await call('ceoA', 'GET', `/crm/customers/${c.id}/context`)).json()
    expect(atCeo.activeBan.id).toBe(banId)

    // Only the raising company (or the CEO) lifts it.
    expect((await call('mgrB', 'POST', `/crm/bans/${banId}/lift`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/crm/bans/${banId}/lift`, { reason: 'paid up' })).statusCode).toBe(200)
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantB })).resolves.toBeUndefined()
  })

  it("an admin who is not a member of the raising company cannot lift its ban (company separation holds)", async () => {
    const c = await customer('ceolift', [conceptA, conceptB])
    const ban = await call('mgrB', 'POST', '/crm/bans', { customerId: c.id, reason: 'x y z' })
    expect((await call('ceoA', 'POST', `/crm/bans/${ban.json().id}/lift`, { reason: 'reviewed' })).statusCode).toBe(404)
    expect((await call('ceoA', 'GET', `/crm/customers/${c.id}`)).json().activeBan).toMatchObject({ id: null, otherKitchen: true })
    expect((await call('mgrB', 'POST', `/crm/bans/${ban.json().id}/lift`, { reason: 'reviewed' })).statusCode).toBe(200)
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
