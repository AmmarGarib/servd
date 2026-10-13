// accounting/inventoryPosting.ts — every food-cost posting that is not a bill
// or a sale (finance wave B, H16-H20).
//
// What this guards:
//   - Each posting is balanced, idempotent on its key, in the SOURCE row's
//     company, and uses the class accounts: drinks hit 1220 / 5020, packaging
//     1230 / 5030.
//   - A brand-less waste is split across the brands that used the item, and
//     the split sums exactly and is stored on the movements.
//   - A cash-settled receipt posts nothing; an opening count posts to 3020,
//     never 5050; the FIFO alignment posts to 3020, once, after a dry run.
//   - A refused waste/count/prep posting in its document's transaction leaves
//     the document standing and hands back the flag to raise.
//   - Two companies: A's receipt / waste / count never post in B's chart, and a
//     B transaction cannot consume A's lot.
import { describe, it, expect, beforeAll } from 'vitest'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { flagPostingFailed, postJournalEntry } from '../src/modules/accounting/journal.js'
import { addLotTx, consumeFifoTx, reclassItemLotsTx, returnToLotsTx, fifoCutoverKey, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import {
  postGoodsReceiptTx, postWasteLog, postStockCount, stockCountAdjustment, postPrepDraw, postGrniWriteOffTx, postItemReclassTx,
  postClassReclassTx, postGrniOpeningTx, postFifoAlign, postInventoryDocInSavepoint,
} from '../src/modules/accounting/inventoryPosting.js'

const DAY = 86_400_000
let A: string
let B: string
let A1: string
let A2: string
let supA: string
let supB: string
let seq = 0
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn)

async function company(slug: string, o: { chart?: boolean; cutOver?: boolean } = {}): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name: `Postings ${slug}`, slug: `inv-postings-${slug}` } })).id
  if (o.chart !== false) await ensureChartOfAccounts(id)
  if (o.cutOver !== false) await prisma.setting.create({ data: { key: fifoCutoverKey(id), value: new Date(Date.now() - 60 * DAY).toISOString() } })
  return id
}

const mkItem = (tenantId: string, category = 'protein') =>
  prisma.inventoryItem.create({ data: { name: `Posting item ${++seq}`, unit: 'kg', tenantId, category } })

function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number, o: { valueCents?: number; kind?: 'count_gain' | 'fifo_cutover' } = {}) {
  const src = `lot-${++seq}`
  const kind = o.kind ?? 'count_gain'
  return tx((t) => addLotTx(t, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, ...(o.valueCents !== undefined ? { valueCents: o.valueCents } : {}),
    kind, lotSourceType: kind, lotSourceId: kind === 'fifo_cutover' ? `${tenantId}:${src}` : src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 2 * DAY),
  }))
}

/** Recipe use of an item by a brand (what the brand shares read). */
const use = (tenantId: string, itemId: string, conceptId: string, theoreticalQty: number) =>
  prisma.stockMovement.create({
    data: { tenantId, inventoryItemId: itemId, kind: 'sale', qty: 0, valueCents: 0, unitCostCents: 0, costClass: 'food', theoreticalQty, conceptId, sourceType: 'test', sourceId: `use-${++seq}`, occurredAt: new Date(Date.now() - DAY) },
  })

async function receive(tenantId: string, supplierId: string, lines: Array<{ itemId: string; qty: number; unitCostCents: number }>, settled = false) {
  return tx(async (t) => {
    const r = await t.goodsReceipt.create({
      data: {
        supplierId, receivedById: 'tester', tenantId,
        ...(settled ? { settledByType: 'petty_cash_movement', settledById: `pc-${++seq}`, settledAccountCode: '1011' } : {}),
        lines: { create: lines.map((l) => ({ inventoryItemId: l.itemId, description: `Line ${++seq}`, receivedQty: l.qty, poUnitCostCents: l.unitCostCents, lotUnitCostCents: l.unitCostCents, unit: 'kg' })) },
      },
      include: { lines: true },
    })
    for (const line of r.lines) {
      await addLotTx(t, {
        tenantId, inventoryItemId: line.inventoryItemId!, qty: line.receivedQty, unitCostCents: line.poUnitCostCents!, kind: 'receipt',
        lotSourceType: 'goods_receipt_line', lotSourceId: `${line.id}:dock`, movementSourceType: STOCK_SOURCE.receiptLine, movementSourceId: line.id,
        receiptLineId: line.id, receivedAt: r.receivedAt,
      })
    }
    return { receipt: r, posted: await postGoodsReceiptTx(t, r.id) }
  })
}

async function lines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  if (!e) return null
  return e.lines
    .map((l) => ({ code: l.account.code, type: l.type as string, cents: Number(l.amountCents), conceptId: l.conceptId }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.type.localeCompare(b.type) || String(a.conceptId).localeCompare(String(b.conceptId)) || a.cents - b.cents)
}
const total = (ls: Array<{ type: string; cents: number }>, type: string, code?: string) =>
  ls.filter((l) => l.type === type && (!code || (l as { code?: string }).code === code)).reduce((s, l) => s + l.cents, 0)
const entries = (reference: string) => prisma.journalEntry.findMany({ where: { reference }, select: { tenantId: true } })

beforeAll(async () => {
  A = await company('a')
  B = await company('b')
  A1 = (await prisma.concept.create({ data: { name: 'Postings One', slug: 'inv-postings-a1', type: 'restaurant', tenantId: A } })).id
  A2 = (await prisma.concept.create({ data: { name: 'Postings Two', slug: 'inv-postings-a2', type: 'restaurant', tenantId: A } })).id
  supA = (await prisma.supplier.create({ data: { name: 'Meat Co', tenantId: A } })).id
  supB = (await prisma.supplier.create({ data: { name: 'Bee Supplies', tenantId: B } })).id
})

describe('1. goods receipt', () => {
  it('Dr 1210 / 1220 / 1230 per class / Cr 2015, in the supplier\'s company, once', async () => {
    const food = await mkItem(A, 'protein')
    const drink = await mkItem(A, 'beverage')
    const box = await mkItem(A, 'packaging')
    const { receipt, posted } = await receive(A, supA, [
      { itemId: food.id, qty: 10, unitCostCents: 100 }, { itemId: drink.id, qty: 5, unitCostCents: 200 }, { itemId: box.id, qty: 20, unitCostCents: 10 },
    ])
    expect(posted.posted).toBe(true)
    const ls = (await lines(A, `procurement.receipt:${receipt.id}`))!
    expect(ls.map((l) => [l.code, l.type, l.cents]).sort()).toEqual([
      ['1210', 'debit', 1000], ['1220', 'debit', 1000], ['1230', 'debit', 200], ['2015', 'credit', 2200],
    ].sort())
    expect(ls.every((l) => l.conceptId === null)).toBe(true)
    const again = await tx((t) => postGoodsReceiptTx(t, receipt.id))
    expect(again).toEqual({ posted: false, entryId: posted.entryId })
    expect(await entries(`procurement.receipt:${receipt.id}`)).toEqual([{ tenantId: A }])
  })

  it('a cash-settled receipt brings the stock in and posts nothing', async () => {
    const food = await mkItem(A)
    const { receipt, posted } = await receive(A, supA, [{ itemId: food.id, qty: 3, unitCostCents: 500 }], true)
    expect(posted).toEqual({ posted: false, reason: 'settled_by_cash' })
    expect(await entries(`procurement.receipt:${receipt.id}`)).toEqual([])
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: food.id } })).currentStock).toBe(3)
  })
})

describe('2. waste', () => {
  async function waste(tenantId: string, itemId: string, qty: number, o: { conceptId?: string; reason?: string } = {}) {
    return tx(async (t) => {
      const log = await t.wasteLog.create({ data: { inventoryItemId: itemId, quantity: qty, unit: 'kg', reason: o.reason ?? 'spoilage', tenantId, conceptId: o.conceptId ?? null } })
      const r = await consumeFifoTx(t, { tenantId, inventoryItemId: itemId, qty, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, clamp: false, conceptId: o.conceptId ?? null, occurredAt: log.recordedAt })
      await t.wasteLog.update({ where: { id: log.id }, data: { estimatedCostCents: r.valueCents } })
      return log
    })
  }

  it('a brand-less waste is split by the brands\' use of the item and sums exactly; the split is stored', async () => {
    const item = await mkItem(A)
    await lot(A, item.id, 1, 1001, { valueCents: 1001 })
    await use(A, item.id, A1, 2)
    await use(A, item.id, A2, 1)
    const log = await waste(A, item.id, 1)
    const r = await postWasteLog(log.id)
    expect(r.posted).toBe(true)
    const ls = (await lines(A, `inventory.waste:${log.id}`))!
    const dr = Object.fromEntries(ls.filter((l) => l.code === '5040').map((l) => [l.conceptId, l.cents]))
    const cr = Object.fromEntries(ls.filter((l) => l.code === '1210').map((l) => [l.conceptId, l.cents]))
    expect(dr).toEqual({ [A1]: 667, [A2]: 334 })
    expect(cr).toEqual(dr)
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, kind: 'waste' } })
    expect((mv.brandShares as Array<{ conceptId: string }>).map((s) => s.conceptId).sort()).toEqual([A1, A2].sort())
    expect(await postWasteLog(log.id)).toMatchObject({ posted: false, entryId: r.entryId })
  })

  it('drinks waste credits 1220, packaging 1230; a brand on the log is charged alone', async () => {
    const drink = await mkItem(A, 'beverage')
    const box = await mkItem(A, 'packaging')
    await lot(A, drink.id, 4, 250)
    await lot(A, box.id, 4, 50)
    const w1 = await waste(A, drink.id, 2, { conceptId: A1 })
    const w2 = await waste(A, box.id, 1)
    await postWasteLog(w1.id)
    await postWasteLog(w2.id)
    expect(await lines(A, `inventory.waste:${w1.id}`)).toEqual(expect.arrayContaining([
      { code: '5040', type: 'debit', cents: 500, conceptId: A1 }, { code: '1220', type: 'credit', cents: 500, conceptId: A1 },
    ]))
    expect((await lines(A, `inventory.waste:${w2.id}`))!.map((l) => [l.code, l.type, l.cents])).toEqual([['1230', 'credit', 50], ['5040', 'debit', 50]])
  })

  it('nothing to post: sold-line waste, no cost, no log', async () => {
    const item = await mkItem(A)
    const sold = await prisma.wasteLog.create({ data: { inventoryItemId: item.id, quantity: 1, unit: 'kg', reason: 'cancelled_after_fire', tenantId: A, estimatedCostCents: 100 } })
    const free = await prisma.wasteLog.create({ data: { inventoryItemId: item.id, quantity: 1, unit: 'kg', reason: 'spoilage', tenantId: A, estimatedCostCents: 0 } })
    expect(await postWasteLog(sold.id)).toMatchObject({ posted: false, reason: 'booked_by_void' })
    expect(await postWasteLog(free.id)).toMatchObject({ posted: false, reason: 'zero_cost' })
    expect(await postWasteLog('no-such-log')).toMatchObject({ posted: false, reason: 'waste_log_not_found' })
  })
})

describe('3. stock counts', () => {
  it('spot: short Dr 5050 / Cr 12x0 at the FIFO value, over Dr 12x0 / Cr 5050 at the new lot; once', async () => {
    const meat = await mkItem(A, 'protein')
    const juice = await mkItem(A, 'beverage')
    await lot(A, meat.id, 10, 100)
    const count = await prisma.physicalCount.create({
      data: { tenantId: A, countedById: 'counter', kind: 'spot', lines: { create: [
        { inventoryItemId: meat.id, systemQty: 10, physicalQty: 7 }, { inventoryItemId: juice.id, systemQty: 0, physicalQty: 2 },
      ] } },
      include: { lines: true },
    })
    const [short, over] = count.lines
    await tx(async (t) => {
      const loss = await consumeFifoTx(t, { tenantId: A, inventoryItemId: meat.id, qty: 3, kind: 'count_loss', sourceType: STOCK_SOURCE.countLine, sourceId: short!.id, clamp: false, occurredAt: count.countedAt })
      await t.physicalCountLine.update({ where: { id: short!.id }, data: { valueCents: -loss.valueCents } })
      await addLotTx(t, {
        tenantId: A, inventoryItemId: juice.id, qty: 2, unitCostCents: 150, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: over!.id,
        movementSourceType: STOCK_SOURCE.countLine, movementSourceId: over!.id, receivedAt: count.countedAt,
      })
      await t.physicalCountLine.update({ where: { id: over!.id }, data: { valueCents: 300 } })
    })
    const adj = await stockCountAdjustment(count.id)
    expect(adj).toMatchObject({ ok: true, shortCents: 300, overCents: 300 })
    const r = await postStockCount(count.id)
    expect(r).toMatchObject({ posted: true, amountCents: 0 })
    const ls = (await lines(A, `inventory.count:${count.id}`))!
    expect(ls.map((l) => [l.code, l.type, l.cents]).sort()).toEqual([
      ['1210', 'credit', 300], ['5050', 'debit', 300], ['1220', 'debit', 300], ['5050', 'credit', 300],
    ].sort())
    expect(await postStockCount(count.id)).toMatchObject({ posted: false, entryId: r.entryId })
  })

  it('opening (H19): Dr 12x0 / Cr 3020 at the entered cost — never 5050', async () => {
    const cups = await mkItem(A, 'packaging')
    const count = await prisma.physicalCount.create({
      data: { tenantId: A, countedById: 'finance', kind: 'opening', lines: { create: [{ inventoryItemId: cups.id, systemQty: 0, physicalQty: 50, unitCostCents: 20 }] } },
      include: { lines: true },
    })
    const line = count.lines[0]!
    await tx(async (t) => {
      await addLotTx(t, {
        tenantId: A, inventoryItemId: cups.id, qty: 50, unitCostCents: 20, kind: 'opening', lotSourceType: 'opening', lotSourceId: line.id,
        movementSourceType: STOCK_SOURCE.countLine, movementSourceId: line.id, receivedAt: count.countedAt,
      })
      await t.physicalCountLine.update({ where: { id: line.id }, data: { valueCents: 1000 } })
    })
    await postStockCount(count.id)
    const ls = (await lines(A, `inventory.count:${count.id}`))!
    expect(ls.map((l) => [l.code, l.type, l.cents])).toEqual([['1230', 'debit', 1000], ['3020', 'credit', 1000]])
    expect(ls.some((l) => l.code === '5050')).toBe(false)
  })
})

describe('4. ad-hoc prep draw', () => {
  it('Dr 50x0 / Cr 12x0 per class at the value drawn; a recipe batch posts nothing', async () => {
    const herb = await mkItem(A, 'produce')
    const syrup = await mkItem(A, 'beverage')
    await lot(A, herb.id, 5, 300)
    await lot(A, syrup.id, 5, 100)
    const batch = await prisma.prepBatch.create({ data: { tenantId: A, itemName: 'Green sauce', inputs: [], actualYieldQty: 1, staffId: 'chef' } })
    await tx(async (t) => {
      let v = 0
      for (const [itemId, qty] of [[herb.id, 2], [syrup.id, 1]] as const) {
        v += (await consumeFifoTx(t, { tenantId: A, inventoryItemId: itemId, qty, kind: 'prep_draw', sourceType: STOCK_SOURCE.prepBatch, sourceId: batch.id, clamp: false, occurredAt: batch.createdAt })).valueCents
      }
      await t.prepBatch.update({ where: { id: batch.id }, data: { drawValueCents: v } })
    })
    const r = await postPrepDraw(batch.id)
    expect(r).toMatchObject({ posted: true, amountCents: 700 })
    expect((await lines(A, `inventory.prep_draw:${batch.id}`))!.map((l) => [l.code, l.type, l.cents]).sort()).toEqual([
      ['5010', 'debit', 600], ['1210', 'credit', 600], ['5020', 'debit', 100], ['1220', 'credit', 100],
    ].sort())
    expect(await postPrepDraw(batch.id)).toMatchObject({ posted: false, entryId: r.entryId })
    const recipeBatch = await prisma.prepBatch.create({ data: { tenantId: A, recipeId: 'some-recipe', itemName: 'Stock', inputs: [], actualYieldQty: 1, staffId: 'chef', drawValueCents: 500 } })
    expect(await postPrepDraw(recipeBatch.id)).toMatchObject({ posted: false, reason: 'not_ad_hoc' })
  })
})

describe('5-8. GRNI write-off, class changes, the cut-over postings', () => {
  it('GRNI write-off: Dr 2015 / Cr 5060 for the open unbilled value; nothing open → 409', async () => {
    const item = await mkItem(A)
    const { receipt } = await receive(A, supA, [{ itemId: item.id, qty: 4, unitCostCents: 250 }])
    const lineId = receipt.lines[0]!.id
    const w = await tx((t) => postGrniWriteOffTx(t, lineId, { id: 'ceo' }))
    expect(w.valueCents).toBe(1000)
    expect((await lines(A, `procurement.grni_writeoff:${lineId}`))!.map((l) => [l.code, l.type, l.cents])).toEqual([['2015', 'debit', 1000], ['5060', 'credit', 1000]])

    // A pre-FIFO line (no lots): open = (received − billed) × cost.
    const legacy = await prisma.goodsReceipt.create({
      data: { supplierId: supA, receivedById: 'tester', tenantId: A, lines: { create: [
        { inventoryItemId: item.id, description: 'Old', receivedQty: 10, billedQty: 4, poUnitCostCents: 50, unit: 'kg' },
        { inventoryItemId: item.id, description: 'Old billed', receivedQty: 10, billedQty: 10, poUnitCostCents: 50, unit: 'kg' },
      ] } },
      include: { lines: true },
    })
    const open = legacy.lines.find((l) => l.description === 'Old')!
    const done = legacy.lines.find((l) => l.description === 'Old billed')!
    expect((await tx((t) => postGrniWriteOffTx(t, open.id, { id: 'ceo' }))).valueCents).toBe(300)
    await expect(tx((t) => postGrniWriteOffTx(t, done.id, { id: 'ceo' }))).rejects.toMatchObject({ code: 'NOTHING_OPEN', statusCode: 409 })
  })

  it('item class change: Dr new / Cr old class inventory, keyed by the audit row', async () => {
    const item = await mkItem(A, 'protein')
    await lot(A, item.id, 3, 400)
    await tx(async (t) => {
      const r = await reclassItemLotsTx(t, { tenantId: A, itemId: item.id, toClass: 'beverage', sourceType: 'inventory.item_reclass', sourceId: 'audit-1' })
      await postItemReclassTx(t, { itemId: item.id, auditLogId: 'audit-1', fromClass: 'food', toClass: 'beverage', valueCents: r.byFromClass.food })
    })
    expect(await lines(A, `inventory.item_reclass:${item.id}:audit-1`)).toEqual([
      { code: '1210', type: 'credit', cents: 1200, conceptId: null }, { code: '1220', type: 'debit', cents: 1200, conceptId: null },
    ])
    await tx((t) => postItemReclassTx(t, { itemId: item.id, auditLogId: 'audit-1', fromClass: 'food', toClass: 'beverage', valueCents: 1200 }))
    expect(await entries(`inventory.item_reclass:${item.id}:audit-1`)).toHaveLength(1)
  })

  it('cut-over class reclass and GRNI opening post once each, balanced', async () => {
    const T = await company('cutover')
    await tx((t) => postClassReclassTx(t, T, { food: 9_999, beverage: 500, packaging: 300 }))
    await tx((t) => postClassReclassTx(t, T, { food: 0, beverage: 500, packaging: 300 }))
    expect((await lines(T, `inventory.class_reclass:${T}`))!.map((l) => [l.code, l.type, l.cents])).toEqual([
      ['1210', 'credit', 800], ['1220', 'debit', 500], ['1230', 'debit', 300],
    ])
    await tx((t) => postGrniOpeningTx(t, T, { received: { food: 1000, beverage: 0, packaging: 200 }, billedAhead: { food: 300, beverage: 0, packaging: 0 } }))
    await tx((t) => postGrniOpeningTx(t, T, { received: { food: 1000, beverage: 0, packaging: 200 }, billedAhead: { food: 300, beverage: 0, packaging: 0 } }))
    const g = (await lines(T, `procurement.grni_opening:${T}`))!
    expect(total(g, 'debit')).toBe(1500)
    expect(total(g, 'credit')).toBe(1500)
    expect(g.filter((l) => l.code === '2015').map((l) => [l.type, l.cents]).sort()).toEqual([['credit', 1000], ['credit', 200], ['debit', 300]].sort())
    expect(await entries(`procurement.grni_opening:${T}`)).toHaveLength(1)
  })
})

describe('9. FIFO alignment', () => {
  it('dry run first, then Dr/Cr 12x0 against 3020 (never 5050), once; open orders are reconciling items', async () => {
    const T = await company('align')
    const concept = (await prisma.concept.create({ data: { name: 'Align Diner', slug: 'inv-postings-align', type: 'restaurant', tenantId: T } })).id
    const meat = await mkItem(T, 'protein')
    const soda = await mkItem(T, 'beverage')
    await lot(T, meat.id, 50, 100, { kind: 'fifo_cutover' })    // 5000 food
    await lot(T, soda.id, 10, 100, { kind: 'fifo_cutover' })    // 1000 drinks
    await postJournalEntry({
      tenantId: T, sourceType: 'test.opening', sourceId: T, description: 'Books before FIFO',
      lines: [{ accountCode: '1210', type: 'debit', amountCents: 4000 }, { accountCode: '3010', type: 'credit', amountCents: 4000 }],
    })
    // An order still being cooked took 300 of food out of the lots; its cost is booked at completion.
    const order = await prisma.order.create({ data: { conceptId: concept, source: 'servd', status: 'preparing', totalCents: 1000, items: { create: [{ name: 'Dish', quantity: 1, unitPriceCents: 1000 }] } }, include: { items: true } })
    await tx((t) => consumeFifoTx(t, { tenantId: T, inventoryItemId: meat.id, qty: 3, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: order.items[0]!.id, orderId: order.id, conceptId: concept, clamp: true, occurredAt: new Date() }))

    const dry = await postFifoAlign(T, { dryRun: true, actor: { id: 'ceo' } })
    expect(dry).toEqual({ byClass: { food: 1000, beverage: 1000, packaging: 0 }, posted: false })
    expect(await entries(`inventory.fifo_align:${T}`)).toEqual([])

    const real = await postFifoAlign(T, { dryRun: false, actor: { id: 'ceo' } })
    expect(real).toEqual({ byClass: { food: 1000, beverage: 1000, packaging: 0 }, posted: true })
    const ls = (await lines(T, `inventory.fifo_align:${T}`))!
    expect(ls.map((l) => [l.code, l.type, l.cents]).sort()).toEqual([
      ['1210', 'debit', 1000], ['3020', 'credit', 1000], ['1220', 'debit', 1000], ['3020', 'credit', 1000],
    ].sort())
    expect(ls.some((l) => l.code === '5050')).toBe(false)
    await expect(postFifoAlign(T, { dryRun: false, actor: { id: 'ceo' } })).rejects.toMatchObject({ code: 'ALREADY_ALIGNED', statusCode: 409 })
    await expect(postFifoAlign(T, { dryRun: true, actor: { id: 'ceo' } })).rejects.toMatchObject({ code: 'ALREADY_ALIGNED' })

    const notCut = await company('align-no-cutover', { cutOver: false })
    await expect(postFifoAlign(notCut, { dryRun: true, actor: { id: 'ceo' } })).rejects.toMatchObject({ code: 'CUTOVER_NOT_RUN', statusCode: 409 })
  })
})

describe('in the document\'s transaction', () => {
  it('a refused posting leaves the document standing and hands back the flag to raise', async () => {
    const D = await company('no-chart', { chart: false })
    const item = await mkItem(D)
    await lot(D, item.id, 2, 100)
    const { logId, out } = await tx(async (t) => {
      const log = await t.wasteLog.create({ data: { inventoryItemId: item.id, quantity: 1, unit: 'kg', reason: 'spoilage', tenantId: D } })
      const r = await consumeFifoTx(t, { tenantId: D, inventoryItemId: item.id, qty: 1, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, clamp: false, occurredAt: new Date() })
      await t.wasteLog.update({ where: { id: log.id }, data: { estimatedCostCents: r.valueCents } })
      return { logId: log.id, out: await postInventoryDocInSavepoint(t, 'inventory.waste', log.id, { tenantId: D, amountCents: r.valueCents }) }
    })
    expect(out.ledger.posted).toBe(false)
    expect(out.ledger.error).toMatch(/missing code/)
    expect(out.failure).toMatchObject({ tenantId: D, sourceType: 'inventory.waste', sourceId: logId, entityType: 'WasteLog', entityId: logId })
    expect(await prisma.wasteLog.findUnique({ where: { id: logId } })).not.toBeNull()
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock).toBe(1)
    await flagPostingFailed(out.failure!)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', tenantId: D, entityId: logId } })).toBe(1)

    // The same path in a company with a chart posts.
    const ok = await mkItem(A)
    await lot(A, ok.id, 2, 100)
    const res = await tx(async (t) => {
      const log = await t.wasteLog.create({ data: { inventoryItemId: ok.id, quantity: 1, unit: 'kg', reason: 'expired', tenantId: A } })
      const r = await consumeFifoTx(t, { tenantId: A, inventoryItemId: ok.id, qty: 1, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, clamp: false, occurredAt: new Date() })
      await t.wasteLog.update({ where: { id: log.id }, data: { estimatedCostCents: r.valueCents } })
      return postInventoryDocInSavepoint(t, 'inventory.waste', log.id, { tenantId: A })
    })
    expect(res.failure).toBeNull()
    expect(res.ledger.posted).toBe(true)
  })
})

describe('two companies', () => {
  it('A\'s receipt / waste / count post only in A; a B transaction cannot consume A\'s lot', async () => {
    const item = await mkItem(A)
    const { receipt } = await receive(A, supA, [{ itemId: item.id, qty: 6, unitCostCents: 100 }])
    const log = await prisma.wasteLog.create({ data: { inventoryItemId: item.id, quantity: 1, unit: 'kg', reason: 'spoilage', tenantId: A, estimatedCostCents: 100 } })
    await postWasteLog(log.id)
    const count = await prisma.physicalCount.create({ data: { tenantId: A, countedById: 'c', kind: 'spot', lines: { create: [{ inventoryItemId: item.id, systemQty: 6, physicalQty: 5, valueCents: -100 }] } } })
    await postStockCount(count.id)
    for (const ref of [`procurement.receipt:${receipt.id}`, `inventory.waste:${log.id}`, `inventory.count:${count.id}`]) {
      expect(await entries(ref)).toEqual([{ tenantId: A }])
    }
    // B's supplier cannot carry A's stock into B's books either: the receipt posts in the receipt's own company only.
    expect(await prisma.journalEntry.count({ where: { tenantId: B } })).toBe(0)

    await expect(tx((t) => consumeFifoTx(t, { tenantId: B, inventoryItemId: item.id, qty: 1, kind: 'waste', sourceType: 'x', sourceId: 'y', clamp: false, occurredAt: new Date() })))
      .rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK' })
    const aRows = await prisma.stockMovement.findMany({ where: { inventoryItemId: item.id, kind: 'receipt' }, select: { id: true, lotId: true, inventoryItemId: true, qty: true, valueCents: true, costClass: true } })
    await expect(tx((t) => returnToLotsTx(t, { rows: aRows.map((r) => ({ ...r, valueCents: Number(r.valueCents), costClass: 'food' as const })), kind: 'sale_return', sourceType: 'x', sourceId: 'z', occurredAt: new Date(), tenantId: B })))
      .rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK' })

    // A's item cannot be lotted against B's receipt line.
    const bReceipt = await prisma.goodsReceipt.create({
      data: { supplierId: supB, receivedById: 'tester', tenantId: B, lines: { create: [{ inventoryItemId: item.id, description: 'Wrong company', receivedQty: 1, unit: 'kg' }] } },
      include: { lines: true },
    })
    const bLine = bReceipt.lines[0]!.id
    await expect(tx((t) => addLotTx(t, {
      tenantId: A, inventoryItemId: item.id, qty: 1, unitCostCents: 100, kind: 'receipt', lotSourceType: 'goods_receipt_line', lotSourceId: `${bLine}:dock`,
      movementSourceType: STOCK_SOURCE.receiptLine, movementSourceId: bLine, receiptLineId: bLine, receivedAt: new Date(),
    }))).rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK' })
    expect(await tx((t) => postGoodsReceiptTx(t, bReceipt.id))).toEqual({ posted: false })
    expect(await prisma.journalEntry.count({ where: { tenantId: B } })).toBe(0)
  })

  it('every entry written by these postings is balanced', async () => {
    const all = await prisma.journalEntry.findMany({ include: { lines: true } })
    for (const e of all) {
      const dr = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + Number(l.amountCents), 0)
      const cr = e.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + Number(l.amountCents), 0)
      expect(dr, e.reference).toBe(cr)
    }
  })
})
