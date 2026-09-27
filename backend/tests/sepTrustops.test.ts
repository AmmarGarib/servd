// Company separation for trust-ops: delivery OTPs, petty cash, staff meals,
// the exceptions inbox and the two nightly flaggers.
//
// Two companies, A and B, each with a manager who belongs only to their own.
// B must never read, verify, top up, spend from, reconcile or see anything of
// A's, and every flag lands in exactly one company's inbox.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { flagException } from '../src/lib/exceptions.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { runOnce as runShrinkageTrend } from '../src/workers/shrinkageTrend.js'
import { runOnce as runRiderScoring } from '../src/workers/riderScoring.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
const PIN = '5829'

async function mkUser(key: string, role: string, primary: string, members: string[], pin?: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.septrust@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, isActive: true, accountStatus: 'active', tenantId: primary,
      ...(pin && { pin: await bcrypt.hash(pin, 4) }),
    },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method, url, payload: payload as never,
    headers: { authorization: `Bearer ${users[who]!.token}`, ...headers },
  })

async function deliveryOrder(conceptId: string, otp: string | null) {
  return prisma.order.create({
    data: {
      conceptId, source: 'pos', status: 'ready', totalCents: 150_000, deliveryOtp: otp,
      items: { create: [{ name: 'Sandwich', quantity: 1, unitPriceCents: 150_000 }] },
    },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Trust A', slug: 'trust-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Trust B', slug: 'trust-b' } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Trust Cafe A', slug: 'trust-cafe-a', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Trust Cafe B', slug: 'trust-cafe-b', type: 'restaurant', tenantId: tenantB } })).id
  await mkUser('mgrA', 'admin', tenantA, [tenantA], PIN)
  await mkUser('mgrB', 'admin', tenantB, [tenantB], '6147')
  await mkUser('cookA', 'cashier', tenantA, [tenantA])
  await mkUser('cookB', 'cashier', tenantB, [tenantB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

// ─── Delivery OTP ─────────────────────────────────────────────────────────────

describe('delivery OTP is scoped through the order\'s brand', () => {
  it('B cannot read A\'s OTP; A can', async () => {
    const o = await deliveryOrder(conceptA, '4821')
    expect((await call('mgrB', 'GET', `/trustops/orders/${o.id}/otp`)).statusCode).toBe(404)
    const own = await call('mgrA', 'GET', `/trustops/orders/${o.id}/otp`)
    expect(own.statusCode).toBe(200)
    expect(own.json().otp).toBe('4821')
  })

  it('B reading an OTP-less A order does not mint one', async () => {
    const o = await deliveryOrder(conceptA, null)
    expect((await call('mgrB', 'GET', `/trustops/orders/${o.id}/otp`)).statusCode).toBe(404)
    expect((await prisma.order.findUnique({ where: { id: o.id } }))!.deliveryOtp).toBeNull()
  })

  it('B cannot verify (complete) A\'s order, even with the right code; A can', async () => {
    const o = await deliveryOrder(conceptA, '7314')
    expect((await call('mgrB', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '7314' })).statusCode).toBe(404)
    const after = await prisma.order.findUnique({ where: { id: o.id } })
    expect(after!.status).toBe('ready')
    expect(after!.deliveryOtpVerifiedAt).toBeNull()
    expect(after!.deliveryOtpAttempts).toBe(0)

    expect((await call('mgrA', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '7314' })).statusCode).toBe(200)
    expect((await prisma.order.findUnique({ where: { id: o.id } }))!.status).toBe('completed')
  })

  it('three wrong codes flag A\'s inbox only', async () => {
    const o = await deliveryOrder(conceptA, '1590')
    for (let i = 0; i < 3; i++) {
      expect((await call('mgrA', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '0000' })).statusCode).toBe(403)
    }
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'lost_package', entityId: o.id } })
    expect(flag?.tenantId).toBe(tenantA)
  })
})

// ─── Petty cash ───────────────────────────────────────────────────────────────

describe('petty cash boxes belong to one company', () => {
  let boxA: string

  it('a new box is stamped with the active company; brand and custodian must be its own', async () => {
    // Foreign brand → 404; foreign custodian → 422.
    expect((await call('mgrA', 'POST', '/trustops/petty-cash/boxes', { name: 'X', conceptId: conceptB, custodianId: users['mgrA']!.id })).statusCode).toBe(404)
    const foreignCustodian = await call('mgrA', 'POST', '/trustops/petty-cash/boxes', { name: 'X', custodianId: users['cookB']!.id })
    expect(foreignCustodian.statusCode).toBe(422)
    expect(foreignCustodian.json().error.code).toBe('CUSTODIAN_NOT_IN_COMPANY')

    const r = await call('mgrA', 'POST', '/trustops/petty-cash/boxes', { name: 'FOH box', conceptId: conceptA, custodianId: users['cookA']!.id, floatCents: 100_000 })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    boxA = r.json().id
  })

  it('B does not see A\'s box', async () => {
    const b = (await call('mgrB', 'GET', '/trustops/petty-cash/boxes')).json() as Array<{ id: string }>
    expect(b.find((x) => x.id === boxA)).toBeUndefined()
    const a = (await call('mgrA', 'GET', '/trustops/petty-cash/boxes')).json() as Array<{ id: string }>
    expect(a.find((x) => x.id === boxA)).toBeTruthy()
  })

  it('B cannot top up or spend from A\'s box', async () => {
    const topup = await call('mgrB', 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 5_000, reason: 'float' })
    expect(topup.statusCode).toBe(404)
    const spend = await call('cookB', 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'spend', amountCents: 5_000, reason: 'milk' })
    expect(spend.statusCode).toBe(404)
    const box = await prisma.pettyCashBox.findUnique({ where: { id: boxA } })
    expect(box!.floatCents).toBe(100_000)
    expect(await prisma.pettyCashMovement.count({ where: { boxId: boxA } })).toBe(0)
  })

  it('B\'s manager PIN cannot lift A\'s top-up limit; A\'s can', async () => {
    await prisma.pettyCashBox.update({ where: { id: boxA }, data: { topUpLimitCents: 10_000 } })
    const withB = await call('mgrA', 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 50_000, reason: 'float', managerOverridePin: '6147' })
    expect(withB.statusCode).toBe(403)
    const withA = await call('mgrA', 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 50_000, reason: 'float', managerOverridePin: PIN })
    expect(withA.statusCode).toBe(201)
    expect(withA.json().newFloatCents).toBe(150_000)
  })

  it('a spend can only pay a bill of the box\'s own company', async () => {
    const supB = await prisma.supplier.create({ data: { name: 'B Dairy', tenantId: tenantB } })
    const billB = await prisma.supplierBill.create({
      data: { supplierId: supB.id, billNumber: 'B-1', billDate: new Date(), dueDate: new Date(), subtotalCents: 1_000, totalCents: 1_000, status: 'open' },
    })
    const r = await call('mgrA', 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'spend', amountCents: 1_000, reason: 'milk', supplierBillId: billB.id })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BILL_NOT_IN_COMPANY')
    expect((await prisma.supplierBill.findUnique({ where: { id: billB.id } }))!.paidCents).toBe(0)
  })

  it('B cannot reconcile A\'s box; A\'s reconcile flags A\'s inbox', async () => {
    expect((await call('mgrB', 'POST', `/trustops/petty-cash/boxes/${boxA}/reconcile`, { countedCents: 0 })).statusCode).toBe(404)
    expect((await prisma.pettyCashBox.findUnique({ where: { id: boxA } }))!.floatCents).toBe(150_000)

    const r = await call('mgrA', 'POST', `/trustops/petty-cash/boxes/${boxA}/reconcile`, { countedCents: 0 })
    expect(r.statusCode).toBe(200)
    const flag = await prisma.exceptionFlag.findFirst({ where: { entityType: 'PettyCashBox', entityId: boxA } })
    expect(flag?.tenantId).toBe(tenantA)
  })
})

// ─── Staff meals ──────────────────────────────────────────────────────────────

describe('staff meals are scoped', () => {
  it('POST refuses a staff member of another company', async () => {
    const r = await call('mgrA', 'POST', '/trustops/staff-meals', { staffId: users['cookB']!.id, description: 'Club sandwich', estimatedCostCents: 50_000, managerPin: PIN })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('STAFF_NOT_IN_COMPANY')
    expect((await call('mgrA', 'POST', '/trustops/staff-meals', { staffId: users['cookA']!.id, conceptId: conceptB, description: 'x', managerPin: PIN })).statusCode).toBe(404)
  })

  it('GET without a brand returns only the operator\'s companies\' meals', async () => {
    const a = await call('mgrA', 'POST', '/trustops/staff-meals', { staffId: users['cookA']!.id, description: 'Club sandwich', estimatedCostCents: 250_000, managerPin: PIN })
    expect(a.statusCode).toBe(201)
    const b = await call('mgrB', 'POST', '/trustops/staff-meals', { staffId: users['cookB']!.id, conceptId: conceptB, description: 'Croissant', estimatedCostCents: 1_000, managerPin: '6147' })
    expect(b.statusCode).toBe(201)

    const seenByB = (await call('mgrB', 'GET', '/trustops/staff-meals')).json() as Array<{ id: string }>
    expect(seenByB.map((m) => m.id)).toContain(b.json().id)
    expect(seenByB.map((m) => m.id)).not.toContain(a.json().id)
    const seenByA = (await call('mgrA', 'GET', '/trustops/staff-meals')).json() as Array<{ id: string }>
    expect(seenByA.map((m) => m.id)).toContain(a.json().id)
    expect(seenByA.map((m) => m.id)).not.toContain(b.json().id)

    // A foreign brand filter is 404, not "B's meals".
    expect((await call('mgrA', 'GET', `/trustops/staff-meals?conceptId=${conceptB}`)).statusCode).toBe(404)

    // The heavy-meal flag (PKR 2,500 in a week) lands in A's inbox.
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'shrinkage', entityType: 'User', entityId: users['cookA']!.id } })
    expect(flag?.tenantId).toBe(tenantA)
  })
})

// ─── Exceptions inbox ─────────────────────────────────────────────────────────

describe('the exceptions inbox is per company', () => {
  let flagA: string
  let flagB: string

  beforeAll(async () => {
    flagA = (await flagException({ tenantId: tenantA, kind: 'manual_journal', severity: 'high', title: 'A manual JE', description: 'A', amountCents: 999_00 }))!.id
    flagB = (await flagException({ tenantId: tenantB, kind: 'manual_journal', title: 'B manual JE', description: 'B' }))!.id
  })

  it('flagException stamps the company, falls back to the brand\'s, and leaves an unattributable flag in no inbox', async () => {
    expect((await prisma.exceptionFlag.findUnique({ where: { id: flagA } }))!.tenantId).toBe(tenantA)
    const viaBrand = await flagException({ kind: 'yield_low', title: 't', description: 'd', conceptId: conceptB })
    expect((await prisma.exceptionFlag.findUnique({ where: { id: viaBrand!.id } }))!.tenantId).toBe(tenantB)
    const orphan = await flagException({ kind: 'pii_export', title: 'orphan', description: 'd' })
    expect((await prisma.exceptionFlag.findUnique({ where: { id: orphan!.id } }))!.tenantId).toBeNull()
    const inbox = (await call('mgrA', 'GET', '/crosschecks/exceptions')).json() as Array<{ id: string }>
    expect(inbox.map((f) => f.id)).not.toContain(orphan!.id)
  })

  it('B\'s inbox never shows A\'s flags', async () => {
    const b = (await call('mgrB', 'GET', '/crosschecks/exceptions')).json() as Array<{ id: string; tenantId: string }>
    expect(b.map((f) => f.id)).toContain(flagB)
    expect(b.map((f) => f.id)).not.toContain(flagA)
    expect(b.every((f) => f.tenantId === tenantB)).toBe(true)
    const byKind = (await call('mgrB', 'GET', '/crosschecks/exceptions?kind=manual_journal&status=open')).json() as Array<{ id: string }>
    expect(byKind.map((f) => f.id)).toEqual([flagB])
    const a = (await call('mgrA', 'GET', '/crosschecks/exceptions')).json() as Array<{ id: string; tenantId: string }>
    expect(a.map((f) => f.id)).toContain(flagA)
    expect(a.every((f) => f.tenantId === tenantA)).toBe(true)
  })

  it('stats count only the operator\'s companies', async () => {
    const [openA, openB] = await Promise.all([
      prisma.exceptionFlag.count({ where: { tenantId: tenantA, status: 'open' } }),
      prisma.exceptionFlag.count({ where: { tenantId: tenantB, status: 'open' } }),
    ])
    expect((await call('mgrA', 'GET', '/crosschecks/exceptions/stats')).json().open).toBe(openA)
    expect((await call('mgrB', 'GET', '/crosschecks/exceptions/stats')).json().open).toBe(openB)
  })

  it('B cannot acknowledge, resolve or dismiss A\'s flag', async () => {
    expect((await call('mgrB', 'PATCH', `/crosschecks/exceptions/${flagA}/acknowledge`)).statusCode).toBe(404)
    expect((await call('mgrB', 'PATCH', `/crosschecks/exceptions/${flagA}/resolve`, { resolution: 'hide it' })).statusCode).toBe(404)
    expect((await call('mgrB', 'DELETE', `/crosschecks/exceptions/${flagA}`)).statusCode).toBe(404)
    expect((await prisma.exceptionFlag.findUnique({ where: { id: flagA } }))!.status).toBe('open')

    expect((await call('mgrA', 'PATCH', `/crosschecks/exceptions/${flagA}/acknowledge`)).statusCode).toBe(204)
    expect((await call('mgrA', 'PATCH', `/crosschecks/exceptions/${flagA}/resolve`, { resolution: 'checked' })).statusCode).toBe(204)
    expect((await prisma.exceptionFlag.findUnique({ where: { id: flagA } }))!.status).toBe('resolved')
  })
})

// ─── Nightly flaggers ─────────────────────────────────────────────────────────

describe('nightly workers run per company', () => {
  it('shrinkage trend flags each company\'s own item into its own inbox', async () => {
    const itemA = await prisma.inventoryItem.create({ data: { name: 'Butter A', unit: 'kg', tenantId: tenantA, unitCostCents: 100_00 } })
    const itemB = await prisma.inventoryItem.create({ data: { name: 'Butter B', unit: 'kg', tenantId: tenantB, unitCostCents: 100_00 } })
    for (const [tenantId, itemId] of [[tenantA, itemA.id], [tenantB, itemB.id]] as const) {
      for (let i = 0; i < 2; i++) {
        await prisma.physicalCount.create({
          data: { tenantId, countedById: users['mgrA']!.id, status: 'completed', lines: { create: [{ inventoryItemId: itemId, systemQty: 10, physicalQty: 9, variancePct: -0.1 }] } },
        })
      }
    }
    await runShrinkageTrend()
    const fa = await prisma.exceptionFlag.findFirst({ where: { kind: 'shrinkage_trend', entityId: itemA.id } })
    const fb = await prisma.exceptionFlag.findFirst({ where: { kind: 'shrinkage_trend', entityId: itemB.id } })
    expect(fa?.tenantId).toBe(tenantA)
    expect(fb?.tenantId).toBe(tenantB)
    // Idempotent per company.
    await runShrinkageTrend()
    expect(await prisma.exceptionFlag.count({ where: { kind: 'shrinkage_trend', entityId: itemA.id } })).toBe(1)
  })

  it('rider scoring flags a company\'s rider into that company\'s inbox, on its own orders', async () => {
    const riderA = await prisma.rider.create({ data: { name: 'Rider A', phone: '+923000000901', tenantId: tenantA } })
    for (let i = 0; i < 5; i++) {
      await prisma.order.create({
        data: {
          conceptId: conceptA, source: 'pos', status: 'completed', totalCents: 1_000, riderId: riderA.id,
          completedAt: new Date(), deliveryOtpAttempts: i < 3 ? 3 : 0,
          items: { create: [{ name: 'x', quantity: 1, unitPriceCents: 1_000 }] },
        },
      })
    }
    await runRiderScoring()
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'lost_package', entityId: riderA.id } })
    expect(flag?.tenantId).toBe(tenantA)
    const b = (await call('mgrB', 'GET', '/crosschecks/exceptions')).json() as Array<{ id: string }>
    expect(b.map((f) => f.id)).not.toContain(flag!.id)
  })
})
