// Group-order submit creates its order through ingestOrder.
//
// It used to insert the Order itself, so a group order never reached a
// station's KDS (items carried no stationId), was never pushed to KDS/expo,
// never deducted stock, and skipped the brand / unpriced-item guards. What
// this guards:
//   - the order comes out of ingestOrder: items routed to their station,
//     GST and total stored, dine-in, source 'servd', external id
//     group-<shareCode>;
//   - exactly one pending 'split' Payment;
//   - a double-tapped submit gets the SAME order back — one order, one
//     Payment, whichever request wins the group claim;
//   - ONLINE-R6: opening hours and time-limited sections apply to a group
//     as they do at checkout — a closed brand is 409 BRAND_CLOSED on create
//     and submit, an item outside its section's window is 400
//     ITEM_UNAVAILABLE on add and submit — and another company's closed
//     brand or items never leak into this company's group;
//   - LEFT-R1: a cancelled group can't be re-locked (lock only moves
//     open → locked), so cancel → lock → submit fires nothing;
//   - LEFT-R2: lock and submit are one server step, and a submit the guards
//     refuse leaves the group OPEN — the members can remove the line and
//     send it again (a refused submit used to strand a locked cart);
//   - LEFT-R3: GET /:code carries the server's own quote (service charge,
//     item tax classes), equal to what submit charges.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { groupOrderRoutes } from '../src/modules/groupOrders/routes.js'
import { pktClock } from '../src/modules/storefront/serviceHours.js'

let app: FastifyInstance
let conceptId: string
let stationId: string
let menuItemId: string
let customerId: string
let token: string

async function group(shareCode: string, opts: { conceptId?: string; menuItemId?: string } = {}) {
  const cId = opts.conceptId ?? conceptId
  const itemId = opts.menuItemId ?? menuItemId
  const go = await prisma.groupOrder.create({
    data: { conceptId: cId, initiatorName: 'Sana', initiatorCustomerId: customerId, shareCode, status: 'open' },
  })
  const sana = await prisma.groupOrderMember.create({ data: { groupOrderId: go.id, customerId, displayName: 'Sana' } })
  const ali = await prisma.groupOrderMember.create({ data: { groupOrderId: go.id, displayName: 'Ali' } })
  await prisma.groupOrderItem.createMany({
    data: [
      { groupOrderId: go.id, memberId: sana.id, menuItemId: itemId, name: 'Club sandwich', quantity: 2, unitPriceCents: 90_000 },
      { groupOrderId: go.id, memberId: ali.id, menuItemId: itemId, name: 'Club sandwich', quantity: 1, unitPriceCents: 90_000 },
    ],
  })
  return go
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/** Opening hours every day that never include the current Karachi minute. */
async function closedNow(cId: string) {
  const open = (pktClock(new Date()).minutes + 180) % 1438
  await prisma.serviceHours.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ conceptId: cId, dayOfWeek, openMin: open, closeMin: open + 1 })),
  })
}

/** A lunch-style section whose window starts two hours from now (Karachi). */
async function sectionNotServingNow(cId: string, name: string) {
  const now = pktClock(new Date()).minutes
  return prisma.category.create({
    data: {
      conceptId: cId, name,
      timeRestrictionStart: hhmm((now + 120) % 1440),
      timeRestrictionEnd:   hhmm((now + 180) % 1440),
    },
  })
}

const errCode = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code

const submit = (code: string) => app.inject({
  method: 'POST', url: `/group-orders/${code}/submit`, headers: { authorization: `Bearer ${token}` },
})
const post = (url: string) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } })
const statusOf = async (id: string) => (await prisma.groupOrder.findUniqueOrThrow({ where: { id } })).status

beforeAll(async () => {
  const tenantId = (await prisma.tenant.create({ data: { name: 'Group Co', slug: 'group-co' } })).id
  conceptId = (await prisma.concept.create({
    data: { name: 'Group Cafe', slug: 'group-cafe', type: 'restaurant', tenantId, taxRateCash: 15, taxRateCard: 8 },
  })).id
  stationId = (await prisma.station.create({ data: { conceptId, name: 'Sandwich line' } })).id
  const categoryId = (await prisma.category.create({ data: { conceptId, name: 'Sandwiches' } })).id
  menuItemId = (await prisma.menuItem.create({
    data: { conceptId, categoryId, name: 'Club sandwich', priceCents: 90_000, stationId },
  })).id
  customerId = (await prisma.customer.create({ data: { name: 'Sana', phone: '+923001112233' } })).id
  token = jwt.sign({ sub: customerId, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '1h' })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } })
  })
  await app.register(groupOrderRoutes, { prefix: '/group-orders' })
  await app.ready()
})

afterAll(async () => { await app.close() })

describe('ONLINE-R6 — opening hours and section windows apply to group orders', () => {
  let tenantId: string
  let closedConceptId: string
  let closedItemId: string
  let lunchItemId: string
  let otherCoItemId: string

  beforeAll(async () => {
    tenantId = (await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { tenantId: true } })).tenantId!
    // Company A: a second brand that is closed right now.
    closedConceptId = (await prisma.concept.create({
      data: { name: 'Closed Cafe', slug: 'closed-cafe', type: 'restaurant', tenantId, taxRateCash: 15, taxRateCard: 8 },
    })).id
    await closedNow(closedConceptId)
    const closedCat = (await prisma.category.create({ data: { conceptId: closedConceptId, name: 'Sandwiches' } })).id
    closedItemId = (await prisma.menuItem.create({
      data: { conceptId: closedConceptId, categoryId: closedCat, name: 'Club sandwich', priceCents: 90_000 },
    })).id
    // Company A, open brand: a lunch section that isn't showing now.
    const lunch = await sectionNotServingNow(conceptId, 'Lunch')
    lunchItemId = (await prisma.menuItem.create({
      data: { conceptId, categoryId: lunch.id, name: 'Lunch thali', priceCents: 90_000, stationId },
    })).id
    // Company B: closed brand AND a lunch section of its own.
    const otherTenant = (await prisma.tenant.create({ data: { name: 'Other Co', slug: 'other-co-group' } })).id
    const otherConcept = (await prisma.concept.create({
      data: { name: 'Other Kitchen', slug: 'other-kitchen', type: 'restaurant', tenantId: otherTenant, taxRateCash: 15, taxRateCard: 8 },
    })).id
    await closedNow(otherConcept)
    const otherLunch = await sectionNotServingNow(otherConcept, 'Lunch')
    otherCoItemId = (await prisma.menuItem.create({
      data: { conceptId: otherConcept, categoryId: otherLunch.id, name: 'Other thali', priceCents: 90_000 },
    })).id
  })

  it('submit at a closed brand is 409 BRAND_CLOSED — no order, group unclaimed', async () => {
    const go = await group('GRPCL1', { conceptId: closedConceptId, menuItemId: closedItemId })
    const r = await submit('GRPCL1')
    expect(r.statusCode).toBe(409)
    expect(errCode(r)).toBe('BRAND_CLOSED')
    expect((r.json() as { error: { message: string } }).error.message).toMatch(/Closed Cafe is closed right now\. Opens at/)
    expect(await prisma.order.count({ where: { externalId: 'group-GRPCL1' } })).toBe(0)
    const after = await prisma.groupOrder.findUniqueOrThrow({ where: { id: go.id } })
    expect(after.orderId).toBeNull()
    expect(after.status).toBe('open')
  })

  it('starting a group at a closed brand is 409 BRAND_CLOSED', async () => {
    const r = await app.inject({
      method: 'POST', url: '/group-orders', headers: { authorization: `Bearer ${token}` },
      payload: { conceptSlug: 'closed-cafe', initiatorName: 'Sana' },
    })
    expect(r.statusCode).toBe(409)
    expect(errCode(r)).toBe('BRAND_CLOSED')
    // Only the group the previous case seeded directly exists at that brand.
    expect(await prisma.groupOrder.count({ where: { conceptId: closedConceptId } })).toBe(1)
  })

  it('adding an item outside its section window is 400 ITEM_UNAVAILABLE', async () => {
    const go = await group('GRPLN1')
    const r = await app.inject({
      method: 'POST', url: '/group-orders/GRPLN1/items', headers: { authorization: `Bearer ${token}` },
      payload: { menuItemId: lunchItemId, quantity: 1 },
    })
    expect(r.statusCode).toBe(400)
    expect(errCode(r)).toBe('ITEM_UNAVAILABLE')
    expect(await prisma.groupOrderItem.count({ where: { groupOrderId: go.id, menuItemId: lunchItemId } })).toBe(0)
    // An item whose section is showing still goes in.
    const ok = await app.inject({
      method: 'POST', url: '/group-orders/GRPLN1/items', headers: { authorization: `Bearer ${token}` },
      payload: { menuItemId, quantity: 1 },
    })
    expect(ok.statusCode).toBe(200)
  })

  it('submit with an item whose section has ended is 400 ITEM_UNAVAILABLE', async () => {
    // Added while lunch was on; lunch is over by the time the group submits.
    const go = await group('GRPLN2', { menuItemId: lunchItemId })
    const r = await submit('GRPLN2')
    expect(r.statusCode).toBe(400)
    expect(errCode(r)).toBe('ITEM_UNAVAILABLE')
    expect(await prisma.order.count({ where: { externalId: 'group-GRPLN2' } })).toBe(0)
    expect((await prisma.groupOrder.findUniqueOrThrow({ where: { id: go.id } })).orderId).toBeNull()
    // Not stranded: the group is open again, so the line can come off.
    expect(await statusOf(go.id)).toBe('open')
  })

  it('LEFT-R2: a refused submit leaves the group open — the member removes the line and sends it', async () => {
    const go = await group('GRPRO1')
    const sana = await prisma.groupOrderMember.findFirstOrThrow({ where: { groupOrderId: go.id, customerId } })
    const lunchLine = await prisma.groupOrderItem.create({
      data: { groupOrderId: go.id, memberId: sana.id, menuItemId: lunchItemId, name: 'Lunch thali', quantity: 1, unitPriceCents: 90_000 },
    })
    const refused = await submit('GRPRO1')
    expect(refused.statusCode).toBe(400)
    expect(errCode(refused)).toBe('ITEM_UNAVAILABLE')
    expect(await statusOf(go.id)).toBe('open')

    const del = await app.inject({
      method: 'DELETE', url: `/group-orders/GRPRO1/items/${lunchLine.id}`, headers: { authorization: `Bearer ${token}` },
    })
    expect(del.statusCode).toBe(204)
    const sent = await submit('GRPRO1')
    expect(sent.statusCode).toBe(200)
    const order = await prisma.order.findFirstOrThrow({ where: { externalId: 'group-GRPRO1' }, include: { items: true } })
    expect(order.items.some((i) => i.menuItemId === lunchItemId)).toBe(false)
    expect(await statusOf(go.id)).toBe('submitted')
  })

  it('LEFT-R2: a group locked earlier (separate /lock) is reopened when its submit is refused', async () => {
    const go = await group('GRPRO2', { menuItemId: lunchItemId })
    expect((await post('/group-orders/GRPRO2/lock')).statusCode).toBe(200)
    expect(await statusOf(go.id)).toBe('locked')
    const r = await submit('GRPRO2')
    expect(r.statusCode).toBe(400)
    expect(await statusOf(go.id)).toBe('open')
  })

  it("company scoping: another company's closed brand doesn't touch this one, and its items can't be added", async () => {
    // Company B is closed and has an off-window section; company A's open
    // brand still takes its group.
    await group('GRPSC1')
    const r = await submit('GRPSC1')
    expect(r.statusCode).toBe(200)
    expect(await prisma.order.count({ where: { externalId: 'group-GRPSC1' } })).toBe(1)
    // Company B's item is not on company A's menu: 404 before any window
    // check (which would otherwise reveal B's hours).
    const go = await group('GRPSC2')
    const add = await app.inject({
      method: 'POST', url: '/group-orders/GRPSC2/items', headers: { authorization: `Bearer ${token}` },
      payload: { menuItemId: otherCoItemId, quantity: 1 },
    })
    expect(add.statusCode).toBe(404)
    expect(await prisma.groupOrderItem.count({ where: { groupOrderId: go.id, menuItemId: otherCoItemId } })).toBe(0)
  })
})

describe('POST /group-orders/:code/submit', () => {
  it('creates the order through ingestOrder — routed, taxed, one pending split payment', async () => {
    const go = await group('GRPAAA')
    const r = await submit('GRPAAA')
    expect(r.statusCode).toBe(200)
    const { orderId, total } = r.json() as { orderId: string; total: number }

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, payments: true },
    })
    expect(order.source).toBe('servd')
    expect(order.externalId).toBe('group-GRPAAA')
    expect(order.fulfilmentType).toBe('dine_in')
    expect(order.status).toBe('received')
    // 3 × 900.00 = 2,700.00 at the cash rate (15%) → 405.00 GST.
    expect(order.taxCents).toBe(40_500)
    expect(order.totalCents).toBe(310_500)
    expect(total).toBe(310_500)
    expect(order.customerId).toBe(customerId)
    // Every line is routed to its station — the KDS per-station screens see it.
    expect(order.items).toHaveLength(2)
    expect(order.items.every((i) => i.stationId === stationId)).toBe(true)
    expect(order.items.map((i) => i.name).sort()).toEqual(['Club sandwich · Ali', 'Club sandwich · Sana'])
    expect(order.payments).toHaveLength(1)
    expect(order.payments[0]).toMatchObject({ method: 'split', status: 'pending', amountCents: 310_500 })

    const after = await prisma.groupOrder.findUniqueOrThrow({ where: { id: go.id } })
    expect(after.status).toBe('submitted')
    expect(after.orderId).toBe(orderId)
  })

  it('a double-tapped submit gets the same order back — one order, one payment', async () => {
    const go = await group('GRPBBB')
    const [a, b] = await Promise.all([submit('GRPBBB'), submit('GRPBBB')])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    const ida = (a.json() as { orderId: string }).orderId
    const idb = (b.json() as { orderId: string }).orderId
    expect(ida).toBe(idb)
    expect(await prisma.order.count({ where: { externalId: 'group-GRPBBB' } })).toBe(1)
    expect(await prisma.payment.count({ where: { orderId: ida } })).toBe(1)
    expect((await prisma.groupOrder.findUniqueOrThrow({ where: { id: go.id } })).orderId).toBe(ida)

    // And a later resubmit is a no-op answer.
    const c = await submit('GRPBBB')
    expect(c.json()).toMatchObject({ orderId: ida, alreadySubmitted: true })
  })

  it('refuses an unpriced item, like every other channel', async () => {
    await prisma.menuItem.update({ where: { id: menuItemId }, data: { priceCents: 0 } })
    try {
      const go = await group('GRPCCC')
      const r = await submit('GRPCCC')
      expect(r.statusCode).toBe(409)
      expect((r.json() as { error: { code: string } }).error.code).toBe('ITEM_NOT_PRICED')
      expect(await prisma.order.count({ where: { externalId: 'group-GRPCCC' } })).toBe(0)
      expect((await prisma.groupOrder.findUniqueOrThrow({ where: { id: go.id } })).orderId).toBeNull()
      // ingestOrder refused before writing anything: the group reopens.
      expect(await statusOf(go.id)).toBe('open')
    } finally {
      await prisma.menuItem.update({ where: { id: menuItemId }, data: { priceCents: 90_000 } })
    }
  })
})

describe('LEFT-R1 — a cancelled group stays cancelled', () => {
  it('cancel → lock is 422 and submit fires nothing', async () => {
    const go = await group('CANCL1')
    expect((await post('/group-orders/CANCL1/cancel')).statusCode).toBe(200)
    const lock = await post('/group-orders/CANCL1/lock')
    expect(lock.statusCode).toBe(422)
    expect(errCode(lock)).toBe('GROUP_LOCKED')
    expect(await statusOf(go.id)).toBe('cancelled')
    const r = await submit('CANCL1')
    expect(r.statusCode).toBe(422)
    expect(errCode(r)).toBe('GROUP_CANCELLED')
    expect(await prisma.order.count({ where: { externalId: 'group-CANCL1' } })).toBe(0)
    expect(await statusOf(go.id)).toBe('cancelled')
  })

  it('lock only moves an open group; locking twice is 422', async () => {
    const go = await group('LOCK01')
    expect((await post('/group-orders/LOCK01/lock')).statusCode).toBe(200)
    const again = await post('/group-orders/LOCK01/lock')
    expect(again.statusCode).toBe(422)
    expect(await statusOf(go.id)).toBe('locked')
    // A locked group still submits (it is the same step now).
    expect((await submit('LOCK01')).statusCode).toBe(200)
    expect(await statusOf(go.id)).toBe('submitted')
    // And a submitted group never re-locks.
    expect((await post('/group-orders/LOCK01/lock')).statusCode).toBe(422)
  })
})

describe('LEFT-R3 — the cart shows the server quote, equal to what submit charges', () => {
  it('GET /:code quote includes the service charge and item tax classes', async () => {
    // Own company, so its service-charge config is read fresh (setup-config caches per company).
    const scTenant = (await prisma.tenant.create({ data: { name: 'SC Co', slug: 'sc-co-group' } })).id
    await prisma.operationsConfig.create({
      data: { scope: 'global', scopeId: null, tenantId: scTenant, serviceChargePct: 0.1, serviceChargeAppliesToChannels: ['pos'] },
    })
    const scConcept = (await prisma.concept.create({
      data: { name: 'SC Cafe', slug: 'sc-cafe', type: 'restaurant', tenantId: scTenant, taxRateCash: 15, taxRateCard: 8 },
    })).id
    const cat = (await prisma.category.create({ data: { conceptId: scConcept, name: 'All' } })).id
    const club = (await prisma.menuItem.create({ data: { conceptId: scConcept, categoryId: cat, name: 'Club sandwich', priceCents: 90_000 } })).id
    const water = (await prisma.menuItem.create({
      data: { conceptId: scConcept, categoryId: cat, name: 'Water', priceCents: 5_000, taxClassification: 'zero_rated' },
    })).id
    const go = await group('GRPQT1', { conceptId: scConcept, menuItemId: club })
    const sana = await prisma.groupOrderMember.findFirstOrThrow({ where: { groupOrderId: go.id, customerId } })
    await prisma.groupOrderItem.create({
      data: { groupOrderId: go.id, memberId: sana.id, menuItemId: water, name: 'Water', quantity: 1, unitPriceCents: 5_000 },
    })

    const g = await app.inject({ method: 'GET', url: '/group-orders/GRPQT1', headers: { authorization: `Bearer ${token}` } })
    expect(g.statusCode).toBe(200)
    const { quote } = g.json() as { quote: { itemTotalCents: number; taxCents: number; serviceChargeCents: number; totalCents: number } }
    // Food 2,750; GST 15% on the 2,700 standard-rated only = 405 (water is
    // zero-rated); service charge 10% of 3,155 = 315.50; total 3,470.50.
    expect(quote).toMatchObject({ itemTotalCents: 275_000, taxCents: 40_500, serviceChargeCents: 31_550, totalCents: 347_050 })

    const r = await submit('GRPQT1')
    expect(r.statusCode).toBe(200)
    expect((r.json() as { total: number }).total).toBe(quote.totalCents)
  })
})
