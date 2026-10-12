// Post-Monday round, stream B — the books.
//
//   (1) BOOKS-06 follow-up: purchase orders, supplier bills, supplier payments
//       and a supplier's opening balance refuse an amount no money column can
//       hold (INT4, PKR 21,474,836.47) — typed or computed (quantity × unit
//       cost, the PO / bill totals) — with 422 AMOUNT_TOO_LARGE before
//       anything is written. It used to be a raw 500 at insert.
//   (2) NEEDS 21: POST /reconciliation/apply-missed-bill-variances — the CEO's
//       catch-up for supplier bills booked before their goods whose carried
//       price difference a pre-hook receipt never applied. Dry run by default,
//       per company in scope (a foreign tenantId is 404), idempotent, and a
//       company whose books are closed through today is 'locked' with nothing
//       applied. Two companies.
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
import { MAX_LINE_CENTS } from '../src/modules/accounting/journal.js'
import { createBill, createPaymentTx, allocatePayment, MAX_AMOUNT_CENTS } from '../src/modules/procurement/service.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { MAX_LINE_CENTS as RECON_MAX_LINE_CENTS } from '../src/modules/reconciliation/service.js'
import { applyReceiptLine, receiveGoods } from '../src/modules/procurement/receiving.js'
import { ensureLoyaltyEarnBooked } from '../src/modules/orders/service.js'
import { applyMissedCarriedBillVariances } from '../src/modules/accounting/supplierPosting.js'
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

// ─── (1) PO / bill / payment amount ceiling ─────────────────────────────────

describe('(1) procurement money inputs and computed totals refuse amounts no column holds — 422, nothing written', () => {
  let supA: string, itemA: string
  beforeAll(async () => {
    supA  = (await prisma.supplier.create({ data: { name: `R5 Mills ${RUN}`, tenantId: tenantA } })).id
    itemA = (await prisma.inventoryItem.create({ data: { name: `R5 Flour ${RUN}`, unit: 'kg', tenantId: tenantA } })).id
  })
  const tooBig = (res: { statusCode: number; body: string; json: () => { error: { code: string; message: string } } }) => {
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect(res.json().error.message).toMatch(/PKR 21,474,836\.47/)
  }

  const tooBigLedger = (res: { statusCode: number; body: string; json: () => { error: { code: string; message: string } } }) => {
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('AMOUNT_TOO_LARGE')
  }

  it('the ceiling is the ledger line ceiling (one shared constant)', () => {
    expect(MAX_AMOUNT_CENTS).toBe(MAX_LINE_CENTS)
    expect(MAX_AMOUNT_CENTS).toBe(2_147_483_647)
    expect(RECON_MAX_LINE_CENTS).toBe(MAX_LINE_CENTS)
  })

  it('PO: a unit cost, a line (qty × cost) or the total above the ceiling is 422; nothing is saved', async () => {
    const before = await prisma.purchaseOrder.count({ where: { supplierId: supA } })
    tooBig(await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: MAX_AMOUNT_CENTS + 1 }],
    }))
    tooBig(await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 30, unitCostCents: 100_000_000 }],   // PKR 1m × 30
    }))
    tooBig(await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [
        { inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1_500_000_000 },
        { inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1_500_000_000 },
      ],
    }))
    expect(await prisma.purchaseOrder.count({ where: { supplierId: supA } })).toBe(before)
  })

  it('PO: exactly the ceiling still fits (201)', async () => {
    const res = await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: MAX_AMOUNT_CENTS }],
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().totalCents).toBe(MAX_AMOUNT_CENTS)
  })

  it('bill: a line total, the tax, or subtotal + tax above the ceiling is 422; no bill and no ledger entry', async () => {
    const bill = (n: string, lines: Array<{ quantity: number; unitCostCents: number }>, taxCents?: number) =>
      call('mgrA', 'POST', '/procurement/bills', {
        supplierId: supA, billNumber: `R5-${n}-${RUN}`, billDate: new Date().toISOString(),
        ...(taxCents !== undefined && { taxCents }),
        lines: lines.map((l) => ({ description: 'flour', ...l })),
      })
    tooBig(await bill('LINE', [{ quantity: 3, unitCostCents: 1_000_000_000 }]))
    tooBig(await bill('TAX', [{ quantity: 1, unitCostCents: 100 }], MAX_AMOUNT_CENTS + 1))
    tooBig(await bill('TOTAL', [{ quantity: 1, unitCostCents: 2_000_000_000 }], 200_000_000))
    tooBig(await bill('SUB', [{ quantity: 1, unitCostCents: 1_200_000_000 }, { quantity: 1, unitCostCents: 1_200_000_000 }]))
    expect(await prisma.supplierBill.count({ where: { supplierId: supA } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { startsWith: 'supplier.bill:' } } })).toBe(0)
  })

  it('payment: an amount or an application above the ceiling is 422 (route and the petty-cash service path)', async () => {
    tooBig(await call('mgrA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: MAX_AMOUNT_CENTS + 1,
    }))
    await expect(prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: 5_000_000_000, createdBy: users['mgrA']!.id,
    }))).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
    expect(await prisma.supplierPayment.count({ where: { supplierId: supA } })).toBe(0)
  })

  it('allocating an application above the ceiling is 422 before anything moves', async () => {
    const p = await prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: 10_000, createdBy: users['mgrA']!.id,
    }))
    await expect(allocatePayment(p.id, [{ billId: '00000000-0000-0000-0000-000000000000', amountAppliedCents: MAX_AMOUNT_CENTS + 5 }]))
      .rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE' })
    tooBig(await call('mgrA', 'POST', `/procurement/payments/${p.id}/allocate`, {
      applications: [{ billId: '00000000-0000-0000-0000-000000000000', amountAppliedCents: MAX_AMOUNT_CENTS + 5 }],
    }))
  })

  it('supplier opening balance above the ceiling is 422 on create and on edit', async () => {
    tooBig(await call('mgrA', 'POST', '/procurement/suppliers', { name: `R5 Big ${RUN}`, openingBalanceCents: 2_500_000_000 }))
    expect(await prisma.supplier.count({ where: { name: `R5 Big ${RUN}` } })).toBe(0)
    tooBig(await call('mgrA', 'PATCH', `/procurement/suppliers/${supA}`, { openingBalanceCents: 2_500_000_000 }))
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supA } })).openingBalanceCents).toBe(0)
  })

  it('the PO approval limit above the ceiling is 422 and unchanged', async () => {
    const before = (await call('ceoA', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents
    tooBig(await call('ceoA', 'PUT', '/procurement/settings/approval-threshold', { thresholdCents: MAX_AMOUNT_CENTS + 1 }))
    expect((await call('ceoA', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents).toBe(before)
  })

  it('reconciliation: a split line on a bank-statement adjustment above the ceiling is 422 before any lookup', async () => {
    tooBigLedger(await call('ceoA', 'POST', '/reconciliation/bank/lines/00000000-0000-0000-0000-000000000000/adjust', {
      memo: 'r5 split', lines: [
        { accountCode: '1010', type: 'debit',  amountCents: MAX_AMOUNT_CENTS + 1 },
        { accountCode: '6080', type: 'credit', amountCents: MAX_AMOUNT_CENTS + 1 },
      ],
    }))
    // Within the ceiling it gets as far as the line lookup (404: no such line).
    expect((await call('ceoA', 'POST', '/reconciliation/bank/lines/00000000-0000-0000-0000-000000000000/adjust', {
      memo: 'r5 split', lines: [
        { accountCode: '1010', type: 'debit',  amountCents: 100 },
        { accountCode: '6080', type: 'credit', amountCents: 100 },
      ],
    })).statusCode).toBe(404)
  })

  it('a normal bill still records and posts (201, balanced)', async () => {
    const res = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `R5-OK-${RUN}`, billDate: new Date().toISOString(), taxCents: 1_800,
      lines: [{ description: 'flour', quantity: 2.5, unitCostCents: 4_000 }],
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ subtotalCents: 10_000, taxCents: 1_800, totalCents: 11_800 })
    expect(await imbalance(tenantA)).toBe(0)
  })
})

// ─── (2) NEEDS 21 — the missed carried-variance catch-up, CEO only ──────────

describe('(2) POST /reconciliation/apply-missed-bill-variances — preview, apply once, per company, locks respected', () => {
  const seeded: Record<'A' | 'B', { item: string; poLineId: string; billId: string; supplier: string }> = {} as never

  // A bill booked before its goods, then the goods received the way receipts
  // worked before receiving applied the carried variance itself.
  async function seed(tenantId: string, key: 'A' | 'B', receiverKey: string, tag: string = key) {
    const supplier = (await prisma.supplier.create({ data: { name: `R5 Butcher ${tag} ${RUN}`, tenantId, paymentTermsDays: 10 } })).id
    const item = (await prisma.inventoryItem.create({ data: { name: `R5 Beef ${tag} ${RUN}`, unit: 'kg', tenantId, currentStock: 0, unitCostCents: 100_000 } })).id
    const po = await prisma.purchaseOrder.create({
      data: { supplierId: supplier, status: 'sent', totalCents: 1_000_000, lines: { create: [{ inventoryItemId: item, quantityOrdered: 10, unitCostCents: 100_000 }] } },
      include: { lines: true },
    })
    const poLineId = po.lines[0]!.id
    const bill = await createBill({
      supplierId: supplier, poId: po.id, billNumber: `R5-CU-${tag}-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId: item, poLineId, description: 'beef', quantity: 10, unitCostCents: 120_000 }],
      createdBy: users[receiverKey]!.id,
    })
    await prisma.$transaction(async (tx) => {
      await tx.goodsReceipt.create({
        data: { poId: po.id, supplierId: supplier, receivedById: users[receiverKey]!.id, status: 'accepted', lines: { create: [{ inventoryItemId: item, description: 'beef', receivedQty: 10, poUnitCostCents: 100_000, unit: 'kg' }] } },
      })
      await applyReceiptLine(tx, { inventoryItemId: item, quantity: 10, unitCostCents: 100_000, supplierId: supplier, poLineId, source: 'po_receive' })
      await tx.purchaseOrderLine.update({ where: { id: poLineId }, data: { quantityReceived: { increment: 10 } } })
    })
    seeded[key] = { item, poLineId, billId: bill.id as string, supplier }
  }
  const cost = async (key: 'A' | 'B') => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: seeded[key].item } })).unitCostCents
  const appliedRows = (key: 'A' | 'B') => prisma.auditLog.count({ where: { entity: 'SupplierBill', entityId: seeded[key].billId, action: 'supplier.bill.variance_applied' } })
  const run = (who: string, body: unknown, headers: Record<string, string> = {}) => call(who, 'POST', '/reconciliation/apply-missed-bill-variances', body, headers)

  beforeAll(async () => {
    await seed(tenantA, 'A', 'ceoA')
    await seed(tenantB, 'B', 'ceoB')
    // Both at the PO price, the bill's 200,000 difference still sitting in 1210.
    expect(await cost('A')).toBe(100_000)
    expect(await cost('B')).toBe(100_000)
  })

  it('CEO only: a manager and finance are 403', async () => {
    expect((await run('mgrA', {})).statusCode).toBe(403)
    expect((await run('finA', {})).statusCode).toBe(403)
  })

  it('a company outside the caller\'s scope is 404', async () => {
    expect((await run('ceoA', { tenantId: tenantB })).statusCode).toBe(404)
    expect((await run('ceoA', { tenantId: tenantB, dryRun: false })).statusCode).toBe(404)
    expect(await cost('B')).toBe(100_000)
  })

  it('preview (the default) lists only the active company\'s line and moves nothing', async () => {
    const res = await run('ceoA', {})
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.dryRun).toBe(true)
    expect(body.tenantIds).toEqual([tenantA])
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ tenantId: tenantA, poLineId: seeded.A.poLineId, quantity: 10, onHandQty: 10, movedCents: null, outcome: 'would_apply' })
    expect(body.rows[0].billNumbers).toEqual([`R5-CU-A-${RUN}`])
    expect(body.summary).toMatchObject({ lines: 1, would_apply: 1 })
    expect(await cost('A')).toBe(100_000)
    expect(await appliedRows('A')).toBe(0)
  })

  it('portfolio preview covers both companies of a CEO in both', async () => {
    const res = await run('ceoAB', {}, { 'x-servd-portfolio': '1' })
    expect(res.statusCode).toBe(200)
    const lines = (res.json().rows as Array<{ poLineId: string; tenantId: string }>).map((r) => `${r.tenantId}|${r.poLineId}`).sort()
    expect(lines).toEqual([`${tenantA}|${seeded.A.poLineId}`, `${tenantB}|${seeded.B.poLineId}`].sort())
  })

  it('apply: A\'s stock re-prices to the billed cost once; B is untouched; the ledger stays balanced; audited', async () => {
    const res = await run('ceoA', { dryRun: false })
    expect(res.statusCode).toBe(200)
    expect(res.json().rows).toHaveLength(1)
    expect(res.json().rows[0]).toMatchObject({ tenantId: tenantA, outcome: 'applied', quantity: 10, movedCents: 200_000 })
    expect(await cost('A')).toBe(120_000)
    expect(await appliedRows('A')).toBe(1)
    expect(await cost('B')).toBe(100_000)
    expect(await appliedRows('B')).toBe(0)
    expect(await imbalance(tenantA)).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'supplier.bill.variance_catch_up', userId: users['ceoA']!.id } })).toBe(1)
  })

  it('idempotent: a second preview and a second apply find nothing', async () => {
    expect((await run('ceoA', {})).json().rows).toHaveLength(0)
    const again = await run('ceoA', { dryRun: false })
    expect(again.json().rows).toHaveLength(0)
    expect(await cost('A')).toBe(120_000)
    expect(await appliedRows('A')).toBe(1)
    // A run with nothing to do writes no audit row.
    expect(await prisma.auditLog.count({ where: { action: 'supplier.bill.variance_catch_up', userId: users['ceoA']!.id } })).toBe(1)
  })

  it('a company whose books are closed through today: listed as locked, nothing applied, ledger untouched', async () => {
    await prisma.periodLock.create({ data: { tenantId: tenantB, lockedThrough: pktToday().to, lockedBy: users['ceoB']!.id, note: 'r5 B lock' } })
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: tenantB } })
    const dry = await run('ceoB', {})
    expect(dry.json().rows).toHaveLength(1)
    expect(dry.json().rows[0]).toMatchObject({ tenantId: tenantB, outcome: 'locked', movedCents: null })
    expect(dry.json().rows[0].detail).toMatch(/closed through/)
    const real = await run('ceoB', { dryRun: false })
    expect(real.statusCode).toBe(200)
    expect(real.json().rows[0]).toMatchObject({ outcome: 'locked', movedCents: null })
    expect(real.json().summary).toMatchObject({ locked: 1 })
    expect(await cost('B')).toBe(100_000)
    expect(await appliedRows('B')).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB } })).toBe(entriesBefore)
  })

  it('a portfolio apply across two companies files one audit row per company, under that company, with only its own lines (RV-B-3)', async () => {
    // B's books reopened; a fresh missed line in A alongside B's still-pending one.
    await prisma.periodLock.deleteMany({ where: { tenantId: tenantB } })
    const keepA = seeded.A
    await seed(tenantA, 'A', 'ceoA', 'A2')
    const freshA = seeded.A
    seeded.A = keepA
    const res = await run('ceoAB', { dryRun: false }, { 'x-servd-portfolio': '1' })
    expect(res.statusCode, res.body).toBe(200)
    const applied = (res.json().rows as Array<{ tenantId: string; poLineId: string; outcome: string }>).map((r) => `${r.tenantId}|${r.poLineId}|${r.outcome}`).sort()
    expect(applied).toEqual([`${tenantA}|${freshA.poLineId}|applied`, `${tenantB}|${seeded.B.poLineId}|applied`].sort())
    expect(await cost('B')).toBe(120_000)
    expect(await imbalance(tenantA)).toBe(0)
    expect(await imbalance(tenantB)).toBe(0)

    const rows = await prisma.auditLog.findMany({
      where:  { action: 'supplier.bill.variance_catch_up', userId: users['ceoAB']!.id },
      select: { tenantId: true, metadata: true, after: true },
    })
    expect(rows).toHaveLength(2)
    const of = (t: string) => rows.find((r) => r.tenantId === t)!
    // B's run is in B's trail even though the operator's home company is A.
    const metaB = of(tenantB).metadata as { tenantId: string; applied: Array<{ poLineId: string }> }
    const metaA = of(tenantA).metadata as { tenantId: string; applied: Array<{ poLineId: string }> }
    expect(metaB.tenantId).toBe(tenantB)
    expect(metaB.applied.map((a) => a.poLineId)).toEqual([seeded.B.poLineId])
    expect(metaA.tenantId).toBe(tenantA)
    expect(metaA.applied.map((a) => a.poLineId)).toEqual([freshA.poLineId])
    // Neither company's row names the other's lines.
    expect(JSON.stringify(of(tenantA))).not.toContain(seeded.B.poLineId)
    expect(JSON.stringify(of(tenantB))).not.toContain(freshA.poLineId)
    expect(of(tenantB).after).toMatchObject({ lines: 1, applied: 1 })
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
