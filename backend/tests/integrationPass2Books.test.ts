// Integration pass 2 — books follow-ups (stream BK2, 2026-10-12).
//
//   NEEDS 12 (RB-3)  receiveGoods applies a supplier bill's carried price
//       variance to the received quantity itself, inside its own transaction,
//       keyed on the receipt (idempotent), in the bill's company.
//   BK2-RV-1  a bill booked before its goods: the receipt re-averages only the
//       share still on hand and expenses the rest to 5060 (stock -9 and -15),
//       the same figures as goods first; a void gives the 5060 share back; a
//       closed period refuses such a receipt. BK2-RV-2: the one-off catch-up
//       for receipts made before the hook. (Both need the supplierPosting.ts
//       patch in .handoff/fixes/BK2-RV-supplierPosting.patch.)
//   NEEDS 13  bookEarn / bookRedeem: a ledger refusal (here a closed period)
//       raises ONE posting_failed flag in the owning company; "nothing to
//       post" outcomes (unknown tx, wrong kind) raise none; another company's
//       postings are untouched.
//   NEEDS 18  the wipe script deletes customer_wallets before customers (the
//       FK is ON DELETE RESTRICT, so the other order fails).
//   NEEDS 19/20  FiscalPayload.totals carries the optional delivery charge and
//       bill discount on the shared type; the vendor contract documents the
//       identity, the new fields and the extra tenders.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { pktToday } from '../src/modules/accounting/dates.js'
import { receiveGoods, applyReceiptLine } from '../src/modules/procurement/receiving.js'
import { createBill, voidBill } from '../src/modules/procurement/service.js'
import { applyCarriedBillVarianceTx } from '../src/modules/accounting/supplierPosting.js'
import { bookEarn, creditPoints, creditPointsTx, quoteRedemption, claimRedemption } from '../src/modules/loyalty/service.js'
import { totalsCheck } from '../src/connectors/fiscal/payload.js'
import type { FiscalPayload } from '../src/connectors/types.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
const users: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@ip2books.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = u.id
}

let seq = 0
const mkCustomer = () => { seq += 1; return prisma.customer.create({ data: { name: `ip2 ${seq}`, email: `c${seq}.${RUN}@ip2books.test` } }) }
const flags = (where: { entityId: string; sourceType?: string }) => prisma.exceptionFlag.findMany({
  where: { kind: 'posting_failed', entityId: where.entityId, ...(where.sourceType && { metadata: { path: ['sourceType'], equals: where.sourceType } }) },
})
const lockThroughToday = (tenantId: string) =>
  prisma.periodLock.create({ data: { tenantId, lockedThrough: pktToday().to, lockedBy: users['adminA']!, note: 'ip2 test lock' } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'IP2 Books A', slug: `ip2-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'IP2 Books B', slug: `ip2-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd IP2', slug: `ip2-stackd-${RUN}`, type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Simmer IP2', slug: `ip2-simmer-${RUN}`, type: 'restaurant', tenantId: tenantB, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('mgrA', 'fnb_manager', tenantA)
}, 60_000)

// ─── NEEDS 12 — RB-3: receiving applies the carried bill variance itself ─────

describe('NEEDS 12 — receiveGoods applies a bill\'s carried variance in its own transaction', () => {
  let supplierA: string
  beforeAll(async () => {
    supplierA = (await prisma.supplier.create({ data: { name: `IP2 Poultry ${RUN}`, tenantId: tenantA, paymentTermsDays: 10 } })).id
  })
  async function sentPo(inventoryItemId: string, qty: number, cost: number) {
    const po = await prisma.purchaseOrder.create({
      data: {
        supplierId: supplierA, status: 'sent', totalCents: Math.round(qty * cost),
        lines: { create: [{ inventoryItemId, quantityOrdered: qty, unitCostCents: cost }] },
      },
      include: { lines: true },
    })
    return { poId: po.id, poLineId: po.lines[0]!.id }
  }
  const receive = (poId: string, poLineId: string, qty: number) =>
    receiveGoods({ actor: { id: users['mgrA']!, role: 'fnb_manager' }, poId, photoUrl: 'https://cdn.example/grn.jpg', lines: [{ poLineId, quantityReceived: qty }] })
  const appliedRows = (billId: string) => prisma.auditLog.findMany({ where: { entity: 'SupplierBill', entityId: billId, action: 'supplier.bill.variance_applied' }, orderBy: { createdAt: 'asc' } })

  it('bill first, then two partial deliveries: each receipt lands its slice once, in the bill\'s company; a re-run is a no-op', async () => {
    const item = (await prisma.inventoryItem.create({ data: { name: `Beef ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 100_000 } })).id
    const { poId, poLineId } = await sentPo(item, 10, 100_000)
    const bill = await createBill({
      supplierId: supplierA, poId, billNumber: `IP2-BEEF-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId: item, poLineId, description: 'beef', quantity: 10, unitCostCents: 110_000 }],
      createdBy: users['adminA']!,
    })
    const billId = bill.id as string

    const r1 = await receive(poId, poLineId, 4)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).unitCostCents).toBe(110_000)
    const r2 = await receive(poId, poLineId, 6)
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).toMatchObject({ currentStock: 10, unitCostCents: 110_000 })

    const rows = await appliedRows(billId)
    expect(rows.map((r) => (r.metadata as { receiptId: string }).receiptId)).toEqual([r1.receipt.id, r2.receipt.id])
    expect(rows.map((r) => (r.metadata as { qty: number }).qty)).toEqual([4, 6])
    for (const r of rows) expect(r.tenantId).toBe(tenantA)

    // The old bridge (a manual call after receiving) is now a no-op for the same receipt.
    const moved = await prisma.$transaction((tx) => applyCarriedBillVarianceTx(tx, { poLineId, quantity: 6, supplierId: supplierA, receiptId: r2.receipt.id }))
    expect(moved).toBe(0)
    expect(await appliedRows(billId)).toHaveLength(2)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).unitCostCents).toBe(110_000)
  })

  it('a delivery with no bill booked stays at the PO price and writes no applied row', async () => {
    const item = (await prisma.inventoryItem.create({ data: { name: `Rice ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 30_000 } })).id
    const { poId, poLineId } = await sentPo(item, 5, 30_000)
    await receive(poId, poLineId, 5)
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).toMatchObject({ currentStock: 5, unitCostCents: 30_000 })
    expect(await prisma.auditLog.count({ where: { action: 'supplier.bill.variance_applied', metadata: { path: ['poLineId'], equals: poLineId } } })).toBe(0)
  })
})

// ─── BK2-RV-1 / RV-2 — carried variance split on receipt; legacy catch-up ───
//
// Needs the supplierPosting.ts patch (applyCarriedBillVarianceTx split +
// void true-up + applyMissedCarriedBillVariances). Its own company (C), so the
// closed period at the end and NEEDS 13's lock on A never meet.

describe('BK2-RV-1/2 — a bill booked before its goods: receipt splits the carried variance like posting does', () => {
  let tenantC: string, supplierC: string, mgrC: string, adminC: string
  beforeAll(async () => {
    tenantC = (await prisma.tenant.create({ data: { name: 'IP2 Books C', slug: `ip2-c-${RUN}` } })).id
    await ensureChartOfAccounts(tenantC)
    invalidateSetupCache()
    await mkUser('mgrC', 'fnb_manager', tenantC)
    await mkUser('adminC', 'admin', tenantC)
    mgrC = users['mgrC']!; adminC = users['adminC']!
    supplierC = (await prisma.supplier.create({ data: { name: `IP2 Butcher ${RUN}`, tenantId: tenantC, paymentTermsDays: 10 } })).id
  })
  const mkItem = async (name: string, stock: number) =>
    (await prisma.inventoryItem.create({ data: { name: `${name} ${RUN}`, unit: 'kg', tenantId: tenantC, currentStock: stock, unitCostCents: 100_000 } })).id
  async function sentPo(inventoryItemId: string, qty = 10) {
    const po = await prisma.purchaseOrder.create({
      data: { supplierId: supplierC, status: 'sent', totalCents: qty * 100_000, lines: { create: [{ inventoryItemId, quantityOrdered: qty, unitCostCents: 100_000 }] } },
      include: { lines: true },
    })
    return { poId: po.id, poLineId: po.lines[0]!.id }
  }
  const billAt1200 = async (inventoryItemId: string, poId: string, poLineId: string, tag: string) =>
    (await createBill({
      supplierId: supplierC, poId, billNumber: `IP2C-${tag}-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId, poLineId, description: 'beef', quantity: 10, unitCostCents: 120_000 }],
      createdBy: adminC,
    })).id as string
  const receive = (poId: string, poLineId: string, qty: number) =>
    receiveGoods({ actor: { id: mgrC, role: 'fnb_manager' }, poId, photoUrl: 'https://cdn.example/grn.jpg', lines: [{ poLineId, quantityReceived: qty }] })
  const item = (id: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id }, select: { currentStock: true, unitCostCents: true } })
  const appliedRows = (billId: string) => prisma.auditLog.findMany({ where: { entity: 'SupplierBill', entityId: billId, action: 'supplier.bill.variance_applied' }, orderBy: { createdAt: 'asc' } })
  type Applied = { qty: number; targetCents: number; absorbedCents: number; usedCents: number; onHand: number }
  /** Net debit per account over the given entry references in company C. */
  async function net(refs: string[]) {
    const lines = await prisma.journalLine.findMany({
      where:   { journalEntry: { tenantId: tenantC, reference: { in: refs } } },
      select:  { type: true, amountCents: true, account: { select: { code: true } } },
    })
    const out: Record<string, number> = {}
    for (const l of lines) out[l.account.code] = (out[l.account.code] ?? 0) + (l.type === 'debit' ? l.amountCents : -l.amountCents)
    return out
  }
  const receiptRefs = async (billId: string) => (await appliedRows(billId)).map((r) => `supplier.bill.variance.receipt:${r.id}`)

  it('stock -9, bill first: 1 kg re-averages to the billed 1,200/kg, 9/10 of the variance goes to 5060 — same as goods first', async () => {
    // Bill first.
    const beef = await mkItem('Beef bill-first', -9)
    const a = await sentPo(beef)
    const billA = await billAt1200(beef, a.poId, a.poLineId, 'BF9')
    expect(await net([`supplier.bill:${billA}`])).toMatchObject({ '1210': 1_200_000 })   // whole variance carried
    await receive(a.poId, a.poLineId, 10)
    expect(await item(beef)).toEqual({ currentStock: 1, unitCostCents: 120_000 })
    const [row] = await appliedRows(billA)
    expect(row!.tenantId).toBe(tenantC)
    expect(row!.metadata).toMatchObject({ qty: 10, targetCents: 200_000, absorbedCents: 20_000, usedCents: 180_000, onHand: 1 } satisfies Partial<Applied>)
    const refs = await receiptRefs(billA)
    expect(await net(refs)).toEqual({ '5060': 180_000, '1210': -180_000 })

    // Goods first, same figures.
    const beef2 = await mkItem('Beef goods-first', -9)
    const b = await sentPo(beef2)
    await receive(b.poId, b.poLineId, 10)
    const billB = await billAt1200(beef2, b.poId, b.poLineId, 'GF9')
    expect(await item(beef2)).toEqual({ currentStock: 1, unitCostCents: 120_000 })
    expect(await net([`supplier.bill:${billB}`])).toMatchObject({ '1210': 1_020_000, '5060': 180_000 })
    // Bill first lands in the same place: 1210 +1,200,000 − 180,000.
    expect((await net([`supplier.bill:${billA}`, ...refs]))['1210']).toBe(1_020_000)
  })

  it('stock -15, bill first: nothing is on hand after the receipt, so the whole variance goes to 5060; a void gives it back', async () => {
    const beef = await mkItem('Beef -15', -15)
    const { poId, poLineId } = await sentPo(beef)
    const billId = await billAt1200(beef, poId, poLineId, 'BF15')
    await receive(poId, poLineId, 10)
    expect(await item(beef)).toEqual({ currentStock: -5, unitCostCents: 100_000 })
    const [row] = await appliedRows(billId)
    expect(row!.metadata).toMatchObject({ qty: 10, targetCents: 200_000, absorbedCents: 0, usedCents: 200_000 })
    const refs = await receiptRefs(billId)
    expect(await net(refs)).toEqual({ '5060': 200_000, '1210': -200_000 })
    // 1210 now holds the goods at the PO price, nothing more.
    expect((await net([`supplier.bill:${billId}`, ...refs]))['1210']).toBe(1_000_000)

    // Void: the reversal takes the whole bill out of 1210; the receipt's 5060
    // share comes back, so every account the bill touched nets to zero.
    await voidBill(billId, adminC, 'wrong price')
    const all = await net([`supplier.bill:${billId}`, `supplier.bill.void:${billId}`, `supplier.bill.void.price:${billId}`, ...refs])
    expect(all['1210'] ?? 0).toBe(0)
    expect(all['5060'] ?? 0).toBe(0)
    expect(await item(beef)).toEqual({ currentStock: -5, unitCostCents: 100_000 })
  })

  it('stock at or above zero is unchanged: the whole slice re-averages and nothing posts to 5060', async () => {
    const beef = await mkItem('Beef zero', 0)
    const { poId, poLineId } = await sentPo(beef)
    const billId = await billAt1200(beef, poId, poLineId, 'BF0')
    await receive(poId, poLineId, 10)
    expect(await item(beef)).toEqual({ currentStock: 10, unitCostCents: 120_000 })
    expect((await appliedRows(billId))[0]!.metadata).toMatchObject({ absorbedCents: 200_000, usedCents: 0 })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC, reference: { in: await receiptRefs(billId) } } })).toBe(0)
  })

  it('RV-2 catch-up: receipts from before the hook get their missing slice once — on hand re-averages, sold goes to 5060', async () => {
    const { applyMissedCarriedBillVariances } = await import('../src/modules/accounting/supplierPosting.js')
    // A receipt the way it was before receiving applied the variance itself.
    const oldReceipt = (inventoryItemId: string, poId: string, poLineId: string, qty: number) => prisma.$transaction(async (tx) => {
      await tx.goodsReceipt.create({
        data: { poId, supplierId: supplierC, receivedById: mgrC, status: 'accepted', lines: { create: [{ inventoryItemId, description: 'beef', receivedQty: qty, poUnitCostCents: 100_000, unit: 'kg' }] } },
      })
      await applyReceiptLine(tx, { inventoryItemId, quantity: qty, unitCostCents: 100_000, supplierId: supplierC, poLineId, source: 'po_receive' })
      await tx.purchaseOrderLine.update({ where: { id: poLineId }, data: { quantityReceived: { increment: qty } } })
    })

    // (a) 4 kg received before the release, 6 kg after (which applied 6/10).
    const partial = await mkItem('Beef partial', 0)
    const p = await sentPo(partial)
    const billP = await billAt1200(partial, p.poId, p.poLineId, 'CU-P')
    await oldReceipt(partial, p.poId, p.poLineId, 4)
    await receive(p.poId, p.poLineId, 6)
    expect(await item(partial)).toEqual({ currentStock: 10, unitCostCents: 112_000 })   // 120,000 of 200,000 spread over 10 kg

    // (b) all 10 kg received before the release and since sold.
    const sold = await mkItem('Beef sold', 0)
    const s = await sentPo(sold)
    const billS = await billAt1200(sold, s.poId, s.poLineId, 'CU-S')
    await oldReceipt(sold, s.poId, s.poLineId, 10)
    await prisma.inventoryItem.update({ where: { id: sold }, data: { currentStock: 0 } })

    const dry = await applyMissedCarriedBillVariances({ tenantIds: [tenantC], dryRun: true })
    const byLine = (rows: typeof dry.rows, id: string) => rows.find((r) => r.poLineId === id)
    expect(byLine(dry.rows, p.poLineId)).toMatchObject({ tenantId: tenantC, quantity: 4, onHandQty: 4, movedCents: null })
    expect(byLine(dry.rows, s.poLineId)).toMatchObject({ tenantId: tenantC, quantity: 10, onHandQty: 0, movedCents: null })
    expect(await item(partial)).toEqual({ currentStock: 10, unitCostCents: 112_000 })   // dry run moved nothing

    const run = await applyMissedCarriedBillVariances({ tenantIds: [tenantC], dryRun: false })
    expect(byLine(run.rows, p.poLineId)).toMatchObject({ quantity: 4, movedCents: 80_000 })
    expect(await item(partial)).toEqual({ currentStock: 10, unitCostCents: 120_000 })
    expect(byLine(run.rows, s.poLineId)).toMatchObject({ quantity: 10, movedCents: 0 })
    expect(await item(sold)).toEqual({ currentStock: 0, unitCostCents: 100_000 })
    expect(await net(await receiptRefs(billS))).toEqual({ '5060': 200_000, '1210': -200_000 })
    expect((await appliedRows(billP)).map((r) => (r.metadata as { qty: number }).qty)).toEqual([6, 4])

    // Idempotent, and another company's run never touches C's bills.
    expect((await applyMissedCarriedBillVariances({ tenantIds: [tenantC], dryRun: false })).rows).toHaveLength(0)
    expect((await applyMissedCarriedBillVariances({ tenantIds: [tenantB], dryRun: false })).rows).toHaveLength(0)
  })

  it('a closed period refuses the receipt that would post to 5060, and nothing moves', async () => {
    const beef = await mkItem('Beef locked', -15)
    const { poId, poLineId } = await sentPo(beef)
    await billAt1200(beef, poId, poLineId, 'LOCK')
    await prisma.periodLock.create({ data: { tenantId: tenantC, lockedThrough: pktToday().to, lockedBy: adminC, note: 'ip2 C lock' } })
    await expect(receive(poId, poLineId, 10)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(await item(beef)).toEqual({ currentStock: -15, unitCostCents: 100_000 })
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } })).quantityReceived).toBe(0)
  })
})

// ─── NEEDS 13 — loyalty refusals reach the inbox ─────────────────────────────

describe('NEEDS 13 — bookEarn / bookRedeem flag a ledger refusal in the owning company', () => {
  let earnTxA: string
  let redeemOrderA: string
  let customerA: string

  beforeAll(async () => {
    // Points to spend at A, booked while A is still open.
    customerA = (await mkCustomer()).id
    const seed = await creditPoints({ customerId: customerA, points: 1_000, tenantId: tenantA, description: 'ip2 seed' })
    expect(seed.credited).toBe(true)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `loyalty.earn:${seed.txId}` } })).toBe(1)
    redeemOrderA = (await prisma.order.create({
      data: {
        conceptId: conceptA, customerId: customerA, source: 'servd', status: 'received', totalCents: 50_000,
        items: { create: [{ name: 'Club sandwich', quantity: 1, unitPriceCents: 50_000 }] },
        payments: { create: [{ method: 'cash', amountCents: 50_000, status: 'pending' }] },
      },
    })).id
    await lockThroughToday(tenantA)
  })

  it('earn refused by a closed period → one high posting_failed flag in company A, keyed on the transaction', async () => {
    const c = await mkCustomer()
    const r = await creditPoints({ customerId: c.id, points: 200, tenantId: tenantA, description: 'ip2 review bonus' })
    expect(r.credited).toBe(true)
    earnTxA = r.txId!
    expect(await prisma.journalEntry.count({ where: { reference: `loyalty.earn:${earnTxA}` } })).toBe(0)
    const f = await flags({ entityId: earnTxA, sourceType: 'loyalty.earn' })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ tenantId: tenantA, severity: 'high', entityType: 'LoyaltyTransaction', status: 'open' })
    expect((f[0]!.metadata as { reason: string; sourceId: string }).sourceId).toBe(earnTxA)
    expect((f[0]!.metadata as { reason: string }).reason).toMatch(/closed/i)
  })

  it('booking the same refused earn again does not raise a second flag', async () => {
    await bookEarn(earnTxA)
    expect(await flags({ entityId: earnTxA, sourceType: 'loyalty.earn' })).toHaveLength(1)
  })

  it('an earn on an order is flagged on the ORDER (same key as the completion check)', async () => {
    const c = await mkCustomer()
    const o = await prisma.order.create({
      data: { conceptId: conceptA, customerId: c.id, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 40_000, items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: 40_000 }] } },
    })
    const r = await prisma.$transaction((tx) => creditPointsTx(tx, { customerId: c.id, points: 40, orderId: o.id, description: 'ip2 order earn' }))
    await bookEarn(r.txId)
    const f = await flags({ entityId: o.id, sourceType: 'loyalty.earn' })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ tenantId: tenantA, entityType: 'Order', conceptId: conceptA })
  })

  it('redeem refused by a closed period → flagged on the order in company A; the points are still taken', async () => {
    const q = await quoteRedemption({ customerId: customerA, requestedPoints: 100, tenantId: tenantA, capCents: 50_000 })
    expect(q.points).toBeGreaterThan(0)
    expect(await claimRedemption({ customerId: customerA, orderId: redeemOrderA, quote: q })).toBe(true)
    const f = await flags({ entityId: redeemOrderA, sourceType: 'loyalty.redeem' })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ tenantId: tenantA, entityType: 'Order', severity: 'high' })
    const redeemTx = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: redeemOrderA, type: 'redeem' } })
    expect((f[0]!.metadata as { sourceId: string }).sourceId).toBe(redeemTx.id)
  })

  it('nothing to post is not a refusal: an unknown tx or a redeem passed to bookEarn raises no flag', async () => {
    const before = await prisma.exceptionFlag.count({ where: { kind: 'posting_failed' } })
    await bookEarn('00000000-0000-0000-0000-000000000000')
    const redeemTx = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: redeemOrderA, type: 'redeem' } })
    await bookEarn(redeemTx.id)     // not_earn_tx
    await bookEarn(null)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed' } })).toBe(before)
  })

  it('company B is unaffected: its earn posts and raises nothing; B\'s scope sees none of A\'s flags', async () => {
    const c = await mkCustomer()
    const r = await creditPoints({ customerId: c.id, points: 300, tenantId: tenantB, description: 'ip2 B bonus' })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `loyalty.earn:${r.txId}` } })).toBe(1)
    expect(await flags({ entityId: r.txId! })).toHaveLength(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', tenantId: tenantB } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', tenantId: tenantA } })).toBe(3)
    void conceptB
  })
})

// ─── NEEDS 18 — wipe order ──────────────────────────────────────────────────

describe('NEEDS 18 — the wipe deletes customer wallets before customers', () => {
  it('the script lists customerWallets after walletTransactions and before customers', () => {
    const src = readFileSync(new URL('../scripts/wipe-and-reset.ts', import.meta.url), 'utf8')
    const at = (key: string) => src.indexOf(`['${key}',`)
    expect(at('customerWallets')).toBeGreaterThan(-1)
    expect(at('customerWallets')).toBeGreaterThan(at('walletTransactions'))
    expect(at('customerWallets')).toBeLessThan(at('customers'))
    expect(src).toMatch(/\['customerWallets',\s*\(\) => prisma\.customerWallet\.deleteMany\(\)\]/)
  })

  it('the FK really restricts: a customer with a wallet cannot go first, and can once the wallet is gone', async () => {
    const c = await mkCustomer()
    await prisma.customerWallet.create({ data: { tenantId: tenantA, customerId: c.id, balanceCents: 0 } })
    await expect(prisma.customer.delete({ where: { id: c.id } })).rejects.toThrow()
    await prisma.customerWallet.deleteMany({ where: { customerId: c.id } })
    await prisma.customer.delete({ where: { id: c.id } })
    expect(await prisma.customer.count({ where: { id: c.id } })).toBe(0)
  })
})

// ─── NEEDS 19 / 20 — the shared payload type and the vendor contract ────────

describe('NEEDS 19/20 — FiscalPayload.totals and the v1 contract', () => {
  // Typed against the SHARED FiscalPayload (no cast): the new totals fields
  // must be part of it for this to compile under tsc.
  const base = (totals: FiscalPayload['totals'], lines: FiscalPayload['lines']): FiscalPayload => ({
    version: 1, documentId: 'ip2doc', kind: 'sale', orderId: 'o', orderRef: 'O', source: 'servd',
    issuedAt: '2026-10-12T12:00:00+05:00', currency: 'PKR', registrations: [],
    seller: { legalName: 'GS Foods' }, buyer: null, lines, totals,
    payment: { mode: 'card', tenders: [{ method: 'wallet', amountCents: totals.totalCents }] },
  })
  const line = (taxable: number, tax: number, gross = taxable): FiscalPayload['lines'][number] => ({
    lineId: 'l', itemCode: 'c', description: 'd', quantity: 1, unitPriceCents: gross,
    grossCents: gross, discountCents: gross - taxable, taxableCents: taxable, taxRatePct: 15, taxCents: tax,
  })

  it('the delivery charge and bill discount are fields of the shared type and enter the identity', () => {
    const delivery = base({
      saleValueCents: 100_000, discountCents: 0, taxableCents: 100_000, taxCents: 15_000, taxRatePct: 15,
      serviceChargeCents: 0, tipCents: 0, deliveryChargeCents: 15_000, totalCents: 130_000,
    }, [line(100_000, 15_000)])
    expect(totalsCheck(delivery).ok).toBe(true)
    const fullyDiscounted = base({
      saleValueCents: 100_000, discountCents: 100_000, taxableCents: 0, taxCents: 15_000, taxRatePct: 15,
      serviceChargeCents: 0, tipCents: 0, deliveryChargeCents: 15_000, billDiscountCents: 10_000, totalCents: 20_000,
    }, [line(0, 15_000, 100_000)])
    expect(totalsCheck(fullyDiscounted).ok).toBe(true)
    // A v1 payload without the new fields still adds up.
    const legacy = base({
      saleValueCents: 100_000, discountCents: 0, taxableCents: 100_000, taxCents: 15_000, taxRatePct: 15,
      serviceChargeCents: 0, tipCents: 0, totalCents: 115_000,
    }, [line(100_000, 15_000)])
    expect(totalsCheck(legacy).ok).toBe(true)
  })

  it('types.ts says totalCents is the bill', () => {
    const src = readFileSync(new URL('../src/connectors/types.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/deliveryChargeCents\?: number/)
    expect(src).toMatch(/billDiscountCents\?: number/)
    expect(src).toMatch(/totalCents: number\s+\/\/ the BILL/)
  })

  it('the vendor contract documents the identity, both optional fields and the extra tenders', () => {
    const doc = readFileSync(new URL('../../docs/pos-connector-api.md', import.meta.url), 'utf8')
    expect(doc).toContain('+ deliveryChargeCents − billDiscountCents  =  totalCents')
    expect(doc).toContain('+ deliveryChargeCents − billDiscountCents  =  refundAmountCents')
    expect(doc).toMatch(/`totals\.deliveryChargeCents` \(optional\)/)
    expect(doc).toMatch(/`totals\.billDiscountCents` \(optional\)/)
    expect(doc).toMatch(/`wallet`/)
    expect(doc).toMatch(/`gift_card`/)
    expect(doc).toMatch(/cash-on-delivery/)
    expect(doc).toMatch(/backward compatible/i)
  })
})
