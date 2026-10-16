// Finance module final (owner, 2026-10-16) — AP group, items 3, 4, 15, 16,
// 17, 30, 31. Two companies (A, B) throughout.
//
//   3  A PO with a bill booked before delivery (a 'pending' GrniMatch) cannot
//      be cancelled (409 PO_BILLED_AHEAD); after the bill is voided it can;
//      a bill ahead of delivery on a CANCELLED PO is 409 PO_CANCELLED.
//   4  A supplier opening balance the ledger refuses (closed month) is flagged
//      posting_failed (sourceType supplier.opening, metadata.documentDate) —
//      never only logged — and is dated at the opening date, not today; the
//      backfill (REPOSTERS 'supplier.opening') posts it once the cause is
//      gone, and the flag closes.
//  15  Finance with 'accounting' records supplier bills, credit notes and
//      bank / cheque payments (and voids, applies, unapplies them); company
//      B's finance gets 404 on A's rows; finance without 'accounting' and a
//      manager without 'procurement' are refused; PO writes stay closed.
//  16  PUT /accounting/withholding/enabled {enabled, reason}: finance switches
//      withholding on for its ACTIVE company only, reason ≥10, audited.
//  17  GET /procurement/ap-aging?asOf=YYYY-MM-DD rebuilds the aging as at that
//      day and ties to AP 2010 as at that day.
//  30  Company-less (legacy) suppliers are listed to the CEO only.
//  31  A payment date or due date that is not a date is 422 INVALID_DATE.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { linkBankLedgerAccount } from '../src/lib/bankAccounts.js'
import { createBill, createPayment, voidBill } from '../src/modules/procurement/service.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { withholdingRoutes } from '../src/modules/accounting/withholdingRoutes.js'
import { syncOpeningBalanceOrFlag } from '../src/modules/procurement/openingBalance.js'
import { backfillUnpostedOrders } from '../src/modules/reconciliation/backfillOrders.js'
import { parsePktEndOfDay, fmtPktDate } from '../src/modules/accounting/dates.js'

const RUN = Math.random().toString(36).slice(2, 8)
let A: string
let B: string
let supA: string
let supB: string
let orphan: string
let bankA: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, extra: { moduleDeny?: string[]; moduleAllow?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@apfinal.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, isActive: true, accountStatus: 'active', tenantId: primary,
      moduleDeny: extra.moduleDeny ?? [], moduleAllow: extra.moduleAllow ?? [],
    },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const day = (offsetDays: number) => fmtPktDate(new Date(Date.now() + offsetDays * 86_400_000))

async function ap2010(tenantId: string, asOf?: Date): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code: '2010' }, journalEntry: { tenantId, ...(asOf ? { entryDate: { lte: asOf } } : {}) } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'credit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}

const expenseBill = (supplierId: string, number: string, cents: number, billDate = day(0), dueDate?: string) => ({
  supplierId, billNumber: number, billDate, ...(dueDate ? { dueDate } : {}),
  lines: [{ description: 'Cleaning supplies', quantity: 1, unitCostCents: cents, expenseAccountCode: '6040' }],
})

beforeAll(async () => {
  invalidateSetupCache()
  A = (await prisma.tenant.create({ data: { name: `APF A ${RUN}`, slug: `apf-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `APF B ${RUN}`, slug: `apf-b-${RUN}` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  supA = (await prisma.supplier.create({ data: { name: `Mill ${RUN}`, tenantId: A, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  supB = (await prisma.supplier.create({ data: { name: `B Veg ${RUN}`, tenantId: B, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  orphan = (await prisma.supplier.create({ data: { name: `Nobody ${RUN}`, tenantId: null, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  await prisma.supplierBill.create({
    data: {
      supplierId: orphan, billNumber: `N-${RUN}`, billDate: new Date(), dueDate: new Date(),
      subtotalCents: 1_234, totalCents: 1_234, status: 'open',
      lines: { create: [{ description: 'legacy', quantity: 1, unitCostCents: 1_234, lineTotalCents: 1_234 }] },
    },
  })
  const code = await linkBankLedgerAccount(A, `APF Bank ${RUN}`)
  bankA = (await prisma.bankAccount.create({ data: { tenantId: A, name: `APF Bank ${RUN}`, bankName: 'HBL', accountCode: code } })).id

  await mkUser('ceo', 'admin', A)
  await prisma.tenantMember.create({ data: { tenantId: B, userId: users['ceo']!.id } as never }).catch(() => {})
  await mkUser('finA', 'finance', A)
  await mkUser('finB', 'finance', B)
  await mkUser('finNoAcct', 'finance', A, { moduleDeny: ['accounting'] })
  // A manager who holds accounting but not procurement gets nothing new.
  await mkUser('mgrNoProc', 'foh_management', A, { moduleAllow: ['accounting'], moduleDeny: ['procurement'] })
  await mkUser('cashier', 'cashier', A)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/api/v1/procurement' })
  await app.register(withholdingRoutes, { prefix: '/api/v1/accounting/withholding' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

// ── 15 ──────────────────────────────────────────────────────────────────────
describe('finance records supplier bills, credit notes and payments (item 15)', () => {
  it('finance (accounting) records a bill, a credit note and a bank payment, applies and voids — each audited', async () => {
    const bill = await call('finA', 'POST', '/api/v1/procurement/bills', expenseBill(supA, `F-1-${RUN}`, 50_000))
    expect(bill.statusCode, bill.body).toBe(201)
    const billId = (bill.json() as { id: string }).id
    const billLine = await prisma.supplierBillLine.findFirstOrThrow({ where: { billId } })
    expect(await prisma.auditLog.count({ where: { action: 'supplier.bill.create', entityId: billId, tenantId: A } })).toBe(1)

    const cn = await call('finA', 'POST', `/api/v1/procurement/bills/${billId}/credit-notes`, {
      number: `CN-1-${RUN}`, date: day(0), reason: 'price', applyToBill: false,
      lines: [{ billLineId: billLine.id, qty: 1, unitCostCents: 5_000 }],
    })
    expect(cn.statusCode, cn.body).toBe(201)
    const cnId = (cn.json() as { id: string }).id
    const apply = await call('finA', 'POST', `/api/v1/procurement/credit-notes/${cnId}/apply`, { applications: [{ billId, amountCents: 5_000 }] })
    expect(apply.statusCode, apply.body).toBe(200)
    expect((await call('finA', 'POST', `/api/v1/procurement/credit-notes/${cnId}/unapply`, { billId })).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/api/v1/procurement/credit-notes/${cnId}/void`, { reason: 'entered twice' })).statusCode).toBe(200)

    const pay = await call('finA', 'POST', '/api/v1/procurement/payments', {
      supplierId: supA, paymentDate: day(0), method: 'cheque', bankAccountId: bankA, reference: `CHQ-${RUN}`, amountCents: 20_000,
    })
    expect(pay.statusCode, pay.body).toBe(201)
    const payId = (pay.json() as { id: string }).id
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A, reference: `supplier.payment:${payId}` }, include: { lines: { include: { account: true } } } })
    const bankCode = (await prisma.bankAccount.findUniqueOrThrow({ where: { id: bankA } })).accountCode
    expect(je.lines.some((l) => l.type === 'credit' && l.account.code === bankCode)).toBe(true)
    const alloc = await call('finA', 'POST', `/api/v1/procurement/payments/${payId}/allocate`, { applications: [{ billId, amountAppliedCents: 20_000 }] })
    expect(alloc.statusCode, alloc.body).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'supplier.payment.allocate', entityId: payId, tenantId: A } })).toBe(1)
    expect((await call('finA', 'POST', `/api/v1/procurement/payments/${payId}/unapply`, { billId })).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/api/v1/procurement/payments/${payId}/void`, { reason: 'bounced cheque' })).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/api/v1/procurement/bills/${billId}/void`, { reason: 'wrong supplier' })).statusCode).toBe(200)
  })

  it('company B\'s finance gets 404 on company A\'s supplier, bill and payment', async () => {
    expect((await call('finB', 'POST', '/api/v1/procurement/bills', expenseBill(supA, `F-X-${RUN}`, 1_000))).statusCode).toBe(404)
    const b = await createBill({ ...expenseBill(supA, `F-2-${RUN}`, 9_000), createdBy: users['ceo']!.id })
    expect((await call('finB', 'POST', `/api/v1/procurement/bills/${b.id}/void`, { reason: 'not mine' })).statusCode).toBe(404)
    expect((await call('finB', 'POST', `/api/v1/procurement/bills/${b.id}/credit-notes`, {
      number: `CN-X-${RUN}`, date: day(0), reason: 'price', lines: [{ billLineId: b.id, qty: 1, unitCostCents: 1 }],
    })).statusCode).toBe(404)
    const p = await createPayment({ supplierId: supA, paymentDate: day(0), method: 'cash', amountCents: 1_000, createdBy: users['ceo']!.id })
    expect((await call('finB', 'POST', `/api/v1/procurement/payments/${p.id}/void`, { reason: 'not mine' })).statusCode).toBe(404)
    expect((await call('finB', 'POST', '/api/v1/procurement/payments', { supplierId: supA, paymentDate: day(0), method: 'cash', amountCents: 1_000 })).statusCode).toBe(404)
    // B's finance pays B's own supplier.
    expect((await call('finB', 'POST', '/api/v1/procurement/payments', { supplierId: supB, paymentDate: day(0), method: 'cash', amountCents: 1_000 })).statusCode).toBe(201)
  })

  it('finance without accounting, a manager without procurement and a cashier are refused; PO writes stay closed to finance', async () => {
    expect((await call('finNoAcct', 'POST', '/api/v1/procurement/bills', expenseBill(supA, `F-3-${RUN}`, 1_000))).statusCode).toBe(403)
    expect((await call('mgrNoProc', 'POST', '/api/v1/procurement/bills', expenseBill(supA, `F-4-${RUN}`, 1_000))).statusCode).toBe(403)
    expect((await call('cashier', 'POST', '/api/v1/procurement/payments', { supplierId: supA, paymentDate: day(0), method: 'cash', amountCents: 1 })).statusCode).toBe(403)
    expect((await call('finA', 'POST', '/api/v1/procurement/purchase-orders', { supplierId: supA, lines: [] })).statusCode).toBe(403)
    expect((await call('finA', 'POST', '/api/v1/procurement/suppliers', { name: 'x' })).statusCode).toBe(403)
  })
})

// ── 31 ──────────────────────────────────────────────────────────────────────
describe('an invalid date is 422, never 500 (item 31)', () => {
  it('payment date and due date', async () => {
    const pay = await call('finA', 'POST', '/api/v1/procurement/payments', { supplierId: supA, paymentDate: '31/10/2026', method: 'cash', amountCents: 1_000 })
    expect(pay.statusCode).toBe(422)
    expect(pay.json().error.code).toBe('INVALID_DATE')
    const bill = await call('finA', 'POST', '/api/v1/procurement/bills', expenseBill(supA, `F-D-${RUN}`, 1_000, day(0), 'next friday'))
    expect(bill.statusCode).toBe(422)
    expect(bill.json().error.code).toBe('INVALID_DATE')
    expect(await prisma.supplierBill.count({ where: { billNumber: `F-D-${RUN}` } })).toBe(0)
  })
})

// ── 3 ───────────────────────────────────────────────────────────────────────
describe('a PO billed ahead of delivery cannot be cancelled (item 3)', () => {
  it('409 PO_BILLED_AHEAD while the pending match stands; voiding the bill frees it; billing ahead on a cancelled PO is refused', async () => {
    const item = (await prisma.inventoryItem.create({ data: { name: `Prawns ${RUN}`, unit: 'kg', tenantId: A, currentStock: 0, unitCostCents: 1_000 } })).id
    const mkPo = async () => {
      const po = await prisma.purchaseOrder.create({
        data: { supplierId: supA, status: 'sent', totalCents: 8_000, lines: { create: [{ inventoryItemId: item, quantityOrdered: 8, unitCostCents: 1_000 }] } },
        include: { lines: true },
      })
      return { poId: po.id, poLineId: po.lines[0]!.id }
    }
    const { poId, poLineId } = await mkPo()
    const b = await createBill({
      supplierId: supA, poId, billNumber: `AHEAD-${RUN}`, billDate: day(0),
      lines: [{ inventoryItemId: item, poLineId, description: 'prawns', quantity: 8, unitCostCents: 1_000 }],
      createdBy: users['ceo']!.id,
    })
    expect(await prisma.grniMatch.count({ where: { billId: b.id, status: 'pending' } })).toBe(1)

    const refused = await call('ceo', 'POST', `/api/v1/procurement/purchase-orders/${poId}/cancel`, { reason: 'supplier out of stock' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('PO_BILLED_AHEAD')
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('sent')

    // Company B cannot even see it.
    expect((await call('finB', 'POST', `/api/v1/procurement/purchase-orders/${poId}/cancel`, { reason: 'x' })).statusCode).toBe(403)

    await voidBill(b.id, users['ceo']!.id, 'goods never coming')
    const ok = await call('ceo', 'POST', `/api/v1/procurement/purchase-orders/${poId}/cancel`, { reason: 'supplier out of stock' })
    expect(ok.statusCode, ok.body).toBe(200)

    // A bill ahead of delivery on the cancelled PO: nothing can arrive on it.
    await expect(createBill({
      supplierId: supA, poId, billNumber: `AHEAD2-${RUN}`, billDate: day(0),
      lines: [{ inventoryItemId: item, poLineId, description: 'prawns', quantity: 8, unitCostCents: 1_000 }],
      createdBy: users['ceo']!.id,
    })).rejects.toMatchObject({ code: 'PO_CANCELLED' })
    expect(await prisma.supplierBill.count({ where: { billNumber: `AHEAD2-${RUN}` } })).toBe(0)
  })
})

// ── 4 ───────────────────────────────────────────────────────────────────────
describe('a refused supplier opening balance is flagged and dated at its opening date (item 4)', () => {
  it('flags posting_failed with the document date, then the backfill posts it on its own date and closes the flag', async () => {
    const openingDay = day(-20)
    const sup = (await prisma.supplier.create({
      data: { name: `Opening ${RUN}`, tenantId: A, filerStatus: 'filer', openingBalanceCents: 33_000, openingBalanceDate: new Date(`${openingDay}T00:00:00Z`) },
    })).id
    // The books are closed through the opening date: the posting is refused.
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: parsePktEndOfDay(day(-10)), lockedBy: users['ceo']!.id } })
    const r = await syncOpeningBalanceOrFlag(sup, { postedBy: users['ceo']!.id })
    expect(r.ok).toBe(false)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'Supplier', entityId: sup, status: 'open' } })
    expect(flag.tenantId).toBe(A)
    const meta = flag.metadata as Record<string, unknown>
    expect(meta['sourceType']).toBe('supplier.opening')
    expect(String(meta['documentDate']).slice(0, 10)).toBe(openingDay)
    // Only in its own company.
    expect(await prisma.exceptionFlag.count({ where: { tenantId: B, entityId: sup } })).toBe(0)

    // The CEO reopens; the backfill posts it on its own (opening) date.
    await prisma.periodLock.delete({ where: { id: lock.id } })
    await backfillUnpostedOrders({ tenantIds: [A], dryRun: false, postedBy: users['finA']!.id })
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A, reference: { startsWith: `supplier.opening:${sup}:` } } })
    expect(fmtPktDate(je.entryDate)).toBe(openingDay)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flag.id } })).status).toBe('resolved')
    // A second run posts nothing more.
    await backfillUnpostedOrders({ tenantIds: [A], dryRun: false })
    expect(await prisma.journalEntry.count({ where: { tenantId: A, reference: { startsWith: `supplier.opening:${sup}:` } } })).toBe(1)
  })

  it('a supplier with no opening date posts at the day it was set up, not today', async () => {
    const createdAt = new Date(Date.now() - 5 * 86_400_000)
    const sup = (await prisma.supplier.create({ data: { name: `Opening2 ${RUN}`, tenantId: A, filerStatus: 'filer', openingBalanceCents: 1_500, createdAt } })).id
    expect((await syncOpeningBalanceOrFlag(sup)).ok).toBe(true)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A, reference: { startsWith: `supplier.opening:${sup}:` } } })
    expect(je.entryDate.getTime()).toBe(createdAt.getTime())
  })
})

// ── 16 ──────────────────────────────────────────────────────────────────────
describe('finance switches withholding on (item 16)', () => {
  const enabledOf = async (tenantId: string) =>
    (await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } }))?.withholdingTaxEnabled ?? false

  it('finance turns it on for its active company with a reason; audited; B untouched; repeat is 409', async () => {
    expect((await call('finA', 'PUT', '/api/v1/accounting/withholding/enabled', { enabled: true, reason: 'short' })).statusCode).toBe(400)
    const on = await call('finA', 'PUT', '/api/v1/accounting/withholding/enabled', { enabled: true, reason: 'CA confirmed the rates for FY27' })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json().enabled).toBe(true)
    expect(await enabledOf(A)).toBe(true)
    expect(await enabledOf(B)).toBe(false)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'withholding.switch', tenantId: A } })
    expect((a.metadata as Record<string, unknown>)['reason']).toBe('CA confirmed the rates for FY27')
    expect((await call('finA', 'PUT', '/api/v1/accounting/withholding/enabled', { enabled: true, reason: 'CA confirmed the rates again' })).statusCode).toBe(409)
    // B's finance switches only B.
    expect((await call('finB', 'PUT', '/api/v1/accounting/withholding/enabled', { enabled: true, reason: 'B goes live with WHT' })).statusCode).toBe(200)
    expect(await enabledOf(B)).toBe(true)
    // Off again for A, as A's finance.
    expect((await call('finA', 'PUT', '/api/v1/accounting/withholding/enabled', { enabled: false, reason: 'Paused until next month' })).statusCode).toBe(200)
    expect(await enabledOf(A)).toBe(false)
    expect(await enabledOf(B)).toBe(true)
  })

  it('a cashier is refused', async () => {
    expect((await call('cashier', 'PUT', '/api/v1/accounting/withholding/enabled', { enabled: true, reason: 'I would like to' })).statusCode).toBe(403)
  })
})

// ── 17 / 30 ─────────────────────────────────────────────────────────────────
describe('AP aging as at a past date ties to 2010 (item 17); legacy company-less suppliers for the CEO only (item 30)', () => {
  it('ties to AP 2010 as at the date, excluding later bills and payments', async () => {
    const T = (await prisma.tenant.create({ data: { name: `APF T ${RUN}`, slug: `apf-t-${RUN}` } })).id
    await ensureChartOfAccounts(T)
    await prisma.tenantMember.create({ data: { tenantId: T, userId: users['finA']!.id } as never })
    const sup = (await prisma.supplier.create({ data: { name: `Aging ${RUN}`, tenantId: T, paymentTermsDays: 10, filerStatus: 'filer' } })).id
    const asOfDay = day(-10)
    const early = await createBill({ ...expenseBill(sup, `AG-1-${RUN}`, 40_000, day(-30), day(-20)), createdBy: users['ceo']!.id })
    await createBill({ ...expenseBill(sup, `AG-2-${RUN}`, 10_000, day(-15), day(-5)), createdBy: users['ceo']!.id })
    // Paid part before asOf, the rest after; a later bill too.
    await createPayment({ supplierId: sup, paymentDate: day(-12), method: 'cash', amountCents: 15_000, applications: [{ billId: early.id, amountAppliedCents: 15_000 }], createdBy: users['ceo']!.id })
    await createPayment({ supplierId: sup, paymentDate: day(-2), method: 'cash', amountCents: 25_000, applications: [{ billId: early.id, amountAppliedCents: 25_000 }], createdBy: users['ceo']!.id })
    await createBill({ ...expenseBill(sup, `AG-3-${RUN}`, 7_000, day(-1)), createdBy: users['ceo']!.id })

    const headers = { authorization: `Bearer ${users['finA']!.token}`, 'x-servd-active-tenant': T }
    const past = await app.inject({ method: 'GET', url: `/api/v1/procurement/ap-aging?asOf=${asOfDay}`, headers })
    expect(past.statusCode, past.body).toBe(200)
    const r = past.json() as { total: { total: number; '1_30': number; current: number } }
    expect(r.total.total).toBe(await ap2010(T, parsePktEndOfDay(asOfDay)))
    expect(r.total.total).toBe(25_000 + 10_000)
    expect(r.total['1_30']).toBe(25_000)       // AG-1 due 10 days before asOf, 15,000 paid by then
    expect(r.total.current).toBe(10_000)       // AG-2 not yet due at asOf

    const now = await app.inject({ method: 'GET', url: '/api/v1/procurement/ap-aging', headers })
    expect((now.json() as { total: { total: number } }).total.total).toBe(await ap2010(T))
    expect((await app.inject({ method: 'GET', url: '/api/v1/procurement/ap-aging?asOf=31-10-2026', headers })).statusCode).toBe(400)
  })

  it('a company-less supplier is listed to the CEO, never to finance', async () => {
    const fin = (await call('finA', 'GET', '/api/v1/procurement/ap-aging')).json() as { unassigned: { bySupplier: Array<{ supplierId: string }> } }
    expect(fin.unassigned.bySupplier).toEqual([])
    const ceo = (await call('ceo', 'GET', '/api/v1/procurement/ap-aging')).json() as { unassigned: { bySupplier: Array<{ supplierId: string }> } }
    expect(ceo.unassigned.bySupplier.map((s) => s.supplierId)).toContain(orphan)
  })
})
