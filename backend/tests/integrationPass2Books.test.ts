// Integration pass 2 — books follow-ups (stream BK2, 2026-10-12).
//
//   NEEDS 12 (RB-3, on FIFO lots since wave B)  a bill booked before its
//       goods debits 2015 at the billed price (a 'pending' GrniMatch); each
//       receipt opens its lot at the billed price for that quantity, settles
//       the match (split across partial deliveries) and credits 2015 by
//       exactly as much — in the bill's company, inside the receipt's
//       transaction.
//   BK2-RV-1  stock cooked before its delivery was entered (a sale shortfall):
//       bill first or goods first, the late receipt settles the shortfall
//       from its lot and both orders land on the same cost of goods and the
//       same 1210; a void re-opens GRNI at the lot value; a closed period
//       refuses such a receipt. (BK2-RV-2's catch-up for pre-hook receipts is
//       step 0 of the FIFO cut-over now — booksRound5 (2).)
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
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { createBill, voidBill } from '../src/modules/procurement/service.js'
import { consumeFifoTx } from '../src/lib/stockLedger.js'
import { ensureFifoCutover } from '../src/modules/inventory/fifoCutover.js'
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

// ─── NEEDS 12 — RB-3 on lots: a bill first, the receipts settle it ──────────

describe('NEEDS 12 — a bill booked before its goods: each receipt settles its share at the billed price', () => {
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
  const net2015 = async (refs: string[]) => {
    const lines = await prisma.journalLine.findMany({ where: { account: { code: '2015' }, journalEntry: { tenantId: tenantA, reference: { in: refs } } }, select: { type: true, amountCents: true } })
    return lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
  }

  it('bill first, then two partial deliveries: each receipt lands its share once, in the bill\'s company; 2015 nets to zero', async () => {
    const item = (await prisma.inventoryItem.create({ data: { name: `Beef ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 100_000 } })).id
    const { poId, poLineId } = await sentPo(item, 10, 100_000)
    const bill = await createBill({
      supplierId: supplierA, poId, billNumber: `IP2-BEEF-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId: item, poLineId, description: 'beef', quantity: 10, unitCostCents: 110_000 }],
      createdBy: users['adminA']!,
    })
    const billId = bill.id as string
    expect(await net2015([`supplier.bill:${billId}`])).toBe(1_100_000)
    expect(await prisma.grniMatch.findMany({ where: { billId }, select: { status: true, qty: true } })).toEqual([{ status: 'pending', qty: 10 }])

    const r1 = await receive(poId, poLineId, 4)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).unitCostCents).toBe(110_000)
    const r2 = await receive(poId, poLineId, 6)
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).toMatchObject({ currentStock: 10, unitCostCents: 110_000 })

    const matches = await prisma.grniMatch.findMany({ where: { billId }, orderBy: { qty: 'asc' } })
    expect(matches.map((m) => [m.status, m.qty, m.receiptLineId])).toEqual([
      ['live', 4, r1.receipt.lines[0]!.id],
      ['live', 6, r2.receipt.lines[0]!.id],
    ])
    for (const m of matches) expect(m.tenantId).toBe(tenantA)
    expect(await net2015([`supplier.bill:${billId}`, `procurement.receipt:${r1.receipt.id}`, `procurement.receipt:${r2.receipt.id}`])).toBe(0)
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: item } })
    expect(lots.map((l) => [l.qtyIn, l.unitCostCents]).sort()).toEqual([[4, 110_000], [6, 110_000]])
  })

  it('a delivery with no bill booked stays at the PO price and leaves its value in 2015 until billed', async () => {
    const item = (await prisma.inventoryItem.create({ data: { name: `Rice ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 30_000 } })).id
    const { poId, poLineId } = await sentPo(item, 5, 30_000)
    const r = await receive(poId, poLineId, 5)
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).toMatchObject({ currentStock: 5, unitCostCents: 30_000 })
    expect(await prisma.grniMatch.count({ where: { poLineId } })).toBe(0)
    expect(await net2015([`procurement.receipt:${r.receipt.id}`])).toBe(-150_000)
  })
})

// ─── BK2-RV-1 — stock cooked before its delivery was entered ─────────────────
//
// Its own company (C), so the closed period at the end and NEEDS 13's lock on
// A never meet.

describe('BK2-RV-1 — cooked before the delivery was entered: bill first and goods first land in the same place', () => {
  let tenantC: string, supplierC: string, mgrC: string, adminC: string
  let saleSeq = 0
  beforeAll(async () => {
    tenantC = (await prisma.tenant.create({ data: { name: 'IP2 Books C', slug: `ip2-c-${RUN}` } })).id
    await ensureChartOfAccounts(tenantC)
    invalidateSetupCache()
    await mkUser('mgrC', 'fnb_manager', tenantC)
    await mkUser('adminC', 'admin', tenantC)
    mgrC = users['mgrC']!; adminC = users['adminC']!
    supplierC = (await prisma.supplier.create({ data: { name: `IP2 Butcher ${RUN}`, tenantId: tenantC, paymentTermsDays: 10 } })).id
    await ensureFifoCutover(tenantC)
  })
  const mkItem = async (name: string) =>
    (await prisma.inventoryItem.create({ data: { name: `${name} ${RUN}`, unit: 'kg', tenantId: tenantC, currentStock: 0, unitCostCents: 100_000 } })).id
  /** Sold with nothing on the books: a clamped sale leaves a shortfall the next receipt settles. */
  const soldShort = (inventoryItemId: string, qty: number) => prisma.$transaction((tx) => consumeFifoTx(tx, {
    tenantId: tenantC, inventoryItemId, qty, kind: 'sale', sourceType: 'order_item.sale', sourceId: `ip2-sale-${RUN}-${++saleSeq}`,
    clamp: true, theoreticalQty: qty, occurredAt: new Date(),
  }))
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
  /** Net debit per account over every entry of company C that names one of `refs` (prefix match). */
  async function net(refs: string[]) {
    const lines = await prisma.journalLine.findMany({
      where:   { journalEntry: { tenantId: tenantC, OR: refs.map((r) => ({ reference: r })) } },
      select:  { type: true, amountCents: true, account: { select: { code: true } } },
    })
    const out: Record<string, number> = {}
    for (const l of lines) out[l.account.code] = (out[l.account.code] ?? 0) + (l.type === 'debit' ? l.amountCents : -l.amountCents)
    return out
  }
  const lotIdsOf = async (receiptId: string) => (await prisma.stockLot.findMany({ where: { receiptLine: { receiptId } }, select: { id: true } })).map((l) => l.id)

  it('9 kg sold before the delivery: bill first and goods first both cost the 9 kg at 1,200/kg and keep 1 kg at 1,200 in 1210', async () => {
    // Bill first: the lot opens at the billed price and settles the 9 kg from it.
    const beef = await mkItem('Beef bill-first')
    await soldShort(beef, 9)
    const a = await sentPo(beef)
    const billA = await billAt1200(beef, a.poId, a.poLineId, 'BF9')
    const ra = await receive(a.poId, a.poLineId, 10)
    expect(await item(beef)).toEqual({ currentStock: 1, unitCostCents: 120_000 })
    const refsA = [`supplier.bill:${billA}`, `procurement.receipt:${ra.receipt.id}`, ...(await lotIdsOf(ra.receipt.id)).map((id) => `inventory.shortfall_settle:${id}`)]
    const na = await net(refsA)
    expect(na['2015'] ?? 0).toBe(0)
    expect(na['1210']).toBe(120_000)
    expect((na['5010'] ?? 0) + (na['5060'] ?? 0)).toBe(1_080_000)

    // Goods first: the lot opens at the PO price; the bill re-prices the 1 kg
    // still on hand and sends the 9 kg's difference to 5060.
    const beef2 = await mkItem('Beef goods-first')
    await soldShort(beef2, 9)
    const b = await sentPo(beef2)
    const rb = await receive(b.poId, b.poLineId, 10)
    const billB = await billAt1200(beef2, b.poId, b.poLineId, 'GF9')
    expect(await item(beef2)).toEqual({ currentStock: 1, unitCostCents: 120_000 })
    expect(await net([`supplier.bill:${billB}`])).toMatchObject({ '2015': 1_000_000, '1210': 20_000, '5060': 180_000 })
    const nb = await net([`supplier.bill:${billB}`, `procurement.receipt:${rb.receipt.id}`, ...(await lotIdsOf(rb.receipt.id)).map((id) => `inventory.shortfall_settle:${id}`)])
    expect(nb['2015'] ?? 0).toBe(0)
    expect(nb['1210']).toBe(na['1210'])
    expect((nb['5010'] ?? 0) + (nb['5060'] ?? 0)).toBe(1_080_000)
  })

  it('15 kg sold, bill first: the whole delivery settles the shortfall; a void re-opens GRNI at the lot value and leaves 1210 alone', async () => {
    const beef = await mkItem('Beef -15')
    await soldShort(beef, 15)
    const { poId, poLineId } = await sentPo(beef)
    const billId = await billAt1200(beef, poId, poLineId, 'BF15')
    const r = await receive(poId, poLineId, 10)
    expect(await item(beef)).toEqual({ currentStock: 0, unitCostCents: 120_000 })

    await voidBill(billId, adminC, 'wrong price')
    const all = await net([`supplier.bill:${billId}`, `supplier.bill.void:${billId}`, `supplier.bill.void.price:${billId}`])
    expect(all['1210'] ?? 0).toBe(0)
    expect(all['5060'] ?? 0).toBe(0)
    expect(all['2010'] ?? 0).toBe(0)
    // The received 10 kg wait for a bill again, at what the receipt booked.
    expect((await net([`procurement.receipt:${r.receipt.id}`, `supplier.bill:${billId}`, `supplier.bill.void:${billId}`]))['2015']).toBe(-1_200_000)
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { receiptId: r.receipt.id } })).billedQty).toBe(0)
  })

  it('nothing sold before: the whole delivery sits at the billed price and nothing posts to 5060', async () => {
    const beef = await mkItem('Beef zero')
    const { poId, poLineId } = await sentPo(beef)
    const billId = await billAt1200(beef, poId, poLineId, 'BF0')
    const r = await receive(poId, poLineId, 10)
    expect(await item(beef)).toEqual({ currentStock: 10, unitCostCents: 120_000 })
    const n = await net([`supplier.bill:${billId}`, `procurement.receipt:${r.receipt.id}`])
    expect(n).toMatchObject({ '2015': 0, '1210': 1_200_000 })
    expect(n['5060'] ?? 0).toBe(0)
  })

  it('a closed period refuses the receipt (it books on arrival), and nothing moves', async () => {
    const beef = await mkItem('Beef locked')
    const { poId, poLineId } = await sentPo(beef)
    await billAt1200(beef, poId, poLineId, 'LOCK')
    await prisma.periodLock.create({ data: { tenantId: tenantC, lockedThrough: pktToday().to, lockedBy: adminC, note: 'ip2 C lock' } })
    await expect(receive(poId, poLineId, 10)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(await item(beef)).toEqual({ currentStock: 0, unitCostCents: 100_000 })
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } })).quantityReceived).toBe(0)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: beef } })).toBe(0)
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
