// GRNI postings (finance wave B, H17) — accounting/supplierPosting.ts.
//
//   - A bill at a higher price after half the lot was used: 2015 clears at
//     the receipt (PO) cost; the on-hand half of the difference re-prices the
//     lot (Dr 1210), the used half goes to 5060; Σ lots == 1210.
//   - A bill before its goods: Dr 2015 at the billed price (pending); the
//     receipt opens the lot at the billed price; 2015 nets to zero.
//   - A void restores the lots and re-opens 2015.
//   - A bill recorded before the FIFO cut-over (legacy) re-opens GRNI at the
//     receipt cost on void and trues 5060 up, so 1210 keeps equalling the lots.
//   - A supplier return takes the bill's own lots first.
// Each scenario runs in its own company, so its ledger IS the scenario.
import { describe, it, expect, beforeAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createBill, voidBill } from '../src/modules/procurement/service.js'
import { createCreditNote } from '../src/modules/procurement/creditNotes.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { postSupplierBill } from '../src/modules/accounting/supplierPosting.js'
import { postWasteLog, postGrniWriteOffTx, postFifoAlign } from '../src/modules/accounting/inventoryPosting.js'
import { addLotTx, consumeFifoTx, ensureFifoReady, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import { ensureFifoCutover, readCutover } from '../src/modules/inventory/fifoCutover.js'

const RUN = Math.random().toString(36).slice(2, 8)
const PHOTO = 'https://example.com/dock.jpg'
let n = 0
let userId: string

async function company(tag: string) {
  const tenantId = (await prisma.tenant.create({ data: { name: `GRNI ${tag}`, slug: `grni-${tag}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await prisma.tenantMember.create({ data: { tenantId, userId } })
  const supplierId = (await prisma.supplier.create({ data: { name: `GRNI Supplier ${tag} ${RUN}`, tenantId } })).id
  return { tenantId, supplierId }
}
const mkItem = async (tenantId: string, name: string) =>
  (await prisma.inventoryItem.create({ data: { name: `${name} ${RUN}`, unit: 'kg', tenantId, currentStock: 0, unitCostCents: 1_000 } })).id
async function sentPo(supplierId: string, item: string, qty: number, cost: number) {
  const po = await prisma.purchaseOrder.create({
    data: { supplierId, status: 'sent', totalCents: qty * cost, lines: { create: [{ inventoryItemId: item, quantityOrdered: qty, unitCostCents: cost }] } },
    include: { lines: true },
  })
  return { poId: po.id, poLineId: po.lines[0]!.id }
}
const receive = async (poId: string, poLineId: string, qty: number) =>
  (await receiveGoods({ actor: { id: userId, role: 'admin' }, poId, photoUrl: PHOTO, lines: [{ poLineId, quantityReceived: qty }] })).receipt
const bill = async (supplierId: string, poId: string | null, line: { item: string; poLineId?: string; receiptLineId?: string; qty: number; cost: number }) =>
  createBill({
    supplierId, poId, billNumber: `GRNI-${++n}-${RUN}`, billDate: new Date().toISOString(),
    lines: [{ inventoryItemId: line.item, poLineId: line.poLineId, receiptLineId: line.receiptLineId, description: 'goods', quantity: line.qty, unitCostCents: line.cost }],
    createdBy: userId,
  })
/** Waste `qty` of an item through the real path: FIFO draw + 'inventory.waste' Dr 5040 / Cr 12x0. */
async function waste(tenantId: string, itemId: string, qty: number) {
  await prisma.$transaction(async (tx) => {
    const log = await tx.wasteLog.create({ data: { tenantId, inventoryItemId: itemId, quantity: qty, unit: 'kg', reason: 'spoilage', recordedById: userId } })
    const r = await consumeFifoTx(tx, { tenantId, inventoryItemId: itemId, qty, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, clamp: false, occurredAt: new Date() })
    await tx.wasteLog.update({ where: { id: log.id }, data: { estimatedCostCents: r.valueCents } })
    await postWasteLog(log.id, { tx })
  })
}
async function balance(tenantId: string, code: string, refs?: string[]): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code, tenantId }, journalEntry: { tenantId, ...(refs ? { reference: { in: refs } } : {}) } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
const lotsValue = async (tenantId: string, costClass = 'food') =>
  (await prisma.stockLot.findMany({ where: { tenantId, costClass } })).reduce((s, l) => s + Number(l.remainingValueCents), 0)

beforeAll(async () => {
  invalidateSetupCache()
  userId = (await prisma.user.create({
    data: { name: 'grni ceo', email: `ceo.${RUN}@grni.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active' },
  })).id
})

describe('a bill clears GRNI at the receipt cost; the difference re-prices the lot', () => {
  it('billed higher after half the lot was used: 2015 at the PO cost, on-hand half to 1210, used half to 5060, lots == 1210', async () => {
    const { tenantId, supplierId } = await company('a')
    const item = await mkItem(tenantId, 'Mutton')
    const { poId, poLineId } = await sentPo(supplierId, item, 10, 1_000)
    await receive(poId, poLineId, 10)
    await waste(tenantId, item, 5)
    expect(await lotsValue(tenantId)).toBe(5_000)
    expect(await balance(tenantId, '1210')).toBe(5_000)

    const b = await bill(supplierId, poId, { item, poLineId, qty: 10, cost: 1_200 })
    const ref = [`supplier.bill:${b.id}`]
    expect(await balance(tenantId, '2015', ref)).toBe(10_000)
    expect(await balance(tenantId, '1210', ref)).toBe(1_000)
    expect(await balance(tenantId, '5060', ref)).toBe(1_000)
    expect(await balance(tenantId, '2010', ref)).toBe(-12_000)
    expect(await balance(tenantId, '2015')).toBe(0)
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: item } })
    expect(lot).toMatchObject({ unitCostCents: 1_200, remainingQty: 5 })
    expect(Number(lot.remainingValueCents)).toBe(6_000)
    expect(await lotsValue(tenantId)).toBe(await balance(tenantId, '1210'))
    expect(await prisma.grniMatch.findFirstOrThrow({ where: { billId: b.id } })).toMatchObject({ status: 'live', qty: 10 })

    // The void: the lot back at 1,000 for what is on hand, 5060 gives back the used half, GRNI re-opens.
    await voidBill(b.id, userId, 'wrong price')
    expect(await lotsValue(tenantId)).toBe(5_000)
    expect(await lotsValue(tenantId)).toBe(await balance(tenantId, '1210'))
    expect(await balance(tenantId, '2015')).toBe(-10_000)
    expect(await balance(tenantId, '5060')).toBe(0)
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { poLineId } })).billedQty).toBe(0)
  })

  it('a bill before its goods: pending at the billed price; the receipt opens the lot at that price; 2015 nets to zero', async () => {
    const { tenantId, supplierId } = await company('b')
    const item = await mkItem(tenantId, 'Prawns')
    const { poId, poLineId } = await sentPo(supplierId, item, 8, 2_000)
    const b = await bill(supplierId, poId, { item, poLineId, qty: 8, cost: 2_100 })
    expect(await balance(tenantId, '2015')).toBe(16_800)
    expect(await prisma.grniMatch.findFirstOrThrow({ where: { billId: b.id } })).toMatchObject({ status: 'pending', qty: 8, receiptLineId: null })
    await receive(poId, poLineId, 8)
    expect(await balance(tenantId, '2015')).toBe(0)
    expect(await balance(tenantId, '1210')).toBe(16_800)
    expect(await lotsValue(tenantId)).toBe(16_800)
    expect(await prisma.grniMatch.findFirstOrThrow({ where: { billId: b.id } })).toMatchObject({ status: 'live', qty: 8 })
    // A re-post is a no-op.
    expect((await postSupplierBill(b.id)).posted).toBe(false)
  })

  it('a supplier return takes the bill\'s own lots first, then FIFO', async () => {
    const { tenantId, supplierId } = await company('c')
    const item = await mkItem(tenantId, 'Cheese')
    await ensureFifoReady(tenantId)
    // An older lot at 900 (opening) and the bill's lot at 1,000.
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId, inventoryItemId: item, qty: 5, unitCostCents: 900, kind: 'opening', lotSourceType: 'opening', lotSourceId: `grni-open-${item}`,
      movementSourceType: 'test.opening', movementSourceId: item, receivedAt: new Date(Date.now() - 86_400_000),
    }))
    const r = await receiveGoods({ actor: { id: userId, role: 'admin' }, supplierId, photoUrl: PHOTO, lines: [{ inventoryItemId: item, quantityReceived: 10, unitCostCents: 1_000 }] })
    const rl = r.receipt.lines[0]!.id
    const b = await bill(supplierId, null, { item, receiptLineId: rl, qty: 10, cost: 1_000 })
    const cn = await createCreditNote({
      billId: b.id, number: `GRNI-CN-${RUN}`, date: new Date().toISOString(), reason: 'return', returnStock: true,
      lines: [{ billLineId: b.lines[0]!.id, qty: 3 }], createdBy: userId,
    })
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: item }, orderBy: { receivedAt: 'asc' } })
    expect(lots.map((l) => [l.sourceType, l.remainingQty])).toEqual([['opening', 5], ['goods_receipt_line', 7]])
    expect(await balance(tenantId, '1210', [`supplier.credit_note:${cn.creditNote.id}`])).toBe(-3_000)
    expect(await balance(tenantId, '5060', [`supplier.credit_note:${cn.creditNote.id}`])).toBe(0)
  })
})

describe('a bill recorded before the FIFO cut-over', () => {
  it('its void re-opens GRNI at the receipt cost and trues 5060 up; 1210 keeps equalling the lots (± the pre-FIFO difference)', async () => {
    const { tenantId, supplierId } = await company('legacy')
    const item = await mkItem(tenantId, 'Ghee')
    const { poId, poLineId } = await sentPo(supplierId, item, 10, 1_000)
    // Before FIFO: the delivery booked nothing and moved currentStock; the bill debited 1210.
    await prisma.goodsReceipt.create({
      data: { poId, supplierId, receivedById: userId, status: 'accepted', tenantId, lines: { create: [{ inventoryItemId: item, poLineId, description: 'ghee', receivedQty: 10, poUnitCostCents: 1_000, unit: 'kg' }] } },
    })
    await prisma.inventoryItem.update({ where: { id: item }, data: { currentStock: 10 } })
    await prisma.purchaseOrderLine.update({ where: { id: poLineId }, data: { quantityReceived: 10 } })
    const legacy = await prisma.supplierBill.create({
      data: {
        supplierId, poId, billNumber: `GRNI-LEG-${RUN}`, billDate: new Date(), dueDate: new Date(), subtotalCents: 11_000, totalCents: 11_000, status: 'open',
        createdAt: new Date(Date.now() - 86_400_000),
        lines: { create: [{ inventoryItemId: item, poLineId, description: 'ghee', quantity: 10, unitCostCents: 1_100, lineTotalCents: 11_000 }] },
      },
    })
    expect((await postSupplierBill(legacy.id)).posted).toBe(true)
    expect(await balance(tenantId, '1210')).toBe(11_000)

    await ensureFifoCutover(tenantId)
    expect(await lotsValue(tenantId)).toBe(10_000)
    expect((await readCutover(tenantId)).preFifoDiff?.food).toBe(1_000)
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { poLineId } })).billedQty).toBe(10)
    expect(await balance(tenantId, '2015')).toBe(0)

    await voidBill(legacy.id, userId, 'never ours')
    const voidRefs = [`supplier.bill.void:${legacy.id}`, `supplier.bill.void.legacy:${legacy.id}`]
    expect(await balance(tenantId, '1210', voidRefs)).toBe(0)
    expect(await balance(tenantId, '2015', voidRefs)).toBe(-10_000)
    expect(await balance(tenantId, '5060', voidRefs)).toBe(-1_000)
    expect(await balance(tenantId, '2010')).toBe(0)
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { poLineId } })).billedQty).toBe(0)
    // 1210 − lots is still exactly the stored pre-FIFO difference.
    expect(await balance(tenantId, '1210') - await lotsValue(tenantId)).toBe(1_000)
  })
})

describe('a written-off delivery is never re-opened by a bill void', () => {
  it('receive 10, bill 4, write off 6, void the bill → 409 RECEIPT_WRITTEN_OFF; 2015 stays 0', async () => {
    const { tenantId, supplierId } = await company('wo')
    const item = await mkItem(tenantId, 'Lentils')
    const { poId, poLineId } = await sentPo(supplierId, item, 10, 100)
    const r = await receive(poId, poLineId, 10)
    const rl = r.lines[0]!.id
    const b = await bill(supplierId, poId, { item, poLineId, qty: 4, cost: 100 })
    expect(await balance(tenantId, '2015')).toBe(-600)
    // The CEO's approval (grniRoutes): the posting plus the line stamped written off.
    await prisma.$transaction(async (tx) => {
      const posted = await postGrniWriteOffTx(tx, rl, { id: userId })
      await tx.goodsReceiptLine.update({ where: { id: rl }, data: { writtenOffAt: new Date(), writtenOffById: userId, writeOffEntryId: posted.entryId } })
    })
    expect(await balance(tenantId, '2015')).toBe(0)
    await expect(voidBill(b.id, userId, 'to re-enter it')).rejects.toMatchObject({ code: 'RECEIPT_WRITTEN_OFF', statusCode: 409 })
    expect(await balance(tenantId, '2015')).toBe(0)
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })).status).not.toBe('void')
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: rl } })).billedQty).toBe(4)
  })
})

describe('legacy bills the admin form wrote (no PO line, no item)', () => {
  it('the cut-over ties a bill to its PO\'s deliveries (no phantom GRNI); a bill naming no PO is listed and its supplier\'s deliveries count billed; voids never book 5060 for an untied bill', async () => {
    const tenantId = (await prisma.tenant.create({ data: { name: 'GRNI unlinked', slug: `grni-unl-${RUN}` } })).id
    await ensureChartOfAccounts(tenantId)
    const s1 = (await prisma.supplier.create({ data: { name: `Rice Co ${RUN}`, tenantId } })).id
    const s2 = (await prisma.supplier.create({ data: { name: `Sugar Co ${RUN}`, tenantId } })).id
    const rice = (await prisma.inventoryItem.create({ data: { name: `Rice u ${RUN}`, unit: 'kg', tenantId, currentStock: 10, unitCostCents: 200 } })).id
    const sugar = (await prisma.inventoryItem.create({ data: { name: `Sugar u ${RUN}`, unit: 'kg', tenantId, currentStock: 10, unitCostCents: 200 } })).id
    const flour = (await prisma.inventoryItem.create({ data: { name: `Flour u ${RUN}`, unit: 'kg', tenantId, currentStock: 5, unitCostCents: 100 } })).id
    const old = new Date(Date.now() - 2 * 86_400_000)
    // Rice: PO received before FIFO; the admin form's bill names the PO, not its line.
    const ricePo = await sentPo(s1, rice, 10, 200)
    const riceRl = (await prisma.goodsReceipt.create({
      data: { poId: ricePo.poId, supplierId: s1, receivedById: userId, status: 'accepted', tenantId, receivedAt: old,
        lines: { create: [{ inventoryItemId: rice, poLineId: ricePo.poLineId, description: 'rice', receivedQty: 10, poUnitCostCents: 200, unit: 'kg' }] } },
      include: { lines: true },
    })).lines[0]!.id
    const mkLegacy = async (supplierId: string, poId: string | null, number: string, description: string) => {
      const b = await prisma.supplierBill.create({
        data: {
          supplierId, poId, billNumber: `${number}-${RUN}`, billDate: new Date(), dueDate: new Date(), subtotalCents: 2_000, totalCents: 2_000, status: 'open',
          createdAt: new Date(Date.now() - 86_400_000),
          lines: { create: [{ description, quantity: 10, unitCostCents: 200, lineTotalCents: 2_000 }] },
        },
      })
      expect((await postSupplierBill(b.id)).posted).toBe(true)
      return b.id
    }
    const b1 = await mkLegacy(s1, ricePo.poId, 'UNL-RICE', 'Rice 10kg')
    // Sugar Co: a flour PO received before FIFO, and two description-only bills naming no PO (one a duplicate).
    const flourPo = await sentPo(s2, flour, 5, 100)
    const flourRl = (await prisma.goodsReceipt.create({
      data: { poId: flourPo.poId, supplierId: s2, receivedById: userId, status: 'accepted', tenantId, receivedAt: old,
        lines: { create: [{ inventoryItemId: flour, poLineId: flourPo.poLineId, description: 'flour', receivedQty: 5, poUnitCostCents: 100, unit: 'kg' }] } },
      include: { lines: true },
    })).lines[0]!.id
    const b2 = await mkLegacy(s2, null, 'UNL-SUGAR', 'Sugar 10kg')
    const b3 = await mkLegacy(s2, null, 'UNL-SUGAR-DUP', 'Sugar 10kg')
    void sugar

    await ensureFifoCutover(tenantId)
    // No phantom GRNI: every pre-cut-over delivery counts billed.
    expect(await balance(tenantId, '2015')).toBe(0)
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: riceRl } })).billedQty).toBe(10)
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: flourRl } })).billedQty).toBe(5)
    const cut = await readCutover(tenantId)
    expect(cut.untied?.bills.map((b) => b.billId).sort()).toEqual([b2, b3].sort())
    expect(cut.untied?.receiptLines.map((r) => r.receiptLineId)).toEqual([flourRl])
    expect(await prisma.exceptionFlag.count({ where: { tenantId, kind: 'fifo_cutover_review' } })).toBe(1)

    // The tied bill's void re-opens exactly its delivery: GRNI back at the receipt cost, no 5060.
    await voidBill(b1, userId, 'wrong supplier')
    const v1 = [`supplier.bill.void:${b1}`, `supplier.bill.void.legacy:${b1}`]
    expect(await balance(tenantId, '1210', v1)).toBe(0)
    expect(await balance(tenantId, '2015', v1)).toBe(-2_000)
    expect(await balance(tenantId, '5060', v1)).toBe(0)
    expect((await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: riceRl } })).billedQty).toBe(0)

    // The duplicate (untied) before the alignment: the reversal's Cr 1210 stands, never a 5060 gain.
    await voidBill(b3, userId, 'duplicate')
    expect(await balance(tenantId, '1210', [`supplier.bill.void:${b3}`, `supplier.bill.void.legacy:${b3}`])).toBe(-2_000)
    expect(await balance(tenantId, '5060')).toBe(0)

    // After the alignment an untied void goes back where the alignment put the difference (3020).
    await postFifoAlign(tenantId, { dryRun: false, actor: { id: userId } })
    await voidBill(b2, userId, 'entered twice')
    const v2 = [`supplier.bill.void.legacy:${b2}`]
    expect(await balance(tenantId, '1210', v2)).toBe(2_000)
    expect(await balance(tenantId, '3020', v2)).toBe(-2_000)
    expect(await balance(tenantId, '5060')).toBe(0)
  })

  it('a price credit on an item-less legacy bill line books 5060, never 1210; the lots do not move', async () => {
    const tenantId = (await prisma.tenant.create({ data: { name: 'GRNI legacy CN', slug: `grni-lcn-${RUN}` } })).id
    await ensureChartOfAccounts(tenantId)
    await prisma.tenantMember.create({ data: { tenantId, userId } })
    const s = (await prisma.supplier.create({ data: { name: `Flour Co ${RUN}`, tenantId } })).id
    await prisma.inventoryItem.create({ data: { name: `Flour cn ${RUN}`, unit: 'kg', tenantId, currentStock: 10, unitCostCents: 200 } })
    const b = await prisma.supplierBill.create({
      data: {
        supplierId: s, billNumber: `LCN-${RUN}`, billDate: new Date(), dueDate: new Date(), subtotalCents: 2_000, totalCents: 2_000, status: 'open',
        createdAt: new Date(Date.now() - 86_400_000),
        lines: { create: [{ description: 'Flour 10kg', quantity: 10, unitCostCents: 200, lineTotalCents: 2_000 }] },
      },
      include: { lines: true },
    })
    expect((await postSupplierBill(b.id)).posted).toBe(true)
    await ensureFifoCutover(tenantId)
    const before1210 = await balance(tenantId, '1210')
    const lotsBefore = await lotsValue(tenantId)
    const cn = await createCreditNote({
      billId: b.id, number: `LCN-CN-${RUN}`, date: new Date().toISOString(), reason: 'price',
      lines: [{ billLineId: b.lines[0]!.id, qty: 10, unitCostCents: 20 }], createdBy: userId,
    })
    const ref = [`supplier.credit_note:${cn.creditNote.id}`]
    expect(await balance(tenantId, '1210')).toBe(before1210)
    expect(await lotsValue(tenantId)).toBe(lotsBefore)
    expect(await balance(tenantId, '5060', ref)).toBe(-200)
    expect(await balance(tenantId, '2010', ref)).toBe(200)
  })
})
