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
//     Payment, whichever request wins the group claim.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { groupOrderRoutes } from '../src/modules/groupOrders/routes.js'

let app: FastifyInstance
let conceptId: string
let stationId: string
let menuItemId: string
let customerId: string
let token: string

async function group(shareCode: string) {
  const go = await prisma.groupOrder.create({
    data: { conceptId, initiatorName: 'Sana', initiatorCustomerId: customerId, shareCode, status: 'open' },
  })
  const sana = await prisma.groupOrderMember.create({ data: { groupOrderId: go.id, customerId, displayName: 'Sana' } })
  const ali = await prisma.groupOrderMember.create({ data: { groupOrderId: go.id, displayName: 'Ali' } })
  await prisma.groupOrderItem.createMany({
    data: [
      { groupOrderId: go.id, memberId: sana.id, menuItemId, name: 'Club sandwich', quantity: 2, unitPriceCents: 90_000 },
      { groupOrderId: go.id, memberId: ali.id, menuItemId, name: 'Club sandwich', quantity: 1, unitPriceCents: 90_000 },
    ],
  })
  return go
}

const submit = (code: string) => app.inject({
  method: 'POST', url: `/group-orders/${code}/submit`, headers: { authorization: `Bearer ${token}` },
})

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
    } finally {
      await prisma.menuItem.update({ where: { id: menuItemId }, data: { priceCents: 90_000 } })
    }
  })
})
