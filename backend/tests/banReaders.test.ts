// DLV-banreaders — bans are per company, and complaint readers ignore ban appeals.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

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
// A ban applies to the companies of whoever raised it (modules/crm/customerScope.ts banCompanies).
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

describe('audience', () => {
  it('a customer banned at A is out of A audience and in B audience', async () => {
    const c = await customer('aud')
    await ban(c.id, tA)
    await prisma.customer.update({ where: { id: c.id }, data: { bannedAt: new Date() } })
    const inA = await prisma.customer.count({ where: { AND: [{ id: c.id }, await reachableAtCompany(tA)] } })
    const inB = await prisma.customer.count({ where: { AND: [{ id: c.id }, await reachableAtCompany(tB)] } })
    expect(inA).toBe(0)
    expect(inB).toBe(1)
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
  it('a referrer banned at A is paid and told at B, paid but not messaged at A', async () => {
    const atB = await referral('refB', cB, tA)
    const atA = await referral('refA', cA, tA)
    sent.length = 0
    await loyalty.runReferralRewardTrigger()
    const earned = (cid: string, t: string) => prisma.loyaltyTransaction.count({ where: { type: 'earn', loyaltyAccount: { tenantId: t, customerId: cid } } })
    expect(await earned(atB.referrer.id, tB)).toBeGreaterThan(0)
    expect(sent.some((m) => m.to === mail('refB-referrer'))).toBe(true)
    expect(await earned(atA.referrer.id, tA)).toBeGreaterThan(0)
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
