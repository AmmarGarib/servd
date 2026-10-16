// Combining companies (POST /tenants/merge) — delivery and customers.
//
//   - customer strikes and bans move to the target (each still names the
//     company that raised it; a ban blocks across servd — owner 2026-10-15);
//   - bans move as-is: one active auto ban per CUSTOMER servd-wide (index
//     customer_bans_one_active_auto_per_customer), so no twins arise; a lifted
//     ban in the target stays lifted; manual bans move as-is;
//   - rider job events move on both columns (the order's company and the
//     rider's company);
//   - fleet agreements: one between the two companies ends; one with a third
//     company is repointed; one the target already has with that third
//     company ends on the source and the target's stays.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0
let ceo: Who

interface Co { id: string; conceptId: string }
async function company(name: string): Promise<Co> {
  const id = (await prisma.tenant.create({ data: { name: `Dlv ${name}`, slug: `tmd-${++seq}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  await prisma.tenantMember.create({ data: { tenantId: id, userId: ceo.id } })
  const conceptId = (await prisma.concept.create({ data: { name: `Dlv ${name} ${seq}`, slug: `tmd-b-${seq}-${RUN}`, type: 'restaurant', tenantId: id } })).id
  return { id, conceptId }
}
const merge = (src: string, dst: string) =>
  app.inject({ method: 'POST', url: '/tenants/merge', headers: { authorization: `Bearer ${ceo.token}` }, payload: { sourceId: src, targetId: dst } })
let custSeq = 0
const customer = () => prisma.customer.create({ data: { name: `Cust ${++custSeq}`, phone: `+9230${RUN.slice(-4)}${String(custSeq).padStart(4, '0')}`.slice(0, 15) } })

beforeAll(async () => {
  ceo = await mkUser('tmd-ceo', 'admin', null)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('delivery and customers move with the company', () => {
  let S: Co, D: Co, X: Co
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    S = await company('Source')
    D = await company('Target')
    X = await company('Third')
    const twinCust = await customer()
    const soloCust = await customer()
    ids.twinCust = twinCust.id

    ids.strike = (await prisma.customerStrike.create({ data: { customerId: soloCust.id, kind: 'cod_refused', tenantId: S.id } })).id
    // An active auto ban in the source and an older, LIFTED auto ban in the target for the same customer
    // (servd-wide: only one may be active per customer).
    ids.banSrcTwin = (await prisma.customerBan.create({ data: { customerId: twinCust.id, phone: twinCust.phone, reason: '3 strikes', tenantId: S.id } })).id
    ids.banDstTwin = (await prisma.customerBan.create({ data: { customerId: twinCust.id, phone: twinCust.phone, reason: '3 strikes', tenantId: D.id, liftedAt: new Date(), liftReason: 'forgiven' } })).id
    // A source-only auto ban and a manual ban for the twin customer.
    ids.banSolo = (await prisma.customerBan.create({ data: { customerId: soloCust.id, reason: '3 strikes', tenantId: S.id } })).id
    ids.banManual = (await prisma.customerBan.create({ data: { customerId: twinCust.id, reason: 'Abusive to rider', tenantId: S.id, bannedById: ceo.id } })).id

    // Rider job events: a source rider on a third company's order, and a third
    // company's rider on a source order.
    const srcRider = await prisma.rider.create({ data: { tenantId: S.id, name: 'Src Rider', phone: `+92311${RUN.slice(-3)}0001`, status: 'available', isActive: true } })
    const xRider = await prisma.rider.create({ data: { tenantId: X.id, name: 'X Rider', phone: `+92311${RUN.slice(-3)}0002`, status: 'available', isActive: true } })
    const xOrder = await prisma.order.create({ data: { conceptId: X.conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: 100_000 } })
    const sOrder = await prisma.order.create({ data: { conceptId: S.conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'completed', totalCents: 100_000 } })
    ids.evRiderSide = (await prisma.riderJobEvent.create({ data: { orderId: xOrder.id, riderId: srcRider.id, tenantId: X.id, riderTenantId: S.id, type: 'accepted' } })).id
    ids.evOrderSide = (await prisma.riderJobEvent.create({ data: { orderId: sOrder.id, riderId: xRider.id, tenantId: S.id, riderTenantId: X.id, type: 'delivered' } })).id

    // Fleet agreements.
    ids.agBetween = (await prisma.fleetAgreement.create({ data: { providerTenantId: D.id, clientTenantId: S.id, createdById: ceo.id } })).id
    ids.agMove = (await prisma.fleetAgreement.create({ data: { providerTenantId: X.id, clientTenantId: S.id, createdById: ceo.id } })).id
    ids.agClashSrc = (await prisma.fleetAgreement.create({ data: { providerTenantId: S.id, clientTenantId: X.id, createdById: ceo.id } })).id
    ids.agClashDst = (await prisma.fleetAgreement.create({ data: { providerTenantId: D.id, clientTenantId: X.id, createdById: ceo.id } })).id
  })

  it('merges, and reports what moved', async () => {
    const res = await merge(S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      strikesMoved: 1, bansMoved: 3, bansLifted: 0,
      jobEventsMoved: 1, jobEventRiderSidesMoved: 1,
      fleetAgreementsEnded: 1, fleetAgreementsMoved: 1, fleetAgreementsSuperseded: 1,
    })
  })

  it('strikes and bans are on the target; the customer keeps exactly one active auto ban', async () => {
    expect((await prisma.customerStrike.findUniqueOrThrow({ where: { id: ids.strike } })).tenantId).toBe(D.id)
    for (const id of [ids.banSrcTwin!, ids.banDstTwin!, ids.banSolo!, ids.banManual!]) {
      expect((await prisma.customerBan.findUniqueOrThrow({ where: { id } })).tenantId).toBe(D.id)
    }
    expect((await prisma.customerBan.findUniqueOrThrow({ where: { id: ids.banDstTwin } })).liftReason).toBe('forgiven')
    const activeAuto = await prisma.customerBan.findMany({ where: { customerId: ids.twinCust, liftedAt: null, bannedById: null } })
    expect(activeAuto.map((b) => b.id)).toEqual([ids.banSrcTwin])
    // The customer stays blocked; the manual ban is untouched.
    expect((await prisma.customerBan.findUniqueOrThrow({ where: { id: ids.banManual } })).liftedAt).toBeNull()
    expect(await prisma.customerStrike.count({ where: { tenantId: S.id } })).toBe(0)
    expect(await prisma.customerBan.count({ where: { tenantId: S.id } })).toBe(0)
  })

  it('rider job events move on both company columns', async () => {
    const r = await prisma.riderJobEvent.findUniqueOrThrow({ where: { id: ids.evRiderSide } })
    expect(r).toMatchObject({ tenantId: X.id, riderTenantId: D.id })
    const o = await prisma.riderJobEvent.findUniqueOrThrow({ where: { id: ids.evOrderSide } })
    expect(o).toMatchObject({ tenantId: D.id, riderTenantId: X.id })
    expect(await prisma.riderJobEvent.count({ where: { OR: [{ tenantId: S.id }, { riderTenantId: S.id }] } })).toBe(0)
  })

  it('an agreement between the two ends; others repoint or give way to the target\'s', async () => {
    expect((await prisma.fleetAgreement.findUniqueOrThrow({ where: { id: ids.agBetween } })).isActive).toBe(false)
    expect(await prisma.fleetAgreement.findUniqueOrThrow({ where: { id: ids.agMove } })).toMatchObject({ providerTenantId: X.id, clientTenantId: D.id, isActive: true })
    expect(await prisma.fleetAgreement.findUniqueOrThrow({ where: { id: ids.agClashSrc } })).toMatchObject({ providerTenantId: S.id, isActive: false })
    expect(await prisma.fleetAgreement.findUniqueOrThrow({ where: { id: ids.agClashDst } })).toMatchObject({ providerTenantId: D.id, clientTenantId: X.id, isActive: true })
    // Nothing active is left naming the deleted company.
    expect(await prisma.fleetAgreement.count({ where: { isActive: true, OR: [{ providerTenantId: S.id }, { clientTenantId: S.id }] } })).toBe(0)
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: S.id } })).deletedAt).not.toBeNull()
  })
})

describe('a merge with shared-fleet rates is still refused', () => {
  it('a rate on an agreement with a third company → 422 MERGE_HAS_INTERCOMPANY, nothing moves', async () => {
    const S = await company('RateSource')
    const D = await company('RateTarget')
    const X = await company('RateThird')
    const ag = await prisma.fleetAgreement.create({ data: { providerTenantId: S.id, clientTenantId: X.id, createdById: ceo.id } })
    await prisma.fleetRate.create({ data: { tenantId: S.id, clientTenantId: X.id, agreementId: ag.id, fromPeriod: '2026-01', ratePerTripCents: 1_000, setById: ceo.id } })
    const cust = await customer()
    const strike = await prisma.customerStrike.create({ data: { customerId: cust.id, kind: 'other', tenantId: S.id } })
    const res = await merge(S.id, D.id)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('MERGE_HAS_INTERCOMPANY')
    expect((await prisma.customerStrike.findUniqueOrThrow({ where: { id: strike.id } })).tenantId).toBe(S.id)
    expect((await prisma.fleetAgreement.findUniqueOrThrow({ where: { id: ag.id } })).providerTenantId).toBe(S.id)
  })
})

// Night audit (2026-10-16, sales days): the target's locked days that gain the
// source's sales reopen; a source row on a date the target also has folds into
// the target's history; the rest move (and open); the start day is the earlier.
describe('night-audit days move with the company', () => {
  it('reopen / fold / move, and the earlier start day', async () => {
    const S = await company('NA source')
    const D = await company('NA target')
    const dayShared = '2026-09-02'
    const dayTargetOnly = '2026-09-03'
    const daySourceOnly = '2026-09-04'
    // The source sold on the shared day.
    await prisma.order.create({ data: { conceptId: S.conceptId, source: 'pos', fulfilmentType: 'takeout', status: 'completed', totalCents: 0, placedAt: new Date(`${dayShared}T12:00:00+05:00`), completedAt: new Date(`${dayShared}T12:05:00+05:00`) } })
    const audited = { status: 'audited' as const, auditedAt: new Date(), auditedById: ceo.id }
    await prisma.nightAuditDay.create({ data: { tenantId: D.id, businessDate: dayShared, ...audited } })
    await prisma.nightAuditDay.create({ data: { tenantId: D.id, businessDate: dayTargetOnly, ...audited } })
    await prisma.nightAuditDay.create({ data: { tenantId: S.id, businessDate: dayShared, ...audited } })
    await prisma.nightAuditDay.create({ data: { tenantId: S.id, businessDate: daySourceOnly, ...audited } })
    await prisma.tenant.update({ where: { id: S.id }, data: { nightAuditStartDay: '2026-09-01' } })
    await prisma.tenant.update({ where: { id: D.id }, data: { nightAuditStartDay: '2026-09-02' } })

    const r = await merge(S.id, D.id)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().nightAuditDays).toEqual({ reopened: 1, folded: 1, moved: 1 })
    expect(await prisma.nightAuditDay.count({ where: { tenantId: S.id } })).toBe(0)
    const rows = await prisma.nightAuditDay.findMany({ where: { tenantId: D.id }, orderBy: { businessDate: 'asc' } })
    expect(rows.map((x) => [x.businessDate, x.status])).toEqual([[dayShared, 'open'], [dayTargetOnly, 'audited'], [daySourceOnly, 'open']])
    const shared = (rows[0]!.history as Array<{ action: string }>).map((h) => h.action)
    expect(shared).toEqual(['merge_reopen', 'merge_fold'])
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: D.id } })).nightAuditStartDay).toBe('2026-09-01')
  })
})
