// Company separation — CRM, campaigns, segments, wallet, strikes/bans,
// conversations, loyalty settings, marketing activity.
//
// Customers are global rows; a company owns its relationship with a customer
// through the orders/reservations placed at its brands. Two companies, A and
// B, each with one brand and one customer, plus a customer shared by both.
// Company B's manager must get a 404 on everything of A's, and every create
// must bind to the active company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { crmRoutes } from '../src/modules/crm/routes.js'
import { walletRoutes } from '../src/modules/wallet/routes.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { loyaltyRoutes } from '../src/modules/loyalty/routes.js'
import { marketingActivityRoutes } from '../src/modules/marketingActivity/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
let custA: string, custB: string, custShared: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@sepcrm.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId: primary } as never,
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function customerWithOrders(key: string, conceptIds: string[], totalCents = 10_000) {
  const c = await prisma.customer.create({ data: { name: key, email: `${key}.${RUN}@sepcrm.test`, phone: `+92300${Math.floor(Math.random() * 1e7)}` } })
  for (const conceptId of conceptIds) {
    await prisma.order.create({
      data: {
        conceptId, customerId: c.id, source: 'pos', status: 'completed', totalCents, completedAt: new Date(),
        items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: totalCents }] },
      } as never,
    })
  }
  return c.id
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Sep A', slug: `sep-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Sep B', slug: `sep-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Brand A', slug: `sep-brand-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Brand B', slug: `sep-brand-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id
  // Top-ups post to the company's books (ONL-R2-01), so each needs its chart.
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  await mkUser('mgrA', tenantA, [tenantA])
  await mkUser('mgrB', tenantB, [tenantB])
  custA = await customerWithOrders('custA', [conceptA], 6_000_000)   // A's VIP (PKR 60k)
  custB = await customerWithOrders('custB', [conceptB])
  custShared = await customerWithOrders('custShared', [conceptA, conceptB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(walletRoutes, { prefix: '/wallet' })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.register(marketingActivityRoutes, { prefix: '/marketing' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

const ids = (rows: Array<{ id?: string; customerId?: string | null; customer?: { id: string } }>) =>
  rows.map((r) => r.id ?? r.customerId ?? r.customer?.id)

// ─── #19 / #20 smart segments ───────────────────────────────────────────────


// ─── #21 segments, #22–#25 campaigns ─────────────────────────────────────────

describe('segments and campaigns belong to one company', () => {
  let segA: string, campA: string


  it("a segment filter naming another company's brand is refused", async () => {
    const r = await call('mgrB', 'POST', '/crm/segments', { name: 'x', filters: { preferredConceptId: conceptA } })
    expect(r.statusCode).toBe(404)
  })

  it("a campaign naming another company's brand is a 404", async () => {
    const r = await call('mgrB', 'POST', '/crm/campaigns', { name: 'steal', channel: 'email', subject: 's', body: 'b', conceptIds: [conceptA] })
    expect(r.statusCode).toBe(404)
  })


  it('a campaign binds to the active company; empty brands = that company only', async () => {
    const r = await call('mgrA', 'POST', '/crm/campaigns', { name: `camp-${RUN}`, channel: 'email', subject: 's', body: 'hello', conceptIds: [] })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    campA = r.json().id
  })

  it("the audience preview counts only the active company's customers", async () => {
    const a = await call('mgrA', 'GET', '/crm/campaigns/audience?channel=email')
    expect(a.json().total).toBe(2)             // custA + custShared
    const b = await call('mgrB', 'GET', `/crm/campaigns/audience?channel=email&conceptIds=${conceptA}`)
    expect(b.statusCode).toBe(404)
    const seg = await call('mgrA', 'GET', `/crm/campaigns/audience?channel=email&segmentId=${segA}`)
    expect(seg.json().total).toBe(2)
  })

  it("B cannot list or send A's campaign", async () => {
    expect(ids((await call('mgrB', 'GET', '/crm/campaigns')).json())).not.toContain(campA)
    expect(ids((await call('mgrA', 'GET', '/crm/campaigns')).json())).toContain(campA)
    const send = await call('mgrB', 'POST', `/crm/campaigns/${campA}/send`)
    expect(send.statusCode).toBe(404)
  })

  it("A's send reaches only A's customers", async () => {
    const r = await call('mgrA', 'POST', `/crm/campaigns/${campA}/send`)
    expect(r.statusCode).toBe(200)
    expect(r.json().recipientCount).toBe(2)
    const until = Date.now() + 5000
    while (Date.now() < until) {
      const c = await prisma.campaign.findUnique({ where: { id: campA } })
      // status flips to 'sent' at the claim, before the first message
      // (W3A-RV-01); the broadcast is finished once recipientCount lands.
      if (c?.recipientCount != null) break
      await new Promise((res) => setTimeout(res, 50))
    }
    const sends = await prisma.campaignSend.findMany({ where: { campaignId: campA }, select: { customerId: true } })
    expect(sends.map((x) => x.customerId).sort()).toEqual([custA, custShared].sort())
  })

  it('a legacy campaign with no company cannot be sent by anyone', async () => {
    const legacy = await prisma.campaign.create({ data: { name: 'legacy', channel: 'email', body: 'x' } })
    expect((await call('mgrA', 'POST', `/crm/campaigns/${legacy.id}/send`)).statusCode).toBe(404)
  })
})

// ─── #26 behavioural segments ────────────────────────────────────────────────


// ─── #18 notes, #27 / #28 conversations ──────────────────────────────────────

describe('customer notes and conversations', () => {
  it("B cannot write notes on A's customer", async () => {
    expect((await call('mgrB', 'PATCH', `/crm/customers/${custA}/notes`, { staffNotes: 'x' })).statusCode).toBe(404)
    expect((await call('mgrA', 'PATCH', `/crm/customers/${custA}/notes`, { staffNotes: 'allergy' })).statusCode).toBe(200)
  })

  it("B cannot open a thread with A's customer, nor read or reply to A's thread", async () => {
    expect((await call('mgrB', 'POST', '/crm/conversations', { customerId: custA, message: 'hi' })).statusCode).toBe(404)
    const conv = await call('mgrA', 'POST', '/crm/conversations', { customerId: custA, message: 'hi' })
    expect(conv.statusCode).toBe(201)
    const id = conv.json().id
    expect((await call('mgrB', 'GET', `/crm/conversations/${id}/messages`)).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/crm/conversations/${id}/messages`, { body: 'x' })).statusCode).toBe(404)
    expect((await call('mgrA', 'GET', `/crm/conversations/${id}/messages`)).statusCode).toBe(200)
  })

  it("A's thread with a SHARED customer is not B's", async () => {
    const conv = await call('mgrA', 'POST', '/crm/conversations', { customerId: custShared, message: 'hi' })
    const id = conv.json().id
    expect((await call('mgrB', 'GET', `/crm/conversations/${id}/messages`)).statusCode).toBe(404)
    expect(ids((await call('mgrB', 'GET', '/crm/conversations')).json())).not.toContain(id)
  })
})

// ─── #29 strikes and bans — servd-wide standing, per-company details ─────────
// (owner 2026-10-15: strikes and bans are the customer's servd-wide standing;
// the incident's details and lifting stay with the company that raised it.)

describe('strikes and bans: servd-wide standing, raised-by company decides', () => {
  it("B cannot strike or ban A's customer", async () => {
    expect((await call('mgrB', 'POST', '/crm/strikes', { customerId: custA, kind: 'other', reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', '/crm/bans', { customerId: custA, reason: 'nope' })).statusCode).toBe(404)
  })

  it("A's strike on a shared customer counts at B but is anonymised there and not reversible by B", async () => {
    expect((await call('mgrA', 'POST', '/crm/strikes', { customerId: custShared, kind: 'other', reason: 'rude' })).statusCode).toBe(201)
    const strike = await prisma.customerStrike.findFirst({ where: { customerId: custShared } })
    // Stamped with the ACTIVE company (column, not attribution).
    expect(strike!.tenantId).toBe(tenantA)
    const nlB = (await call('mgrB', 'GET', '/crm/naughty-list')).json() as Array<{ customer: { id: string; strikeCount: number }; strikes: Array<{ id: string; reason: string | null; where: string | null }> }>
    const rowB = nlB.find((r) => r.customer.id === custShared)!
    expect(rowB.customer.strikeCount).toBe(1)
    expect(rowB.strikes.find((s) => s.id === strike!.id)).toMatchObject({ reason: null, where: 'Another servd kitchen' })
    const nlA = await call('mgrA', 'GET', '/crm/naughty-list')
    expect(ids(nlA.json())).toContain(custShared)
    expect((await call('mgrB', 'POST', `/crm/strikes/${strike!.id}/reverse`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/crm/strikes/${strike!.id}/reverse`, { reason: 'ok' })).statusCode).toBe(200)
  })

  it("A's ban on a shared customer shows at B only anonymised, and B cannot lift it", async () => {
    const ban = await call('mgrA', 'POST', '/crm/bans', { customerId: custShared, reason: 'dine and dash' })
    expect(ban.statusCode).toBe(201)
    expect(ban.json().tenantId).toBe(tenantA)
    const id = ban.json().id
    const bansB = (await call('mgrB', 'GET', '/crm/bans')).json() as Array<{ id: string | null; customerId: string; reason: string }>
    expect(bansB.map((b) => b.id)).not.toContain(id)
    expect(bansB.find((b) => b.customerId === custShared)).toMatchObject({ id: null, reason: 'Blocked by another servd kitchen' })
    expect(ids((await call('mgrA', 'GET', '/crm/bans')).json())).toContain(id)
    const nlB = (await call('mgrB', 'GET', '/crm/naughty-list')).json() as Array<{ customer: { id: string; bannedAt: string | null }; activeBanId: string | null }>
    const rowB = nlB.find((r) => r.customer.id === custShared)!
    expect(rowB.customer.bannedAt).not.toBeNull()
    expect(rowB.activeBanId).toBeNull()
    expect((await call('mgrB', 'POST', `/crm/bans/${id}/lift`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/crm/bans/${id}/release-contact`, { contact: 'phone', reason: 'new number' })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/crm/bans/${id}/lift`, { reason: 'paid up' })).statusCode).toBe(200)
  })

  it('the company column wins over the old attribution', async () => {
    // A strike stamped with B's company, though recorded by A's manager on a
    // shared customer: it is B's, not A's.
    const s = await prisma.customerStrike.create({
      data: { customerId: custShared, kind: 'other', severity: 1, tenantId: tenantB, recordedById: users.mgrA!.id },
    })
    expect((await call('mgrA', 'POST', `/crm/strikes/${s.id}/reverse`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/crm/strikes/${s.id}/reverse`, { reason: 'ok' })).statusCode).toBe(200)
    // A ban stamped with B's company though raised by A's manager.
    const b = await prisma.customerBan.create({
      data: { customerId: custShared, reason: 'x', tenantId: tenantB, bannedById: users.mgrA!.id },
    })
    expect(ids((await call('mgrA', 'GET', '/crm/bans')).json())).not.toContain(b.id)
    expect(ids((await call('mgrB', 'GET', '/crm/bans')).json())).toContain(b.id)
    expect((await call('mgrA', 'POST', `/crm/bans/${b.id}/lift`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/crm/bans/${b.id}/lift`, { reason: 'ok' })).statusCode).toBe(200)
  })
})

// ─── #84 wallet ──────────────────────────────────────────────────────────────

describe('wallet top-ups and reads', () => {
  it("B cannot credit or read A's customer's wallet", async () => {
    expect((await call('mgrB', 'POST', '/wallet/topup', { customerId: custA, amountCents: 500 })).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/wallet/customers/${custA}`)).statusCode).toBe(404)
    const bulk = await call('mgrB', 'POST', '/wallet/bulk-topup', { customerIds: [custA, custB], amountCents: 500 })
    expect(bulk.json().success).toBe(1)
    // The wallet is per company (ONL-R2-01): nothing at A, and B's credit for
    // its own customer sits in B's wallet only.
    expect(await prisma.customerWallet.count({ where: { customerId: custA } })).toBe(0)
    const b = await prisma.customerWallet.findMany({ where: { customerId: custB } })
    expect(b.map((w) => [w.tenantId, w.balanceCents])).toEqual([[tenantB, 500]])
  })

  it('A can credit its own customer', async () => {
    expect((await call('mgrA', 'POST', '/wallet/topup', { customerId: custA, amountCents: 500 })).statusCode).toBe(201)
    expect((await call('mgrA', 'GET', `/wallet/customers/${custA}`)).json().walletBalance).toBe(500)
  })
})

// ─── #43 loyalty settings ────────────────────────────────────────────────────

describe('loyalty settings are per company', () => {
  it('inherit the old global value once, then change independently', async () => {
    await prisma.setting.upsert({
      where: { key: 'loyalty.stamp_threshold' },
      create: { key: 'loyalty.stamp_threshold', value: '7' },
      update: { value: '7' },
    })
    const a0 = await call('mgrA', 'GET', '/loyalty/settings')
    expect(a0.json().values['loyalty.stamp_threshold']).toBe(7)
    const p = await call('mgrA', 'PATCH', '/loyalty/settings', { 'loyalty.stamp_threshold': 11 })
    expect(p.statusCode).toBe(200)
    expect(p.json().values['loyalty.stamp_threshold']).toBe(11)
    const b = await call('mgrB', 'GET', '/loyalty/settings')
    expect(b.json().values['loyalty.stamp_threshold']).toBe(7)
    const global = await prisma.setting.findUnique({ where: { key: 'loyalty.stamp_threshold' } })
    expect(global!.value).toBe('7')
  })
})

// ─── #44 / #45 marketing activity ────────────────────────────────────────────

describe('marketing activity is per company', () => {
  it("B does not see A's marketing actions or campaign sends", async () => {
    await prisma.auditLog.create({ data: { tenantId: tenantA, action: 'campaign.create', entity: 'Campaign', entityId: `a-${RUN}`, userEmail: 'agency@a' } })
    await prisma.auditLog.create({ data: { tenantId: tenantB, action: 'campaign.create', entity: 'Campaign', entityId: `b-${RUN}`, userEmail: 'agency@b' } })
    const b = await call('mgrB', 'GET', '/marketing/activity')
    const entityIds = (b.json() as Array<{ entityId: string }>).map((x) => x.entityId)
    expect(entityIds).toContain(`b-${RUN}`)
    expect(entityIds).not.toContain(`a-${RUN}`)
    const perfB = await call('mgrB', 'GET', '/marketing/performance')
    expect(perfB.json().campaigns).toBe(0)
  })
})
