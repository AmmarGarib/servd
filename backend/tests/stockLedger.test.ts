// lib/stockLedger.ts — THE stock writer on FIFO lots (finance wave B, H16).
//
// What this guards:
//   - FIFO: oldest lot first across lots; a draw that empties a lot takes its
//     exact remaining value, so values never drift; returns go back to the
//     very lots they came from; currentStock stays Σ lot remainingQty and the
//     item's cost is the FIFO head.
//   - Sales clamp (shortfall + memo value); everything else refuses
//     (NEGATIVE_STOCK). Company rules: CROSS_COMPANY_STOCK, ITEM_HAS_NO_COMPANY,
//     STOCK_NOT_ON_LOTS before the cut-over.
//   - Relabel to waste keeps stock; re-pricing splits on-hand / used; the head
//     cost moves without writing price history (only receipts do).
//   - A late receipt settles a 3-day-old sale shortfall (not an 8-day-old one,
//     nor a cancelled order's) and posts it; an issue-on-receipt item is
//     consumed and posted at once.
//   - Replays write nothing.
import { describe, it, expect, beforeAll } from 'vitest'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import {
  addLotTx, consumeFifoTx, returnToLotsTx, relabelToWasteTx, repriceLotTx, refreshItemCostTx, reclassItemLotsTx,
  latestPurchaseCostCents, lotValuation, ensureFifoReady, fifoCutoverKey, readFifoCutoverAt, lockItemsTx,
  SHORTFALL_SETTLE_DAYS, STOCK_SOURCE,
} from '../src/lib/stockLedger.js'

const DAY = 86_400_000
let A: string
let B: string
let conceptA1: string
let conceptA2: string
let seq = 0

const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn)

async function company(slug: string, cutOver = true): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name: `Stock ${slug}`, slug: `stock-ledger-${slug}` } })).id
  await ensureChartOfAccounts(id)
  if (cutOver) await prisma.setting.create({ data: { key: fifoCutoverKey(id), value: new Date(Date.now() - 60 * DAY).toISOString() } })
  return id
}

async function mkItem(tenantId: string | null, o: { category?: string; issueOnReceipt?: boolean; unitCostCents?: number; currentStock?: number } = {}) {
  return prisma.inventoryItem.create({
    data: {
      name: `Ingredient ${++seq}`, unit: 'kg', tenantId, category: o.category ?? 'protein',
      issueOnReceipt: o.issueOnReceipt ?? false, unitCostCents: o.unitCostCents ?? null, currentStock: o.currentStock ?? 0,
    },
  })
}

/** A plain lot (a count gain: no receipt side effects). */
function gain(tenantId: string, itemId: string, qty: number, unitCostCents: number, at: Date, valueCents?: number) {
  const src = `gain-${++seq}`
  return tx((t) => addLotTx(t, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, ...(valueCents !== undefined ? { valueCents } : {}),
    kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: at,
  }))
}

function receipt(tenantId: string, itemId: string, qty: number, unitCostCents: number, at = new Date()) {
  const src = `rcpt-${++seq}`
  return tx((t) => addLotTx(t, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents,
    kind: 'receipt', lotSourceType: 'goods_receipt_line', lotSourceId: src, movementSourceType: STOCK_SOURCE.receiptLine, movementSourceId: src, receivedAt: at,
  }))
}

function take(tenantId: string, itemId: string, qty: number, o: Partial<Parameters<typeof consumeFifoTx>[1]> = {}) {
  return tx((t) => consumeFifoTx(t, {
    tenantId, inventoryItemId: itemId, qty, kind: 'waste', sourceType: 'test', sourceId: `take-${++seq}`, clamp: false, occurredAt: new Date(), ...o,
  }))
}

const lotOf = (id: string) => prisma.stockLot.findUniqueOrThrow({ where: { id } })
const itemOf = (id: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id } })

async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return e?.lines.map((l) => ({ code: l.account.code, type: l.type, cents: Number(l.amountCents), conceptId: l.conceptId })) ?? null
}

beforeAll(async () => {
  A = await company('a')
  B = await company('b')
  conceptA1 = (await prisma.concept.create({ data: { name: 'Ledger Diner', slug: 'stock-ledger-a1', type: 'restaurant', tenantId: A } })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Ledger Cafe', slug: 'stock-ledger-a2', type: 'restaurant', tenantId: A } })).id
})

describe('FIFO draws', () => {
  it('takes the oldest lot first across three lots and keeps the cache', async () => {
    const it0 = await mkItem(A)
    const t0 = Date.now() - 10 * DAY
    await gain(A, it0.id, 10, 100, new Date(t0))
    await gain(A, it0.id, 10, 120, new Date(t0 + DAY))
    await gain(A, it0.id, 10, 150, new Date(t0 + 2 * DAY))
    expect((await itemOf(it0.id)).currentStock).toBe(30)
    expect((await itemOf(it0.id)).unitCostCents).toBe(100)

    const r = await take(A, it0.id, 25)
    expect(r.takenQty).toBe(25)
    expect(r.shortfallQty).toBe(0)
    expect(r.valueCents).toBe(1000 + 1200 + 750)
    expect(r.rows.map((x) => [x.qty, x.valueCents])).toEqual([[-10, -1000], [-10, -1200], [-5, -750]])
    const item = await itemOf(it0.id)
    expect(item.currentStock).toBe(5)
    expect(item.unitCostCents).toBe(150)          // the FIFO head moved to the last lot
  })

  it('the draw that empties a lot takes its exact remaining value', async () => {
    const it0 = await mkItem(A)
    const { lotId } = await gain(A, it0.id, 3, 333, new Date(Date.now() - DAY), 1000)
    const a = await take(A, it0.id, 1)
    const b = await take(A, it0.id, 1)
    const c = await take(A, it0.id, 1)
    expect(a.valueCents + b.valueCents + c.valueCents).toBe(1000)
    const lot = await lotOf(lotId)
    expect(lot.remainingQty).toBe(0)
    expect(Number(lot.remainingValueCents)).toBe(0)
    // The ledger of the lot sums to what is left: zero.
    const sum = await prisma.stockMovement.aggregate({ where: { lotId }, _sum: { valueCents: true } })
    expect(Number(sum._sum.valueCents)).toBe(0)
  })

  it('returns go back to the same lots, exactly, and a replay returns nothing more', async () => {
    const it0 = await mkItem(A)
    const l1 = await gain(A, it0.id, 10, 100, new Date(Date.now() - 3 * DAY))
    const l2 = await gain(A, it0.id, 10, 130, new Date(Date.now() - 2 * DAY))
    const sale = await take(A, it0.id, 15, { kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, conceptId: conceptA1, theoreticalQty: 15 })
    expect((await itemOf(it0.id)).currentStock).toBe(5)

    const back = () => tx((t) => returnToLotsTx(t, { rows: sale.rows, kind: 'sale_return', sourceType: 'test.void', sourceId: `ret-${seq}`, occurredAt: new Date(), tenantId: A }))
    const r1 = await back()
    expect(r1.valueCents).toBe(1000 + 650)
    expect((await lotOf(l1.lotId)).remainingQty).toBe(10)
    expect(Number((await lotOf(l1.lotId)).remainingValueCents)).toBe(1000)
    expect((await lotOf(l2.lotId)).remainingQty).toBe(10)
    expect(Number((await lotOf(l2.lotId)).remainingValueCents)).toBe(1300)
    expect((await itemOf(it0.id)).currentStock).toBe(20)
    const returns = await prisma.stockMovement.findMany({ where: { inventoryItemId: it0.id, kind: 'sale_return' } })
    expect(returns).toHaveLength(2)
    expect(returns.every((m) => m.conceptId === conceptA1)).toBe(true)   // the brand comes from the sale row

    await back()
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: it0.id, kind: 'sale_return' } })).toBe(2)
    expect((await itemOf(it0.id)).currentStock).toBe(20)
  })

  it('a sale clamps: takes what the lots hold and records the shortfall at the latest purchase price', async () => {
    const it0 = await mkItem(A)
    await prisma.itemPriceHistory.create({ data: { inventoryItemId: it0.id, newCostCents: 600, source: 'po_receive' } })
    await gain(A, it0.id, 2, 500, new Date(Date.now() - DAY))
    expect(await latestPurchaseCostCents(prisma, it0.id)).toBe(600)

    const r = await take(A, it0.id, 5, { kind: 'sale', clamp: true, sourceType: STOCK_SOURCE.orderItemSale, conceptId: conceptA1, theoreticalQty: 5 })
    expect(r.takenQty).toBe(2)
    expect(r.shortfallQty).toBe(3)
    expect(r.valueCents).toBe(1000)
    const short = await prisma.stockMovement.findFirstOrThrow({ where: { inventoryItemId: it0.id, kind: 'sale', lotId: null } })
    expect(short.shortfallQty).toBe(3)
    expect(Number(short.shortfallValueCents)).toBe(1800)
    expect(Number(short.valueCents)).toBe(0)
    // theoreticalQty is spread across the rows (the brand shares read it).
    const theo = await prisma.stockMovement.aggregate({ where: { inventoryItemId: it0.id, kind: 'sale' }, _sum: { theoreticalQty: true } })
    expect(theo._sum.theoreticalQty).toBeCloseTo(5, 9)
    expect((await itemOf(it0.id)).currentStock).toBe(0)
  })

  it('without clamp a shortfall is 422 NEGATIVE_STOCK and nothing moves', async () => {
    const it0 = await mkItem(A)
    const { lotId } = await gain(A, it0.id, 2, 500, new Date(Date.now() - DAY))
    await expect(take(A, it0.id, 5)).rejects.toMatchObject({ code: 'NEGATIVE_STOCK', statusCode: 422 })
    expect((await lotOf(lotId)).remainingQty).toBe(2)
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: it0.id, kind: 'waste' } })).toBe(0)
    // Only sales may clamp.
    await expect(take(A, it0.id, 5, { clamp: true })).rejects.toMatchObject({ code: 'CLAMP_SALES_ONLY' })
  })

  it('a supplier return draws the named lots first', async () => {
    const it0 = await mkItem(A)
    await gain(A, it0.id, 5, 100, new Date(Date.now() - 3 * DAY))
    const newer = await gain(A, it0.id, 5, 200, new Date(Date.now() - DAY))
    const r = await take(A, it0.id, 3, { kind: 'supplier_return', preferLotIds: [newer.lotId] })
    expect(r.rows.map((x) => x.lotId)).toEqual([newer.lotId])
    expect(r.valueCents).toBe(600)
  })
})

describe('company rules', () => {
  it('another company\'s item or lot: 500 CROSS_COMPANY_STOCK', async () => {
    const itA = await mkItem(A)
    const lotA = await gain(A, itA.id, 4, 100, new Date(Date.now() - DAY))
    await expect(take(B, itA.id, 1)).rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK', statusCode: 500 })
    // A B item cannot draw A's lot by naming it.
    const itB = await mkItem(B)
    await gain(B, itB.id, 4, 100, new Date(Date.now() - DAY))
    await expect(take(B, itB.id, 1, { kind: 'supplier_return', preferLotIds: [lotA.lotId] })).rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK' })
    // Nor return A's rows into B's books.
    const sale = await take(A, itA.id, 1, { kind: 'sale' })
    await expect(tx((t) => returnToLotsTx(t, { rows: sale.rows, kind: 'sale_return', sourceType: 'x', sourceId: 'y', occurredAt: new Date(), tenantId: B })))
      .rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK' })
    expect((await lotOf(lotA.lotId)).remainingQty).toBe(3)
  })

  it('an item with no company is refused on every write: 422 ITEM_HAS_NO_COMPANY', async () => {
    const orphan = await mkItem(null)
    await expect(gain(A, orphan.id, 1, 100, new Date())).rejects.toMatchObject({ code: 'ITEM_HAS_NO_COMPANY', statusCode: 422 })
    await expect(take(A, orphan.id, 1)).rejects.toMatchObject({ code: 'ITEM_HAS_NO_COMPANY', statusCode: 422 })
    expect(await prisma.stockLot.count({ where: { inventoryItemId: orphan.id } })).toBe(0)
  })

  it('stock not held as lots (no cut-over yet) is refused: 500 STOCK_NOT_ON_LOTS; an opening lot on a lot-less item is allowed', async () => {
    const legacy = await mkItem(A, { currentStock: 7, unitCostCents: 100 })
    await expect(take(A, legacy.id, 1)).rejects.toMatchObject({ code: 'STOCK_NOT_ON_LOTS', statusCode: 500 })
    await expect(gain(A, legacy.id, 1, 100, new Date())).rejects.toMatchObject({ code: 'STOCK_NOT_ON_LOTS' })
    expect((await itemOf(legacy.id)).currentStock).toBe(7)
    // H19 opening (e.g. assigning a company to an item that holds stock): the lot becomes the stock.
    await tx((t) => addLotTx(t, {
      tenantId: A, inventoryItemId: legacy.id, qty: 7, unitCostCents: 100, kind: 'opening', lotSourceType: 'opening',
      lotSourceId: `open-${legacy.id}`, movementSourceType: STOCK_SOURCE.countLine, movementSourceId: `open-${legacy.id}`, receivedAt: new Date(),
    }))
    expect((await itemOf(legacy.id)).currentStock).toBe(7)
    await take(A, legacy.id, 2)
    expect((await itemOf(legacy.id)).currentStock).toBe(5)
  })

  it('locks items in id order without error (one statement)', async () => {
    const a = await mkItem(A)
    const b = await mkItem(A)
    await tx((t) => lockItemsTx(t, [b.id, a.id, b.id]))
  })
})

describe('relabel, re-price, head cost', () => {
  it('relabelling a sold line to waste keeps stock and lots unchanged', async () => {
    const it0 = await mkItem(A)
    const { lotId } = await gain(A, it0.id, 10, 100, new Date(Date.now() - DAY))
    const order = await prisma.order.create({ data: { conceptId: conceptA1, source: 'pos', status: 'preparing', totalCents: 1000, items: { create: [{ name: 'Dish', quantity: 1, unitPriceCents: 1000 }] } }, include: { items: true } })
    const line = order.items[0]!
    const sale = await take(A, it0.id, 4, { kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: line.id, orderId: order.id, orderItemId: line.id, conceptId: conceptA1, theoreticalQty: 4 })
    const before = await lotOf(lotId)
    const log = await prisma.wasteLog.create({ data: { inventoryItemId: it0.id, quantity: 4, unit: 'kg', reason: 'void_after_fire', tenantId: A, conceptId: conceptA1, orderItemId: line.id, estimatedCostCents: 400 } })
    const relabel = () => tx((t) => relabelToWasteTx(t, { rows: sale.rows, wasteLogIdByItem: { [it0.id]: log.id }, conceptId: conceptA1, occurredAt: new Date(), tenantId: A }))
    const r = await relabel()
    expect(r.valueCents).toBe(400)
    const after = await lotOf(lotId)
    expect(after.remainingQty).toBe(before.remainingQty)
    expect(Number(after.remainingValueCents)).toBe(Number(before.remainingValueCents))
    expect((await itemOf(it0.id)).currentStock).toBe(6)
    const rows = await prisma.stockMovement.findMany({ where: { sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id }, orderBy: { kind: 'asc' } })
    expect(rows.map((m) => [m.kind, m.qty, Number(m.valueCents), m.orderId])).toEqual([['sale_void', 4, 400, order.id], ['waste', -4, -400, order.id]])
    await relabel()
    expect(await prisma.stockMovement.count({ where: { sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id } })).toBe(2)
  })

  it('re-pricing splits the difference between stock on hand and stock already used', async () => {
    const it0 = await mkItem(A)
    const { lotId } = await gain(A, it0.id, 10, 100, new Date(Date.now() - DAY))
    await take(A, it0.id, 4)
    const reprice = () => tx((t) => repriceLotTx(t, { lotId, deltaCents: 200, qtyBasis: 10, sourceType: 'grni_match', sourceId: `m-${lotId}` }))
    expect(await reprice()).toEqual({ onHandCents: 120, usedCents: 80 })
    const lot = await lotOf(lotId)
    expect(Number(lot.remainingValueCents)).toBe(720)
    expect(Number(lot.valueInCents)).toBe(1200)
    expect(lot.unitCostCents).toBe(120)
    expect((await itemOf(it0.id)).unitCostCents).toBe(120)
    // Replay: same split, nothing written.
    expect(await reprice()).toEqual({ onHandCents: 120, usedCents: 80 })
    expect(await prisma.stockMovement.count({ where: { lotId, kind: 'cost_adjust' } })).toBe(1)
    // The lot ledger still sums to the lot.
    const sum = await prisma.stockMovement.aggregate({ where: { lotId }, _sum: { valueCents: true } })
    expect(Number(sum._sum.valueCents)).toBe(720)
  })

  it('the head cost moves with FIFO and writes NO price history; a receipt writes a purchase price once per change', async () => {
    const it0 = await mkItem(A, { unitCostCents: 50 })
    await gain(A, it0.id, 5, 100, new Date(Date.now() - 2 * DAY))
    await gain(A, it0.id, 5, 200, new Date(Date.now() - DAY))
    expect((await itemOf(it0.id)).unitCostCents).toBe(100)
    await take(A, it0.id, 5)
    expect((await itemOf(it0.id)).unitCostCents).toBe(200)
    await tx((t) => refreshItemCostTx(t, it0.id))
    expect((await itemOf(it0.id)).unitCostCents).toBe(200)
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: it0.id } })).toBe(0)

    await receipt(A, it0.id, 1, 250)
    await receipt(A, it0.id, 1, 250)
    const hist = await prisma.itemPriceHistory.findMany({ where: { inventoryItemId: it0.id } })
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ source: 'dock_receive', newCostCents: 250 })
    expect(await latestPurchaseCostCents(prisma, it0.id)).toBe(250)
  })

  it('a class change moves the lots and their value to the new class', async () => {
    const it0 = await mkItem(A, { category: 'protein' })
    await gain(A, it0.id, 4, 250, new Date(Date.now() - DAY))
    const before = await lotValuation(prisma, A)
    const r = await tx((t) => reclassItemLotsTx(t, { tenantId: A, itemId: it0.id, toClass: 'beverage', sourceType: 'test.reclass', sourceId: it0.id }))
    expect(r.byFromClass.food).toBe(1000)
    expect(r.valueCents).toBe(1000)
    const after = await lotValuation(prisma, A)
    expect(after.food).toBe(before.food - 1000)
    expect(after.beverage).toBe(before.beverage + 1000)
    expect(await lotValuation(prisma, A, new Date(Date.now() + DAY))).toEqual(after)   // the lot ledger replays to the lots
  })
})

describe('late receipts and issue on receipt', () => {
  it('a receipt lot settles a 3-day-old sale shortfall, not an 8-day-old one nor a cancelled order\'s, and posts it', async () => {
    const it0 = await mkItem(A)
    const cancelled = await prisma.order.create({ data: { conceptId: conceptA2, source: 'pos', status: 'cancelled', totalCents: 0 } })
    const old = await take(A, it0.id, 2, { kind: 'sale', clamp: true, conceptId: conceptA1, theoreticalQty: 2, occurredAt: new Date(Date.now() - 8 * DAY) })
    const dead = await take(A, it0.id, 1, { kind: 'sale', clamp: true, conceptId: conceptA2, orderId: cancelled.id, theoreticalQty: 1, occurredAt: new Date(Date.now() - 2 * DAY) })
    const recent = await take(A, it0.id, 3, { kind: 'sale', clamp: true, conceptId: conceptA1, theoreticalQty: 3, occurredAt: new Date(Date.now() - 3 * DAY) })
    expect([old.shortfallQty, dead.shortfallQty, recent.shortfallQty]).toEqual([2, 1, 3])
    expect(SHORTFALL_SETTLE_DAYS).toBe(7)

    const r = await receipt(A, it0.id, 10, 100)
    expect(r.settled).toEqual({ valueCents: 300 })
    const settles = await prisma.stockMovement.findMany({ where: { inventoryItemId: it0.id, kind: 'shortfall_settle' } })
    expect(settles).toHaveLength(1)
    expect(settles[0]).toMatchObject({ qty: -3, settlesMovementId: recent.rows[0]!.id, conceptId: conceptA1, lotId: r.lotId })
    expect(Number(settles[0]!.valueCents)).toBe(-300)
    expect((await lotOf(r.lotId)).remainingQty).toBe(7)
    expect((await itemOf(it0.id)).currentStock).toBe(7)
    expect(await entryLines(A, `inventory.shortfall_settle:${r.lotId}`)).toEqual(expect.arrayContaining([
      { code: '5010', type: 'debit', cents: 300, conceptId: conceptA1 },
      { code: '1210', type: 'credit', cents: 300, conceptId: conceptA1 },
    ]))
    // A second receipt finds nothing more to settle inside the window.
    const r2 = await receipt(A, it0.id, 1, 100)
    expect(r2.settled).toBeUndefined()
  })

  it('an issue-on-receipt item is consumed at once, split by usage, and posted', async () => {
    const oil = await mkItem(A, { issueOnReceipt: true, category: 'dry_goods' })
    // Recipe use in the last 30 days: brand 1 used three times what brand 2 used.
    for (const [conceptId, q] of [[conceptA1, 3], [conceptA2, 1]] as const) {
      await prisma.stockMovement.create({
        data: { tenantId: A, inventoryItemId: oil.id, kind: 'sale', qty: 0, valueCents: 0, unitCostCents: 0, costClass: 'food', theoreticalQty: q, conceptId, sourceType: 'test', sourceId: `use-${++seq}`, occurredAt: new Date(Date.now() - DAY) },
      })
    }
    const r = await receipt(A, oil.id, 5, 200)
    expect(r.issued).toEqual({ valueCents: 1000 })
    expect((await lotOf(r.lotId)).remainingQty).toBe(0)
    expect((await itemOf(oil.id)).currentStock).toBe(0)
    const issue = await prisma.stockMovement.findFirstOrThrow({ where: { lotId: r.lotId, kind: 'issue_on_receipt' } })
    expect(issue.qty).toBe(-5)
    const shares = issue.brandShares as Array<{ conceptId: string; share: number }>
    expect(Object.fromEntries(shares.map((s) => [s.conceptId, s.share]))).toEqual({ [conceptA1]: 0.75, [conceptA2]: 0.25 })
    const lines = (await entryLines(A, `inventory.issue_on_receipt:${r.lotId}`))!
    expect(lines.filter((l) => l.code === '5010').map((l) => [l.conceptId, l.cents]).sort()).toEqual([[conceptA1, 750], [conceptA2, 250]].sort())
    expect(lines.filter((l) => l.code === '1210').reduce((s, l) => s + l.cents, 0)).toBe(1000)
  })
})

describe('replays and the cut-over seam', () => {
  it('a replayed draw or lot writes nothing', async () => {
    const it0 = await mkItem(A)
    const src = `lot-replay-${++seq}`
    const add = () => tx((t) => addLotTx(t, {
      tenantId: A, inventoryItemId: it0.id, qty: 6, unitCostCents: 100, kind: 'count_gain', lotSourceType: 'count_gain',
      lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - DAY),
    }))
    const first = await add()
    const second = await add()
    expect(second).toEqual({ lotId: first.lotId, movementId: first.movementId })
    expect((await itemOf(it0.id)).currentStock).toBe(6)

    const draw = () => tx((t) => consumeFifoTx(t, { tenantId: A, inventoryItemId: it0.id, qty: 2, kind: 'waste', sourceType: 'test', sourceId: `draw-${src}`, clamp: false, occurredAt: new Date() }))
    const d1 = await draw()
    const d2 = await draw()
    expect(d2).toEqual(d1)
    expect((await itemOf(it0.id)).currentStock).toBe(4)
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: it0.id } })).toBe(2)
  })

  it('valuation now equals the lot ledger replayed', async () => {
    const now = await lotValuation(prisma, A)
    const replay = await lotValuation(prisma, A, new Date(Date.now() + DAY))
    expect(replay).toEqual(now)
    const lots = await prisma.stockLot.findMany({ where: { tenantId: A }, select: { id: true, remainingValueCents: true } })
    for (const l of lots) {
      const s = await prisma.stockMovement.aggregate({ where: { lotId: l.id }, _sum: { valueCents: true } })
      expect(Number(s._sum.valueCents)).toBe(Number(l.remainingValueCents))
    }
  })

  it('ensureFifoReady is a no-op once the company is cut over', async () => {
    const at = await readFifoCutoverAt(prisma, A)
    expect(at).toBeInstanceOf(Date)
    await ensureFifoReady(A)
    expect((await readFifoCutoverAt(prisma, A))?.getTime()).toBe(at!.getTime())
  })

  it('ensureFifoReady on a company not cut over runs the cut-over when it is installed, and never throws for its absence', async () => {
    const fresh = await company('fresh', false)
    expect(await readFifoCutoverAt(prisma, fresh)).toBeNull()
    await expect(ensureFifoReady(fresh)).resolves.toBeUndefined()
  })
})
