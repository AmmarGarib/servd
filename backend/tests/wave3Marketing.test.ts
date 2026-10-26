// Wave 3 UI-06 — the Marketing workspace's sidebar and its API agree.
//
// marketing and brand_manager own the Marketing workspace (lib/workspaces.ts)
// and hold crm, campaigns, promos, analytics and marketing_workspace by
// default (lib/moduleAccess.ts). Before this change every read behind those
// pages was MANAGERS-only, so the pages rendered empty with red 403 toasts.
//
// Defended here:
//   - every read those pages make answers 200 for both marketing roles, and
//     for foh_management on the crm / campaigns pages it holds;
//   - the workspace's normal writes work (campaigns incl. send, segment
//     recompute, promos, section discounts, QR codes, loyalty settings and
//     tiers) and bind to the ACTIVE company;
//   - company separation: company B's marketing login gets 404 / nothing on
//     every company-A row, a foreign brand on create is 404, and a login with
//     no company sees nothing (an empty scope denies);
//   - what stays guarded: bans/strikes, wallet credits and the loyalty
//     back-fill stay MANAGERS; a cashier still gets 403 on all of it.
//   - review fixes (W3A-RV-01..06): a campaign sends exactly once (a second
//     or concurrent press is a 409); a customer shared by both companies shows
//     company B only B's spend / orders / brand, never the global rollups or
//     A's brand; the CEO's Module Access really closes the widened routes; the
//     section-discount page's category read works and stays company-scoped.
//
// WhatsApp and email are stubbed — a campaign send never leaves the process.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})
vi.mock('../src/lib/notify.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/notify.js')>()
  return { ...real, sendEmail: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { promoRoutes } = await import('../src/modules/promos/routes.js')
const { discountRoutes } = await import('../src/modules/discounts/routes.js')
const { qrCodeRoutes } = await import('../src/modules/qrcodes/routes.js')
const { analyticsRoutes } = await import('../src/modules/analytics/routes.js')
const { marketingActivityRoutes } = await import('../src/modules/marketingActivity/routes.js')
const { loyaltyRoutes } = await import('../src/modules/loyalty/routes.js')
const { walletRoutes } = await import('../src/modules/wallet/routes.js')
const { menuRoutes } = await import('../src/modules/menu/routes.js')
const { DEFAULT_MODULE_ACCESS } = await import('../src/lib/moduleAccess.js')
const { companySegmentSlug } = await import('../src/modules/crm/segmentComputation.js')
const { sendEmail } = await import('../src/lib/notify.js')

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
let custA: string, custB: string
let campaignA: string, promoA: string, discountA: string, qrA: string, tierA: string
let shared: string, secretA: string, categoryA: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: UserRole, tenantId: string | null, moduleDeny: string[] = []) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@w3mkt.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, isActive: true, accountStatus: 'active', tenantId, moduleDeny,
    } as never,
  })
  if (tenantId) await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function orderAt(customerId: string, conceptId: string, totalCents = 10_000, completedAt = new Date()) {
  await prisma.order.create({
    data: {
      conceptId, customerId, source: 'pos', status: 'completed', totalCents, completedAt,
      items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: totalCents }] },
    } as never,
  })
}

async function customerWithOrder(key: string, conceptId: string) {
  const c = await prisma.customer.create({
    data: { name: key, email: `${key}.${RUN}@w3mkt.test`, phone: `+92300${Math.floor(1e6 + Math.random() * 8e6)}` },
  })
  await orderAt(c.id, conceptId)
  return c.id
}

const today = new Date()
const inAMonth = new Date(Date.now() + 30 * 864e5)

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'W3 Mkt A', slug: `w3m-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'W3 Mkt B', slug: `w3m-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Brand A', slug: `w3m-brand-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Brand B', slug: `w3m-brand-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id

  await mkUser('mktA', 'marketing', tenantA)
  await mkUser('bmA', 'brand_manager', tenantA)
  await mkUser('fohA', 'foh_management', tenantA)
  await mkUser('cashierA', 'cashier', tenantA)
  await mkUser('mktB', 'marketing', tenantB)
  await mkUser('mktNone', 'marketing', null)
  // The CEO's Module Access, per login: same resolver as a saved role row
  // (effectiveModulesForUser), without changing the marketing role for every
  // other test file sharing this database.
  await mkUser('mktDenied', 'marketing', tenantA, ['promos', 'analytics', 'marketing_workspace', 'crm', 'campaigns'])

  custA = await customerWithOrder('custA', conceptA)
  custB = await customerWithOrder('custB', conceptB)

  // A customer of BOTH companies (W3A-RV-02): big spender at company A's
  // secret brand, one small order at company B. The global rollups, the
  // servd-wide wallet and the preferred brand all point at company A.
  secretA = (await prisma.concept.create({ data: { name: `Secret A Brand ${RUN}`, slug: `w3m-secret-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  shared = (await prisma.customer.create({
    data: {
      name: 'Shared', email: `shared.${RUN}@w3mkt.test`, phone: `+92301${Math.floor(1e6 + Math.random() * 8e6)}`,
      totalSpentCents: 9_999_900, walletBalance: 77_700, preferredConceptId: secretA,
      firstOrderAt: new Date('2025-01-01T10:00:00Z'), lastOrderAt: new Date(Date.now() - 60_000),
    } as never,
  })).id
  // The wallet is per company (ONL-R2-01): the 77,700 is A's wallet.
  await prisma.customerWallet.create({ data: { tenantId: tenantA, customerId: shared, balanceCents: 77_700 } })
  for (let i = 0; i < 5; i++) await orderAt(shared, secretA, 2_000_000, new Date(Date.now() - 60_000))
  const bOrderAt = new Date('2026-03-03T12:00:00Z')
  await orderAt(shared, conceptB, 12_300, bOrderAt)
  // B's VIP segment holds the shared customer (as computeAllSegments would).
  const segB = await prisma.customerSegment.create({ data: { slug: companySegmentSlug('vip', tenantB), name: 'VIP', memberCount: 1 } })
  await prisma.customerSegmentMembership.create({ data: { customerId: shared, segmentId: segB.id } })

  categoryA = (await prisma.category.create({ data: { conceptId: conceptA, name: `Sandwiches ${RUN}` } as never })).id

  campaignA = (await prisma.campaign.create({ data: { name: `A-camp-${RUN}`, channel: 'whatsapp', body: 'Hello A', tenantId: tenantA, conceptIds: [], status: 'draft' } as never })).id
  promoA = (await prisma.promoCode.create({ data: { code: `AONLY${RUN}`.toUpperCase(), discountValue: 10, startAt: today, endAt: inAMonth, tenantId: tenantA } as never })).id
  discountA = (await prisma.sectionDiscount.create({
    data: { conceptId: conceptA, discountPercent: 10, startDate: today, endDate: inAMonth, startTime: '00:00', endTime: '23:59' } as never,
  })).id
  qrA = (await prisma.qrCode.create({ data: { conceptId: conceptA, label: `A table ${RUN}` } })).id
  tierA = (await prisma.tierConfig.create({ data: { tier: `a-gold-${RUN}`, tenantId: tenantA } as never })).id
  await prisma.analyticsEvent.create({ data: { sessionId: `s-${RUN}`, conceptId: conceptA, event: 'checkout_started' } as never })
  await prisma.analyticsEvent.create({ data: { sessionId: `s-${RUN}`, conceptId: conceptA, event: 'item_view', properties: { itemId: 'i1', name: 'Latte' } } as never })
  await prisma.auditLog.create({ data: { tenantId: tenantA, action: 'promo.create', entity: 'PromoCode', entityId: promoA, userId: users.mktA!.id } as never })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(promoRoutes, { prefix: '/promos' })
  await app.register(discountRoutes, { prefix: '/discounts' })
  await app.register(qrCodeRoutes, { prefix: '/qrcodes' })
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.register(marketingActivityRoutes, { prefix: '/marketing' })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.register(walletRoutes, { prefix: '/wallet' })
  await app.register(menuRoutes, { prefix: '/menu' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

const range = `dateFrom=${new Date(Date.now() - 864e5).toISOString()}&dateTo=${new Date(Date.now() + 864e5).toISOString()}`

/** Every read the Marketing workspace's pages make (crawl-marketing-d.json). */
const MARKETING_READS = [
  '/crm/customers?search=&limit=50',
  '/crm/summary',
  '/crm/campaigns',
  '/crm/campaigns/audience?channel=whatsapp',
  '/crm/behavioral-segments',
  '/crm/behavioral-segments/vip/members?limit=300',
  '/promos',
  '/promos/usages',
  `/analytics/funnel?${range}`,
  `/analytics/items?${range}&limit=15`,
  `/analytics/search?${range}&limit=15`,
  `/analytics/overview?${range}`,
  '/marketing/activity?days=30&limit=500',
  '/marketing/team',
  '/marketing/performance',
  '/loyalty/settings',
  '/loyalty/tiers',
  '/discounts/sections',
  '/qrcodes',
]

describe('UI-06 the marketing roles reach their workspace', () => {
  it('the defaults really promise these modules (the premise of this test)', () => {
    for (const role of ['marketing', 'brand_manager'] as const) {
      for (const m of ['crm', 'campaigns', 'promos', 'analytics', 'marketing_workspace']) {
        expect(DEFAULT_MODULE_ACCESS[role], `${role}: ${m}`).toContain(m)
      }
    }
  })

  it('marketing and brand_manager: every read behind the pages answers 200', async () => {
    const bad: string[] = []
    for (const who of ['mktA', 'bmA']) {
      for (const url of [...MARKETING_READS, `/crm/customers/${custA}`]) {
        const r = await call(who, 'GET', url)
        if (r.statusCode !== 200) bad.push(`${who} ${url} → ${r.statusCode} ${r.body.slice(0, 120)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('foh_management gets what its crm + campaigns defaults promise', async () => {
    for (const url of ['/crm/customers', '/crm/summary', '/crm/campaigns', '/crm/behavioral-segments', `/crm/customers/${custA}`]) {
      expect((await call('fohA', 'GET', url)).statusCode, url).toBe(200)
    }
  })

  it('reads show company A\'s own rows to company A\'s marketing', async () => {
    expect((await call('mktA', 'GET', '/crm/customers')).json().data.map((c: { id: string }) => c.id)).toContain(custA)
    expect((await call('mktA', 'GET', '/crm/campaigns')).json().map((c: { id: string }) => c.id)).toContain(campaignA)
    expect((await call('mktA', 'GET', '/promos')).json().map((p: { id: string }) => p.id)).toContain(promoA)
    expect((await call('mktA', 'GET', '/discounts/sections')).json().map((d: { id: string }) => d.id)).toContain(discountA)
    expect((await call('mktA', 'GET', '/qrcodes')).json().map((q: { id: string }) => q.id)).toContain(qrA)
    expect((await call('mktA', 'GET', '/loyalty/tiers')).json().map((t: { id: string }) => t.id)).toContain(tierA)
    expect((await call('mktA', 'GET', `/analytics/overview?${range}`)).json().checkoutStarted).toBe(1)
    expect((await call('mktA', 'GET', `/analytics/items?${range}`)).json().map((i: { itemId: string }) => i.itemId)).toContain('i1')
    expect((await call('mktA', 'GET', '/marketing/activity')).json().map((a: { entityId: string }) => a.entityId)).toContain(promoA)
    const team = (await call('mktA', 'GET', '/marketing/team')).json().map((u: { id: string }) => u.id)
    expect(team).toContain(users.mktA!.id)
    expect(team).toContain(users.bmA!.id)
  })
})

describe('UI-06 the workspace\'s normal writes work and bind to the active company', () => {
  it('campaigns: create, preview, send (stubbed) — in company A', async () => {
    // Email: WhatsApp campaigns wait for their own number (owner C19, 2026-10-26).
    const created = await call('mktA', 'POST', '/crm/campaigns', { name: `mkt-${RUN}`, channel: 'email', subject: 'Hi', body: 'Hi' })
    expect(created.statusCode).toBe(201)
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: created.json().id } })).tenantId).toBe(tenantA)
    const sent = await call('bmA', 'POST', `/crm/campaigns/${created.json().id}/send`)
    expect(sent.statusCode).toBe(200)
    expect(sent.json().recipientCount).toBeGreaterThanOrEqual(1)
    expect((await call('mktA', 'POST', '/crm/behavioral-segments/compute')).statusCode).toBe(202)
  })

  it('promos: create / edit / delete in company A', async () => {
    const r = await call('mktA', 'POST', '/promos', {
      code: `MKT${RUN}`, discountType: 'percentage', discountValue: 15, startAt: today.toISOString(), endAt: inAMonth.toISOString(),
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await call('mktA', 'PATCH', `/promos/${r.json().id}`, { description: 'edited' })).statusCode).toBe(200)
    expect((await call('mktA', 'DELETE', `/promos/${r.json().id}`)).statusCode).toBe(204)
    // A brand of the other company on create → 404.
    expect((await call('mktA', 'POST', '/promos', {
      code: `MKTX${RUN}`, conceptId: conceptB, discountValue: 15, startAt: today.toISOString(), endAt: inAMonth.toISOString(),
    })).statusCode).toBe(404)
  })

  it('section discounts and QR codes: own brand 201, the other company\'s brand 404', async () => {
    const d = { discountPercent: 10, startDate: today.toISOString(), endDate: inAMonth.toISOString(), startTime: '10:00', endTime: '12:00' }
    const ok = await call('mktA', 'POST', '/discounts/sections', { ...d, conceptId: conceptA })
    expect(ok.statusCode).toBe(201)
    expect((await call('mktA', 'PATCH', `/discounts/sections/${ok.json().id}`, { discountPercent: 12 })).statusCode).toBe(200)
    expect((await call('mktA', 'DELETE', `/discounts/sections/${ok.json().id}`)).statusCode).toBe(204)
    expect((await call('mktA', 'POST', '/discounts/sections', { ...d, conceptId: conceptB })).statusCode).toBe(404)

    const qr = await call('bmA', 'POST', '/qrcodes', { conceptId: conceptA, label: 'Window' })
    expect(qr.statusCode).toBe(201)
    expect((await call('bmA', 'PATCH', `/qrcodes/${qr.json().id}`, { label: 'Window 2' })).statusCode).toBe(200)
    expect((await call('bmA', 'DELETE', `/qrcodes/${qr.json().id}`)).statusCode).toBe(204)
    expect((await call('bmA', 'POST', '/qrcodes', { conceptId: conceptB, label: 'Nope' })).statusCode).toBe(404)
  })

  it('loyalty programme: settings and tiers, in company A', async () => {
    const before = (await call('mktB', 'GET', '/loyalty/settings')).json().values['loyalty.min_redeem_points']
    const saved = await call('mktA', 'PATCH', '/loyalty/settings', { 'loyalty.min_redeem_points': 4321 })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().values['loyalty.min_redeem_points']).toBe(4321)
    expect((await call('mktA', 'GET', '/loyalty/settings')).json().values['loyalty.min_redeem_points']).toBe(4321)
    // Company B's programme is untouched.
    const after = (await call('mktB', 'GET', '/loyalty/settings')).json().values['loyalty.min_redeem_points']
    expect(after).toBe(before)
    expect(after).not.toBe(4321)
    const t = await call('mktA', 'POST', '/loyalty/tiers', { tier: `mkt-${RUN}` })
    expect(t.statusCode).toBe(201)
    expect(t.json().tenantId).toBe(tenantA)
    expect((await call('mktA', 'PATCH', `/loyalty/tiers/${t.json().id}`, { displayName: 'Mkt' })).statusCode).toBe(200)
    expect((await call('mktA', 'DELETE', `/loyalty/tiers/${t.json().id}`)).statusCode).toBe(204)
  })
})

describe('UI-06 company separation for the newly admitted roles', () => {
  it('company B\'s marketing sees none of company A\'s rows', async () => {
    const custs = (await call('mktB', 'GET', '/crm/customers')).json().data.map((c: { id: string }) => c.id)
    expect(custs).toContain(custB)
    expect(custs).not.toContain(custA)
    expect((await call('mktB', 'GET', `/crm/customers/${custA}`)).statusCode).toBe(404)
    expect((await call('mktB', 'GET', '/crm/campaigns')).json().map((c: { id: string }) => c.id)).not.toContain(campaignA)
    expect((await call('mktB', 'GET', '/promos')).json().map((p: { id: string }) => p.id)).not.toContain(promoA)
    expect((await call('mktB', 'GET', '/discounts/sections')).json().map((d: { id: string }) => d.id)).not.toContain(discountA)
    expect((await call('mktB', 'GET', `/discounts/sections?conceptId=${conceptA}`)).json()).toEqual([])
    expect((await call('mktB', 'GET', '/qrcodes')).json().map((q: { id: string }) => q.id)).not.toContain(qrA)
    expect((await call('mktB', 'GET', '/loyalty/tiers')).json().map((t: { id: string }) => t.id)).not.toContain(tierA)
    expect((await call('mktB', 'GET', `/analytics/overview?${range}`)).json().totalEvents).toBe(0)
    expect((await call('mktB', 'GET', `/analytics/items?${range}`)).json()).toEqual([])
    expect((await call('mktB', 'GET', '/marketing/activity')).json().map((a: { entityId: string }) => a.entityId)).not.toContain(promoA)
    expect((await call('mktB', 'GET', '/marketing/team')).json().map((u: { id: string }) => u.id)).not.toContain(users.mktA!.id)
  })

  it('company B\'s marketing gets 404 on company A\'s rows and brands', async () => {
    for (const [method, url, body] of [
      ['POST', `/crm/campaigns/${campaignA}/send`, undefined],
      ['PATCH', `/promos/${promoA}`, { description: 'x' }],
      ['DELETE', `/promos/${promoA}`, undefined],
      ['PATCH', `/discounts/sections/${discountA}`, { discountPercent: 50 }],
      ['DELETE', `/discounts/sections/${discountA}`, undefined],
      ['PATCH', `/qrcodes/${qrA}`, { label: 'x' }],
      ['DELETE', `/qrcodes/${qrA}`, undefined],
      ['PATCH', `/loyalty/tiers/${tierA}`, { displayName: 'x' }],
      ['DELETE', `/loyalty/tiers/${tierA}`, undefined],
      ['GET', `/qrcodes?conceptId=${conceptA}`, undefined],
      ['GET', `/analytics/overview?conceptId=${conceptA}`, undefined],
      ['GET', `/analytics/funnel?conceptId=${conceptA}`, undefined],
      ['GET', `/analytics/items?conceptId=${conceptA}`, undefined],
      ['GET', `/analytics/search?conceptId=${conceptA}`, undefined],
      ['GET', `/crm/campaigns/audience?channel=whatsapp&conceptIds=${conceptA}`, undefined],
    ] as const) {
      expect((await call('mktB', method, url, body)).statusCode, `${method} ${url}`).toBe(404)
    }
    // Nothing of A's moved.
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promoA } })).description).toBeNull()
    expect((await prisma.sectionDiscount.findUniqueOrThrow({ where: { id: discountA } })).discountPercent).toBe(10)
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignA } })).status).toBe('draft')
  })

  it('a marketing login with no company sees nothing (empty scope denies)', async () => {
    expect((await call('mktNone', 'GET', '/promos')).json()).toEqual([])
    expect((await call('mktNone', 'GET', '/discounts/sections')).json()).toEqual([])
    expect((await call('mktNone', 'GET', '/qrcodes')).json()).toEqual([])
    expect((await call('mktNone', 'GET', '/crm/campaigns')).json()).toEqual([])
    expect((await call('mktNone', 'GET', '/crm/customers')).json().data).toEqual([])
    expect((await call('mktNone', 'GET', `/analytics/items?${range}`)).json()).toEqual([])
    expect((await call('mktNone', 'GET', `/analytics/overview?${range}`)).json().totalEvents).toBe(0)
    expect((await call('mktNone', 'GET', '/loyalty/tiers')).json()).toEqual([])
  })
})

describe('W3A-RV-01 a campaign broadcasts exactly once', () => {
  const sendsOf = (campaignId: string) => prisma.campaignSend.count({ where: { campaignId } })
  async function settled(campaignId: string) {
    for (let i = 0; i < 100; i++) {
      const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })
      if (c.recipientCount != null) return c
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('broadcast never finished')
  }

  it('two presses at once: one 200, one 409, one message per recipient', async () => {
    const id = (await call('bmA', 'POST', '/crm/campaigns', { name: `once-${RUN}`, channel: 'email', subject: 'Once', body: 'Once' })).json().id as string
    const audience = (await call('bmA', 'GET', '/crm/campaigns/audience?channel=email')).json().total as number
    expect(audience).toBeGreaterThanOrEqual(2)   // custA + shared, both reachable at A
    vi.mocked(sendEmail).mockClear()
    const [r1, r2] = await Promise.all([
      call('bmA', 'POST', `/crm/campaigns/${id}/send`),
      call('mktA', 'POST', `/crm/campaigns/${id}/send`),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    expect([r1, r2].find((r) => r.statusCode === 409)!.json().error.code).toBe('CAMPAIGN_ALREADY_SENT')
    const done = await settled(id)
    expect(done.status).toBe('sent')
    expect(done.sentAt).not.toBeNull()
    expect(done.recipientCount).toBe(audience)
    expect(await sendsOf(id)).toBe(audience)
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(audience)
  })

  it('a press after the broadcast finished is a 409 and sends nothing', async () => {
    const id = (await call('mktA', 'POST', '/crm/campaigns', { name: `again-${RUN}`, channel: 'email', subject: 'Again', body: 'Again' })).json().id as string
    expect((await call('mktA', 'POST', `/crm/campaigns/${id}/send`)).statusCode).toBe(200)
    await settled(id)
    const n = await sendsOf(id)
    const again = await call('bmA', 'POST', `/crm/campaigns/${id}/send`)
    expect(again.statusCode).toBe(409)
    expect(await sendsOf(id)).toBe(n)
  })
})

describe('W3A-RV-02 a customer of both companies: B sees only B', () => {
  type Card = { id: string; totalSpentCents: number; _count: { orders: number }; walletBalance: number | null
    preferredConceptId: string | null; preferredConcept: unknown; firstOrderAt: string | null; lastOrderAt: string | null }

  it('the customer list and profile carry B\'s own figures, no A brand, no wallet', async () => {
    const list = (await call('mktB', 'GET', '/crm/customers?search=&limit=50')).json().data as Card[]
    const row = list.find((c) => c.id === shared)!
    expect(row).toBeTruthy()
    const profile = (await call('mktB', 'GET', `/crm/customers/${shared}`)).json() as Card & { orders: Array<{ conceptId: string }> }
    for (const c of [row, profile]) {
      expect(c.totalSpentCents).toBe(12_300)
      expect(c._count.orders).toBe(1)
      expect(c.lastOrderAt).toBe('2026-03-03T12:00:00.000Z')
      expect(c.firstOrderAt).toBe('2026-03-03T12:00:00.000Z')
      expect(c.preferredConceptId).toBeNull()
      expect(c.preferredConcept).toBeNull()
      expect(c.walletBalance).toBeNull()
    }
    expect(profile.orders.map((o) => o.conceptId)).toEqual([conceptB])
    const raw = JSON.stringify([row, profile])
    expect(raw).not.toContain('Secret A Brand')
    expect(raw).not.toContain('9999900')
    expect(raw).not.toContain('77700')
  })

  it('company A sees its own spend and brand; the wallet stays a manager figure', async () => {
    const a = (await call('mktA', 'GET', `/crm/customers/${shared}`)).json() as Card
    expect(a.totalSpentCents).toBe(10_000_000)
    expect(a._count.orders).toBe(5)
    expect(a.preferredConceptId).toBe(secretA)
    expect((a.preferredConcept as { name: string }).name).toBe(`Secret A Brand ${RUN}`)
    expect(a.walletBalance).toBeNull()
    expect(((await call('fohA', 'GET', `/crm/customers/${shared}`)).json() as Card).walletBalance).toBe(77_700)
  })

  it('segment members carry B\'s own spend, no wallet', async () => {
    const members = (await call('mktB', 'GET', '/crm/behavioral-segments/vip/members')).json() as Array<{ customer: Record<string, unknown> }>
    const m = members.find((x) => x.customer.id === shared)!
    expect(m).toBeTruthy()
    expect(m.customer.totalSpentCents).toBe(12_300)
    expect(m.customer.lastOrderAt).toBe('2026-03-03T12:00:00.000Z')
    expect(m.customer).not.toHaveProperty('walletBalance')
  })

  it('filtering the list by another company\'s brand is a 404', async () => {
    expect((await call('mktB', 'GET', `/crm/customers?conceptId=${secretA}`)).statusCode).toBe(404)
    expect((await call('mktA', 'GET', `/crm/customers?conceptId=${secretA}`)).json().data.map((c: Card) => c.id)).toContain(shared)
  })
})

describe('W3A-RV-03 the CEO\'s Module Access closes the widened routes', () => {
  it('a marketing login without promos / analytics / marketing / crm gets 403, and nothing is written', async () => {
    for (const [method, url, body] of [
      ['POST', '/promos', { code: `DENY${RUN}`, discountType: 'percentage', discountValue: 100, startAt: today.toISOString(), endAt: inAMonth.toISOString() }],
      ['GET', '/promos', undefined],
      ['GET', '/promos/usages', undefined],
      ['POST', '/discounts/sections', { conceptId: conceptA, discountPercent: 50, startDate: today.toISOString(), endDate: inAMonth.toISOString(), startTime: '00:00', endTime: '23:59' }],
      ['GET', '/qrcodes', undefined],
      ['POST', '/qrcodes', { conceptId: conceptA, label: 'Denied' }],
      ['PATCH', '/loyalty/settings', { 'loyalty.point_value_cents': 999 }],
      ['GET', '/loyalty/tiers', undefined],
      ['GET', `/analytics/overview?${range}`, undefined],
      ['GET', `/analytics/funnel?${range}`, undefined],
      ['GET', '/marketing/activity', undefined],
      ['GET', '/marketing/team', undefined],
    ] as const) {
      expect((await call('mktDenied', method, url, body)).statusCode, `${method} ${url}`).toBe(403)
    }
    expect(await prisma.promoCode.count({ where: { code: `DENY${RUN}`.toUpperCase() } })).toBe(0)
    expect(await prisma.qrCode.count({ where: { label: 'Denied', conceptId: conceptA } })).toBe(0)
    // The same role with the modules (mktA) still works — the gate is the module, not the role.
    expect((await call('mktA', 'GET', '/promos')).statusCode).toBe(200)
  })
})

describe('W3A-RV-06 the discount page\'s brand sections', () => {
  it('own brand: the menu read lists its sections; another company\'s brand: 404', async () => {
    const own = await call('mktA', 'GET', `/menu/${conceptA}`)
    expect(own.statusCode).toBe(200)
    expect(own.json().map((c: { id: string }) => c.id)).toContain(categoryA)
    expect((await call('mktB', 'GET', `/menu/${conceptA}`)).statusCode).toBe(404)
    // …and a discount on that section binds to brand A.
    const d = await call('mktA', 'POST', '/discounts/sections', {
      conceptId: conceptA, categoryId: categoryA, discountPercent: 5,
      startDate: today.toISOString(), endDate: inAMonth.toISOString(), startTime: '00:00', endTime: '23:59',
    })
    expect(d.statusCode).toBe(201)
    expect((await call('mktB', 'GET', '/discounts/sections')).json().map((x: { id: string }) => x.id)).not.toContain(d.json().id)
  })
})

describe('UI-06 not over-opened', () => {
  it('bans, strikes, wallet credits and the loyalty back-fill stay with managers', async () => {
    for (const who of ['mktA', 'bmA']) {
      expect((await call(who, 'POST', '/crm/bans', { customerId: custA, reason: 'rude to staff' })).statusCode).toBe(403)
      expect((await call(who, 'POST', '/crm/strikes', { customerId: custA, kind: 'other', reason: 'x' })).statusCode).toBe(403)
      expect((await call(who, 'POST', '/wallet/topup', { customerId: custA, amountCents: 50_000 })).statusCode).toBe(403)
      expect((await call(who, 'POST', '/wallet/bulk-topup', { customerIds: [custA], amountCents: 50_000 })).statusCode).toBe(403)
      expect((await call(who, 'POST', '/loyalty/earn', { orderId: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(403)
    }
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: custA } })).walletBalance).toBe(0)
  })

  it('a cashier still gets 403 on the Marketing workspace', async () => {
    for (const url of ['/crm/customers', '/crm/campaigns', '/promos', '/discounts/sections', '/qrcodes', `/analytics/overview?${range}`, '/marketing/activity', '/loyalty/settings']) {
      expect((await call('cashierA', 'GET', url)).statusCode, url).toBe(403)
    }
  })
})
