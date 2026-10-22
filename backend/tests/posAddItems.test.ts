// Add items to a sent bill (owner, 2026-10-22): POST /pos/orders/:orderId/items — two companies.
//
//   - the lines land on the SAME ticket, pending for the kitchen; the bill grows to exactly what a ring-up of
//     everything would bill (THE pricing function, the ticket's tender rate);
//   - only the new lines take stock (the first lines are never drawn twice);
//   - a resend with the same key adds once (200, replayed);
//   - company B: 404 on A's ticket; A's ticket refuses B's dish (422 ITEM_NOT_IN_BRAND);
//   - money on the bill (a pending payment) → 409 BILL_IN_PAYMENT; a completed ticket → 409 ORDER_NOT_OPEN;
//   - a cashier pricing below the menu needs a manager PIN (403 PRICE_OVERRIDE_BLOCKED).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { prisma, mkCompany, mkUser, buildApp, caller, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, cashierB: Who
let beef: string, milk: string

const line = (menuItemId: string, name: string, unitPriceCents: number, quantity = 1) => ({ menuItemId, name, quantity, unitPriceCents, modifiers: [] })

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `ai-lot-${randomUUID().slice(0, 8)}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
}

async function ringUp(items: unknown[]) {
  const r = await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items, paymentMethod: 'cash', idempotencyKey: randomUUID() })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; totalCents: number }
}

/** Sale movements per line, once the fire-and-forget depletion of the ring-up has landed. */
async function saleRows(orderId: string, expectLines: number) {
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.stockMovement.findMany({ where: { orderId, kind: 'sale' }, select: { orderItemId: true, inventoryItemId: true, qty: true } })
    if (new Set(rows.map((r) => r.orderItemId)).size >= expectLines) return rows
    await new Promise((r) => setTimeout(r, 100))
  }
  return prisma.stockMovement.findMany({ where: { orderId, kind: 'sale' }, select: { orderItemId: true, inventoryItemId: true, qty: true } })
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`ai-a-${Date.now()}`)
  B = await mkCompany(`ai-b-${Date.now()}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(Date.now() - 30 * DAY).toISOString() } })
  cashierA = await mkUser(`ai-cashier-a-${Date.now()}`, 'cashier', A.tenantId)
  cashierB = await mkUser(`ai-cashier-b-${Date.now()}`, 'cashier', B.tenantId)
  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  milk = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Milk', unit: 'l', category: 'dairy' } })).id
  await lot(A.tenantId, beef, 50, 150_000)
  await lot(A.tenantId, milk, 50, 20_000)
  await prisma.recipe.create({ data: { kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: beef, quantity: 0.25, unit: 'kg' }] } } })
  await prisma.recipe.create({ data: { kind: 'plate', menuItemId: A.items.kheer, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: milk, quantity: 0.2, unit: 'l' }] } } })
  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('add items to a sent bill', () => {
  it('adds to the same ticket; the bill equals a ring-up of everything; only the new lines take stock', async () => {
    const o = await ringUp([line(A.items.nihari, 'Beef Nihari', 145_000)])
    const firstRows = await saleRows(o.id, 1)
    expect(firstRows.length).toBeGreaterThan(0)

    const key = randomUUID()
    const r = await call(cashierA, 'POST', `/pos/orders/${o.id}/items`, { items: [line(A.items.kheer, 'Kheer', 55_000, 2)], idempotencyKey: key })
    expect(r.statusCode, r.body).toBe(201)
    const v = r.json()
    expect(v.id).toBe(o.id)
    expect(v.addedItemIds).toHaveLength(1)
    expect(v.items).toHaveLength(2)
    expect(v.items.find((i: { id: string }) => i.id === v.addedItemIds[0])).toMatchObject({ name: 'Kheer', quantity: 2, status: 'pending' })

    // The bill = what one ring-up of everything bills at the same tender.
    const q = await call(cashierA, 'POST', '/pos/quote', { conceptId: A.conceptId, paymentMethod: 'cash', items: [line(A.items.nihari, 'Beef Nihari', 145_000), line(A.items.kheer, 'Kheer', 55_000, 2)] })
    expect(q.statusCode, q.body).toBe(200)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.totalCents).toBe(q.json().totalCents)
    expect(row.taxCents).toBe(q.json().taxCents)
    expect(row.totalCents).toBeGreaterThan(o.totalCents)

    // Stock: the kheer line drew milk; the nihari line was not drawn again.
    const rows = await saleRows(o.id, 2)
    const nihariLine = v.items.find((i: { name: string }) => i.name === 'Beef Nihari').id as string
    expect(rows.filter((x) => x.orderItemId === nihariLine)).toHaveLength(firstRows.filter((x) => x.orderItemId === nihariLine).length)
    const kheerRows = rows.filter((x) => x.orderItemId === v.addedItemIds[0])
    expect(kheerRows.every((x) => x.inventoryItemId === milk)).toBe(true)
    expect(kheerRows.length).toBeGreaterThan(0)
    expect(kheerRows.reduce((s, x) => s + Math.abs(x.qty), 0)).toBeGreaterThan(0)

    // The same key again adds nothing.
    const again = await call(cashierA, 'POST', `/pos/orders/${o.id}/items`, { items: [line(A.items.kheer, 'Kheer', 55_000, 2)], idempotencyKey: key })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().replayed).toBe(true)
    expect(await prisma.orderItem.count({ where: { orderId: o.id } })).toBe(2)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(row.totalCents)
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: o.id, action: 'pos.order.items_added' } })).toBe(1)
  })

  it('company B gets 404 on A’s ticket; A’s ticket refuses B’s dish', async () => {
    const o = await ringUp([line(A.items.water, 'Water', 10_000)])
    const foreign = await call(cashierB, 'POST', `/pos/orders/${o.id}/items`, { items: [line(B.items.kheer, 'Kheer', 55_000)] })
    expect(foreign.statusCode).toBe(404)
    const wrongDish = await call(cashierA, 'POST', `/pos/orders/${o.id}/items`, { items: [line(B.items.kheer, 'Kheer', 55_000)] })
    expect(wrongDish.statusCode).toBe(422)
    expect(wrongDish.json().error.code).toBe('ITEM_NOT_IN_BRAND')
    expect(await prisma.orderItem.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('refuses a bill with money on it, a completed ticket, and an unapproved price below the menu', async () => {
    const paying = await ringUp([line(A.items.water, 'Water', 10_000)])
    await prisma.payment.create({ data: { orderId: paying.id, method: 'cash', amountCents: paying.totalCents, status: 'pending' } })
    const r1 = await call(cashierA, 'POST', `/pos/orders/${paying.id}/items`, { items: [line(A.items.kheer, 'Kheer', 55_000)] })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('BILL_IN_PAYMENT')

    const done = await ringUp([line(A.items.water, 'Water', 10_000)])
    await prisma.order.update({ where: { id: done.id }, data: { status: 'completed', completedAt: new Date() } })
    const r2 = await call(cashierA, 'POST', `/pos/orders/${done.id}/items`, { items: [line(A.items.kheer, 'Kheer', 55_000)] })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('ORDER_NOT_OPEN')

    const open = await ringUp([line(A.items.water, 'Water', 10_000)])
    const r3 = await call(cashierA, 'POST', `/pos/orders/${open.id}/items`, { items: [line(A.items.kheer, 'Kheer', 1_000)] })
    expect(r3.statusCode).toBe(403)
    expect(r3.json().error.code).toBe('PRICE_OVERRIDE_BLOCKED')
    expect(await prisma.orderItem.count({ where: { orderId: open.id } })).toBe(1)
  })
})
