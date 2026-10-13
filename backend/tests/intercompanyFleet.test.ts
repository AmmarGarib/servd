// Shared-fleet recharge (H30) — modules/intercompany/fleet.ts.
//
// P employs the riders; Cl's orders ride with them under a fleet agreement; X
// is unrelated. What this defends:
//   - trips = distinct Cl orders whose FIRST pick-up by a P rider is in the
//     month (a re-pick counts once; Cl's own riders and other steps never);
//   - the charge posts in both books: Cl Dr 6035 per Cl brand / Cr Due to P;
//     P Dr Due from Cl / Cr 6990 (never 6035); charging twice makes one transfer;
//   - a month closed in either company posts on the first day open in BOTH,
//     with a note naming the month;
//   - a refused posting raises posting_failed 'ic.fleet_charge'; the re-poster
//     refuses an operator of one company and posts for one of both;
//   - rates: CEO of both only (Cl-only → 403, X → 404), 409 RATE_EXISTS /
//     RATE_PERIOD_CHARGED;
//   - the close check blocks an uncharged month for BOTH companies, and the
//     nightly run clears it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { parsePktEndOfDay, fmtPktDate } = await import('../src/modules/accounting/dates.js')
const { intercompanyRoutes } = await import('../src/modules/intercompany/routes.js')
const fleet = await import('../src/modules/intercompany/fleet.js')
const { intercompanyCloseChecks } = await import('../src/modules/intercompany/closeChecks.js')

const PREFIX = `icf-${Date.now()}`
let app: FastifyInstance
let P: string, Cl: string, X: string
let c1: string, c2: string, pBrand: string
let riderP: string, riderCl: string
let agreementId: string

interface Who { id: string; token: string }
let ceoPC: Who, ceoCl: Who, ceoX: Who, finPC: Who, finCl: Who

const cur = fleet.monthOf(new Date())
const M = fleet.addMonths(cur, -2)
const Mm1 = fleet.addMonths(cur, -3)
const Mm2 = fleet.addMonths(cur, -4)
const Mp1 = fleet.addMonths(cur, -1)

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `${PREFIX}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, role: 'admin' | 'finance', tenants: string[], active = tenants[0]!): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${key}`, email: `${PREFIX}.${key}@icf.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: active, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role })) },
    },
  })
  return { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/accounting/intercompany${url}`, headers: { authorization: who.token }, ...(payload !== undefined ? { payload: payload as object } : {}) })

let orderSeq = 0
async function mkOrder(conceptId: string): Promise<string> {
  orderSeq += 1
  return (await prisma.order.create({ data: { conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: 150_000 + orderSeq } })).id
}

async function pickUp(orderId: string, riderId: string, client: string, riderTenant: string, at: string, type: 'picked_up' | 'delivered' = 'picked_up') {
  await prisma.riderJobEvent.create({ data: { orderId, riderId, tenantId: client, riderTenantId: riderTenant, type, createdAt: new Date(at) } })
}

const mid = (month: string, day = '10') => `${month}-${day}T10:00:00+05:00`

beforeAll(async () => {
  P = await mkTenant('Fleet Provider')
  Cl = await mkTenant('Fleet Client')
  X = await mkTenant('Fleet Other')
  c1 = (await prisma.concept.create({ data: { name: 'Client One', slug: `${PREFIX}-c1`, type: 'restaurant', tenantId: Cl } })).id
  c2 = (await prisma.concept.create({ data: { name: 'Client Two', slug: `${PREFIX}-c2`, type: 'restaurant', tenantId: Cl } })).id
  pBrand = (await prisma.concept.create({ data: { name: 'Provider Brand', slug: `${PREFIX}-p1`, type: 'restaurant', tenantId: P } })).id
  riderP = (await prisma.rider.create({ data: { name: 'P rider', phone: `92300${Date.now() % 10_000_000}`, tenantId: P } })).id
  riderCl = (await prisma.rider.create({ data: { name: 'Cl rider', phone: `92301${Date.now() % 10_000_000}`, tenantId: Cl } })).id
  ceoPC = await mkUser('ceo-pc', 'admin', [P, Cl])
  ceoCl = await mkUser('ceo-cl', 'admin', [Cl])
  ceoX = await mkUser('ceo-x', 'admin', [X])
  finPC = await mkUser('fin-pc', 'finance', [P, Cl])
  finCl = await mkUser('fin-cl', 'finance', [Cl])
  agreementId = (await prisma.fleetAgreement.create({ data: { providerTenantId: P, clientTenantId: Cl, createdById: ceoPC.id } })).id

  // Month M: o1 (c1) picked twice, o2 (c1), o3 (c2) — 2 trips for c1, 1 for c2.
  const o1 = await mkOrder(c1)
  const o2 = await mkOrder(c1)
  const o3 = await mkOrder(c2)
  await pickUp(o1, riderP, Cl, P, mid(M, '05'))
  await pickUp(o1, riderP, Cl, P, mid(M, '06'))
  await pickUp(o2, riderP, Cl, P, mid(M, '07'))
  await pickUp(o2, riderP, Cl, P, mid(M, '07'), 'delivered')
  await pickUp(o3, riderP, Cl, P, mid(M, '20'))
  await pickUp(o1, riderP, Cl, P, mid(Mp1, '02')) // a re-pick next month: never a second trip
  // Cl's own rider: not a fleet trip.
  await pickUp(await mkOrder(c1), riderCl, Cl, Cl, mid(M, '08'))
  // One trip each in Mm1, Mm2 and Mp1.
  await pickUp(await mkOrder(c1), riderP, Cl, P, mid(Mm1))
  await pickUp(await mkOrder(c2), riderP, Cl, P, mid(Mm2))
  await pickUp(await mkOrder(c1), riderP, Cl, P, mid(Mp1, '15'))

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(intercompanyRoutes, { prefix: '/accounting/intercompany' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

async function entryOf(tenantId: string, transferId: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference: `ic.transfer:${transferId}` },
    include: { lines: { include: { account: { select: { code: true, controlledBy: true } } } } },
  })
}

describe('trips', () => {
  it('counts distinct orders by their first pick-up by the provider, per client brand', async () => {
    const trips = await fleet.tripsFor(prisma, P, Cl, M)
    const by = Object.fromEntries(trips.map((t) => [t.conceptId, t.trips]))
    expect(by).toEqual({ [c1]: 2, [c2]: 1 })
    expect((await fleet.tripsFor(prisma, P, Cl, Mp1)).reduce((s, t) => s + t.trips, 0)).toBe(1)
  })
})

describe('rates', () => {
  it('only the CEO of both companies sets a rate (Cl-only → 403, X → 404, finance → 403)', async () => {
    const body = { ratePerTripCents: 15_000, fromPeriod: Mm2 }
    const clOnly = await call(ceoCl, 'PUT', `/fleet/${agreementId}/rate`, body)
    expect(clOnly.statusCode).toBe(403)
    expect(clOnly.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    expect((await call(ceoX, 'PUT', `/fleet/${agreementId}/rate`, body)).statusCode).toBe(404)
    expect((await call(finPC, 'PUT', `/fleet/${agreementId}/rate`, body)).statusCode).toBe(403)
    expect((await call(ceoPC, 'PUT', `/fleet/${agreementId}/rate`, { ...body, ratePerTripCents: -1 })).statusCode).toBe(400)
    const ok = await call(ceoPC, 'PUT', `/fleet/${agreementId}/rate`, body)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ fromPeriod: Mm2, ratePerTripCents: 15_000 })
    const audits = await prisma.auditLog.findMany({ where: { action: 'intercompany.fleet_rate.set' } })
    expect(audits.map((a) => a.tenantId).sort()).toEqual([P, Cl].sort())
  })
})

let transferM: string

describe('charging a month', () => {
  it('posts both books: Cl Dr 6035 per brand / Cr Due to P; P Dr Due from Cl / Cr 6990', async () => {
    const r = await call(ceoPC, 'POST', '/fleet/charge', { month: M, agreementId })
    expect(r.statusCode).toBe(200)
    expect(r.json().charged).toBe(1)
    transferM = r.json().results[0].transferId
    const t = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: transferM } })
    expect(t).toMatchObject({ tenantId: Cl, counterpartyTenantId: P, source: 'fleet', status: 'posted', period: M, sourceRef: `fleet:${agreementId}:${M}` })
    expect(Number(t.amountCents)).toBe(45_000)
    expect(fmtPktDate(t.entryDate)).toBe(fleet.monthBounds(M).lastDay)

    const inCl = await entryOf(Cl, transferM)
    const dr = inCl!.lines.filter((l) => l.type === 'debit')
    expect(dr.every((l) => l.account.code === '6035')).toBe(true)
    expect(Object.fromEntries(dr.map((l) => [l.conceptId, Number(l.amountCents)]))).toEqual({ [c1]: 30_000, [c2]: 15_000 })
    expect(inCl!.lines.find((l) => l.type === 'credit')!.account.controlledBy).toBe('intercompany')

    const inP = await entryOf(P, transferM)
    expect(inP!.lines.find((l) => l.type === 'debit')!.account.controlledBy).toBe('intercompany')
    const cr = inP!.lines.find((l) => l.type === 'credit')!
    expect(cr.account.code).toBe('6990')
    expect(Number(cr.amountCents)).toBe(45_000)
    expect(inP!.lines.some((l) => l.account.code === '6035')).toBe(false)
  })

  it('charging again makes no second transfer', async () => {
    const r = await call(ceoPC, 'POST', '/fleet/charge', { month: M, agreementId })
    expect(r.statusCode).toBe(200)
    expect(r.json().charged).toBe(0)
    expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: { startsWith: `fleet:${agreementId}:${M}` } } })).toBe(1)
    const direct = await fleet.chargeFleetMonth(agreementId, M)
    expect(direct).toMatchObject({ charged: false, reason: 'already_charged', transferId: transferM })
  })

  it('a month that has not ended is 422', async () => {
    const r = await call(ceoPC, 'POST', '/fleet/charge', { month: cur, agreementId })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('MONTH_NOT_ENDED')
  })
})

describe('a refused fleet charge', () => {
  it("raises posting_failed 'ic.fleet_charge'; the re-poster refuses one-company staff and posts for staff of both", async () => {
    await prisma.account.updateMany({ where: { tenantId: P, code: '6990' }, data: { isActive: false } })
    await expect(fleet.chargeFleetMonth(agreementId, Mm2)).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' })
    const id = `${agreementId}:${Mm2}`
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityType: 'FleetCharge', entityId: id } })
    expect(flag).toBeTruthy()
    expect(flag!.tenantId).toBe(Cl)
    expect((flag!.metadata as Record<string, unknown>)['sourceType']).toBe('ic.fleet_charge')
    expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: `fleet:${agreementId}:${Mm2}` } })).toBe(0)

    await prisma.account.updateMany({ where: { tenantId: P, code: '6990' }, data: { isActive: true } })
    const doc = await fleet.fleetChargeRefusedDoc(id)
    expect(doc).toMatchObject({ tenantId: Cl, date: null, orderId: null, amountCents: 15_000 })
    expect(doc!.nothingOwed).toBeUndefined()
    const refused = await doc!.post({ postedBy: finCl.id })
    expect(refused).toMatchObject({ posted: false, reason: fleet.FLEET_ASK_CEO })
    const posted = await doc!.post({ postedBy: finPC.id })
    expect(posted.posted).toBe(true)
    expect(posted.entryId).toBeTruthy()
    const closed = await prisma.exceptionFlag.findFirstOrThrow({ where: { id: flag!.id } })
    expect(closed.status).toBe('resolved')
    const after = await fleet.fleetChargeRefusedDoc(id)
    expect(after!.nothingOwed).toContain('Already charged')
  })
})

describe('a closed month', () => {
  it('posts on the first day open in BOTH companies, with a note naming the month', async () => {
    const lockP = await prisma.periodLock.create({ data: { tenantId: P, lockedThrough: parsePktEndOfDay(fleet.monthBounds(Mm1).lastDay), lockedBy: ceoPC.id } })
    const lockCl = await prisma.periodLock.create({ data: { tenantId: Cl, lockedThrough: parsePktEndOfDay(`${M}-05`), lockedBy: ceoPC.id } })
    try {
      const r = await fleet.chargeFleetMonth(agreementId, Mm1)
      expect(r.charged).toBe(true)
      const t = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: r.transferId! } })
      expect(fmtPktDate(t.entryDate)).toBe(`${M}-06`)
      for (const tenantId of [P, Cl]) {
        const e = await entryOf(tenantId, t.id)
        expect(fmtPktDate(e!.entryDate)).toBe(`${M}-06`)
        expect(e!.description).toContain('posted late on the first day open in both companies')
        expect(e!.description).toContain(fleet.monthLabel(Mm1))
      }
    } finally {
      await prisma.periodLock.deleteMany({ where: { id: { in: [lockP.id, lockCl.id] } } })
    }
  })
})

describe('changing a rate', () => {
  it('is refused for a charged month (409) and for an existing month (409); later months are fine', async () => {
    const charged = await call(ceoPC, 'PUT', `/fleet/${agreementId}/rate`, { ratePerTripCents: 20_000, fromPeriod: M })
    expect(charged.statusCode).toBe(409)
    expect(charged.json().error.code).toBe('RATE_PERIOD_CHARGED')
    const same = await call(ceoPC, 'PUT', `/fleet/${agreementId}/rate`, { ratePerTripCents: 20_000, fromPeriod: Mm2 })
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('RATE_EXISTS')
    const later = await call(ceoPC, 'PUT', `/fleet/${agreementId}/rate`, { ratePerTripCents: 20_000, fromPeriod: Mp1 })
    expect(later.statusCode).toBe(200)
  })
})

describe('the period close', () => {
  const ctxFor = (tenantId: string) => ({
    db: prisma, tenantId, prevLock: parsePktEndOfDay(fleet.monthBounds(M).lastDay),
    newLock: parsePktEndOfDay(fleet.monthBounds(Mp1).lastDay), months: [Mp1], isYearEnd: false,
  })
  const check = intercompanyCloseChecks.find((c) => c.key === 'fleet_recharge')!

  it('blocks the uncharged month for both companies, with the Charge now fix', async () => {
    for (const tenantId of [P, Cl]) {
      const p = await check.run(ctxFor(tenantId))
      expect(p).toMatchObject({ key: 'fleet_recharge', severity: 'block', months: [Mp1], cents: 20_000, overridable: true })
      expect(p!.fix).toMatchObject({ method: 'POST', path: '/accounting/intercompany/fleet/charge' })
    }
    // X has nothing to do with it.
    expect(await check.run(ctxFor(X))).toBeNull()
  })

  it('a provider with trips and no rate gets the fleet_no_rate warning', async () => {
    // Cl's riders carry one P order in Mp1, with no rate on that agreement.
    await prisma.fleetAgreement.create({ data: { providerTenantId: Cl, clientTenantId: P, createdById: ceoPC.id } })
    const o = await mkOrder(pBrand)
    await pickUp(o, riderCl, P, Cl, mid(Mp1, '12'))
    const warn = intercompanyCloseChecks.find((c) => c.key === 'fleet_no_rate')!
    expect(await warn.run(ctxFor(P))).toMatchObject({ key: 'fleet_no_rate', severity: 'warn', count: 1 })
  })

  it('the nightly run charges it and the block clears', async () => {
    await fleet.runFleetChargesOnce(new Date())
    const t = await prisma.intercompanyTransfer.findFirst({ where: { sourceRef: `fleet:${agreementId}:${Mp1}`, status: 'posted' } })
    expect(t).toBeTruthy()
    expect(Number(t!.amountCents)).toBe(20_000)
    expect(t!.preparedById).toBe('system')
    for (const tenantId of [P, Cl]) expect(await check.run(ctxFor(tenantId))).toBeNull()
  })

  it('GET /fleet shows the months to the CEO of both, nothing to X', async () => {
    const r = await call(ceoPC, 'GET', `/fleet?from=${Mm2}&to=${Mp1}`)
    expect(r.statusCode).toBe(200)
    const ag = r.json().agreements.find((a: { id: string }) => a.id === agreementId)
    expect(ag.canDecide).toBe(true)
    expect(ag.months.map((m: { status: string }) => m.status)).toEqual(['charged', 'charged', 'charged', 'charged'])
    expect(ag.months[2].byBrand.map((b: { conceptName: string }) => b.conceptName).sort()).toEqual(['Client One', 'Client Two'])
    const x = await call(ceoX, 'GET', '/fleet')
    expect(x.json().agreements).toHaveLength(0)
  })
})
