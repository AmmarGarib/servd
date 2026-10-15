// DLV-banreaders — bans are servd-wide (owner 2026-10-15), and complaint readers ignore ban appeals.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const sent: Array<{ to: string }> = []
vi.mock('../src/lib/notify.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/notify.js')>()
  return {
    ...real,
    sendEmail: vi.fn(async (to: string) => { sent.push({ to }) }),
    sendPhoneMessage: vi.fn(async (to: string) => { sent.push({ to }) }),
  }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { reachableAtCompany } = await import('../src/lib/marketingAudience.js')
const { recomputeCustomerRollups } = await import('../src/lib/customerRollups.js')
const loyalty = await import('../src/workers/loyaltyTriggers.js')
const { managementRoutes } = await import('../src/modules/management/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')

const RUN = Math.random().toString(36).slice(2, 8)
let tA: string, tB: string, tHO: string, cA: string, cB: string, cHO: string
const mail = (k: string) => `${k}.${RUN}@banreaders.test`

async function customer(k: string) {
  return prisma.customer.create({ data: { name: k, email: mail(k), phone: `+92302${Math.floor(1e6 + Math.random() * 8e6)}` } })
}
async function order(customerId: string, conceptId: string, totalCents: number) {
  await prisma.order.create({
    data: {
      conceptId, customerId, source: 'pos', status: 'completed', totalCents, completedAt: new Date(Date.now() - 3 * 864e5),
      items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: totalCents }] },
    } as never,
  })
}
// A ban is stamped with the company that raised it and applies at every company.
const bannerOf = new Map<string, string>()
async function ban(customerId: string, tenantId: string) {
  let uid = bannerOf.get(tenantId)
  if (!uid) {
    const u = await prisma.user.create({
      data: { name: 'banner', email: `banner-${tenantId}@banreaders.test`, password: 'x', role: 'foh_management', isActive: true, accountStatus: 'active', tenantId } as never,
    })
    await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
    uid = u.id
    bannerOf.set(tenantId, uid)
  }
  return prisma.customerBan.create({ data: { customerId, tenantId, reason: 'test', bannedById: uid } as never })
}

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'BR A', slug: `br-a-${RUN}` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'BR B', slug: `br-b-${RUN}` } })).id
  tHO = (await prisma.tenant.create({ data: { name: 'BR HO', slug: `br-ho-${RUN}`, kind: 'head_office' } as never })).id
  const mk = (t: string, s: string) => prisma.concept.create({ data: { name: s, slug: `br-${s}-${RUN}`, type: 'restaurant', tenantId: t } as never }).then((c) => c.id)
  cA = await mk(tA, 'a'); cB = await mk(tB, 'b'); cHO = await mk(tHO, 'ho')
})

afterAll(async () => { await prisma.$disconnect() })

describe('activate (platform welcome, no sending company)', () => {
  it('a banned customer with no orders gets no activate message; an unbanned one does', async () => {
    const signedUp = new Date(Date.now() - 2 * 864e5)
    const banned = await prisma.customer.create({ data: { name: 'act-banned', email: mail('act-banned'), createdAt: signedUp, bannedAt: new Date() } })
    await ban(banned.id, tA)
    const ok = await prisma.customer.create({ data: { name: 'act-ok', email: mail('act-ok'), createdAt: signedUp } })
    await loyalty.runActivateUsersTrigger()
    expect(await prisma.triggerLog.count({ where: { customerId: banned.id, triggerType: 'activate' } })).toBe(0)
    expect(await prisma.triggerLog.count({ where: { customerId: ok.id, triggerType: 'activate' } })).toBe(1)
  })
})

describe('audience', () => {
  it('a customer banned at A is out of A audience and out of B audience', async () => {
    const c = await customer('aud')
    await ban(c.id, tA)
    await prisma.customer.update({ where: { id: c.id }, data: { bannedAt: new Date() } })
    const inA = await prisma.customer.count({ where: { AND: [{ id: c.id }, await reachableAtCompany(tA)] } })
    const inB = await prisma.customer.count({ where: { AND: [{ id: c.id }, await reachableAtCompany(tB)] } })
    expect(inA).toBe(0)
    expect(inB).toBe(0)
  })
})

describe('referral', () => {
  async function referral(key: string, orderConcept: string, banAt: string) {
    const referrer = await customer(`${key}-referrer`)
    await ban(referrer.id, banAt)
    const referee = await prisma.customer.create({
      data: { name: `${key}-referee`, email: mail(`${key}-referee`), referredById: referrer.id, firstOrderAt: new Date(), phoneVerifiedAt: new Date() } as never,
    })
    await order(referee.id, orderConcept, 100_000)
    return { referrer, referee }
  }
  it('a referrer banned at A is neither paid nor told at B or A; the referees are paid', async () => {
    const atB = await referral('refB', cB, tA)
    const atA = await referral('refA', cA, tA)
    sent.length = 0
    await loyalty.runReferralRewardTrigger()
    const earned = (cid: string, t: string) => prisma.loyaltyTransaction.count({ where: { type: 'earn', loyaltyAccount: { tenantId: t, customerId: cid } } })
    expect(await earned(atB.referrer.id, tB)).toBe(0)
    expect(await earned(atB.referee.id, tB)).toBeGreaterThan(0)
    expect(sent.some((m) => m.to === mail('refB-referrer'))).toBe(false)
    expect(await earned(atA.referrer.id, tA)).toBe(0)
    expect(await earned(atA.referee.id, tA)).toBeGreaterThan(0)
    expect((await prisma.customer.findUnique({ where: { id: atA.referee.id } }))!.referralRewardCreditedAt).not.toBeNull()
    expect(sent.some((m) => m.to === mail('refA-referrer'))).toBe(false)
  })
})

describe('ban appeals are not complaints', () => {
  it('follow-up skips ban_appeal rows; rollup ignores them', async () => {
    const c = await customer('appeal')
    const base = { customerId: c.id, conceptId: cA, title: 't', description: 'd', category: 'other', status: 'resolved', resolvedAt: new Date(Date.now() - 36 * 3_600_000) }
    const appeal = await prisma.orderComplaint.create({ data: { ...base, kind: 'ban_appeal' } as never })
    const real = await prisma.orderComplaint.create({ data: { ...base, kind: 'complaint' } as never })
    await loyalty.runComplaintFollowUpTrigger()
    expect((await prisma.orderComplaint.findUnique({ where: { id: appeal.id } }))!.followUpSentAt).toBeNull()
    expect((await prisma.orderComplaint.findUnique({ where: { id: real.id } }))!.followUpSentAt).not.toBeNull()
    await recomputeCustomerRollups(c.id)
    expect((await prisma.customer.findUnique({ where: { id: c.id } }))!.complaintCount).toBe(1)
  })
})

describe('management KPIs ignore ban appeals', () => {
  it('open complaints and food-quality figures count the complaint, not the appeal', async () => {
    const cK = (await prisma.concept.create({ data: { name: 'k', slug: `br-k-${RUN}`, type: 'restaurant', tenantId: tA } as never })).id
    const c = await customer('kpi')
    const base = { customerId: c.id, conceptId: cK, title: 't', description: 'd', category: 'quality', status: 'open' }
    await prisma.orderComplaint.create({ data: { ...base, kind: 'ban_appeal' } as never })
    await prisma.orderComplaint.create({ data: { ...base, kind: 'complaint' } as never })
    const u = await prisma.user.create({
      data: { name: 'kpi-admin', email: `kpi-admin-${RUN}@banreaders.test`, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId: tA } as never,
    })
    await prisma.tenantMember.create({ data: { tenantId: tA, userId: u.id } })
    const token = (issueStaffSession(u) as { accessToken: string }).accessToken
    const app: FastifyInstance = Fastify()
    await app.register(managementRoutes, { prefix: '/management' })
    await app.ready()
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    const brand = await get(`/management/brand-metrics?conceptId=${cK}`)
    expect(brand.statusCode).toBe(200)
    expect((brand.json() as { reputation: { openComplaints: number } }).reputation.openComplaints).toBe(1)
    const fnb = await get(`/management/fnb-metrics?conceptId=${cK}`)
    expect(fnb.statusCode).toBe(200)
    const q = (fnb.json() as { quality: { foodComplaints: number; complaintsByCategory: Array<{ category: string; count: number }> } }).quality
    expect(q.foodComplaints).toBe(1)
    expect(q.complaintsByCategory).toEqual([{ category: 'quality', count: 1 }])
    await app.close()
  })
})

describe('head office', () => {
  it('the loyalty tick does not credit milestones at a head-office tenant', async () => {
    const c = await customer('ho')
    await order(c.id, cHO, 3_000_000)
    await order(c.id, cA, 3_000_000)
    await loyalty.runSpendMilestoneTrigger()
    const logs = await prisma.triggerLog.findMany({ where: { customerId: c.id }, select: { triggerType: true } })
    expect(logs.some((l) => l.triggerType.endsWith(`.${tA}`))).toBe(true)
    expect(logs.some((l) => l.triggerType.endsWith(`.${tHO}`))).toBe(false)
  })
})
