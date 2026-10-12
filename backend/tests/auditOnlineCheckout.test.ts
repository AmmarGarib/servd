// Online-ordering audit (2026-10-10) — checkout fixes, regression suite.
//
//   ONL-01  a fixed promo is stored in paisa and applied in paisa (it took
//           100× its value: "PKR 150 off" took the whole bill)
//   ONL-02  Keenu / JazzCash / EasyPaisa are refused (422) until a gateway is
//           configured AND checkout charges through it; the public endpoints
//           list only what checkout accepts
//   ONL-03  the tip is in the pending payment with the order total; the
//           response is the order as placed (tip, gift card, wallet applied)
//   ONL-12  promo codes are unique per company; a clash is a 409
//   ONL-13  time-limited menu sections follow Karachi time, at checkout too
//   ONL-14  a closed brand refuses orders (409 BRAND_CLOSED), except a
//           pre-order for a time when it is open
//   ONL-15  an unusable gift card is a 422 before anything is created
//
// Two companies throughout: A (the brand under test) and B (another company
// with its own brand, promo codes and gift cards).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'
import { promoRoutes } from '../src/modules/promos/routes.js'
import { promoDiscountCents, describePromo } from '../src/lib/promoEval.js'
import {
  availablePaymentMethods, gatewayAvailable, gatewayConfigured,
} from '../src/modules/storefront/paymentMethods.js'
import { openAt, nextOpening, sectionVisibleAt, pktClock, assertItemsServedAt } from '../src/modules/storefront/serviceHours.js'

const RUN = Math.random().toString(36).slice(2, 8)
const MIN = 60_000
const DAY = 86_400_000

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string, conceptClosed: string
let slugA: string, slugB: string, slugClosed: string
let clubA: string, clubB: string, clubClosed: string
const staff: Record<string, string> = {}

async function mkStaff(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const asStaff = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]}` } })

const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
const asCustomer = (id: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${customerToken(id)}` } })

let seq = 0
async function mkCustomer(data: { walletBalance?: number } = {}) {
  seq += 1
  const c = await prisma.customer.create({
    data: {
      name: `Guest ${seq}`, email: `ao-${RUN}-${seq}@example.com`,
      phone: `+92300${RUN.replace(/\D/g, '').padEnd(3, '1').slice(0, 3)}${String(seq).padStart(4, '0')}`,
      phoneVerifiedAt: new Date(),
    },
  })
  // The wallet is per company (ONL-R2-01): a balance is the wallet at A's
  // company, where every wallet test here orders.
  if (data.walletBalance) {
    await prisma.customerWallet.create({ data: { tenantId: tenantA, customerId: c.id, balanceCents: data.walletBalance } })
  }
  return c
}
/** The customer's wallet balance at company A. */
async function walletOf(customerId: string): Promise<number> {
  return (await prisma.customerWallet.findUnique({ where: { tenantId_customerId: { tenantId: tenantA, customerId } } }))?.balanceCents ?? 0
}

const basket = (menuItemId: string, quantity = 1) => [{ menuItemId, quantity, modifiers: [] }]
const quoteUrl = (slug: string, params: Record<string, string>) =>
  `/storefront/quote?${new URLSearchParams({ conceptSlug: slug, type: 'pickup', ...params }).toString()}`

async function pendingSum(orderId: string) {
  const ps = await prisma.payment.findMany({ where: { orderId, status: 'pending' } })
  return ps.reduce((s, p) => s + p.amountCents, 0)
}

/** "HH:MM" for a PKT minute-of-day (wrapped into 0..1439). */
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Online A', slug: `online-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Online B', slug: `online-b-${RUN}` } })).id
  const mkConcept = async (tenantId: string, slug: string) => (await prisma.concept.create({
    data: { name: slug, slug, type: 'restaurant', tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8, isActive: true },
  })).id
  slugA = `ao-a-${RUN}`; slugB = `ao-b-${RUN}`; slugClosed = `ao-closed-${RUN}`
  conceptA = await mkConcept(tenantA, slugA)
  conceptB = await mkConcept(tenantB, slugB)
  conceptClosed = await mkConcept(tenantA, slugClosed)
  const mkItem = async (conceptId: string) => {
    const categoryId = (await prisma.category.create({ data: { conceptId, name: 'Sandwiches' } })).id
    return (await prisma.menuItem.create({ data: { conceptId, categoryId, name: 'Club sandwich', priceCents: 100_000, isAvailable: true } })).id
  }
  clubA = await mkItem(conceptA)
  clubB = await mkItem(conceptB)
  clubClosed = await mkItem(conceptClosed)

  await mkStaff('mgrA', tenantA)
  await mkStaff('mgrB', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.register(promoRoutes, { prefix: '/promos' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── ONL-01 — fixed promo units ──────────────────────────────────────────────

describe('ONL-01: a fixed promo is paisa end to end', () => {
  const window = () => ({ startAt: new Date(Date.now() - DAY).toISOString(), endAt: new Date(Date.now() + DAY).toISOString() })

  it('the admin payload for "Fixed, PKR 150" takes PKR 150 off the quote and the order', async () => {
    // Exactly what admin/promos/page.tsx sends for value 150, min order 1000.
    const created = await asStaff('mgrA', 'POST', '/promos', {
      code: `FLAT150${RUN}`, discountType: 'fixed', discountValue: 15000, minOrderCents: 100000, perCustomerLimit: 5, ...window(),
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().discountValue).toBe(15000)

    const c = await mkCustomer()
    const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, {
      paymentGateway: 'cash', promoCode: `FLAT150${RUN}`, items: JSON.stringify(basket(clubA, 2)),
    }))
    expect(q.statusCode).toBe(200)
    // Food 2,000 + 15% GST 300 − promo 150 = 2,150.
    expect(q.json().promo).toMatchObject({ discountCents: 15_000 })
    expect(q.json().promo.description).toMatch(/^PKR 150 off/)
    expect(q.json().totalCents).toBe(200_000 + 30_000 - 15_000)

    const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', promoCode: `FLAT150${RUN}`, items: basket(clubA, 2),
    })
    expect(o.statusCode).toBe(201)
    expect(o.json()).toMatchObject({ promoDiscountCents: 15_000, totalCents: 215_000 })
    expect(await pendingSum(o.json().id)).toBe(215_000)
  })

  it('promoDiscountCents reads a fixed value as paisa, capped at the food subtotal', () => {
    expect(promoDiscountCents({ discountType: 'fixed', discountValue: 15_000, maxDiscountCents: null }, 230_000)).toBe(15_000)
    expect(promoDiscountCents({ discountType: 'fixed', discountValue: 500, maxDiscountCents: null }, 30_000)).toBe(500)
    expect(promoDiscountCents({ discountType: 'fixed', discountValue: 50_000, maxDiscountCents: null }, 30_000)).toBe(30_000)
    expect(promoDiscountCents({ discountType: 'percentage', discountValue: 10, maxDiscountCents: 5_000 }, 100_000)).toBe(5_000)
  })

  it('the description shows rupees', () => {
    const endAt = new Date('2026-12-31T12:00:00Z')
    expect(describePromo({ description: null, discountType: 'fixed', discountValue: 15_000, endAt })).toBe('PKR 150 off · expires 31 Dec 2026')
    expect(describePromo({ description: null, discountType: 'fixed', discountValue: 15_050, endAt })).toMatch(/^PKR 150\.50 off/)
    expect(describePromo({ description: null, discountType: 'percentage', discountValue: 20, endAt })).toMatch(/^20% off food/)
  })

  it('refuses a value in the wrong unit', async () => {
    const half = await asStaff('mgrA', 'POST', '/promos', { code: `HALF${RUN}`, discountType: 'fixed', discountValue: 150.5, ...window() })
    expect(half.statusCode).toBe(400)
    expect(half.json().error.code).toBe('INVALID_DISCOUNT')
    const pct = await asStaff('mgrA', 'POST', '/promos', { code: `PCT${RUN}`, discountType: 'percentage', discountValue: 150, ...window() })
    expect(pct.statusCode).toBe(400)
    // An edit is checked against the promo's own type.
    const ok = await asStaff('mgrA', 'POST', '/promos', { code: `EDIT${RUN}`, discountType: 'percentage', discountValue: 10, ...window() })
    expect(ok.statusCode).toBe(201)
    expect((await asStaff('mgrA', 'PATCH', `/promos/${ok.json().id}`, { discountValue: 120 })).statusCode).toBe(400)
    expect((await asStaff('mgrA', 'PATCH', `/promos/${ok.json().id}`, { discountValue: 15 })).statusCode).toBe(200)
  })
})

// ─── ONL-12 — promo codes per company ────────────────────────────────────────

describe('ONL-12: a promo code is unique within its company only', () => {
  const window = () => ({ startAt: new Date(Date.now() - DAY).toISOString(), endAt: new Date(Date.now() + DAY).toISOString() })
  const code = `SHARED${RUN}`.toUpperCase()

  it('company B can run a code company A already runs; a repeat inside one company is a 409', async () => {
    const a = await asStaff('mgrA', 'POST', '/promos', { code, discountType: 'fixed', discountValue: 10_000, ...window() })
    expect(a.statusCode).toBe(201)
    const b = await asStaff('mgrB', 'POST', '/promos', { code, discountType: 'percentage', discountValue: 20, ...window() })
    expect(b.statusCode).toBe(201)
    expect(b.json().tenantId).toBe(tenantB)

    const againA = await asStaff('mgrA', 'POST', '/promos', { code, discountType: 'percentage', discountValue: 5, ...window() })
    expect(againA.statusCode).toBe(409)
    expect(againA.json().error.code).toBe('PROMO_CODE_TAKEN')
    const againB = await asStaff('mgrB', 'POST', '/promos', { code: code.toLowerCase(), discountType: 'percentage', discountValue: 5, ...window() })
    expect(againB.statusCode).toBe(409)
  })

  it('renaming onto a code the company already has is a 409; B never sees or edits A’s row', async () => {
    const other = await asStaff('mgrA', 'POST', '/promos', { code: `OTHER${RUN}`, discountType: 'percentage', discountValue: 5, ...window() })
    expect((await asStaff('mgrA', 'PATCH', `/promos/${other.json().id}`, { code })).statusCode).toBe(409)
    expect((await asStaff('mgrB', 'PATCH', `/promos/${other.json().id}`, { isActive: false })).statusCode).toBe(404)
    const listB = await asStaff('mgrB', 'GET', '/promos')
    expect(listB.json().map((p: { id: string }) => p.id)).not.toContain(other.json().id)
  })

  it('checkout applies the promo of the brand’s own company', async () => {
    const c = await mkCustomer()
    const atA = await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: 'cash', promoCode: code, items: JSON.stringify(basket(clubA)) }))
    expect(atA.json().promo.discountCents).toBe(10_000)               // A's: PKR 100 fixed
    const atB = await asCustomer(c.id, 'GET', quoteUrl(slugB, { paymentGateway: 'cash', promoCode: code, items: JSON.stringify(basket(clubB)) }))
    expect(atB.json().promo.discountCents).toBe(20_000)               // B's: 20% of 1,000
    const orderB = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugB, type: 'pickup', paymentGateway: 'cash', promoCode: code, items: basket(clubB),
    })
    expect(orderB.statusCode).toBe(201)
    const promoB = await prisma.promoCode.findFirstOrThrow({ where: { tenantId: tenantB, code } })
    expect(orderB.json().promoCodeId).toBe(promoB.id)
  })
})

// ─── ONL-02 — online payment methods ─────────────────────────────────────────

describe('ONL-02: online methods are refused until checkout really charges them', () => {
  const ENV = ['KEENU_MERCHANT_ID', 'KEENU_API_KEY']
  afterEach(() => { for (const k of ENV) delete process.env[k] })

  it('quote and checkout answer 422 PAYMENT_METHOD_UNAVAILABLE for Keenu, JazzCash and EasyPaisa; nothing is created', async () => {
    const c = await mkCustomer()
    for (const gw of ['keenu', 'jazzcash', 'easypaisa']) {
      const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: gw, items: JSON.stringify(basket(clubA)) }))
      expect(q.statusCode).toBe(422)
      expect(q.json().error.code).toBe('PAYMENT_METHOD_UNAVAILABLE')
      const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
        conceptSlug: slugA, type: 'pickup', paymentGateway: gw, paymentPhone: '03001234567', items: basket(clubA),
      })
      expect(o.statusCode).toBe(422)
      expect(o.json().error).toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE', details: { available: ['cash'] } })
    }
    expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0)
  })

  it('credentials alone do not switch a gateway on — it must be wired into checkout', async () => {
    process.env['KEENU_MERCHANT_ID'] = 'm-1'
    process.env['KEENU_API_KEY'] = 'k-1'
    expect(gatewayConfigured('keenu')).toBe(true)
    expect(gatewayAvailable('keenu')).toBe(false)
    expect(availablePaymentMethods()).toEqual(['cash'])
    const c = await mkCustomer()
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'keenu', items: basket(clubA) })
    expect(o.statusCode).toBe(422)
  })

  it('the public endpoints list only what checkout accepts', async () => {
    expect((await app.inject({ method: 'GET', url: '/storefront/payment-methods' })).json()).toEqual({ methods: ['cash'] })
    const menu = await app.inject({ method: 'GET', url: `/storefront/${slugA}/menu` })
    expect(menu.json().paymentMethods).toEqual(['cash'])
    const q = await app.inject({ method: 'GET', url: quoteUrl(slugA, { paymentGateway: 'cash', items: JSON.stringify(basket(clubA)) }) })
    expect(q.json().paymentMethods).toEqual(['cash'])
  })

  it('"wallet" as the method is accepted only when nothing is left to collect', async () => {
    const poor = await mkCustomer({ walletBalance: 10_000 })
    const short = await asCustomer(poor.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', useWallet: true, items: basket(clubA),
    })
    expect(short.statusCode).toBe(422)
    expect(short.json().error.code).toBe('PAYMENT_METHOD_UNAVAILABLE')
    expect((await walletOf(poor.id))).toBe(10_000)

    // Card rate 8%: 1,000 + 80 = 1,080, all from the wallet.
    const rich = await mkCustomer({ walletBalance: 200_000 })
    const full = await asCustomer(rich.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', useWallet: true, items: basket(clubA),
    })
    expect(full.statusCode).toBe(201)
    expect(full.json()).toMatchObject({ totalCents: 0, walletAmountCents: 108_000 })
    expect((await walletOf(rich.id))).toBe(92_000)
  })
})

// ─── ONL-03 — the tip is in the payment ──────────────────────────────────────

describe('ONL-03: total == pending payments after checkout, tip included', () => {
  it('cash + tip: the pending cash payment is the bill including the tip, and the response shows it', async () => {
    const c = await mkCustomer()
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', tipCents: 10_000, items: basket(clubA),
    })
    expect(o.statusCode).toBe(201)
    // 1,000 + 15% GST = 1,150, + PKR 100 tip.
    expect(o.json()).toMatchObject({ totalCents: 125_000, tipCents: 10_000 })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.json().id }, include: { payments: true } })
    expect(row).toMatchObject({ totalCents: 125_000, tipCents: 10_000 })
    expect(row.payments.map((p) => [p.method, p.status, p.amountCents])).toEqual([['cash', 'pending', 125_000]])
  })

  it('tip + gift card: the card pays part, the payment carries the rest', async () => {
    const card = await prisma.giftCard.create({ data: { code: `GC-TIP-${RUN}`.toUpperCase(), tenantId: tenantA, issuedAmountCents: 50_000, balanceCents: 50_000 } })
    const c = await mkCustomer()
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', tipCents: 10_000, giftCardCode: card.code, items: basket(clubA),
    })
    expect(o.statusCode).toBe(201)
    expect(o.json()).toMatchObject({ totalCents: 75_000, tipCents: 10_000, giftCardAppliedCents: 50_000, giftCardError: null })
    expect(await pendingSum(o.json().id)).toBe(75_000)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(0)
  })

  it('tip + wallet: the wallet pays first, the tip stays on the payment', async () => {
    const c = await mkCustomer({ walletBalance: 20_000 })
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', useWallet: true, tipCents: 10_000, items: basket(clubA),
    })
    expect(o.statusCode).toBe(201)
    expect(o.json()).toMatchObject({ totalCents: 105_000, walletAmountCents: 20_000, tipCents: 10_000 })
    expect(await pendingSum(o.json().id)).toBe(105_000)
  })

  it('two checkouts spending the same wallet at once: every order still owes exactly its pending payment', async () => {
    const c = await mkCustomer({ walletBalance: 50_000 })
    const place = () => asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', useWallet: true, tipCents: 5_000, items: basket(clubA),
    })
    const res = await Promise.all([place(), place()])
    for (const r of res) expect(r.statusCode).toBe(201)
    const orders = await prisma.order.findMany({ where: { customerId: c.id }, include: { payments: true } })
    expect(orders).toHaveLength(2)
    for (const o of orders) {
      expect(o.payments.filter((p) => p.status === 'pending').reduce((s, p) => s + p.amountCents, 0)).toBe(o.totalCents)
      // Food + GST + tip, less what the wallet REALLY paid.
      expect(o.totalCents).toBe(115_000 + 5_000 - o.walletAmountCents)
    }
    // The wallet paid once, in full, and never went negative.
    expect(orders.reduce((s, o) => s + o.walletAmountCents, 0)).toBe(50_000)
    expect((await walletOf(c.id))).toBe(0)
  })

  it('a wallet emptied mid-checkout puts its share back on the bill AND the pending payment', async () => {
    const c = await mkCustomer({ walletBalance: 30_000 })
    // Empty the wallet the moment this customer's order row is written —
    // after checkout read the balance, before it takes the money.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ao_drain_wallet() RETURNS trigger AS $$
      BEGIN UPDATE customer_wallets SET "balanceCents" = 0 WHERE "customerId" = NEW."customerId"; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ao_drain AFTER INSERT ON orders FOR EACH ROW
      WHEN (NEW."customerId" = '${c.id}') EXECUTE FUNCTION ao_drain_wallet()`)
    try {
      const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
        conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', useWallet: true, tipCents: 5_000, items: basket(clubA),
      })
      expect(o.statusCode).toBe(201)
      // Nothing came out of the wallet, so the customer owes everything.
      expect(o.json()).toMatchObject({ totalCents: 120_000, walletAmountCents: 0 })
      expect(await pendingSum(o.json().id)).toBe(120_000)
      expect(await prisma.walletTransaction.count({ where: { orderId: o.json().id } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ao_drain ON orders')
    }
  })
})

// ─── ONL-15 — unusable gift card ─────────────────────────────────────────────

describe('ONL-15: a gift card that cannot pay here is refused before anything is created', () => {
  it("another company's card: 422 GIFT_CARD_NOT_VALID_HERE, no order, no promo use claimed", async () => {
    const foreign = await prisma.giftCard.create({ data: { code: `KG-${RUN}-0001`.toUpperCase(), tenantId: tenantB, issuedAmountCents: 100_000, balanceCents: 100_000 } })
    const promo = await prisma.promoCode.create({
      data: { code: `LIM${RUN}`.toUpperCase(), tenantId: tenantA, discountType: 'percentage', discountValue: 10, maxUsageCount: 5, startAt: new Date(Date.now() - DAY), endAt: new Date(Date.now() + DAY) },
    })
    const c = await mkCustomer()
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', giftCardCode: foreign.code, promoCode: promo.code, items: basket(clubA),
    })
    expect(o.statusCode).toBe(422)
    expect(o.json().error.code).toBe('GIFT_CARD_NOT_VALID_HERE')
    expect(o.json().error.message).not.toMatch(/Online B|another company/i)
    expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0)
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).usedCount).toBe(0)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: foreign.id } })).balanceCents).toBe(100_000)

    // The quote says so too, like a promo error, and prices without it.
    const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: 'cash', giftCardCode: foreign.code, items: JSON.stringify(basket(clubA)) }))
    expect(q.statusCode).toBe(200)
    expect(q.json()).toMatchObject({ giftCardCents: 0, totalCents: 115_000, giftCardError: { code: 'GIFT_CARD_NOT_VALID_HERE' } })
  })

  it('unknown, expired and empty cards are refused with their own reason', async () => {
    const c = await mkCustomer()
    const place = (giftCardCode: string) => asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', giftCardCode, items: basket(clubA),
    })
    expect((await place('NO-SUCH-CARD')).json().error.code).toBe('GIFT_CARD_NOT_VALID_HERE')
    const expired = await prisma.giftCard.create({ data: { code: `EXP-${RUN}`.toUpperCase(), tenantId: tenantA, issuedAmountCents: 10_000, balanceCents: 10_000, expiresAt: new Date(Date.now() - DAY) } })
    expect((await place(expired.code)).json().error.code).toBe('GIFT_CARD_EXPIRED')
    const empty = await prisma.giftCard.create({ data: { code: `EMPTY-${RUN}`.toUpperCase(), tenantId: tenantA, issuedAmountCents: 10_000, balanceCents: 0, status: 'redeemed_full' } })
    const r = await place(empty.code)
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('GIFT_CARD_EMPTY')
    expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0)
  })
})

// ─── ONL-13 — Karachi time for menu sections ─────────────────────────────────

describe('ONL-13: time-limited sections follow Karachi time', () => {
  it('sectionVisibleAt reads the clock in PKT, including sections past midnight', () => {
    const at1930pkt = new Date('2026-10-10T14:30:00Z')
    expect(pktClock(at1930pkt).hhmm).toBe('19:30')
    expect(sectionVisibleAt('19:00', '23:30', at1930pkt)).toBe(true)
    expect(sectionVisibleAt('12:00', '16:00', at1930pkt)).toBe(false)
    expect(sectionVisibleAt(null, null, at1930pkt)).toBe(true)
    const at0100pkt = new Date('2026-10-10T20:00:00Z')
    expect(sectionVisibleAt('22:00', '02:00', at0100pkt)).toBe(true)
    expect(sectionVisibleAt('22:00', '02:00', at1930pkt)).toBe(false)
  })

  it('the menu shows the section open in Karachi now, not the one open on the UTC clock; checkout agrees', async () => {
    const nowPkt = pktClock(new Date()).minutes
    const nowUtc = nowPkt - 300
    const open = await prisma.category.create({ data: { conceptId: conceptA, name: `Now in Karachi ${RUN}`, timeRestrictionStart: hhmm(nowPkt - 30), timeRestrictionEnd: hhmm(nowPkt + 30) } })
    const utc = await prisma.category.create({ data: { conceptId: conceptA, name: `Now on the UTC clock ${RUN}`, timeRestrictionStart: hhmm(nowUtc - 30), timeRestrictionEnd: hhmm(nowUtc + 30) } })
    const special = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: open.id, name: 'Special', priceCents: 50_000, isAvailable: true } })
    const hidden = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: utc.id, name: 'Hidden', priceCents: 50_000, isAvailable: true } })

    const menu = await app.inject({ method: 'GET', url: `/storefront/${slugA}/menu` })
    const names = menu.json().categories.map((c: { name: string }) => c.name)
    expect(names).toContain(open.name)
    expect(names).not.toContain(utc.name)

    const c = await mkCustomer()
    expect((await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: 'cash', items: JSON.stringify(basket(special.id)) }))).statusCode).toBe(200)
    const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: 'cash', items: JSON.stringify(basket(hidden.id)) }))
    expect(q.statusCode).toBe(400)
    expect(q.json().error.code).toBe('ITEM_UNAVAILABLE')
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', items: basket(hidden.id) })
    expect(o.statusCode).toBe(400)
  })

  it('ONLINE-R6: assertItemsServedAt (for the group-order paths) applies the same section rule, inside the brand only', async () => {
    const lunch = await prisma.category.create({ data: { conceptId: conceptA, name: `Lunch ${RUN}`, timeRestrictionStart: '12:00', timeRestrictionEnd: '16:00' } })
    const lunchItem = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: lunch.id, name: 'Lunch plate', priceCents: 50_000, isAvailable: true } })
    const at1300pkt = new Date('2026-10-10T08:00:00Z')
    const at2330pkt = new Date('2026-10-10T18:30:00Z')
    await expect(assertItemsServedAt(conceptA, [lunchItem.id, clubA], at1300pkt)).resolves.toBeUndefined()
    await expect(assertItemsServedAt(conceptA, [clubA, lunchItem.id], at2330pkt)).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE', statusCode: 400 })
    // Another brand's id is not looked up under this brand (ingest refuses it on its own).
    await expect(assertItemsServedAt(conceptB, [lunchItem.id], at2330pkt)).resolves.toBeUndefined()
    await expect(assertItemsServedAt(conceptA, [], at2330pkt)).resolves.toBeUndefined()
  })
})

// ─── ONL-14 — opening hours ──────────────────────────────────────────────────

describe('ONL-14: a closed brand takes no orders', () => {
  it('openAt / nextOpening: same-day and past-midnight windows, closures', () => {
    // Saturday 2026-10-10. 19:30 PKT = 14:30 UTC.
    const sat1930 = new Date('2026-10-10T14:30:00Z')
    const flipd = [{ dayOfWeek: 6, openMin: 600, closeMin: 660 }]                // Sat 10:00–11:00
    expect(openAt(flipd, [], sat1930)).toBe(false)
    expect(nextOpening(flipd, [], sat1930)?.toISOString()).toBe('2026-10-17T05:00:00.000Z') // next Sat 10:00 PKT
    const late = [{ dayOfWeek: 5, openMin: 18 * 60, closeMin: 2 * 60 }]          // Fri 18:00 → Sat 02:00
    expect(openAt(late, [], new Date('2026-10-09T20:00:00Z'))).toBe(true)        // Sat 01:00 PKT
    expect(openAt(late, [], new Date('2026-10-09T22:00:00Z'))).toBe(false)       // Sat 03:00 PKT
    expect(openAt([], [], sat1930)).toBe(true)                                     // no hours set = open
    const closure = [{ startTime: new Date('2026-10-10T10:00:00Z'), endTime: new Date('2026-10-10T15:00:00Z') }]
    expect(openAt([], closure, sat1930)).toBe(false)
    expect(nextOpening([], closure, sat1930)?.toISOString()).toBe('2026-10-10T15:00:00.000Z')
  })

  it('refuses an order and a quote outside opening hours, and accepts a pre-order for when it opens', async () => {
    // Every day: a one-hour window starting two hours from now (PKT).
    const nowPkt = pktClock(new Date()).minutes
    const openMin = (nowPkt + 120) % 1440
    const closeMin = (nowPkt + 180) % 1440
    await prisma.serviceHours.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ conceptId: conceptClosed, dayOfWeek, openMin, closeMin })),
    })
    const c = await mkCustomer()
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', { conceptSlug: slugClosed, type: 'pickup', paymentGateway: 'cash', items: basket(clubClosed) })
    expect(o.statusCode).toBe(409)
    expect(o.json().error.code).toBe('BRAND_CLOSED')
    expect(o.json().error.message).toMatch(new RegExp(`closed right now\\. Opens at ${hhmm(openMin)} (today|tomorrow)`))
    const opensAt = new Date(o.json().error.details.opensAt).getTime()
    expect(Math.abs(opensAt - (Date.now() + 120 * MIN))).toBeLessThan(2 * MIN)
    expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0)

    const q = await asCustomer(c.id, 'GET', quoteUrl(slugClosed, { paymentGateway: 'cash', items: JSON.stringify(basket(clubClosed)) }))
    expect(q.statusCode).toBe(409)
    expect(q.json().error.code).toBe('BRAND_CLOSED')

    const menu = await app.inject({ method: 'GET', url: `/storefront/${slugClosed}/menu` })
    expect(menu.json().ordering).toMatchObject({ open: false })
    expect(menu.json().ordering.message).toMatch(/closed right now/)

    // A pre-order for half an hour into the window is fine; one for now is not.
    const scheduledFor = new Date(Date.now() + 150 * MIN).toISOString()
    const pre = await asCustomer(c.id, 'POST', '/storefront/orders', { conceptSlug: slugClosed, type: 'pickup', paymentGateway: 'cash', scheduledFor, items: basket(clubClosed) })
    expect(pre.statusCode).toBe(201)
    expect(pre.json()).toMatchObject({ isPreOrder: true })
    const preQuote = await asCustomer(c.id, 'GET', quoteUrl(slugClosed, { paymentGateway: 'cash', scheduledFor, items: JSON.stringify(basket(clubClosed)) }))
    expect(preQuote.statusCode).toBe(200)
    const closedSlot = new Date(Date.now() + 240 * MIN).toISOString()
    const bad = await asCustomer(c.id, 'POST', '/storefront/orders', { conceptSlug: slugClosed, type: 'pickup', paymentGateway: 'cash', scheduledFor: closedSlot, items: basket(clubClosed) })
    expect(bad.statusCode).toBe(409)
    expect(bad.json().error.code).toBe('BRAND_CLOSED')
  })

  it('a brand with no hours configured stays open', async () => {
    const menu = await app.inject({ method: 'GET', url: `/storefront/${slugA}/menu` })
    expect(menu.json().ordering).toEqual({ open: true, opensAt: null, message: null })
  })
})

// ─── Loyalty accounts are per company (schema change, minimal route fix) ────

describe('the storefront account shows the loyalty account of the right company', () => {
  it("?conceptSlug picks that brand's company; B's points never show at A", async () => {
    const c = await mkCustomer()
    await prisma.loyaltyAccount.create({ data: { tenantId: tenantA, customerId: c.id, pointsBalance: 100 } })
    await prisma.loyaltyAccount.create({ data: { tenantId: tenantB, customerId: c.id, pointsBalance: 900 } })
    const atA = await asCustomer(c.id, 'GET', `/storefront/account?conceptSlug=${slugA}`)
    expect(atA.statusCode).toBe(200)
    expect(atA.json().loyaltyAccount).toMatchObject({ tenantId: tenantA, pointsBalance: 100 })
    expect(atA.json().loyaltyAccounts).toHaveLength(2)
    const atB = await asCustomer(c.id, 'GET', `/storefront/account?conceptSlug=${slugB}`)
    expect(atB.json().loyaltyAccount).toMatchObject({ tenantId: tenantB, pointsBalance: 900 })
    const perksA = await asCustomer(c.id, 'GET', `/storefront/my-perks?conceptSlug=${slugA}`)
    expect(perksA.statusCode).toBe(200)
    expect(perksA.json().pointsBalance).toBe(100)
  })
})

// ─── ONLINE-R4 — a reservations closure does not close ordering ──────────────

describe('ONLINE-R4: a reservations "Closure (no bookings)" leaves online ordering open', () => {
  it('a closure blockout over now (e.g. a buyout) does not 409 the quote, the order or the menu', async () => {
    const b = await prisma.conceptBlockout.create({
      data: { conceptId: conceptA, kind: 'closure', startTime: new Date(Date.now() - 60 * MIN), endTime: new Date(Date.now() + 120 * MIN), reason: 'full buyout for company X' },
    })
    try {
      const c = await mkCustomer()
      const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: 'cash', items: JSON.stringify(basket(clubA)) }))
      expect(q.statusCode).toBe(200)
      const o = await asCustomer(c.id, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', items: basket(clubA) })
      expect(o.statusCode).toBe(201)
      const menu = await app.inject({ method: 'GET', url: `/storefront/${slugA}/menu` })
      expect(menu.json().ordering).toMatchObject({ open: true })
    } finally {
      await prisma.conceptBlockout.delete({ where: { id: b.id } })
    }
  })
})

// ─── ONLINE-R5 — the wallet as the payment method ────────────────────────────

describe('ONLINE-R5: a wallet-paid order never leaves an uncollectable payment', () => {
  it('the wallet pays the tip too: quote and checkout agree, nothing is left to collect', async () => {
    const c = await mkCustomer({ walletBalance: 500_000 })
    const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, { paymentGateway: 'wallet', tipCents: '5000', items: JSON.stringify(basket(clubA)) }))
    expect(q.statusCode).toBe(200)
    // Card rate 8%: 1,000 + 80 + PKR 50 tip = 1,130, all from the wallet.
    expect(q.json()).toMatchObject({ walletCents: 113_000, tipCents: 5_000, totalCents: 0 })
    const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', tipCents: 5_000, items: basket(clubA),
    })
    expect(o.statusCode).toBe(201)
    expect(o.json()).toMatchObject({ totalCents: 0, walletAmountCents: 113_000, tipCents: 5_000 })
    expect(await pendingSum(o.json().id)).toBe(0)
    expect((await walletOf(c.id))).toBe(387_000)
    const wt = await prisma.walletTransaction.findMany({ where: { orderId: o.json().id } })
    expect(wt.map((t) => [t.type, t.amountCents, t.balanceAfter])).toEqual([['spend', -113_000, 387_000]])
  })

  it('a wallet spent elsewhere at the same moment: 409 before any order exists, the promo use is given back', async () => {
    const c = await mkCustomer({ walletBalance: 200_000 })
    const promo = await prisma.promoCode.create({
      data: { tenantId: tenantA, code: `RACE${RUN}`.toUpperCase(), discountType: 'percentage', discountValue: 10, maxUsageCount: 5, isActive: true, startAt: new Date(Date.now() - DAY), endAt: new Date(Date.now() + DAY) },
    })
    // Empty the wallet the moment the promo use is claimed — after checkout
    // read the balance, before it takes the wallet.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ao_r5_drain() RETURNS trigger AS $$
      BEGIN UPDATE customer_wallets SET "balanceCents" = 0 WHERE "customerId" = '${c.id}'; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ao_r5_drain AFTER UPDATE ON promo_codes FOR EACH ROW
      WHEN (NEW.id = '${promo.id}' AND NEW."usedCount" > OLD."usedCount") EXECUTE FUNCTION ao_r5_drain()`)
    try {
      const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
        conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', promoCode: promo.code, items: basket(clubA),
      })
      expect(o.statusCode).toBe(409)
      expect(o.json().error.code).toBe('WALLET_BALANCE_CHANGED')
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ao_r5_drain ON promo_codes')
    }
    expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(0)
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).usedCount).toBe(0)
    expect((await walletOf(c.id))).toBe(0)
  })

  it('two wallet-paid checkouts racing on one wallet: one order, the other refused, no unpaid card row', async () => {
    const c = await mkCustomer({ walletBalance: 150_000 })
    const place = () => asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', items: basket(clubA),
    })
    const res = await Promise.all([place(), place()])
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1)
    for (const r of res.filter((x) => x.statusCode !== 201)) {
      expect(['WALLET_BALANCE_CHANGED', 'PAYMENT_METHOD_UNAVAILABLE']).toContain(r.json().error.code)
    }
    const orders = await prisma.order.findMany({ where: { customerId: c.id }, include: { payments: true } })
    expect(orders).toHaveLength(1)
    expect(orders[0]!.payments.filter((p) => p.status === 'pending').reduce((s, p) => s + p.amountCents, 0)).toBe(0)
    expect((await walletOf(c.id))).toBe(42_000)
  })

  it('a gift card drained after the order is written: the order is cancelled, the wallet comes back, 409', async () => {
    const card = await prisma.giftCard.create({ data: { code: `GC-R5-${RUN}`.toUpperCase(), tenantId: tenantA, issuedAmountCents: 100_000, balanceCents: 100_000 } })
    const c = await mkCustomer({ walletBalance: 50_000 })
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ao_r5_card() RETURNS trigger AS $$
      BEGIN UPDATE gift_cards SET "balanceCents" = 0 WHERE id = '${card.id}'; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ao_r5_card AFTER INSERT ON orders FOR EACH ROW
      WHEN (NEW."customerId" = '${c.id}') EXECUTE FUNCTION ao_r5_card()`)
    let orderId: string | undefined
    try {
      const o = await asCustomer(c.id, 'POST', '/storefront/orders', {
        conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', giftCardCode: card.code, items: basket(clubA),
      })
      expect(o.statusCode).toBe(409)
      expect(o.json().error.code).toBe('PAYMENT_NOT_COVERED')
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ao_r5_card ON orders')
    }
    const orders = await prisma.order.findMany({ where: { customerId: c.id } })
    expect(orders).toHaveLength(1)
    orderId = orders[0]!.id
    expect(orders[0]!.status).toBe('cancelled')
    // The cancel's restores run in the background.
    for (let i = 0; i < 40; i++) {
      if ((await walletOf(c.id)) === 50_000) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect((await walletOf(c.id))).toBe(50_000)
    expect(orderId).toBeTruthy()
  })
})
