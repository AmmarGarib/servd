// Customers & loyalty reconciliation — one implementation each for loyalty
// earn/redeem, the tier ladder, gift-card redemption, promo evaluation,
// segments, blocking, the marketing audience and the phone channel.
//
// Owner decisions exercised: 10 (percentage promos on food only), 12 (one
// point = PKR 0.10; birthday 500 points), 13 (tiers on lifetime spend), 14
// (gift cards at the till, same company only), 15 (bans per company), 16
// (segment definitions), 17 (WhatsApp + email only).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { crmRoutes } from '../src/modules/crm/routes.js'
import { loyaltyRoutes } from '../src/modules/loyalty/routes.js'
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { promoRoutes } from '../src/modules/promos/routes.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { LOYALTY_DEFAULTS, invalidateLoyaltySettings } from '../src/lib/loyaltySettings.js'
import { loadCompanyLoyaltySettings, companyLoyaltyKey, pointValueMarkerKey } from '../src/modules/loyalty/settings.js'
import { awardOrderPoints, redeemPointsOnOrder, quoteRedemption, tierStatus } from '../src/modules/loyalty/service.js'
import { evaluatePromo, promoDiscountCents } from '../src/lib/promoEval.js'
import { redeemGiftCard } from '../src/modules/giftCards/service.js'
import { applyGiftCardTender } from '../src/modules/pos/service.js'
import { activeBanAtCompany, assertNotBannedAtCompany } from '../src/lib/strikes.js'
import { reachableAtCompany } from '../src/lib/marketingAudience.js'
import { computeCompanySegments, segmentMemberIds } from '../src/modules/crm/segmentComputation.js'
import { updateOrderStatus } from '../src/modules/orders/service.js'
import { whatsappNumber, sendPhoneMessage } from '../src/lib/notify.js'

const RUN = Math.random().toString(36).slice(2, 8)
const DAY = 86_400_000
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptA2: string, conceptB: string
const staff: Record<string, { id: string; token: string }> = {}

async function mkStaff(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@recon.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '1h' })
const asCustomer = (id: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${customerToken(id)}` } })

let phoneSeq = 0
async function mkCustomer(key: string) {
  phoneSeq += 1
  return prisma.customer.create({
    data: { name: key, email: `${key}.${RUN}@recon.test`, phone: `+92311${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}${String(phoneSeq).padStart(4, '0')}` },
  })
}

async function mkOrder(conceptId: string, customerId: string | null, totalCents: number, opts: { status?: string; source?: string; completedAt?: Date; pending?: boolean } = {}) {
  const o = await prisma.order.create({
    data: {
      conceptId, customerId, source: opts.source ?? 'servd', status: opts.status ?? 'completed', totalCents,
      completedAt: opts.status && opts.status !== 'completed' ? null : (opts.completedAt ?? new Date()),
      placedAt: opts.completedAt ?? new Date(),
      items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: totalCents }] },
    } as never,
  })
  if (opts.pending) {
    await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: totalCents, status: 'pending' } })
  }
  return o
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Recon A', slug: `recon-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Recon B', slug: `recon-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Brand A', slug: `rc-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Brand A2', slug: `rc-a2-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Brand B', slug: `rc-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  await mkStaff('mgrA', tenantA)
  await mkStaff('mgrB', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.register(giftCardRoutes, { prefix: '/gift-cards' })
  await app.register(promoRoutes, { prefix: '/promos' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── Loyalty point value (decision 12) ────────────────────────────────────────

describe('one point is worth PKR 0.10', () => {
  it('is the default', () => {
    expect(LOYALTY_DEFAULTS['loyalty.point_value_cents']).toBe(10)
  })

  it('a stored PKR 1 value is corrected once, and a later edit is respected', async () => {
    const t = (await prisma.tenant.create({ data: { name: 'Legacy value', slug: `legacy-${RUN}` } })).id
    const key = companyLoyaltyKey('loyalty.point_value_cents', t)
    await prisma.setting.create({ data: { key, value: '100' } })
    expect((await loadCompanyLoyaltySettings(t))['loyalty.point_value_cents']).toBe(10)
    expect(await prisma.setting.findUnique({ where: { key: pointValueMarkerKey(t) } })).not.toBeNull()
    await prisma.setting.update({ where: { key }, data: { value: '20' } })
    expect((await loadCompanyLoyaltySettings(t))['loyalty.point_value_cents']).toBe(20)
  })

  it('the public programme endpoint reports it for a brand', async () => {
    invalidateLoyaltySettings()
    const r = await app.inject({ method: 'GET', url: `/loyalty/program?conceptSlug=rc-a-${RUN}` })
    expect(r.statusCode).toBe(200)
    expect(r.json().pointValueCents).toBe(10)
    expect(r.json().birthdayBonusPoints).toBe(500)
  })
})

// ─── Loyalty earn (one earn, on completion) ───────────────────────────────────

describe('the order earn', () => {
  it('credits once per order, advances the stamp card and books the liability', async () => {
    const c = await mkCustomer('earner')
    const o = await mkOrder(conceptA, c.id, 25_000)   // PKR 250 → 250 pts at 1 pt / PKR 1
    const first = await awardOrderPoints(o.id)
    const second = await awardOrderPoints(o.id)
    expect(first?.credited).toBe(true)
    expect(second?.credited).toBe(false)
    const acct = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { tenantId_customerId: { tenantId: tenantA, customerId: c.id } } })
    expect(acct.pointsBalance).toBe(250)
    expect((acct.stampCounts as Record<string, number>)[`rc-a-${RUN}`]).toBe(1)
    const earns = await prisma.loyaltyTransaction.findMany({ where: { orderId: o.id, type: 'earn' } })
    expect(earns).toHaveLength(1)
    const je = await prisma.journalEntry.findFirst({ where: { reference: `loyalty.earn:${earns[0]!.id}` } })
    expect(je?.tenantId).toBe(tenantA)
  })

  it('fires when an order completes through the order lifecycle', async () => {
    const c = await mkCustomer('lifecycle')
    const o = await mkOrder(conceptA, c.id, 10_000, { status: 'ready' })
    await updateOrderStatus(o.id, 'completed')
    const until = Date.now() + 5000
    let n = 0
    while (Date.now() < until) {
      n = await prisma.loyaltyTransaction.count({ where: { orderId: o.id, type: 'earn' } })
      if (n > 0) break
      await new Promise((res) => setTimeout(res, 50))
    }
    expect(n).toBe(1)
  })

  it('POST /loyalty/earn is a scoped back-fill that never double-awards', async () => {
    const c = await mkCustomer('backfill')
    const o = await mkOrder(conceptA, c.id, 5_000)
    expect((await call('mgrB', 'POST', '/loyalty/earn', { orderId: o.id })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', '/loyalty/earn', { orderId: o.id })).statusCode).toBe(200)
    expect((await call('mgrA', 'POST', '/loyalty/earn', { orderId: o.id })).statusCode).toBe(409)
  })
})

// ─── Loyalty redeem (one redeem) ──────────────────────────────────────────────

describe('the redeem', () => {
  it('values points at PKR 0.10 and enforces the minimum', async () => {
    const c = await mkCustomer('redeemer')
    await prisma.loyaltyAccount.create({ data: { tenantId: tenantA, customerId: c.id, pointsBalance: 1000, lifetimePoints: 1000, stampCounts: {} } })
    const q = await quoteRedemption({ customerId: c.id, requestedPoints: 500, tenantId: tenantA, capCents: 1_000_000 })
    expect(q).toMatchObject({ points: 500, discountCents: 5_000 })
    await expect(quoteRedemption({ customerId: c.id, requestedPoints: 10, tenantId: tenantA, capCents: 1_000_000 }))
      .rejects.toMatchObject({ code: 'LOYALTY_BELOW_MINIMUM' })
  })

  it('POST /loyalty/redeem lowers the bill and the pending payment, and records the discount', async () => {
    const c = await mkCustomer('redeem-route')
    await prisma.loyaltyAccount.create({ data: { tenantId: tenantA, customerId: c.id, pointsBalance: 300, lifetimePoints: 300, stampCounts: {} } })
    const o = await mkOrder(conceptA, c.id, 20_000, { status: 'received', pending: true })
    const r = await asCustomer(c.id, 'POST', '/loyalty/redeem', { orderId: o.id, pointsToRedeem: 200 })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ pointsRedeemed: 200, discountCents: 2_000, newBalance: 100 })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } })
    expect(after.totalCents).toBe(18_000)
    expect(after.discountCents).toBe(2_000)
    expect(after.payments[0]!.amountCents).toBe(18_000)
    expect((await asCustomer(c.id, 'POST', '/loyalty/redeem', { orderId: o.id, pointsToRedeem: 60 })).statusCode).toBe(409)
  })

  it('redeemPointsOnOrder refuses a closed order', async () => {
    const c = await mkCustomer('closed')
    await prisma.loyaltyAccount.create({ data: { tenantId: tenantA, customerId: c.id, pointsBalance: 300, lifetimePoints: 300, stampCounts: {} } })
    const o = await mkOrder(conceptA, c.id, 20_000)
    await expect(redeemPointsOnOrder({ customerId: c.id, orderId: o.id, points: 100 })).rejects.toMatchObject({ code: 'ORDER_NOT_OPEN' })
  })
})

// ─── Tiers (decision 13) ──────────────────────────────────────────────────────

describe('tiers unlock on lifetime spend', () => {
  it('reads the TierConfig ladder and assigns on the order earn', async () => {
    await prisma.tierConfig.createMany({
      data: [
        { tenantId: tenantA, tier: `rc-bronze-${RUN}`, displayName: 'Bronze', rank: 0, unlockSpendCents: 0 },
        { tenantId: tenantA, tier: `rc-gold-${RUN}`, displayName: 'Gold', rank: 5, unlockSpendCents: 1_000_000 },
      ],
      skipDuplicates: true,
    })
    const c = await mkCustomer('tiered')
    const o = await mkOrder(conceptA, c.id, 1_200_000)        // PKR 12,000 at company A
    await mkOrder(conceptB, c.id, 50_000)                      // not A's spend
    await awardOrderPoints(o.id)
    const st = await tierStatus(c.id, tenantA)
    expect(st.lifetimeSpendCents).toBe(1_200_000)
    expect(st.tier.slug).toBe(`rc-gold-${RUN}`)
    const acct = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { tenantId_customerId: { tenantId: tenantA, customerId: c.id } } })
    expect(acct.tier).toBe(`rc-gold-${RUN}`)
    const r = await asCustomer(c.id, 'GET', `/loyalty/status?conceptSlug=rc-a-${RUN}`)
    expect(r.statusCode).toBe(200)
    expect(r.json().tier.name).toBe('Gold')
    expect(r.json().pointsValueCents).toBe(r.json().pointsBalance * 10)
  })
})

// ─── Promos (decision 10) ─────────────────────────────────────────────────────

describe('one promo evaluation, percentage on food only', () => {
  let code: string
  beforeAll(async () => {
    code = `RC${RUN}`.toUpperCase()
    await prisma.promoCode.create({
      data: {
        code, tenantId: tenantA, discountType: 'percentage', discountValue: 10, minOrderCents: 50_000,
        startAt: new Date(Date.now() - DAY), endAt: new Date(Date.now() + DAY), perCustomerLimit: 1,
      },
    })
  })

  it('discounts the food subtotal and measures the minimum on it', async () => {
    const ok = await evaluatePromo({ code, tenantId: tenantA, conceptId: conceptA, foodSubtotalCents: 100_000 })
    expect(ok.ok && ok.discountCents).toBe(10_000)
    const low = await evaluatePromo({ code, tenantId: tenantA, conceptId: conceptA, foodSubtotalCents: 40_000 })
    expect(low).toMatchObject({ ok: false, reason: 'PROMO_MIN_ORDER' })
    // Fixed promos are stored in paisa (PKR 500 = 50_000), capped at the bill.
    expect(promoDiscountCents({ discountType: 'fixed', discountValue: 50_000, maxDiscountCents: null }, 30_000)).toBe(30_000)
  })

  it("another company's code is unknown", async () => {
    const r = await evaluatePromo({ code, tenantId: tenantB, conceptId: conceptB, foodSubtotalCents: 100_000 })
    expect(r).toMatchObject({ ok: false, reason: 'INVALID_PROMO' })
  })

  it('applies the per-customer limit when a customer is known', async () => {
    const c = await mkCustomer('promo-user')
    const promo = await prisma.promoCode.findUniqueOrThrow({ where: { tenantId_code: { tenantId: tenantA, code } } })
    const o = await mkOrder(conceptA, c.id, 100_000)
    await prisma.promoCodeUsage.create({ data: { promoCodeId: promo.id, customerId: c.id, orderId: o.id, discountCents: 10_000 } })
    const r = await evaluatePromo({ code, tenantId: tenantA, conceptId: conceptA, foodSubtotalCents: 100_000, customerId: c.id })
    expect(r).toMatchObject({ ok: false, reason: 'PROMO_LIMIT_REACHED' })
  })

  it('POST /promos/validate is gone', async () => {
    const r = await app.inject({ method: 'POST', url: '/promos/validate', payload: { code, conceptId: conceptA, orderCents: 100_000 } })
    expect(r.statusCode).toBe(404)
  })
})

// ─── Gift cards (decision 14) ─────────────────────────────────────────────────

describe('one gift-card redeem, same company only', () => {
  const card = async (tenantId: string, balance: number) => prisma.giftCard.create({
    data: { tenantId, code: `GS-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${RUN.toUpperCase().slice(0, 4)}`, issuedAmountCents: balance, balanceCents: balance },
  })

  it('pays part of an order: card drained, bill and pending payment lowered', async () => {
    const gc = await card(tenantA, 5_000)
    const o = await mkOrder(conceptA2, null, 12_000, { status: 'received', pending: true })
    const r = await redeemGiftCard({ code: gc.code, orderId: o.id })
    expect(r).toMatchObject({ appliedCents: 5_000, remainingDueCents: 7_000, cardBalanceCents: 0 })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true, giftCardRedemptions: true } })
    expect(after.totalCents).toBe(7_000)
    expect(after.payments[0]!.amountCents).toBe(7_000)
    expect(after.giftCardRedemptions).toHaveLength(1)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).status).toBe('redeemed_full')
  })

  it("never pays for another company's order", async () => {
    const gc = await card(tenantA, 5_000)
    const o = await mkOrder(conceptB, null, 12_000, { status: 'received', pending: true })
    await expect(redeemGiftCard({ code: gc.code, orderId: o.id })).rejects.toMatchObject({ statusCode: 404 })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents).toBe(5_000)
  })

  it('is a till tender: a card covering the bill closes the sale', async () => {
    const gc = await card(tenantA, 20_000)
    const o = await mkOrder(conceptA, null, 8_000, { status: 'received', source: 'pos', pending: true })
    const r = await applyGiftCardTender({ orderId: o.id, code: gc.code })
    expect(r.appliedCents).toBe(8_000)
    expect(r.completed).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).balanceCents).toBe(12_000)
  })

  it('POST /gift-cards/redeem needs an order the operator can act on', async () => {
    const gc = await card(tenantA, 3_000)
    expect((await call('mgrA', 'POST', '/gift-cards/redeem', { code: gc.code, amountCents: 1_000 })).statusCode).toBe(400)
    const o = await mkOrder(conceptA, null, 9_000, { status: 'received', source: 'pos', pending: true })
    expect((await call('mgrB', 'POST', '/gift-cards/redeem', { code: gc.code, orderId: o.id })).statusCode).toBe(404)
    const r = await call('mgrA', 'POST', '/gift-cards/redeem', { code: gc.code, orderId: o.id })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ appliedCents: 3_000, remainingDueCents: 6_000, completed: false })
  })
})

// ─── Blocking (decision 15) ───────────────────────────────────────────────────

describe('one blocking mechanism, per company', () => {
  it('the CRM block raises a ban with the customer’s contacts, effective at that company only', async () => {
    const c = await mkCustomer('blocked')
    await mkOrder(conceptA, c.id, 5_000)
    await mkOrder(conceptB, c.id, 5_000)
    const r = await call('mgrA', 'POST', '/crm/bans', { customerId: c.id, reason: 'dine and dash' })
    expect(r.statusCode).toBe(201)
    expect(r.json().email).toBe(c.email!.toLowerCase())
    expect(r.json().phone).toBe(c.phone)

    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantA, intent: 'order' })).rejects.toMatchObject({ code: 'BANNED' })
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantB, intent: 'order' })).resolves.toBeUndefined()
    // Matched on the phone alone too (a fresh account with the same number).
    expect(await activeBanAtCompany({ phone: c.phone, tenantId: tenantA })).not.toBeNull()

    // The CRM shows it to A, not to B; A can unblock.
    const a = await call('mgrA', 'GET', `/crm/customers/${c.id}`)
    expect(a.json().activeBan?.id).toBe(r.json().id)
    const b = await call('mgrB', 'GET', `/crm/customers/${c.id}`)
    expect(b.json().activeBan).toBeNull()
    expect((await call('mgrA', 'POST', `/crm/bans/${r.json().id}/lift`, { reason: 'paid up' })).statusCode).toBe(200)
    await expect(assertNotBannedAtCompany({ customerId: c.id, tenantId: tenantA })).resolves.toBeUndefined()
  })

  it('the old blacklist toggle is gone', async () => {
    const c = await mkCustomer('toggle')
    await mkOrder(conceptA, c.id, 5_000)
    const r = await call('mgrA', 'PATCH', `/crm/customers/${c.id}/blacklist`, { isBlacklisted: true })
    expect(r.statusCode).toBe(404)
  })

  it("marketing reach excludes a company's own banned customers only", async () => {
    const c = await mkCustomer('reach')
    await mkOrder(conceptA, c.id, 5_000)
    await call('mgrA', 'POST', '/crm/bans', { customerId: c.id, reason: 'abuse' })
    const inA = await prisma.customer.count({ where: { AND: [{ id: c.id }, await reachableAtCompany(tenantA)] } })
    const inB = await prisma.customer.count({ where: { AND: [{ id: c.id }, await reachableAtCompany(tenantB)] } })
    expect(inA).toBe(0)
    expect(inB).toBe(1)
  })
})

// ─── Segments (decision 16) and campaigns ─────────────────────────────────────

describe('one segment system, per company', () => {
  let vip: string, lapsed: string, fresh: string

  beforeAll(async () => {
    vip = (await mkCustomer('seg-vip')).id
    await mkOrder(conceptA, vip, 3_000_000)
    await mkOrder(conceptA2, vip, 2_500_000)            // PKR 55k across A's brands
    lapsed = (await mkCustomer('seg-lapsed')).id
    await mkOrder(conceptA, lapsed, 10_000, { completedAt: new Date(Date.now() - 90 * DAY) })
    await mkOrder(conceptB, lapsed, 10_000)             // recent at B: not B's lapsed
    fresh = (await mkCustomer('seg-fresh')).id
    await mkOrder(conceptA, fresh, 10_000)
    await computeCompanySegments(tenantA)
    await computeCompanySegments(tenantB)
  })

  it('VIP is PKR 50k lifetime spend at the company; lapsed is 60 days with an earlier order', async () => {
    expect(await segmentMemberIds('vip', [tenantA])).toContain(vip)
    expect(await segmentMemberIds('vip', [tenantB])).not.toContain(vip)
    expect(await segmentMemberIds('lapsed', [tenantA])).toContain(lapsed)
    expect(await segmentMemberIds('lapsed', [tenantA])).not.toContain(fresh)
    expect(await segmentMemberIds('lapsed', [tenantB])).not.toContain(lapsed)
  })

  it('the summary and segment lists are the company’s own; smart-segments and saved filters are gone', async () => {
    const s = await call('mgrA', 'GET', '/crm/summary')
    expect(s.statusCode).toBe(200)
    const seg = Object.fromEntries((s.json().segments as Array<{ key: string; count: number }>).map((x) => [x.key, x.count]))
    expect(seg['vip']).toBeGreaterThanOrEqual(1)
    const members = await call('mgrB', 'GET', '/crm/behavioral-segments/vip/members')
    expect((members.json() as Array<{ customer: { id: string } }>).map((m) => m.customer.id)).not.toContain(vip)
    expect((await call('mgrA', 'GET', '/crm/smart-segments')).statusCode).toBe(404)
    expect((await call('mgrA', 'GET', '/crm/segments')).statusCode).toBe(404)
  })

  it('a campaign targets a segment: the audience count is its reachable members', async () => {
    const aud = await call('mgrA', 'GET', '/crm/campaigns/audience?channel=email&segment=vip')
    expect(aud.statusCode).toBe(200)
    expect(aud.json().total).toBe(1)
    const created = await call('mgrA', 'POST', '/crm/campaigns', { name: `vip-${RUN}`, channel: 'email', subject: 's', body: 'b', segment: 'vip' })
    expect(created.statusCode).toBe(201)
    expect(created.json().segment.slug).toBe('vip')
    const sent = await call('mgrA', 'POST', `/crm/campaigns/${created.json().id}/send`)
    expect(sent.json().recipientCount).toBe(1)
    expect((await call('mgrA', 'POST', '/crm/campaigns', { name: 'x', channel: 'sms', body: 'b' })).statusCode).toBe(400)
  })
})

// ─── Phone channel (decision 17) ──────────────────────────────────────────────

describe('WhatsApp and email only', () => {
  it('the phone sender is WhatsApp, and numbers are normalised for the gateway', () => {
    expect(whatsappNumber('+92 300 1234567')).toBe('923001234567')
    expect(whatsappNumber('03001234567')).toBe('923001234567')
  })
})
