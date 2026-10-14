// The one-time FIFO cut-over per company (inventory/fifoCutover.ts).
//
//   - Every item with stock gets ONE 'fifo_cutover' lot: lots == currentStock;
//     a negative stock is set to 0 first (audited); an item with no cost is
//     cut over at 0; a company-less item with stock is listed, never lotted.
//   - The class reclass (drinks and packaging out of 1210) posts once.
//   - GRNI opens for PO quantity received but not billed (at the PO cost), and
//     quantity billed ahead of receipt becomes a pending match (Dr 2015 /
//     Cr 12x0) keyed by its bill line; a receipt without a PO counts as billed.
//   - A re-run posts and writes nothing; each company's cut-over touches only
//     its own rows; lib/stockLedger.ts ensureFifoReady runs it lazily.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureFifoReady, readFifoCutoverAt } from '../src/lib/stockLedger.js'
import { companyLessStockItems, ensureFifoCutover, readCutover } from '../src/modules/inventory/fifoCutover.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string, userId: string
const items: Record<string, string> = {}
let riceLine: string, beefLine: string, beefBillLine: string, dockLine: string, bDockLine: string, orphan: string

async function item(key: string, tenantId: string | null, stock: number, cost: number | null, category: string | null = null) {
  items[key] = (await prisma.inventoryItem.create({ data: { name: `${key} ${RUN}`, unit: 'kg', tenantId, currentStock: stock, unitCostCents: cost, category } })).id
  return items[key]!
}
async function legacyPoReceipt(supplierId: string, tenantId: string, itemId: string, ordered: number, received: number, cost: number) {
  const po = await prisma.purchaseOrder.create({
    data: { supplierId, status: received >= ordered ? 'received' : 'partial', totalCents: ordered * cost, lines: { create: [{ inventoryItemId: itemId, quantityOrdered: ordered, quantityReceived: received, unitCostCents: cost }] } },
    include: { lines: true },
  })
  const poLineId = po.lines[0]!.id
  const r = await prisma.goodsReceipt.create({
    data: { poId: po.id, supplierId, receivedById: userId, status: 'accepted', tenantId, receivedAt: new Date(Date.now() - 2 * 86_400_000),
      lines: { create: [{ inventoryItemId: itemId, poLineId, description: 'legacy', receivedQty: received, poUnitCostCents: cost, unit: 'kg' }] } },
    include: { lines: true },
  })
  return { poId: po.id, poLineId, receiptLineId: r.lines[0]!.id }
}
async function legacyBill(supplierId: string, poId: string, poLineId: string, itemId: string, qty: number, cost: number) {
  const b = await prisma.supplierBill.create({
    data: {
      supplierId, poId, billNumber: `FC-${qty}-${cost}-${RUN}`, billDate: new Date(), dueDate: new Date(), subtotalCents: qty * cost, totalCents: qty * cost, status: 'open',
      createdAt: new Date(Date.now() - 86_400_000),
      lines: { create: [{ inventoryItemId: itemId, poLineId, description: 'legacy', quantity: qty, unitCostCents: cost, lineTotalCents: qty * cost }] },
    },
    include: { lines: true },
  })
  return b.lines[0]!.id
}
const entryLines = async (tenantId: string, reference: string) => {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je?.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() ?? null
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'FC A', slug: `fc-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'FC B', slug: `fc-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  userId = (await prisma.user.create({
    data: { name: 'fc', email: `fc.${RUN}@fc.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId: tenantA },
  })).id
  const supA = (await prisma.supplier.create({ data: { name: `FC Supplier ${RUN}`, tenantId: tenantA } })).id
  const supB = (await prisma.supplier.create({ data: { name: `FC B Supplier ${RUN}`, tenantId: tenantB } })).id

  await item('flour', tenantA, 10, 100)
  await item('cola', tenantA, 24, 50, 'beverage')
  await item('cups', tenantA, 200, 5, 'packaging')
  await item('mystery', tenantA, 3, null)
  await item('minus', tenantA, -4, 100)
  await item('empty', tenantA, 0, 100)
  await item('rice', tenantA, 10, 200)
  await item('beef', tenantA, 10, 300)
  orphan = await item('orphan', null, 7, 100)
  await item('bFlour', tenantB, 5, 100)

  // Rice: ordered 10, received 10, billed 6 → 4 received not billed.
  const rice = await legacyPoReceipt(supA, tenantA, items['rice']!, 10, 10, 200)
  riceLine = rice.receiptLineId
  await legacyBill(supA, rice.poId, rice.poLineId, items['rice']!, 6, 200)
  // Beef: ordered 12, received 10, billed 12 → 2 billed ahead of receipt.
  const beef = await legacyPoReceipt(supA, tenantA, items['beef']!, 12, 10, 300)
  beefLine = beef.receiptLineId
  beefBillLine = await legacyBill(supA, beef.poId, beef.poLineId, items['beef']!, 12, 300)
  // A dock receipt without a PO (settled at the dock), in each company.
  dockLine = (await prisma.goodsReceipt.create({
    data: { supplierId: supA, receivedById: userId, status: 'accepted', tenantId: tenantA, lines: { create: [{ inventoryItemId: items['flour']!, description: 'dock', receivedQty: 2, poUnitCostCents: 100, unit: 'kg' }] } },
    include: { lines: true },
  })).lines[0]!.id
  bDockLine = (await prisma.goodsReceipt.create({
    data: { supplierId: supB, receivedById: userId, status: 'accepted', tenantId: tenantB, lines: { create: [{ inventoryItemId: items['bFlour']!, description: 'dock', receivedQty: 5, poUnitCostCents: 100, unit: 'kg' }] } },
    include: { lines: true },
  })).lines[0]!.id
})

describe('the cut-over', () => {
  it('opens one lot per item with stock: lots == currentStock; negative → 0 (audited); no cost → 0; company-less listed, not lotted', async () => {
    expect(await readFifoCutoverAt(prisma, tenantA)).toBeNull()
    const r = await ensureFifoCutover(tenantA)
    expect(r.ran).toBe(true)
    expect(await readFifoCutoverAt(prisma, tenantA)).toEqual(r.at)

    for (const key of ['flour', 'cola', 'cups', 'mystery', 'rice', 'beef']) {
      const it = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: items[key]! } })
      const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: it.id } })
      expect(lots, key).toHaveLength(1)
      expect(lots[0]).toMatchObject({ sourceType: 'fifo_cutover', sourceId: tenantA, tenantId: tenantA })
      expect(lots[0]!.remainingQty, key).toBe(it.currentStock)
    }
    expect(await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: items['cola']! } })).toMatchObject({ costClass: 'beverage', unitCostCents: 50 })
    expect(await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: items['mystery']! } })).toMatchObject({ unitCostCents: 0 })
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: items['minus']! } })).currentStock).toBe(0)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: { in: [items['minus']!, items['empty']!] } } })).toBe(0)
    const reset = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: tenantA, action: 'inventory.fifo_cutover.stock_reset' } })
    expect(JSON.stringify(reset.metadata)).toContain(items['minus']!)

    expect(await prisma.stockLot.count({ where: { inventoryItemId: orphan } })).toBe(0)
    expect((await companyLessStockItems()).map((i) => i.id)).toContain(orphan)
  })

  it('drinks and packaging leave 1210 once; GRNI opens received-unbilled at the PO cost and billed-ahead as a pending match', async () => {
    expect(await entryLines(tenantA, `inventory.class_reclass:${tenantA}`)).toEqual([
      ['1210', 'credit', 2_200], ['1220', 'debit', 1_200], ['1230', 'debit', 1_000],
    ])
    expect(await entryLines(tenantA, `procurement.grni_opening:${tenantA}`)).toEqual([
      ['1210', 'credit', 600], ['1210', 'debit', 800], ['2015', 'credit', 800], ['2015', 'debit', 600],
    ])
    expect(await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: riceLine } })).toMatchObject({ billedQty: 6 })
    expect(await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: beefLine } })).toMatchObject({ billedQty: 10 })
    expect(await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: dockLine } })).toMatchObject({ billedQty: 2 })
    const pending = await prisma.grniMatch.findMany({ where: { tenantId: tenantA } })
    expect(pending.map((m) => [m.billLineId, m.status, m.qty, Number(m.grniCents), m.receiptLineId])).toEqual([[beefBillLine, 'pending', 2, 600, null]])
    const cut = await readCutover(tenantA)
    expect(cut.at).toEqual(await readFifoCutoverAt(prisma, tenantA))
    expect(cut.preFifoDiff).not.toBeNull()
  })

  it('a re-run (and ensureFifoReady) posts and writes nothing', async () => {
    const entries = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const lots = await prisma.stockLot.count({ where: { tenantId: tenantA } })
    const matches = await prisma.grniMatch.count({ where: { tenantId: tenantA } })
    expect((await ensureFifoCutover(tenantA)).ran).toBe(false)
    await ensureFifoReady(tenantA)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(entries)
    expect(await prisma.stockLot.count({ where: { tenantId: tenantA } })).toBe(lots)
    expect(await prisma.grniMatch.count({ where: { tenantId: tenantA } })).toBe(matches)
  })

  it('company B was untouched by A\'s cut-over; ensureFifoReady runs B\'s own, which touches only B', async () => {
    expect(await readFifoCutoverAt(prisma, tenantB)).toBeNull()
    expect(await prisma.stockLot.count({ where: { inventoryItemId: items['bFlour']! } })).toBe(0)
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: bDockLine } })).billedQty).toBe(0)
    const aEntries = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const aLots = await prisma.stockLot.count({ where: { tenantId: tenantA } })

    await ensureFifoReady(tenantB)
    expect(await readFifoCutoverAt(prisma, tenantB)).not.toBeNull()
    expect(await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: items['bFlour']! } })).toMatchObject({ tenantId: tenantB, remainingQty: 5 })
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: bDockLine } })).billedQty).toBe(5)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(aEntries)
    expect(await prisma.stockLot.count({ where: { tenantId: tenantA } })).toBe(aLots)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: orphan } })).toBe(0)
  })
})
