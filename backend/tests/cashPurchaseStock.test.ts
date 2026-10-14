// Food bought with cash enters stock through ONE contract (decision P6) —
// inventory/cashPurchase.ts recordCashPurchaseStockTx → receiving.ts receiveGoodsTx.
//
//   - A settled receipt from the company's system supplier 'Cash purchases'
//     (created once, never listed): lines born billed, lots at exactly the
//     amount paid, and it posts NOTHING (the cash document books Dr 12x0 —
//     the accountCode returned per line — / Cr its cash account).
//   - The same cash document twice → 409 ALREADY_RECEIVED (one receipt per
//     document); another company's item → 404; an unconvertible unit → 422
//     UNIT_MISMATCH; grams convert to the item's kg.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureFifoReady } from '../src/lib/stockLedger.js'
import { recordCashPurchaseStockTx } from '../src/modules/inventory/cashPurchase.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string, actor: string, token: string
let tomato: string, milk: string, itemB: string
let app: FastifyInstance

const record = (settledId: string, lines: Parameters<typeof recordCashPurchaseStockTx>[1]['lines'], tenantId = tenantA) =>
  prisma.$transaction((tx) => recordCashPurchaseStockTx(tx, {
    tenantId, settledBy: { kind: 'petty_cash_movement', id: settledId, creditAccountCode: '1011' },
    lines, occurredAt: new Date(), actorId: actor,
  }))

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'CP A', slug: `cp-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'CP B', slug: `cp-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  const u = await prisma.user.create({
    data: { name: 'cp keeper', email: `keeper.${RUN}@cp.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId: tenantA },
  })
  await prisma.tenantMember.create({ data: { tenantId: tenantA, userId: u.id } })
  actor = u.id
  token = (issueStaffSession(u) as { accessToken: string }).accessToken
  tomato = (await prisma.inventoryItem.create({ data: { name: `Tomato ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, category: 'produce' } })).id
  milk = (await prisma.inventoryItem.create({ data: { name: `Milk ${RUN}`, unit: 'l', tenantId: tenantA, currentStock: 0, category: 'beverage' } })).id
  itemB = (await prisma.inventoryItem.create({ data: { name: `B Tomato ${RUN}`, unit: 'kg', tenantId: tenantB, currentStock: 0 } })).id
  await ensureFifoReady(tenantA)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => { invalidateSetupCache(); await app.close() })

describe('a cash buy into stock', () => {
  it('lines born billed, lots at exactly the amount paid, no posting; the accounts the cash document debits', async () => {
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const r = await record('pc-1', [
      { spendLineId: 's1', inventoryItemId: tomato, qty: 2_500, unit: 'g', totalCents: 33_333 },   // 2.5 kg for PKR 333.33
      { spendLineId: 's2', inventoryItemId: milk, qty: 3, unit: 'l', totalCents: 90_000 },
    ])
    expect(r.lines).toEqual([
      { spendLineId: 's1', receiptLineId: expect.any(String), accountCode: '1210', valueCents: 33_333 },
      { spendLineId: 's2', receiptLineId: expect.any(String), accountCode: '1220', valueCents: 90_000 },
    ])
    expect(r.byClass).toEqual({ food: 33_333, beverage: 90_000, packaging: 0 })
    const receipt = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: r.goodsReceiptId }, include: { lines: true } })
    expect(receipt).toMatchObject({ tenantId: tenantA, settledByType: 'petty_cash_movement', settledById: 'pc-1', settledAccountCode: '1011' })
    expect(receipt.lines.every((l) => l.billedQty === l.receivedQty)).toBe(true)
    expect(receipt.lines.find((l) => l.inventoryItemId === tomato)!.receivedQty).toBe(2.5)
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: tomato } })
    expect(Number(lot.valueInCents)).toBe(33_333)
    expect(lot.qtyIn).toBe(2.5)
    // Posts nothing: the cash document's own entry carries Dr 12x0 / Cr 1011.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(entriesBefore)
    // The system supplier exists once and is never listed.
    const sys = await prisma.supplier.findMany({ where: { tenantId: tenantA, systemKind: 'cash_purchases' } })
    expect(sys).toHaveLength(1)
    expect(receipt.supplierId).toBe(sys[0]!.id)
    const listed = (await app.inject({ method: 'GET', url: '/procurement/suppliers', headers: { authorization: `Bearer ${token}` } })).json() as Array<{ id: string }>
    expect(listed.some((s) => s.id === sys[0]!.id)).toBe(false)
  })

  it('the same cash document twice is 409 ALREADY_RECEIVED; nothing more comes in', async () => {
    await expect(record('pc-1', [{ spendLineId: 's1', inventoryItemId: tomato, qty: 1, unit: 'kg', totalCents: 100 }]))
      .rejects.toMatchObject({ code: 'ALREADY_RECEIVED', statusCode: 409 })
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: tomato } })).currentStock).toBe(2.5)
    // A second document is fine, and reuses the system supplier.
    await record('pc-2', [{ spendLineId: 's9', inventoryItemId: tomato, qty: 1, unit: 'kg', totalCents: 15_000 }])
    expect(await prisma.supplier.count({ where: { tenantId: tenantA, systemKind: 'cash_purchases' } })).toBe(1)
  })

  it('another company\'s item is 404; a unit that does not convert is 422 UNIT_MISMATCH', async () => {
    await expect(record('pc-3', [{ spendLineId: 's1', inventoryItemId: itemB, qty: 1, unit: 'kg', totalCents: 100 }]))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(record('pc-4', [{ spendLineId: 's1', inventoryItemId: tomato, qty: 1, unit: 'pcs', totalCents: 100 }]))
      .rejects.toMatchObject({ code: 'UNIT_MISMATCH', statusCode: 422 })
    expect(await prisma.goodsReceipt.count({ where: { settledById: { in: ['pc-3', 'pc-4'] } } })).toBe(0)
  })
})
