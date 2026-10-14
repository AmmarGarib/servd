// Delivery fee carries sales tax, ADDED ON TOP (owner 2026-10-13, H9).
//
//   lib/pricing priceOrder: deliveryFeeTaxCents = round(fee × the order's
//   STANDARD tender rate / 100) — 15 % cash on delivery, 8 % card / Raast /
//   online / wallet — never an item tax class; taxCents = itemTaxCents +
//   deliveryFeeTaxCents; total = food + food GST − discount + fee + fee GST +
//   service charge. Service charge and the tip % never include the fee or its
//   GST.
//   GET /storefront/quote returns itemTaxCents + deliveryFeeTaxCents;
//   checkout charges exactly the quote; the rider collects fee + GST (the
//   pending cash row); WhatsApp and group orders carry no fee.
//
// Two companies: A's and B's delivery orders each carry their own zone's fee.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import jwt from 'jsonwebtoken'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { priceOrder, tenderOf } from '../src/lib/pricing.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'
import { getJob } from '../src/modules/rider/service.js'

const RUN = Math.random().toString(36).slice(2, 8)

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string, conceptFree: string
let slugA: string, slugB: string, slugFree: string
let clubA: string, clubB: string, waterA: string, clubFree: string

// Kitchen pins (Karachi) and a drop point ~1.1 km away.
const KITCHEN = { latitude: 24.8000, longitude: 67.0500 }
const DROP = { deliveryLat: 24.8100, deliveryLng: 67.0500 }

const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
const asCustomer = (id: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${customerToken(id)}` } })

let seq = 0
async function mkCustomer() {
  seq += 1
  return prisma.customer.create({
    data: {
      name: `Delivery guest ${seq}`, email: `dft-${RUN}-${seq}@example.com`,
      phone: `+92311${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}${String(seq).padStart(4, '0')}`,
      phoneVerifiedAt: new Date(),
    },
  })
}

const basket = (menuItemId: string, quantity = 1) => [{ menuItemId, quantity, modifiers: [] }]
const quoteUrl = (slug: string, params: Record<string, string>) =>
  `/storefront/quote?${new URLSearchParams({ conceptSlug: slug, ...params }).toString()}`
const deliveryQuote = (slug: string, items: unknown, extra: Record<string, string> = {}) => quoteUrl(slug, {
  type: 'delivery', items: JSON.stringify(items), deliveryLat: String(DROP.deliveryLat), deliveryLng: String(DROP.deliveryLng), ...extra,
})

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Fee GST A', slug: `fee-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Fee GST B', slug: `fee-b-${RUN}` } })).id
  const mkConcept = async (tenantId: string, slug: string) => (await prisma.concept.create({
    data: { name: slug, slug, type: 'restaurant', tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8, isActive: true, ...KITCHEN },
  })).id
  slugA = `fee-a-${RUN}`; slugB = `fee-b-${RUN}`; slugFree = `fee-free-${RUN}`
  conceptA = await mkConcept(tenantA, slugA)
  conceptB = await mkConcept(tenantB, slugB)
  conceptFree = await mkConcept(tenantA, slugFree)
  const mkItem = async (conceptId: string, name: string, priceCents: number, taxClassification?: 'zero_rated') => {
    const categoryId = (await prisma.category.create({ data: { conceptId, name: `Menu ${name}` } })).id
    return (await prisma.menuItem.create({ data: { conceptId, categoryId, name, priceCents, isAvailable: true, ...(taxClassification && { taxClassification }) } })).id
  }
  clubA = await mkItem(conceptA, 'Club sandwich', 100_000)
  waterA = await mkItem(conceptA, 'Water', 10_000, 'zero_rated')
  clubB = await mkItem(conceptB, 'Club sandwich', 100_000)
  clubFree = await mkItem(conceptFree, 'Club sandwich', 100_000)

  await prisma.deliveryZone.createMany({
    data: [
      { tenantId: tenantA, conceptId: conceptA, name: 'A inner', radiusKmMin: 0, radiusKmMax: 10, feeCents: 15_000 },
      { tenantId: tenantB, conceptId: conceptB, name: 'B inner', radiusKmMin: 0, radiusKmMax: 10, feeCents: 20_000 },
      // A free-delivery zone (free above PKR 500 of food).
      { tenantId: tenantA, conceptId: conceptFree, name: 'Free zone', radiusKmMin: 0, radiusKmMax: 10, feeCents: 15_000, freeAboveCents: 50_000 },
    ],
  })
  // Company A charges a 10 % service charge online; B none.
  await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, serviceChargePct: 0.1, serviceChargeAppliesToChannels: ['storefront'] } })
  await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantB } })
  invalidateSetupCache()

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('priceOrder: the fee GST rides on top at the tender rate', () => {
  const pricing = async (conceptId: string) => {
    const c = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { id: true, tenantId: true, taxRateCash: true, taxRateCard: true } })
    return c
  }

  it('card (8 %): fee 15,000 → 1,200 on top; the food tax unchanged; the card total includes the fee GST', async () => {
    const c = await pricing(conceptB) // B: no service charge
    const lines = [{ menuItemId: clubB, unitPriceCents: 100_000, quantity: 2, modifiers: [{ priceDeltaCents: 5_000 }] }]
    const card = await priceOrder(lines, 'card', 'storefront', c, { deliveryFeeCents: 15_000 })
    expect(card).toMatchObject({
      taxRatePct: 8, itemTotalCents: 210_000, itemTaxCents: 16_800,
      deliveryFeeCents: 15_000, deliveryFeeTaxCents: 1_200, taxCents: 18_000,
      serviceChargeCents: 0, totalCents: 210_000 + 16_800 + 15_000 + 1_200,
    })
  })

  it('cash on delivery (15 %): fee 15,000 → 2,250; a zero-rated basket still pays GST on the delivery', async () => {
    const c = await pricing(conceptB)
    const water = await priceOrder([{ menuItemId: waterA, unitPriceCents: 10_000, quantity: 3 }], 'cash', 'storefront', c, { deliveryFeeCents: 15_000 })
    expect(water).toMatchObject({ itemTaxCents: 0, deliveryFeeTaxCents: 2_250, taxCents: 2_250, totalCents: 30_000 + 15_000 + 2_250 })
  })

  it('no fee → no fee GST; a staff discount comes off the food and its GST only', async () => {
    const c = await pricing(conceptB)
    const p = await priceOrder([{ menuItemId: clubB, unitPriceCents: 100_000, quantity: 1 }], 'cash', 'pos', c, { discountCents: 999_999 })
    expect(p).toMatchObject({ deliveryFeeCents: 0, deliveryFeeTaxCents: 0, itemTaxCents: 15_000, taxCents: 15_000, discountCents: 115_000, totalCents: 0 })
  })

  it('the service-charge base never includes the fee or its GST', async () => {
    const c = await pricing(conceptA) // A: 10 % online service charge
    const p = await priceOrder([{ menuItemId: clubA, unitPriceCents: 100_000, quantity: 1 }], 'cash', 'storefront', c, { deliveryFeeCents: 15_000 })
    expect(p.serviceChargeCents).toBe(11_500)  // 10 % of 100,000 + 15,000 — not of the 17,250 delivery
    expect(p.totalCents).toBe(100_000 + 15_000 + 15_000 + 2_250 + 11_500)
  })

  it('on-account is the cash class (CA default)', () => {
    expect(tenderOf('on_account')).toBe('cash')
  })

  it('WhatsApp and group orders carry no fee: no fee GST, totals unchanged', async () => {
    const c = await pricing(conceptA)
    const lines = [{ menuItemId: clubA, unitPriceCents: 100_000, quantity: 1 }]
    // The calls WhatsApp priceCart and the group-order routes make (no delivery fee).
    const wa = await priceOrder(lines, 'cash', 'whatsapp', c)
    const group = await priceOrder(lines, 'cash', 'group', c)
    for (const p of [wa, group]) {
      expect(p).toMatchObject({ deliveryFeeCents: 0, deliveryFeeTaxCents: 0, itemTaxCents: 15_000, taxCents: 15_000 })
      expect(p.totalCents).toBe(100_000 + 15_000 + p.serviceChargeCents)
    }
  })
})

describe('GET /storefront/quote', () => {
  it('COD cash 15 %: fee 15,000 → GST 2,250; itemTaxCents + deliveryFeeTaxCents = taxCents; the priced total includes it', async () => {
    const c = await mkCustomer()
    const q = await asCustomer(c.id, 'GET', deliveryQuote(slugB, basket(clubB), { paymentGateway: 'cash' }))
    expect(q.statusCode, q.body).toBe(200)
    expect(q.json()).toMatchObject({
      tender: 'cash', taxRatePct: 15, itemTotalCents: 100_000, itemTaxCents: 15_000,
      deliveryFeeCents: 20_000, deliveryFeeTaxCents: 3_000, taxCents: 18_000,
      serviceChargeCents: 0, pricedTotalCents: 100_000 + 15_000 + 20_000 + 3_000, totalCents: 138_000,
    })
  })

  it('paid online (wallet, the card group, 8 %): fee GST 1,200 on A\'s 15,000', async () => {
    const c = await mkCustomer()
    const q = await asCustomer(c.id, 'GET', deliveryQuote(slugA, basket(clubA), { paymentGateway: 'wallet' }))
    expect(q.statusCode, q.body).toBe(200)
    expect(q.json()).toMatchObject({ tender: 'card', taxRatePct: 8, itemTaxCents: 8_000, deliveryFeeCents: 15_000, deliveryFeeTaxCents: 1_200, taxCents: 9_200 })
  })

  it('service charge excludes the fee; a tip % is of food + food GST, never the fee GST', async () => {
    const c = await mkCustomer()
    const q = await asCustomer(c.id, 'GET', deliveryQuote(slugA, basket(clubA), { paymentGateway: 'cash', tipPct: '10' }))
    expect(q.statusCode, q.body).toBe(200)
    const b = q.json()
    expect(b).toMatchObject({ itemTaxCents: 15_000, deliveryFeeTaxCents: 2_250, serviceChargeCents: 11_500 })
    expect(b.tipCents).toBe(11_500)  // 10 % of 115,000 — not of 115,000 + 15,000 + 2,250
    expect(b.pricedTotalCents).toBe(100_000 + 15_000 + 15_000 + 2_250 + 11_500)
    expect(b.totalCents).toBe(b.pricedTotalCents + 11_500)
  })

  it('a free-delivery zone: fee 0, fee GST 0', async () => {
    const c = await mkCustomer()
    const q = await asCustomer(c.id, 'GET', deliveryQuote(slugFree, basket(clubFree), { paymentGateway: 'cash' }))
    expect(q.statusCode, q.body).toBe(200)
    expect(q.json()).toMatchObject({ deliveryFeeCents: 0, deliveryFeeTaxCents: 0, itemTaxCents: 15_000, taxCents: 15_000 })
  })

  it('pickup carries no fee', async () => {
    const c = await mkCustomer()
    const q = await asCustomer(c.id, 'GET', quoteUrl(slugA, { type: 'pickup', items: JSON.stringify(basket(clubA)), paymentGateway: 'cash' }))
    expect(q.json()).toMatchObject({ deliveryFeeCents: 0, deliveryFeeTaxCents: 0, taxCents: 15_000 })
  })
})

describe('checkout: charges the quote, the rider collects fee + GST', () => {
  let placedA: { id: string; totalCents: number }
  let quoteA: { totalCents: number; taxCents: number }
  let placedB: { id: string; totalCents: number }

  beforeAll(async () => {
    const ca = await mkCustomer()
    quoteA = (await asCustomer(ca.id, 'GET', deliveryQuote(slugA, basket(clubA, 2), { paymentGateway: 'cash' }))).json()
    const ra = await asCustomer(ca.id, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'delivery', deliveryAddress: 'House 4, Street 9', ...DROP,
      paymentGateway: 'cash', items: basket(clubA, 2),
    })
    expect(ra.statusCode, ra.body).toBe(201)
    placedA = ra.json()

    const cb = await mkCustomer()
    const rb = await asCustomer(cb.id, 'POST', '/storefront/orders', {
      conceptSlug: slugB, type: 'delivery', deliveryAddress: 'Flat 2, Block 7', ...DROP,
      paymentGateway: 'cash', items: basket(clubB),
    })
    expect(rb.statusCode, rb.body).toBe(201)
    placedB = rb.json()
  })

  it('the order total is the quote, its GST includes the fee GST', async () => {
    // 2 × 100,000 + 15 % 30,000 + fee 15,000 + fee GST 2,250 + 10 % service 23,000
    expect(quoteA.totalCents).toBe(200_000 + 30_000 + 15_000 + 2_250 + 23_000)
    expect(placedA.totalCents).toBe(quoteA.totalCents)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: placedA.id } })
    expect(row).toMatchObject({ taxCents: 32_250, taxRatePct: 15, serviceChargeCents: 23_000, totalCents: quoteA.totalCents, fulfilmentType: 'delivery' })
  })

  it('checkout stores the fee and its GST on the order (ingestOrder writes them from the price — w2-sale)', async () => {
    const row = await prisma.order.findUniqueOrThrow({ where: { id: placedA.id } })
    expect(row).toMatchObject({ deliveryFeeCents: 15_000, deliveryFeeTaxCents: 2_250 })
    const rowB = await prisma.order.findUniqueOrThrow({ where: { id: placedB.id } })
    expect(rowB).toMatchObject({ deliveryFeeCents: 20_000, deliveryFeeTaxCents: 3_000 })
    // The response and the customer's order page carry the stored columns.
    const page = await asCustomer(row.customerId!, 'GET', `/storefront/orders/${placedA.id}`)
    expect(page.json()).toMatchObject({ deliveryFeeCents: 15_000, deliveryFeeTaxCents: 2_250 })
  })

  it('two companies: B\'s delivery order carries B\'s fee and B\'s GST, never A\'s', async () => {
    const rowB = await prisma.order.findUniqueOrThrow({ where: { id: placedB.id }, include: { concept: { select: { tenantId: true } } } })
    expect(rowB.concept.tenantId).toBe(tenantB)
    // 100,000 + 15,000 + fee 20,000 + fee GST 3,000; B has no service charge.
    expect(rowB).toMatchObject({ taxCents: 18_000, serviceChargeCents: 0, totalCents: 138_000 })
  })

  it('the rider\'s cash to collect is the pending cash row: fee and its GST included', async () => {
    const rider = await prisma.rider.create({ data: { tenantId: tenantA, name: 'Asif', phone: `923${String(Date.now()).slice(-9)}` } })
    await prisma.order.update({ where: { id: placedA.id }, data: { riderId: rider.id, riderAssignedAt: new Date() } })
    const job = await getJob(rider.id, placedA.id)
    expect(job.cashToCollectCents).toBe(quoteA.totalCents)
  })

  it('the customer\'s order page: a hand-over code until it is rerouted to the rider, then none', async () => {
    const row = await prisma.order.findUniqueOrThrow({ where: { id: placedA.id } })
    const before = (await asCustomer(row.customerId!, 'GET', `/storefront/orders/${placedA.id}`)).json()
    expect(before.deliveryOtp).toBe(row.deliveryOtp)
    expect(before.handoverRerouted).toBe(false)
    await prisma.order.update({ where: { id: placedA.id }, data: { handoverReroutedAt: new Date() } })
    const after = (await asCustomer(row.customerId!, 'GET', `/storefront/orders/${placedA.id}`)).json()
    expect(after.deliveryOtp).toBeNull()
    expect(after.handoverRerouted).toBe(true)
    expect(after).not.toHaveProperty('handoverRerouteRiderId')
    // Another customer never sees the order.
    const stranger = await mkCustomer()
    expect((await asCustomer(stranger.id, 'GET', `/storefront/orders/${placedA.id}`)).statusCode).toBe(404)
  })

  it('GET /storefront/account no longer carries a global isBlacklisted flag', async () => {
    const c = await mkCustomer()
    const acct = await asCustomer(c.id, 'GET', '/storefront/account')
    expect(acct.statusCode, acct.body).toBe(200)
    expect(acct.json()).not.toHaveProperty('isBlacklisted')
  })
})
