// Order intake audit (2026-10-10 kitchen + till simulations).
//
// What this guards:
//   - FOH-06: an order rung up without an idempotency key (the waiter screen)
//     is never deduped on the millisecond: two companies' waiters ringing up at
//     once each get THEIR OWN order with their own items. A dedupe hit is only
//     returned to the same brand and the same till operator — a reused key
//     from another brand / company / operator is a 409, never the other order.
//   - BOH-03: an item routed to a retired station (soft-deleted or switched
//     off) is not sent to it: it goes to the brand's expo / pass station, or
//     stays unrouted and shows on GET /kds/unrouted (company-scoped).
//   - BOH-10: every channel refuses an 86'd (or deleted) item with 409
//     ITEM_UNAVAILABLE — the till included — while a retry of an order made
//     before the 86 still gets that order back.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ingestOrder } from '../src/modules/orders/service.js'
import { createPosOrder } from '../src/modules/pos/service.js'
import { kdsRoutes } from '../src/modules/kds/routes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let kheerId: string
let burgerId: string
let pulaoId: string
let croissantId: string
let waiterA: string
let waiterA2: string
let cashierB: string
let tokenA: string
let tokenB: string
let hotLineId: string

let n = 0
function dto(over: Partial<OrderDTO> & { items: OrderDTO['items'] }): OrderDTO {
  n += 1
  return {
    source: 'pos',
    external_id: `pos-${crypto.randomUUID()}`,
    concept_id: conceptA,
    placed_at: new Date().toISOString(),
    customer_id: null,
    customer_name: null,
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
    pos_staff_id: waiterA,
    payment: { provider: null, amountCents: 50_000, status: 'pending' },
    ...over,
  }
}
const line = (menuItemId: string | null, name: string) => ({
  externalItemId: menuItemId ?? `custom-${n}`, menuItemId, name, quantity: 1, unitPriceCents: 50_000, modifiers: [],
})

const call = (token: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Intake A', slug: 'intake-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Intake B', slug: 'intake-b' } })).id
  conceptA = (await prisma.concept.create({
    data: { name: 'Intake Simmer', slug: 'intake-simmer', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'Intake Grill', slug: 'intake-grill', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  const catA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  const catB = (await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })).id
  hotLineId = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Hot Line' } })).id
  kheerId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA, name: 'Kheer', priceCents: 50_000 } })).id
  pulaoId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA, name: 'Chicken Yakhni Pulao', priceCents: 50_000, stationId: hotLineId } })).id
  croissantId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA, name: 'Butter Croissant', priceCents: 50_000 } })).id
  burgerId = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB, name: 'Chapli Burger', priceCents: 50_000 } })).id

  const mk = async (email: string, tenantId: string, role: string) => prisma.user.create({
    data: { name: email, email, password: 'x', role, isActive: true, accountStatus: 'active', tenantId } as never,
  })
  const uA = await mk('intake-waiter-a@test.local', tenantA, 'admin')
  const uA2 = await mk('intake-waiter-a2@test.local', tenantA, 'cashier')
  const uB = await mk('intake-cashier-b@test.local', tenantB, 'admin')
  waiterA = uA.id
  waiterA2 = uA2.id
  cashierB = uB.id
  tokenA = (issueStaffSession(uA) as { accessToken: string }).accessToken
  tokenB = (issueStaffSession(uB) as { accessToken: string }).accessToken

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(kdsRoutes, { prefix: '/kds' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── FOH-06 ───────────────────────────────────────────────────────────────────

describe('FOH-06 — keyless orders never collide on the millisecond', () => {
  it('two companies ringing up 15 keyless orders each in the same millisecond get 30 orders, each their own', async () => {
    const before = await prisma.order.count({ where: { conceptId: { in: [conceptA, conceptB] } } })
    // Freeze the clock the till mints its fallback key from: every request
    // below would have carried the SAME `pos-<ms>` key.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_760_102_400_123)
    let results: Array<{ who: 'A' | 'B'; order: Awaited<ReturnType<typeof createPosOrder>> }>
    try {
      results = await Promise.all([
        ...Array.from({ length: 15 }, async () => ({
          who: 'A' as const,
          order: await createPosOrder({
            conceptId: conceptA, staffId: waiterA, staffRole: 'admin',
            items: [{ menuItemId: kheerId, name: 'Kheer', quantity: 1, unitPriceCents: 50_000, modifiers: [] }],
          }),
        })),
        ...Array.from({ length: 15 }, async () => ({
          who: 'B' as const,
          order: await createPosOrder({
            conceptId: conceptB, staffId: cashierB, staffRole: 'admin',
            items: [{ menuItemId: burgerId, name: 'Chapli Burger', quantity: 1, unitPriceCents: 50_000, modifiers: [] }],
          }),
        })),
      ])
    } finally {
      clock.mockRestore()
    }

    expect(new Set(results.map((r) => r.order.id)).size).toBe(30)
    for (const r of results) {
      expect(r.order.conceptId).toBe(r.who === 'A' ? conceptA : conceptB)
      expect(r.order.items.map((i) => i.name)).toEqual([r.who === 'A' ? 'Kheer' : 'Chapli Burger'])
      expect(r.order.externalId).not.toBe('pos-1760102400123')
    }
    expect(await prisma.order.count({ where: { conceptId: { in: [conceptA, conceptB] } } })).toBe(before + 30)
    // Every order's line reached the kitchen (one item each, none dropped).
    const orders = await prisma.order.findMany({ where: { id: { in: results.map((r) => r.order.id) } }, include: { items: true } })
    expect(orders.every((o) => o.items.length === 1)).toBe(true)
  })

  it('a reused key returns the order only to the same brand and the same operator', async () => {
    const key = `pos-${crypto.randomUUID()}`
    const first = await ingestOrder(dto({ external_id: key, items: [line(kheerId, 'Kheer')] }))
    expect(first.created).toBe(true)

    // A retry (same brand, same operator) gets the same order back.
    const retry = await ingestOrder(dto({ external_id: key, items: [line(kheerId, 'Kheer')] }))
    expect(retry.created).toBe(false)
    expect(retry.order.id).toBe(first.order.id)

    // Another company's brand with the same key: 409, never A's order.
    await expect(ingestOrder(dto({ external_id: key, concept_id: conceptB, pos_staff_id: cashierB, items: [line(burgerId, 'Chapli Burger')] })))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
    // Another operator in the same brand: also a different order.
    await expect(ingestOrder(dto({ external_id: key, pos_staff_id: waiterA2, items: [line(kheerId, 'Kheer')] })))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(await prisma.order.count({ where: { externalId: key } })).toBe(1)
  })

  it('the concurrent (unique-constraint) path is scoped the same way', async () => {
    const key = `pos-${crypto.randomUUID()}`
    const settled = await Promise.allSettled([
      ingestOrder(dto({ external_id: key, items: [line(kheerId, 'Kheer')] })),
      ingestOrder(dto({ external_id: key, concept_id: conceptB, pos_staff_id: cashierB, items: [line(burgerId, 'Chapli Burger')] })),
    ])
    const ok = settled.filter((s) => s.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof ingestOrder>>>>
    const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    const winner = ok[0]!.value.order
    const winnerItems = await prisma.orderItem.findMany({ where: { orderId: winner.id } })
    expect(winnerItems.map((i) => i.name)).toEqual([winner.conceptId === conceptA ? 'Kheer' : 'Chapli Burger'])

    // Two identical retries racing each other both get the one order.
    const key2 = `pos-${crypto.randomUUID()}`
    const [x, y] = await Promise.all([
      ingestOrder(dto({ external_id: key2, items: [line(kheerId, 'Kheer')] })),
      ingestOrder(dto({ external_id: key2, items: [line(kheerId, 'Kheer')] })),
    ])
    expect(x.order.id).toBe(y.order.id)
    expect(await prisma.order.count({ where: { externalId: key2 } })).toBe(1)
  })
})

// ─── BOH-03 ───────────────────────────────────────────────────────────────────

describe('BOH-03 — a retired station never swallows a ticket', () => {
  it('routes to the live station while it is live', async () => {
    const { order } = await ingestOrder(dto({ items: [line(pulaoId, 'Chicken Yakhni Pulao')] }))
    expect(order.items[0]!.stationId).toBe(hotLineId)
  })

  it('a soft-deleted station → unrouted, and /kds/unrouted shows it to its company only', async () => {
    await prisma.station.update({ where: { id: hotLineId }, data: { deletedAt: new Date() } })
    const { order } = await ingestOrder(dto({ items: [line(pulaoId, 'Chicken Yakhni Pulao')] }))
    expect(order.items[0]!.stationId).toBeNull()

    // A ticket rung up BEFORE the fix, still pointing at the retired station.
    const legacy = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'preparing', totalCents: 50_000,
        items: { create: [{ name: 'Chicken Yakhni Pulao', menuItemId: pulaoId, stationId: hotLineId, quantity: 1, unitPriceCents: 50_000, status: 'preparing' }] },
      },
      include: { items: true },
    })

    const resA = await call(tokenA, '/kds/unrouted')
    expect(resA.statusCode).toBe(200)
    const listed = (resA.json() as { items: Array<{ itemId: string; retiredStation: string | null; order: { id: string } }> }).items
    expect(listed.map((i) => i.itemId)).toEqual(expect.arrayContaining([order.items[0]!.id, legacy.items[0]!.id]))
    expect(listed.find((i) => i.itemId === legacy.items[0]!.id)!.retiredStation).toBe('Hot Line')

    // Company B sees its own unrouted lines (its brand has no stations at
    // all), never A's.
    const resB = await call(tokenB, '/kds/unrouted')
    expect(resB.statusCode).toBe(200)
    const listedB = (resB.json() as { items: Array<{ itemId: string; order: { concept: { id: string } } }> }).items
    expect(listedB.length).toBeGreaterThan(0)
    expect(listedB.every((i) => i.order.concept.id === conceptB)).toBe(true)
    expect(listedB.map((i) => i.itemId)).not.toContain(legacy.items[0]!.id)
    expect(listedB.map((i) => i.itemId)).not.toContain(order.items[0]!.id)
  })

  it('falls back to the brand\'s expo / pass station when it has one — also for a switched-off station and a custom line', async () => {
    const expo = await prisma.station.create({ data: { conceptId: conceptA, name: 'Expo Pass', displayOrder: 9 } })
    const { order } = await ingestOrder(dto({ items: [line(pulaoId, 'Chicken Yakhni Pulao'), line(null, 'Off-menu toastie')] }))
    expect(order.items.map((i) => i.stationId)).toEqual([expo.id, expo.id])

    const fryer = await prisma.station.create({ data: { conceptId: conceptA, name: 'Fryer', isActive: false } })
    await prisma.menuItem.update({ where: { id: pulaoId }, data: { stationId: fryer.id } })
    const again = await ingestOrder(dto({ items: [line(pulaoId, 'Chicken Yakhni Pulao')] }))
    expect(again.order.items[0]!.stationId).toBe(expo.id)
  })
})

// ─── BOH-10 ───────────────────────────────────────────────────────────────────

describe('BOH-10 — every channel refuses an 86\'d item', () => {
  it('the shared intake and the till refuse an unavailable item with 409 ITEM_UNAVAILABLE', async () => {
    const key = `pos-${crypto.randomUUID()}`
    const before86 = await ingestOrder(dto({ external_id: key, items: [line(croissantId, 'Butter Croissant')] }))
    await prisma.menuItem.update({ where: { id: croissantId }, data: { isAvailable: false } })

    await expect(ingestOrder(dto({ items: [line(croissantId, 'Butter Croissant')] })))
      .rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE', statusCode: 409 })
    await expect(ingestOrder(dto({ source: 'servd', pos_staff_id: null, items: [line(croissantId, 'Butter Croissant')] })))
      .rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
    await expect(createPosOrder({
      conceptId: conceptA, staffId: waiterA, staffRole: 'admin',
      items: [{ menuItemId: croissantId, name: 'Butter Croissant', quantity: 1, unitPriceCents: 50_000, modifiers: [] }],
    })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE', statusCode: 409 })

    // The till's offline resend of the order rung up BEFORE the 86 still gets it back.
    const resend = await ingestOrder(dto({ external_id: key, items: [line(croissantId, 'Butter Croissant')] }))
    expect(resend.created).toBe(false)
    expect(resend.order.id).toBe(before86.order.id)
  })

  it('a deleted menu item is refused too', async () => {
    await prisma.menuItem.update({ where: { id: kheerId }, data: { deletedAt: new Date() } })
    await expect(ingestOrder(dto({ items: [line(kheerId, 'Kheer')] }))).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
    await prisma.menuItem.update({ where: { id: kheerId }, data: { deletedAt: null } })
  })
})
