// Orders reconcile: ONE completion routine, ONE pricing function.
//
// What this guards:
//   - lib/pricing.ts priceOrder is the one GST rule (decision 9): cash 15% /
//     card-or-online 8% by tender, on the pre-discount item base, item tax
//     classes applied, service charge on food + GST − discount, never the
//     legacy concept.taxRate. Order.taxRatePct is stamped by ingestOrder.
//   - The till prices by the tender it rang up under and re-prices when the
//     customer pays with the other one (decision 9, incl. group orders).
//   - completeOrder runs its side effects exactly once per order, whichever
//     path completes it, and no longer writes a FinancialEntry (decision 39).
//   - Decision 8: a till sale completes at payment; pickup at expo hand-off;
//     a delivery when the rider marks it delivered or the OTP is verified —
//     expo handing it to the rider does not complete it, and a staff
//     "Complete" can't jump either door.
//   - GET /storefront/quote prices with the same function as checkout.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { priceOrder, tenderOf, tenderOfPayments, allocateTaxCents, gstRatePct } from '../src/lib/pricing.js'
import { completeOrder, completionDoor, updateOrderStatus, ingestOrder } from '../src/modules/orders/service.js'
import { createPosOrder, processPayment } from '../src/modules/pos/service.js'
import { markDelivered } from '../src/modules/dispatch/service.js'
import { setCodeOnlyDelivery } from '../src/lib/deliveryRules.js'
import { mkRaastAccount } from './connectorsFixtures.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'

let app: FastifyInstance
let tenantA: string
let conceptId: string
let conceptSlug: string
let burgerId: string
let waterId: string
let cashierId: string
let token: string
let shiftId: string
let n = 0

const concept = () => prisma.concept.findUniqueOrThrow({ where: { id: conceptId } })

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}
const settle = () => new Promise((r) => setTimeout(r, 300))

const claims = (orderId: string) =>
  prisma.auditLog.count({ where: { entity: 'Order', entityId: orderId, action: 'order.complete' } })

async function order(data: Partial<{
  status: 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed'
  source: 'servd' | 'pos'
  fulfilmentType: 'dine_in' | 'takeout' | 'delivery'
  riderId: string
  deliveryOtp: string
  rawPayload: object
}> = {}) {
  n += 1
  return prisma.order.create({
    data: {
      conceptId,
      source: data.source ?? 'servd',
      status: data.status ?? 'ready',
      fulfilmentType: data.fulfilmentType ?? 'takeout',
      totalCents: 115_000,
      taxCents: 15_000,
      riderId: data.riderId ?? null,
      deliveryOtp: data.deliveryOtp ?? null,
      rawPayload: (data.rawPayload ?? undefined) as never,
      externalId: `reconcile-${n}-${Date.now()}`,
      items: { create: [{ name: 'Club sandwich', quantity: 1, unitPriceCents: 100_000, status: 'bumped' }] },
    },
  })
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } })

beforeAll(async () => {
  // The test DB is built from schema.prisma by db push; until the migration
  // adding Order.taxRatePct lands in the schema, add the column here.
  await prisma.$executeRawUnsafe('ALTER TABLE orders ADD COLUMN IF NOT EXISTS "taxRatePct" DOUBLE PRECISION')

  tenantA = (await prisma.tenant.create({ data: { name: 'Reconcile A', slug: 'reconcile-a' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptSlug = 'reconcile-cafe'
  // Legacy taxRate left at 17 on purpose: nothing may read it.
  conceptId = (await prisma.concept.create({
    data: { name: 'Reconcile Cafe', slug: conceptSlug, type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8, isActive: true },
  })).id
  const categoryId = (await prisma.category.create({ data: { conceptId, name: 'Mains' } })).id
  burgerId = (await prisma.menuItem.create({
    data: { conceptId, categoryId, name: 'Club sandwich', priceCents: 100_000, isAvailable: true },
  })).id
  waterId = (await prisma.menuItem.create({
    data: { conceptId, categoryId, name: 'Mineral water', priceCents: 10_000, isAvailable: true, taxClassification: 'zero_rated' },
  })).id
  const u = await prisma.user.create({
    data: { name: 'Till', email: 'reconcile-till@test.local', password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId: tenantA } as never,
  })
  cashierId = u.id
  token = (issueStaffSession(u) as { accessToken: string }).accessToken
  shiftId = (await prisma.shift.create({ data: { userId: cashierId, openingFloatCents: 0, status: 'open', tenantId: tenantA } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: (err as { code?: string }).code ?? 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── Pricing ──────────────────────────────────────────────────────────────────

describe('priceOrder — the one GST rule', () => {
  it('maps tenders: cash (incl. cash on delivery) 15%, card / Raast QR / online 8% (the digital group), unknown → cash', () => {
    expect(tenderOf('cash')).toBe('cash')
    // Raast QR is the digital group with card; the retired Keenu QR still reads at the card rate.
    for (const m of ['card', 'raast', 'keenu_qr', 'keenu', 'jazzcash', 'easypaisa', 'wallet']) expect(tenderOf(m)).toBe('card')
    for (const m of ['split', 'comp', null, undefined]) expect(tenderOf(m)).toBe('cash')
    expect(tenderOfPayments(['card', 'keenu_qr'])).toBe('card')
    expect(tenderOfPayments(['card', 'raast'])).toBe('card')
    expect(tenderOfPayments(['raast', 'cash'])).toBe('cash')
    expect(tenderOfPayments(['card', 'cash'])).toBe('cash')
  })

  it('taxes the pre-discount base at the tender rate, never the legacy 17%', async () => {
    const c = await concept()
    const lines = [{ menuItemId: burgerId, unitPriceCents: 100_000, quantity: 2, modifiers: [{ priceDeltaCents: 5_000 }] }]
    const cash = await priceOrder(lines, 'cash', 'pos', c, { discountCents: 20_000 })
    expect(cash.itemTotalCents).toBe(210_000)
    expect(cash.taxRatePct).toBe(15)
    expect(cash.taxCents).toBe(31_500)              // 15% of 210,000 — the discount does not shrink it
    expect(cash.totalCents).toBe(210_000 + 31_500 - 20_000)
    const card = await priceOrder(lines, 'card', 'storefront', c, { deliveryFeeCents: 15_000 })
    expect(card.taxRatePct).toBe(8)
    expect(card.itemTaxCents).toBe(16_800)
    expect(card.deliveryFeeTaxCents).toBe(1_200)   // H9: 8 % GST on the fee, on top
    expect(card.taxCents).toBe(18_000)
    expect(card.totalCents).toBe(210_000 + 16_800 + 15_000 + 1_200)
    expect(gstRatePct(c, 'cash')).toBe(15)
  })

  it('applies item tax classes (zero-rated water carries no GST)', async () => {
    const c = await concept()
    const p = await priceOrder([
      { menuItemId: burgerId, unitPriceCents: 100_000, quantity: 1 },
      { menuItemId: waterId, unitPriceCents: 10_000, quantity: 3 },
    ], 'cash', 'pos', c)
    expect(p.taxCents).toBe(15_000)
    expect(p.lines.map((l) => l.taxRatePct)).toEqual([15, 0])
  })

  it('allocates a stored tax across document lines to the paisa', () => {
    const parts = allocateTaxCents([1000, 1000, 1000], 100)
    expect(parts.reduce((s, x) => s + x, 0)).toBe(100)
    expect(allocateTaxCents([500, 0], 75)).toEqual([75, 0])
  })

  it('ingestOrder stamps the price on the order it creates', async () => {
    const c = await concept()
    const price = await priceOrder([{ menuItemId: burgerId, unitPriceCents: 100_000, quantity: 1 }], 'card', 'storefront', c)
    const { order: o } = await ingestOrder({
      source: 'servd', external_id: `ingest-${Date.now()}`, concept_id: conceptId, placed_at: new Date().toISOString(),
      customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      items: [{ externalItemId: burgerId, menuItemId: burgerId, name: 'Club sandwich', quantity: 1, unitPriceCents: 100_000, modifiers: [] }],
      payment: { provider: null, amountCents: price.totalCents, status: 'pending' },
    }, { price })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.taxRatePct).toBe(8)
    expect(row.taxCents).toBe(8_000)
    expect(row.totalCents).toBe(108_000)
  })
})

// ─── The till ─────────────────────────────────────────────────────────────────

describe('the till — priced by tender, complete at payment, once', () => {
  it('rings up at the cash rate, re-prices to the card rate when paid by card, completes once', async () => {
    const o = await createPosOrder({
      conceptId, staffId: cashierId, staffRole: 'admin', shiftId,
      items: [{ menuItemId: burgerId, name: 'Club sandwich', quantity: 1, unitPriceCents: 100_000, modifiers: [] }],
    })
    expect(o.taxRatePct).toBe(15)
    expect(o.taxCents).toBe(15_000)
    expect(o.totalCents).toBe(115_000)

    // Tendering the cash-rate total by card is refused with the re-priced due…
    await expect(processPayment({
      orderId: o.id, shiftId, payments: [{ method: 'card', amountCents: 115_000, gatewayRef: 'TERM-1' }],
    })).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' })
    // …and nothing was written by the refused attempt.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).taxRatePct).toBe(15)

    const r = await processPayment({
      orderId: o.id, shiftId, payments: [{ method: 'card', amountCents: 108_000, gatewayRef: 'TERM-1' }],
    })
    expect(r).toBeTruthy()
    const done = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(done.status).toBe('completed')
    expect(done.taxRatePct).toBe(8)
    expect(done.taxCents).toBe(8_000)
    expect(done.totalCents).toBe(108_000)
    expect(await claims(o.id)).toBe(1)
    // Decision 39: no register row.
    expect(await prisma.financialEntry.count({ where: { orderId: o.id } })).toBe(0)

    // A second run of the routine is a no-op.
    const again = await completeOrder(o.id, null, { via: 'status_update' })
    expect(again.ran).toBe(false)
    expect(await claims(o.id)).toBe(1)
  })

  it('a group order is priced at the cash rate and re-priced to the tender used at the till', async () => {
    const c = await concept()
    // Raast QR (the digital group) replaced Keenu QR at the till: the brand's
    // company needs a Raast receiving account, and the cashier types the bank
    // reference after checking the counter phone.
    const raast = await mkRaastAccount({ tenantId: tenantA, conceptId, locationId: '', items: { nihari: burgerId, kheer: burgerId, water: waterId } })
    const price = await priceOrder([{ menuItemId: burgerId, unitPriceCents: 100_000, quantity: 1 }], 'cash', 'group', c)
    const { order: o } = await ingestOrder({
      source: 'servd', external_id: `group-RC${Date.now()}`, concept_id: conceptId, placed_at: new Date().toISOString(),
      customer_id: null, customer_name: 'Table', loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      items: [{ externalItemId: 'g1', menuItemId: burgerId, name: 'Club sandwich · Ali', quantity: 1, unitPriceCents: 100_000, modifiers: [] }],
      payment: { provider: null, amountCents: price.totalCents, status: 'pending' },
      fulfilment_type: 'dine_in', raw_payload: { channel: 'group_order', shareCode: 'RC' },
    }, { price })
    expect(completionDoor(o)).toBe('payment')
    // The retired Keenu QR is refused, nothing written.
    await expect(processPayment({ orderId: o.id, shiftId, payments: [{ method: 'keenu_qr', amountCents: 108_000, gatewayRef: 'QR-9' }] }))
      .rejects.toMatchObject({ code: 'KEENU_QR_RETIRED', statusCode: 422 })
    await processPayment({
      orderId: o.id, shiftId, actorId: cashierId,
      payments: [{ method: 'raast', amountCents: 108_000, gatewayRef: 'RC-RAAST-9001', raast: { via: 'cashier', cashierVerified: true } }],
    })
    const done = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true, raastReceipts: true } })
    expect(done.taxRatePct).toBe(8)
    expect(done.status).toBe('completed')
    expect(await claims(o.id)).toBe(1)
    const paid = done.payments.find((p) => p.status === 'paid')!
    expect(paid).toMatchObject({ method: 'raast', gateway: 'raast', gatewayRef: 'RCRAAST9001', amountCents: 108_000 })
    expect(done.raastReceipts).toHaveLength(1)
    expect(done.raastReceipts[0]).toMatchObject({
      tenantId: tenantA, status: 'provisional', paymentId: paid.id, bankRef: 'RCRAAST9001',
      bankAccountId: raast.bankAccountId, ledgerCode: raast.ledgerCode, amountCents: 108_000, confirmedVia: 'cashier', cashierVerified: true,
    })
  })
})

// ─── Decision 8 ───────────────────────────────────────────────────────────────

describe('decision 8 — who completes an order', () => {
  it('names the door per kind of order', async () => {
    expect(completionDoor({ source: 'pos', fulfilmentType: 'dine_in' })).toBe('payment')
    expect(completionDoor({ source: 'servd', fulfilmentType: 'delivery' })).toBe('delivery')
    expect(completionDoor({ source: 'servd', fulfilmentType: 'takeout' })).toBe('handoff')
    expect(completionDoor({ source: 'servd', fulfilmentType: 'dine_in', rawPayload: { channel: 'group_order' } })).toBe('payment')
  })

  it('expo hand-off completes a pickup, once, and takes it off the ready column', async () => {
    const o = await order({ fulfilmentType: 'takeout' })
    const res = await call('POST', `/expo/orders/${o.id}/handoff`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ completed: true, completesOn: 'handoff' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
    expect(await claims(o.id)).toBe(1)
    // The ledger entry is posted (the one record — no FinancialEntry).
    const je = await waitFor(
      () => prisma.journalEntry.count({ where: { reference: `order.complete:${o.id}` } }),
      (x) => x > 0,
    )
    expect(je).toBe(1)
    expect(await prisma.financialEntry.count({ where: { orderId: o.id } })).toBe(0)
    // A staff "Complete" afterwards is a same-state no-op — no second run.
    await updateOrderStatus(o.id, 'completed')
    await settle()
    expect(await claims(o.id)).toBe(1)
    expect(await prisma.journalEntry.count({ where: { reference: `order.complete:${o.id}` } })).toBe(1)
  })

  it('expo hand-off does NOT complete a delivery; the rider drop-off does', async () => {
    const rider = await prisma.rider.create({ data: { tenantId: tenantA, name: 'R1', phone: '+923110009001', status: 'busy', isActive: true } })
    const o = await order({ fulfilmentType: 'delivery', riderId: rider.id })
    const res = await call('POST', `/expo/orders/${o.id}/handoff`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ completed: false, completesOn: 'delivery' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('ready')
    expect(await claims(o.id)).toBe(0)

    const q = await call('GET', '/expo/queue')
    expect(q.statusCode).toBe(200)
    expect((q.json() as { ready: Array<{ id: string }> }).ready.some((r) => r.id === o.id)).toBe(false)

    // A staff "Complete" can't jump the drop-off.
    const patch = await call('PATCH', `/orders/${o.id}/status`, { status: 'completed' })
    expect(patch.statusCode).toBe(409)
    expect(patch.json().error.code).toBe('COMPLETE_ON_DELIVERY')

    const d = await markDelivered(o.id, { actor: { id: cashierId } })
    expect(d.alreadyDelivered).toBe(false)
    expect(d.order.status).toBe('completed')
    expect(d.order.deliveredAt).toBeInstanceOf(Date)
    expect(await claims(o.id)).toBe(1)
    const again = await markDelivered(o.id)
    expect(again.alreadyDelivered).toBe(true)
    expect(await claims(o.id)).toBe(1)
    const r = await waitFor(() => prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }), (x) => x.status === 'available')
    expect(r.totalDeliveries).toBe(1)
  })

  it('a staff "Complete" cannot complete an unpaid till sale', async () => {
    const o = await order({ source: 'pos', fulfilmentType: 'dine_in' })
    const patch = await call('PATCH', `/orders/${o.id}/status`, { status: 'completed' })
    expect(patch.statusCode).toBe(409)
    expect(patch.json().error.code).toBe('COMPLETE_ON_PAYMENT')
    const res = await call('POST', `/expo/orders/${o.id}/handoff`)
    expect(res.json()).toMatchObject({ completed: false, completesOn: 'payment' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('ready')
  })

  it('an OTP verified at the door completes the delivery through the same routine', async () => {
    const o = await order({ fulfilmentType: 'delivery', deliveryOtp: '4321' })
    const bad = await call('POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '0000' })
    expect(bad.statusCode).toBe(403)
    const ok = await call('POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '4321' })
    expect(ok.statusCode).toBe(200)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.status).toBe('completed')
    expect(row.deliveryOtpVerifiedAt).toBeInstanceOf(Date)
    expect(row.deliveredAt).toBeInstanceOf(Date)
    expect(await claims(o.id)).toBe(1)
  })

  it('code-only delivery ON: completion needs the verified code; a staff close completes nothing', async () => {
    await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: tenantA, on: true, actorId: cashierId, reason: 'code-only test window' }))
    try {
      const rider = await prisma.rider.create({ data: { tenantId: tenantA, name: 'R2', phone: '+923110009002', status: 'busy', isActive: true } })
      const o = await order({ fulfilmentType: 'delivery', riderId: rider.id, deliveryOtp: '2468' })
      await expect(markDelivered(o.id, { actor: { id: cashierId } })).rejects.toMatchObject({ code: 'CODE_REQUIRED', statusCode: 409 })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('ready')
      expect(await claims(o.id)).toBe(0)
      const d = await markDelivered(o.id, { otpVerified: true, actor: { id: cashierId } })
      expect(d.order.status).toBe('completed')
      expect(d.order.deliveryOtpVerifiedAt).toBeInstanceOf(Date)
      expect(await claims(o.id)).toBe(1)
    } finally {
      await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: tenantA, on: false, actorId: cashierId, reason: 'code-only test window' }))
    }
  })

  it('an OTP for an order the kitchen has not finished is refused, and nothing completes', async () => {
    const o = await order({ status: 'preparing', fulfilmentType: 'delivery', deliveryOtp: '1111' })
    const res = await call('POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '1111' })
    expect(res.statusCode).toBe(409)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('preparing')
    expect(await claims(o.id)).toBe(0)
  })

  it('completeOrder does nothing for an order that is not completed', async () => {
    const o = await order({ status: 'ready' })
    expect((await completeOrder(o.id, null, { via: 'status_update' })).ran).toBe(false)
    expect(await claims(o.id)).toBe(0)
  })
})

// ─── Storefront quote ────────────────────────────────────────────────────────

describe('GET /storefront/quote — the page shows the server price', () => {
  const quote = (gateway: string) => call('GET', `/storefront/quote?${new URLSearchParams({
    conceptSlug, type: 'pickup', paymentGateway: gateway,
    items: JSON.stringify([{ menuItemId: burgerId, quantity: 1, modifiers: [] }]),
  }).toString()}`)

  it('cash on pickup is taxed at 15%, paid online at 8%', async () => {
    const cash = await quote('cash')
    expect(cash.statusCode).toBe(200)
    expect(cash.json()).toMatchObject({ taxRatePct: 15, taxCents: 15_000, itemTotalCents: 100_000, totalCents: 115_000 })
    // Non-cash tenders price at 8%. The online gateways aren't wired yet, so
    // a jazzcash quote is refused (ONL-02); the wallet is the non-cash tender.
    const online = await quote('wallet')
    expect(online.json()).toMatchObject({ taxRatePct: 8, taxCents: 8_000, totalCents: 108_000 })
    expect((await quote('jazzcash')).statusCode).toBe(422)
  })

  it('refuses a basket that is not valid JSON', async () => {
    const res = await call('GET', `/storefront/quote?conceptSlug=${conceptSlug}&items=nope`)
    expect(res.statusCode).toBe(400)
  })
})
