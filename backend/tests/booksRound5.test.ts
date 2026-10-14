// Post-Monday round, stream B — the books.
//
//   (1) BOOKS-06 (BIGINT money columns, migration 20261012140000): PO totals,
//       supplier bills (stock-line totals, subtotal, tax, total), supplier
//       payments and a supplier's opening balance are BIGINT paisa — one
//       amount up to PKR 900,000,000,000.00 (MAX_MONEY_CENTS) fits; above it
//       is 422 AMOUNT_TOO_LARGE before anything is written. A unit cost that
//       becomes an item's STOCK cost (a PO line, a stock-linked bill line,
//       receiving) stays INT4 (PKR 21,474,836.47) — 422 above it — and so do
//       a bill's non-stock lines, each and together (they book to 1210 like
//       stock; capital spend is CapEx — MONEY-BIG-1).
//   (2) NEEDS 21, moved (wave B): the catch-up for supplier bills booked before
//       their goods whose carried price difference a pre-hook receipt never
//       applied is now step 0 of each company's one-time FIFO cut-over
//       (inventory/fifoCutover.ts) — the CEO route
//       POST /reconciliation/apply-missed-bill-variances is gone. It applies
//       once, before the cut-over lots open at the settled cost, per company;
//       a company already cut over is never re-averaged. Two companies.
//   (3) Loyalty earn vs refund race: an earn reversed (claimed by a refund /
//       cancel) before its posting lands is never posted — postLoyaltyEarn
//       re-reads it under a row lock — and that is "nothing to post", not a
//       posting_failed flag. Both interleavings are driven deterministically
//       with real row / advisory locks; the ledger stays balanced.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { pktToday } from '../src/modules/accounting/dates.js'
import { INT4_MAX_CENTS, MAX_MONEY_CENTS } from '../src/lib/money.js'
import { MAX_AMOUNT_CENTS as POS_MAX_AMOUNT_CENTS } from '../src/modules/pos/service.js'
import { createBill, createPaymentTx, allocatePayment } from '../src/modules/procurement/service.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { ensureLoyaltyEarnBooked } from '../src/modules/orders/service.js'
import { postSupplierBill } from '../src/modules/accounting/supplierPosting.js'
import { applyMissedCarriedBillVariances, ensureFifoCutover, readCutover } from '../src/modules/inventory/fifoCutover.js'
import { postLoyaltyEarn, postLoyaltyRedeem, postLoyaltyReversal } from '../src/modules/accounting/loyaltyPosting.js'
import { bookEarn, creditPointsTx, LOYALTY_NOTHING_TO_POST } from '../src/modules/loyalty/service.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@booksr5.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of [primary, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}`, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) })

/** Σ debits − Σ credits over every journal line of a company (0 = balanced). */
async function imbalance(tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
}

/** Net debit on one account code of a company over the given references. */
async function netOn(tenantId: string, code: string, refs: string[]): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where:  { account: { code }, journalEntry: { tenantId, reference: { in: refs } } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'R5 Books A', slug: `r5b-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'R5 Books B', slug: `r5b-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('ceoAB', 'admin', tenantA, [tenantB])
  await mkUser('mgrA', 'boh_management', tenantA)
  await mkUser('finA', 'finance', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

// ─── (1) PO / bill / payment amount ceilings (BOOKS-06, BIGINT) ─────────────

describe('(1) procurement money: BIGINT amounts fit up to PKR 900bn, per-unit stock cost stays INT4 — 422 above, nothing written', () => {
  let supA: string, itemA: string
  beforeAll(async () => {
    supA  = (await prisma.supplier.create({ data: { name: `R5 Mills ${RUN}`, tenantId: tenantA } })).id
    itemA = (await prisma.inventoryItem.create({ data: { name: `R5 Flour ${RUN}`, unit: 'kg', tenantId: tenantA } })).id
  })
  const tooBigInt4 = (res: { statusCode: number; body: string; json: () => { error: { code: string; message: string } } }) => {
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect(res.json().error.message).toMatch(/PKR 21,474,836\.47/)
  }
  const tooBig = (res: { statusCode: number; body: string; json: () => { error: { code: string; message: string } } }) => {
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect(res.json().error.message).toMatch(/PKR 900,000,000,000\.00/)
  }

  it('one BIGINT ceiling and one INT4 ceiling; the till keeps the INT4 one', () => {
    expect(MAX_MONEY_CENTS).toBe(90_000_000_000_000)
    expect(INT4_MAX_CENTS).toBe(2_147_483_647)
    expect(POS_MAX_AMOUNT_CENTS).toBe(INT4_MAX_CENTS)
  })

  it('PO: a unit cost above INT4 is 422 (it becomes the stock cost); a total above PKR 900bn is 422; nothing saved', async () => {
    const before = await prisma.purchaseOrder.count({ where: { supplierId: supA } })
    tooBigInt4(await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: INT4_MAX_CENTS + 1 }],
    }))
    tooBig(await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 50_000, unitCostCents: 2_000_000_000 }],   // PKR 1 trillion
    }))
    expect(await prisma.purchaseOrder.count({ where: { supplierId: supA } })).toBe(before)
  })

  it('PO: totals above INT4 now fit (30 × PKR 1m, and 2 × PKR 15m → 201, exact numbers)', async () => {
    const r1 = await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 30, unitCostCents: 100_000_000 }],
    })
    expect(r1.statusCode, r1.body).toBe(201)
    expect(r1.json().totalCents).toBe(3_000_000_000)
    const r2 = await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [
        { inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1_500_000_000 },
        { inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1_500_000_000 },
      ],
    })
    expect(r2.statusCode, r2.body).toBe(201)
    expect(r2.json().totalCents).toBe(3_000_000_000)
    const r3 = await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: INT4_MAX_CENTS }],
    })
    expect(r3.statusCode).toBe(201)
    expect(r3.json().totalCents).toBe(INT4_MAX_CENTS)
  })

  it('bill: stock-line totals, subtotals and totals above INT4 record and post balanced (clearing 2015); non-stock lines above INT4 (each or together), tax above PKR 900bn or a stock unit cost above INT4 is 422', async () => {
    // Stock is received at the dock first (wave B: a stock line bills its receipt).
    const received = async (qty: number, unitCostCents: number) => (await receiveGoods({
      actor: { id: users['mgrA']!.id, role: 'boh_management' }, supplierId: supA, photoUrl: 'https://example.test/dock.jpg',
      lines: [{ inventoryItemId: itemA, quantityReceived: qty, unitCostCents }],
    })).receipt.lines[0]!.id
    const bill = (n: string, lines: Array<{ quantity: number; unitCostCents: number; inventoryItemId?: string; receiptLineId?: string }>, taxCents?: number) =>
      call('mgrA', 'POST', '/procurement/bills', {
        supplierId: supA, billNumber: `R5-${n}-${RUN}`, billDate: new Date().toISOString(),
        ...(taxCents !== undefined && { taxCents }),
        lines: lines.map((l) => ({ description: l.inventoryItemId ? 'flour' : 'fit-out', ...(l.inventoryItemId ? {} : { expenseAccountCode: '6050' }), ...l })),
      })
    tooBig(await bill('TAX', [{ quantity: 1, unitCostCents: 100 }], MAX_MONEY_CENTS + 1))
    const rlBig = await received(1, 1_000)
    tooBigInt4(await bill('STOCK', [{ quantity: 1, unitCostCents: INT4_MAX_CENTS + 1, inventoryItemId: itemA, receiptLineId: rlBig }]))
    // MONEY-BIG-1: a non-stock line books to 1210 Inventory – Food like stock,
    // so it stays at the INT4 cap — capital spend goes through CapEx.
    for (const r of [
      await bill('NS-UNIT', [{ quantity: 1, unitCostCents: INT4_MAX_CENTS + 1 }]),
      await bill('NS-LINE', [{ quantity: 3, unitCostCents: 1_000_000_000 }]),
      await bill('NS-SUM', [{ quantity: 1, unitCostCents: 1_200_000_000 }, { quantity: 1, unitCostCents: 1_200_000_000 }]),
    ]) {
      tooBigInt4(r)
      expect(r.json().error.message).toMatch(/CapEx/)
    }
    expect(await prisma.supplierBill.count({ where: { supplierId: supA } })).toBe(0)

    const line = await bill('LINE', [{ quantity: 3, unitCostCents: 1_000_000_000, inventoryItemId: itemA, receiptLineId: await received(3, 1_000_000_000) }])
    expect(line.statusCode, line.body).toBe(201)
    expect(line.json()).toMatchObject({ subtotalCents: 3_000_000_000, totalCents: 3_000_000_000 })
    // The receipt booked the stock (Dr 1210 / Cr 2015); the bill clears 2015.
    expect(await netOn(tenantA, '2015', [`supplier.bill:${line.json().id}`])).toBe(3_000_000_000)
    expect(await netOn(tenantA, '1210', [`supplier.bill:${line.json().id}`])).toBe(0)
    const total = await bill('TOTAL', [{ quantity: 1, unitCostCents: 2_000_000_000, inventoryItemId: itemA, receiptLineId: await received(1, 2_000_000_000) }], 200_000_000)
    expect(total.statusCode, total.body).toBe(201)
    expect(total.json()).toMatchObject({ subtotalCents: 2_000_000_000, taxCents: 200_000_000, totalCents: 2_200_000_000 })
    // A non-stock line within INT4 next to a stock line: the bill's subtotal
    // is past INT4, the non-stock part is not.
    const sub = await bill('SUB', [{ quantity: 1, unitCostCents: 1_200_000_000, inventoryItemId: itemA, receiptLineId: await received(1, 1_200_000_000) }, { quantity: 1, unitCostCents: 1_200_000_000 }])
    expect(sub.statusCode, sub.body).toBe(201)
    expect(sub.json().totalCents).toBe(2_400_000_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { startsWith: 'supplier.bill:' } } })).toBe(3)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('payment: PKR 50m records (201, posted); above PKR 900bn is 422 (route and the petty-cash service path)', async () => {
    tooBig(await call('mgrA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: MAX_MONEY_CENTS + 1,
    }))
    await expect(prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: MAX_MONEY_CENTS + 1, createdBy: users['mgrA']!.id,
    }))).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
    expect(await prisma.supplierPayment.count({ where: { supplierId: supA } })).toBe(0)
    const big = await prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'bank_transfer', amountCents: 5_000_000_000, createdBy: users['mgrA']!.id,
    }))
    expect(big.amountCents).toBe(5_000_000_000)
    expect(await netOn(tenantA, '2010', [`supplier.payment:${big.id}`])).toBe(5_000_000_000)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('allocating an application above PKR 900bn is 422 before anything moves', async () => {
    const p = await prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: 10_000, createdBy: users['mgrA']!.id,
    }))
    await expect(allocatePayment(p.id, [{ billId: '00000000-0000-0000-0000-000000000000', amountAppliedCents: MAX_MONEY_CENTS + 5 }]))
      .rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE' })
    tooBig(await call('mgrA', 'POST', `/procurement/payments/${p.id}/allocate`, {
      applications: [{ billId: '00000000-0000-0000-0000-000000000000', amountAppliedCents: MAX_MONEY_CENTS + 5 }],
    }))
  })

  it('supplier opening balance: PKR 25m records (201) and posts exactly; above PKR 900bn is 422 on create and on edit', async () => {
    const ok = await call('mgrA', 'POST', '/procurement/suppliers', { name: `R5 Big ${RUN}`, openingBalanceCents: 2_500_000_000 })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().openingBalanceCents).toBe(2_500_000_000)
    expect(await netOn(tenantA, '2010', (await prisma.journalEntry.findMany({ where: { tenantId: tenantA, reference: { startsWith: `supplier.opening:${ok.json().id}` } }, select: { reference: true } })).map((e) => e.reference!))).toBe(-2_500_000_000)
    tooBig(await call('mgrA', 'POST', '/procurement/suppliers', { name: `R5 Huge ${RUN}`, openingBalanceCents: MAX_MONEY_CENTS + 1 }))
    expect(await prisma.supplier.count({ where: { name: `R5 Huge ${RUN}` } })).toBe(0)
    tooBig(await call('mgrA', 'PATCH', `/procurement/suppliers/${supA}`, { openingBalanceCents: MAX_MONEY_CENTS + 1 }))
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supA } })).openingBalanceCents).toBe(0)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('the PO approval limit above PKR 900bn is 422 and unchanged', async () => {
    const before = (await call('ceoA', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents
    tooBig(await call('ceoA', 'PUT', '/procurement/settings/approval-threshold', { thresholdCents: MAX_MONEY_CENTS + 1 }))
    expect((await call('ceoA', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents).toBe(before)
  })

  it('reconciliation: a split line on a bank-statement adjustment above PKR 900bn is 422 before any lookup', async () => {
    tooBig(await call('ceoA', 'POST', '/reconciliation/bank/lines/00000000-0000-0000-0000-000000000000/adjust', {
      memo: 'r5 split', lines: [
        { accountCode: '1010', type: 'debit',  amountCents: MAX_MONEY_CENTS + 1 },
        { accountCode: '6080', type: 'credit', amountCents: MAX_MONEY_CENTS + 1 },
      ],
    }))
    // Within the ceiling (even above INT4) it gets as far as the line lookup (404: no such line).
    expect((await call('ceoA', 'POST', '/reconciliation/bank/lines/00000000-0000-0000-0000-000000000000/adjust', {
      memo: 'r5 split', lines: [
        { accountCode: '1010', type: 'debit',  amountCents: 2_500_000_000 },
        { accountCode: '6080', type: 'credit', amountCents: 2_500_000_000 },
      ],
    })).statusCode).toBe(404)
  })

  it('a normal bill still records and posts (201, balanced)', async () => {
    const res = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `R5-OK-${RUN}`, billDate: new Date().toISOString(), taxCents: 1_800,
      lines: [{ description: 'cleaning', quantity: 2.5, unitCostCents: 4_000, expenseAccountCode: '6040' }],
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ subtotalCents: 10_000, taxCents: 1_800, totalCents: 11_800 })
    expect(await imbalance(tenantA)).toBe(0)
  })
})

// ─── (2) NEEDS 21 — the missed carried-variance catch-up, now cut-over step 0 ─

describe('(2) the missed carried-variance catch-up runs once, as step 0 of the FIFO cut-over', () => {
  let tenantC: string, tenantD: string
  const seeded: Record<'C' | 'D', { item: string; poLineId: string; billId: string }> = {} as never

  // A pre-FIFO company: a bill booked before its goods (all of its variance
  // carried, as the old posting recorded it), then the goods received the way
  // receipts worked before receiving applied the carried variance itself.
  async function seed(tenantId: string, key: 'C' | 'D') {
    const supplier = (await prisma.supplier.create({ data: { name: `R5 Butcher ${key} ${RUN}`, tenantId, paymentTermsDays: 10 } })).id
    const item = (await prisma.inventoryItem.create({ data: { name: `R5 Beef ${key} ${RUN}`, unit: 'kg', tenantId, currentStock: 0, unitCostCents: 100_000 } })).id
    const po = await prisma.purchaseOrder.create({
      data: { supplierId: supplier, status: 'sent', totalCents: 1_000_000, lines: { create: [{ inventoryItemId: item, quantityOrdered: 10, unitCostCents: 100_000 }] } },
      include: { lines: true },
    })
    const poLineId = po.lines[0]!.id
    const day = 86_400_000
    const bill = await prisma.supplierBill.create({
      data: {
        supplierId: supplier, poId: po.id, billNumber: `R5-CU-${key}-${RUN}`, billDate: new Date(Date.now() - day), dueDate: new Date(Date.now() + 9 * day),
        subtotalCents: 1_200_000, totalCents: 1_200_000, status: 'open', createdAt: new Date(Date.now() - day),
        lines: { create: [{ inventoryItemId: item, poLineId, description: 'beef', quantity: 10, unitCostCents: 120_000, lineTotalCents: 1_200_000 }] },
      },
    })
    expect((await postSupplierBill(bill.id)).posted).toBe(true)   // not cut over yet: the old shape, Dr 1210
    await prisma.auditLog.create({
      data: {
        category: 'accounting', tenantId, action: 'supplier.bill.variance', entity: 'SupplierBill', entityId: bill.id,
        metadata: { lines: [{ poLineId, inventoryItemId: item, billedQty: 10, receivedQty: 0, varianceCents: 200_000, absorbedCents: 0, onHandAtPosting: 0, usedCents: 0, carriedQty: 10, carriedCents: 200_000 }] },
      },
    })
    await prisma.goodsReceipt.create({
      data: {
        poId: po.id, supplierId: supplier, receivedById: users['ceoA']!.id, status: 'accepted', tenantId, receivedAt: new Date(Date.now() - day / 2),
        lines: { create: [{ inventoryItemId: item, poLineId, description: 'beef', receivedQty: 10, poUnitCostCents: 100_000, unit: 'kg' }] },
      },
    })
    await prisma.inventoryItem.update({ where: { id: item }, data: { currentStock: 10 } })
    await prisma.purchaseOrderLine.update({ where: { id: poLineId }, data: { quantityReceived: 10 } })
    seeded[key] = { item, poLineId, billId: bill.id }
  }
  const cost = async (key: 'C' | 'D') => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: seeded[key].item } })).unitCostCents
  const appliedRows = (key: 'C' | 'D') => prisma.auditLog.count({ where: { entity: 'SupplierBill', entityId: seeded[key].billId, action: 'supplier.bill.variance_applied' } })

  beforeAll(async () => {
    tenantC = (await prisma.tenant.create({ data: { name: 'R5 Books C', slug: `r5b-c-${RUN}` } })).id
    tenantD = (await prisma.tenant.create({ data: { name: 'R5 Books D', slug: `r5b-d-${RUN}` } })).id
    await ensureChartOfAccounts(tenantC)
    await ensureChartOfAccounts(tenantD)
    await seed(tenantC, 'C')
    await seed(tenantD, 'D')
    expect(await cost('C')).toBe(100_000)
    expect(await cost('D')).toBe(100_000)
  })

  it('the CEO route is gone', async () => {
    expect((await call('ceoA', 'POST', '/reconciliation/apply-missed-bill-variances', {})).statusCode).toBe(404)
  })

  it('a preview lists the pre-FIFO company\'s line and moves nothing', async () => {
    const r = await applyMissedCarriedBillVariances({ tenantIds: [tenantC], dryRun: true })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ tenantId: tenantC, poLineId: seeded.C.poLineId, quantity: 10, onHandQty: 10, outcome: 'would_apply' })
    expect(await cost('C')).toBe(100_000)
  })

  it('the cut-over applies the missed slice once, then opens the lot at the settled cost; D is untouched', async () => {
    const r = await ensureFifoCutover(tenantC)
    expect(r.ran).toBe(true)
    expect(await cost('C')).toBe(120_000)
    expect(await appliedRows('C')).toBe(1)
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: seeded.C.item } })
    expect(lots).toHaveLength(1)
    expect(lots[0]).toMatchObject({ sourceType: 'fifo_cutover', qtyIn: 10, unitCostCents: 120_000 })
    // 1210 holds the bill (12,000.00); the lots hold the same: no pre-FIFO difference.
    expect((await readCutover(tenantC)).preFifoDiff).toEqual({ food: 0, beverage: 0, packaging: 0 })
    expect(await imbalance(tenantC)).toBe(0)
    // The legacy bill matched what arrived: billed, nothing in GRNI.
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { poLineId: seeded.C.poLineId } })).billedQty).toBe(10)
    expect(await netOn(tenantC, '2015', [`procurement.grni_opening:${tenantC}`])).toBe(0)

    expect(await cost('D')).toBe(100_000)
    expect(await appliedRows('D')).toBe(0)
    expect((await readCutover(tenantD)).at).toBeNull()
  })

  it('idempotent: a second cut-over and a catch-up on a company already cut over do nothing', async () => {
    expect((await ensureFifoCutover(tenantC)).ran).toBe(false)
    expect((await applyMissedCarriedBillVariances({ tenantIds: [tenantC], dryRun: false })).rows).toHaveLength(0)
    expect(await cost('C')).toBe(120_000)
    expect(await appliedRows('C')).toBe(1)
  })

  it('the service: an empty company list does nothing', async () => {
    expect(await applyMissedCarriedBillVariances({ tenantIds: [], dryRun: false })).toMatchObject({ rows: [], summary: { lines: 0 } })
  })
})

// ─── (3) Loyalty earn vs refund race ─────────────────────────────────────────

describe('(3) an earn reversed before its posting lands is never posted; the ledger stays balanced', () => {
  // A tenant of its own (B carries a period lock from (2)).
  let tenantL: string
  let seq = 0
  beforeAll(async () => {
    tenantL = (await prisma.tenant.create({ data: { name: 'R5 Loyalty', slug: `r5b-l-${RUN}` } })).id
    await ensureChartOfAccounts(tenantL)
    invalidateSetupCache()
  })
  const mkEarn = async (points = 500) => {
    seq += 1
    const c = await prisma.customer.create({ data: { name: `r5 ${seq}`, email: `c${seq}.${RUN}@booksr5.test` } })
    const r = await prisma.$transaction((tx) => creditPointsTx(tx, { customerId: c.id, points, tenantId: tenantL, description: `r5 earn ${seq}` }))
    expect(r.credited).toBe(true)
    return prisma.loyaltyTransaction.findUniqueOrThrow({ where: { id: r.txId! } })
  }
  // The refund's claim, exactly as orderPosting.postOrderRefund step 1 does it.
  const claimAndReverse = async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], earn: { id: string; loyaltyAccountId: string; pointsDelta: number }) => {
    const claimed = await tx.loyaltyTransaction.updateMany({ where: { id: earn.id, reversedAt: null }, data: { reversedAt: new Date() } })
    if (claimed.count === 0) return null
    await tx.loyaltyAccount.update({ where: { id: earn.loyaltyAccountId }, data: { pointsBalance: { decrement: earn.pointsDelta }, lifetimePoints: { decrement: earn.pointsDelta } } })
    await tx.loyaltyTransaction.create({ data: { loyaltyAccountId: earn.loyaltyAccountId, type: 'reversal', pointsDelta: -earn.pointsDelta, description: 'r5 reversed earn' } })
    return postLoyaltyReversal(earn.id, { tx, reason: 'r5 refund' })
  }
  const entries = (id: string) => prisma.journalEntry.count({ where: { reference: { in: [`loyalty.earn:${id}`, `loyalty.earn.reversal:${id}`] } } })
  /** Wait until `n` other sessions are blocked on a lock. */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
      if ((row?.n ?? 0) >= n) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timed out waiting for ${n} lock waiter(s)`)
  }

  it('"reversed" is a nothing-to-post outcome', () => {
    expect(LOYALTY_NOTHING_TO_POST.has('reversed')).toBe(true)
  })

  it('claim first, posting after: original_not_booked, then the earn refuses with "reversed" — nothing posted, no flag', async () => {
    const earn = await mkEarn()
    const r = await prisma.$transaction((tx) => claimAndReverse(tx, earn))
    expect(r).toMatchObject({ posted: false, reason: 'original_not_booked' })
    expect(await postLoyaltyEarn(earn.id)).toMatchObject({ posted: false, entryId: null, reason: 'reversed' })
    await bookEarn(earn.id)
    expect(await entries(earn.id)).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', metadata: { path: ['sourceId'], equals: earn.id } } })).toBe(0)
    expect(await imbalance(tenantL)).toBe(0)
  })

  it('the race: the posting read the earn BEFORE the claim committed — it waits on the row lock, then refuses', async () => {
    const earn = await mkEarn()
    let earnPosting: Promise<Awaited<ReturnType<typeof postLoyaltyEarn>>> | null = null
    const reversal = await prisma.$transaction(async (tx) => {
      const r = await claimAndReverse(tx, earn)            // claim held, uncommitted
      earnPosting = postLoyaltyEarn(earn.id)              // reads reversedAt = null, then blocks on FOR UPDATE
      await waitForLockWaiters(1)
      return r
    }, { timeout: 20_000 })
    expect(reversal).toMatchObject({ posted: false, reason: 'original_not_booked' })
    expect(await earnPosting!).toMatchObject({ posted: false, reason: 'reversed' })
    expect(await entries(earn.id)).toBe(0)
    const acct = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: earn.loyaltyAccountId } })
    expect(acct.pointsBalance).toBe(0)
    expect(await imbalance(tenantL)).toBe(0)
  })

  it('the other order: the posting holds the row first — the claim waits, then finds the entry and reverses it (2060 nets to zero)', async () => {
    const earn = await mkEarn()
    // Hold the posting's own advisory lock so it stops after locking the row.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let held!: () => void
    const isHeld = new Promise<void>((r) => { held = r })
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantL}::text), hashtext(${`loyalty.earn:${earn.id}`}::text))`
      held()
      await gate
    }, { timeout: 20_000 })
    await isHeld
    const posting = postLoyaltyEarn(earn.id)                    // locks the row, then waits on the advisory lock
    await waitForLockWaiters(1)
    const refund = prisma.$transaction((tx) => claimAndReverse(tx, earn), { timeout: 20_000 })   // waits on the row
    await waitForLockWaiters(2)
    release()
    await holder
    expect(await posting).toMatchObject({ posted: true })
    expect(await refund).toMatchObject({ posted: true })
    expect(await entries(earn.id)).toBe(2)
    expect(await netOn(tenantL, '2060', [`loyalty.earn:${earn.id}`, `loyalty.earn.reversal:${earn.id}`])).toBe(0)
    expect(await imbalance(tenantL)).toBe(0)
  })

  it('an unreversed earn still posts (and once)', async () => {
    const earn = await mkEarn(200)
    expect(await postLoyaltyEarn(earn.id)).toMatchObject({ posted: true })
    expect(await postLoyaltyEarn(earn.id)).toMatchObject({ posted: false })
    expect(await entries(earn.id)).toBe(1)
    expect(await netOn(tenantL, '2060', [`loyalty.earn:${earn.id}`])).toBeLessThan(0)
    expect(await imbalance(tenantL)).toBe(0)
  })

  it('a redemption given back before it was booked is refused the same way', async () => {
    const earn = await mkEarn(300)
    const redeem = await prisma.loyaltyTransaction.create({
      data: { loyaltyAccountId: earn.loyaltyAccountId, type: 'redeem', pointsDelta: -100, description: 'r5 redeem', reversedAt: new Date() },
    })
    expect(await postLoyaltyRedeem(redeem.id)).toMatchObject({ posted: false, reason: 'reversed' })
    expect(await prisma.journalEntry.count({ where: { reference: `loyalty.redeem:${redeem.id}` } })).toBe(0)
    expect(await imbalance(tenantL)).toBe(0)
  })

  // RV-B-1. The order-completion path chains ensureLoyaltyEarnBooked after
  // bookEarn; orders/service.ts (not this stream's file) checks its own
  // NOTHING_TO_POST, which lacks 'reversed', so a refund that lands before the
  // earn's entry still raises a spurious high posting_failed flag there.
  // `it.fails` until orders/service.ts also honours LOYALTY_NOTHING_TO_POST —
  // then this turns red: change it to `it`.
  it('RV-B-1: a reversed earn through ensureLoyaltyEarnBooked raises no posting_failed flag', async () => {
    const earn = await mkEarn(400)
    await prisma.$transaction((tx) => claimAndReverse(tx, earn))
    const r = await ensureLoyaltyEarnBooked(earn.id, null)
    expect(r.posted).toBe(false)
    expect(await entries(earn.id)).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', metadata: { path: ['sourceId'], equals: earn.id } } })).toBe(0)
  })
})

// ─── (4) RV-B-2: dock receiving without a PO, unit cost above the ceiling ───

describe('(4) a dock receipt without a PO refuses a unit cost no column holds', () => {
  // receiveGoods (procurement/receiving.ts, not this stream's file) checks
  // only that the cost is a non-negative integer; the value reaches
  // goods_receipt_lines.poUnitCostCents / inventory_items.unitCostCents (INT4)
  // and Prisma throws a raw 500. `it.fails` until receiving.ts calls
  // assertAmountFits — then this turns red: change it to `it`.
  it('RV-B-2: a no-PO receipt at PKR 30m a unit is 422 AMOUNT_TOO_LARGE and writes nothing', async () => {
    const sup  = (await prisma.supplier.create({ data: { name: `R5 Dock ${RUN}`, tenantId: tenantA } })).id
    const item = (await prisma.inventoryItem.create({ data: { name: `R5 Saffron ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 100 } })).id
    await expect(receiveGoods({
      actor: { id: users['mgrA']!.id, role: 'boh_management' }, supplierId: sup, photoUrl: 'https://example.test/dock.jpg',
      lines: [{ inventoryItemId: item, quantityReceived: 1, unitCostCents: 3_000_000_000 }],
    })).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
    expect(await prisma.goodsReceipt.count({ where: { supplierId: sup } })).toBe(0)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).unitCostCents).toBe(100)
  })
})
