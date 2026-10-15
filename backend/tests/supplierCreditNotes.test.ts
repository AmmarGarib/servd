// Supplier credit notes / returns (finance gaps 14a).
//
// What this guards:
//   - A credit note is a SupplierBill of kind 'credit_note' against its bill,
//     posted in the same transaction: Dr 2010 (total − WHT share) + Dr 2040
//     (WHT share, pro rata) / Cr 1210 (the goods, at the FIFO value of the
//     lots they left, or the on-hand share of a price credit) / Cr 1320 (its
//     tax) — balanced; a price credit on stock already used goes to 5060 and
//     the bill's lot is re-priced (wave B: FIFO lots).
//   - Goods sent back leave the bill's own lots (never more than is left in
//     them — 422 OVER_RETURN and nothing saved); a 'short' credit moves no
//     stock.
//   - It can never credit more than the bill (per line, tax, total).
//   - It is applied to its bill (or another open bill of the same supplier);
//     billDueCents = total − WHT − paid − credited drives the bill's status,
//     the AP aging (unapplied credit = a credit) and the statement, and the
//     company's aging total still equals ledger AP 2010.
//   - Void only while unapplied: the entry is reversed, stock comes back, item
//     cost is restored; voiding twice is a no-op. A bill with a live credit
//     note can't be voided until the credit note is.
//   - A closed month is 422 and nothing is saved (stock included).
//   - Company B gets 404 on company A's bill and credit notes; a payment can't
//     be applied to a credit note row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createBill, createPayment, agingReport, billDueCents } from '../src/modules/procurement/service.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { consumeFifoTx } from '../src/lib/stockLedger.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

let tenantA: string
let tenantB: string
let supA: string
let supA2: string
let supB: string
let flour: string        // stock item, cost PKR 10.00
let oil: string          // stock item, cost PKR 5.00
let bill1: { id: string; lineId: string }      // 10 flour @ 1,000 + tax 1,700
let bill2: { id: string; lineId: string }      // 10 oil @ 500
let bill3: string                                // another A Mills bill
let billOther: string                            // A's other supplier's bill
let billB: string                                // company B's bill
let cnReturn: string
let cnPrice: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.suppcn@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const today = () => new Date().toISOString()

async function entryLines(reference: string, tenantId: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { reference, tenantId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je?.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents) })) ?? null
}

async function ledgerAp(tenantId: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code: '2010' } })
  const sums = await prisma.journalLine.groupBy({ by: ['type'], where: { accountId: acct.id }, _sum: { amountCents: true } })
  const cr = Number(sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0)
  const dr = Number(sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0)
  return cr - dr
}

async function item(id: string) {
  return prisma.inventoryItem.findUniqueOrThrow({ where: { id }, select: { currentStock: true, unitCostCents: true } })
}

/** A delivery taken at the dock (no PO) — its receipt line, to bill against. */
async function dock(itemId: string, qty: number, unitCostCents: number): Promise<string> {
  const r = await receiveGoods({
    actor: { id: users['ceoA']!.id, role: 'admin' }, supplierId: supA, photoUrl: 'https://example.com/dock.jpg',
    lines: [{ inventoryItemId: itemId, quantityReceived: qty, unitCostCents }],
  })
  return r.receipt.lines[0]!.id
}

/** Stock used (out of the lots, oldest first). */
let used = 0
const useStock = (itemId: string, qty: number) => prisma.$transaction((tx) => consumeFifoTx(tx, {
  tenantId: tenantA, inventoryItemId: itemId, qty, kind: 'waste', sourceType: 'test.use', sourceId: `use-${++used}`, clamp: false, occurredAt: new Date(),
}))

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SCN A', slug: 'scn-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SCN B', slug: 'scn-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  // A withholds 4.5% at source.
  await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: tenantA, withholdingTaxEnabled: true, withholdingTaxPct: 0.045 } })
  invalidateSetupCache()

  supA  = (await prisma.supplier.create({ data: { name: 'A Mills', tenantId: tenantA, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  supA2 = (await prisma.supplier.create({ data: { name: 'A Dairy', tenantId: tenantA, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  supB  = (await prisma.supplier.create({ data: { name: 'B Farms', tenantId: tenantB, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  flour = (await prisma.inventoryItem.create({ data: { name: 'Flour', unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 1_000 } })).id
  oil   = (await prisma.inventoryItem.create({ data: { name: 'Oil', unit: 'l', tenantId: tenantA, currentStock: 0, unitCostCents: 500 } })).id

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)

  // Stock is received at the dock first (one lot each), then billed against its receipt.
  const flourRl = await dock(flour, 10, 1_000)
  const oilRl = await dock(oil, 10, 500)
  const b1 = await createBill({
    supplierId: supA, billNumber: 'INV-1', billDate: today(), taxCents: 1_700,
    lines: [{ inventoryItemId: flour, receiptLineId: flourRl, description: 'Flour', quantity: 10, unitCostCents: 1_000 }], createdBy: users['ceoA']!.id,
  })
  bill1 = { id: b1.id, lineId: b1.lines[0]!.id }
  const b2 = await createBill({
    supplierId: supA, billNumber: 'INV-2', billDate: today(),
    lines: [{ inventoryItemId: oil, receiptLineId: oilRl, description: 'Oil', quantity: 10, unitCostCents: 500 }], createdBy: users['ceoA']!.id,
  })
  bill2 = { id: b2.id, lineId: b2.lines[0]!.id }
  bill3 = (await createBill({ supplierId: supA, billNumber: 'INV-3', billDate: today(), lines: [{ description: 'Cleaning cloths', quantity: 1, unitCostCents: 3_000, expenseAccountCode: '6040' }], createdBy: users['ceoA']!.id })).id
  billOther = (await createBill({ supplierId: supA2, billNumber: 'D-1', billDate: today(), lines: [{ description: 'Detergent', quantity: 1, unitCostCents: 3_000, expenseAccountCode: '6040' }], createdBy: users['ceoA']!.id })).id
  billB = (await createBill({ supplierId: supB, billNumber: 'B-1', billDate: today(), lines: [{ description: 'Detergent', quantity: 1, unitCostCents: 3_000, expenseAccountCode: '6040' }], createdBy: users['ceoB']!.id })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

describe('recording a credit note / return', () => {
  it('company B gets 404 on company A\'s bill; nothing is saved', async () => {
    const res = await call('ceoB', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-X', date: today(), reason: 'return', lines: [{ billLineId: bill1.lineId, qty: 1 }],
    })
    expect(res.statusCode).toBe(404)
    expect(await prisma.supplierBill.count({ where: { kind: 'credit_note' } })).toBe(0)
  })

  it('a return: stock goes back, the entry is balanced and net of the WHT share, the bill owes less', async () => {
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-1', date: today(), reason: 'return', returnStock: true, taxCents: 680,
      lines: [{ billLineId: bill1.lineId, qty: 4 }],
    })
    expect(res.statusCode).toBe(201)
    const cn = res.json()
    cnReturn = cn.id
    expect(cn).toMatchObject({ kind: 'credit_note', originalBillId: bill1.id, subtotalCents: 4_000, taxCents: 680, totalCents: 4_680, whtCents: 180, appliedCents: 4_500, status: 'applied' })
    expect(cn.lines[0]).toMatchObject({ inventoryItemId: flour, quantity: 4, returnQty: 4, poLineId: null })

    expect((await item(flour)).currentStock).toBe(6)
    const lines = await entryLines(`supplier.credit_note:${cnReturn}`, tenantA)
    expect(lines).toEqual(expect.arrayContaining([
      { code: '2010', type: 'debit', amount: 4_500 },
      { code: '2040', type: 'debit', amount: 180 },
      { code: '1210', type: 'credit', amount: 4_000 },
      { code: '1320', type: 'credit', amount: 680 },
    ]))
    const dr = lines!.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0)
    const cr = lines!.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0)
    expect(dr).toBe(cr)

    const b = await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill1.id } })
    expect(Number(b.creditedCents)).toBe(4_500)
    expect(billDueCents(b)).toBe(11_700 - 450 - 4_500)
    expect(b.status).toBe('partially_paid')
  })

  it('never more than the bill: per line, unit price and tax', async () => {
    const overLine = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-BIG', date: today(), reason: 'price', lines: [{ billLineId: bill1.lineId, qty: 10, unitCostCents: 1_000 }],
    })
    expect(overLine.statusCode).toBe(422)
    expect(overLine.json().error.code).toBe('OVER_CREDIT')

    const overUnit = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-BIG', date: today(), reason: 'price', lines: [{ billLineId: bill1.lineId, qty: 1, unitCostCents: 1_001 }],
    })
    expect(overUnit.statusCode).toBe(422)
    expect(overUnit.json().error.code).toBe('OVER_CREDIT')

    const overTax = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-BIG', date: today(), reason: 'price', taxCents: 1_100, lines: [{ billLineId: bill1.lineId, qty: 1, unitCostCents: 100 }],
    })
    expect(overTax.statusCode).toBe(422)
    expect(overTax.json().error.code).toBe('CREDIT_TAX_EXCEEDS_BILL')

    const overReturn = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-BIG', date: today(), reason: 'return', returnStock: true, lines: [{ billLineId: bill1.lineId, qty: 7 }],
    })
    expect(overReturn.statusCode).toBe(422)
    expect(overReturn.json().error.code).toBe('OVER_RETURN')
    expect(await prisma.supplierBill.count({ where: { billNumber: 'CN-BIG' } })).toBe(0)
  })

  it('a return never takes more than is left in the bill\'s own lots — 422 and nothing saved', async () => {
    await useStock(flour, 5)   // 1 kg of the bill's lot left
    const creditable = (await call('ceoA', 'GET', `/procurement/bills/${bill1.id}`)).json().creditable
    expect(creditable.lines[0].returnableQty).toBe(1)
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-NEG', date: today(), reason: 'return', returnStock: true, lines: [{ billLineId: bill1.lineId, qty: 2 }],
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('OVER_RETURN')
    expect(await prisma.supplierBill.count({ where: { billNumber: 'CN-NEG' } })).toBe(0)
    expect((await item(flour)).currentStock).toBe(1)
  })

  it('a closed month is 422 and nothing is saved, stock included', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date(Date.now() - 5 * 86_400_000), lockedBy: users['ceoA']!.id } })
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/credit-notes`, {
      number: 'CN-LOCK', date: new Date(Date.now() - 10 * 86_400_000).toISOString(), reason: 'return', returnStock: true,
      lines: [{ billLineId: bill1.lineId, qty: 1 }],
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.supplierBill.count({ where: { billNumber: 'CN-LOCK' } })).toBe(0)
    expect((await item(flour)).currentStock).toBe(1)
    await prisma.periodLock.delete({ where: { id: lock.id } })
  })

  it('a price credit on stock partly used: the share on hand re-prices the bill\'s lot, the used share goes to 5060', async () => {
    // 6 of the 10 litres billed are already used.
    await useStock(oil, 6)
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill2.id}/credit-notes`, {
      number: 'CN-2', date: today(), reason: 'price', applyToBill: false,
      lines: [{ billLineId: bill2.lineId, unitCostCents: 100 }],          // PKR 1 off each of the 10 litres
    })
    expect(res.statusCode).toBe(201)
    const cn = res.json()
    cnPrice = cn.id
    expect(cn).toMatchObject({ subtotalCents: 1_000, whtCents: 45, appliedCents: 0, status: 'open' })
    expect(await entryLines(`supplier.credit_note:${cnPrice}`, tenantA)).toEqual(expect.arrayContaining([
      { code: '2010', type: 'debit', amount: 955 },
      { code: '2040', type: 'debit', amount: 45 },
      { code: '1210', type: 'credit', amount: 400 },
      { code: '5060', type: 'credit', amount: 600 },
    ]))
    expect(await item(oil)).toEqual({ currentStock: 4, unitCostCents: 400 })

    // Unapplied, it is a credit on the AP aging.
    const row = (await agingReport([tenantA])).bySupplier.find((r) => r.supplierId === supA)!
    expect(row.creditNotesCents).toBe(955)
  })

  it('a return leaves the bill\'s own lot (at the billed price); its void puts it all back', async () => {
    // Received at PKR 8.00, billed at PKR 10.00: the bill re-priced the lot.
    const sugar = (await prisma.inventoryItem.create({ data: { name: 'Sugar', unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 800 } })).id
    const rl = await dock(sugar, 5, 800)
    const b = await createBill({
      supplierId: supA, billNumber: 'INV-4', billDate: today(),
      lines: [{ inventoryItemId: sugar, receiptLineId: rl, description: 'Sugar', quantity: 5, unitCostCents: 1_000 }], createdBy: users['ceoA']!.id,
    })
    expect(await item(sugar)).toEqual({ currentStock: 5, unitCostCents: 1_000 })
    const res = await call('ceoA', 'POST', `/procurement/bills/${b.id}/credit-notes`, {
      number: 'CN-SUGAR', date: today(), reason: 'return', returnStock: true, applyToBill: false,
      lines: [{ billLineId: b.lines[0]!.id, qty: 2 }],
    })
    expect(res.statusCode).toBe(201)
    // 2 kg leave the lot at 10.00 (2,000) — exactly the credit: no 5060.
    expect(await item(sugar)).toEqual({ currentStock: 3, unitCostCents: 1_000 })
    const lines = await entryLines(`supplier.credit_note:${res.json().id}`, tenantA)
    expect(lines).toEqual(expect.arrayContaining([{ code: '1210', type: 'credit', amount: 2_000 }]))
    expect(lines!.some((l) => l.code === '5060')).toBe(false)

    const v = await call('ceoA', 'POST', `/procurement/credit-notes/${res.json().id}/void`, { reason: 'supplier refused the return' })
    expect(v.statusCode).toBe(200)
    expect(await item(sugar)).toEqual({ currentStock: 5, unitCostCents: 1_000 })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.credit_note.void.price:${res.json().id}` } })).toBe(0)
  })

  it('a short delivery credit on received goods moves no stock (it re-prices the bill\'s lot)', async () => {
    const before = await item(oil)
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill2.id}/credit-notes`, {
      number: 'CN-SHORT', date: today(), reason: 'short', lines: [{ billLineId: bill2.lineId, qty: 1, unitCostCents: 400 }],
    })
    expect(res.statusCode).toBe(201)
    expect((await item(oil)).currentStock).toBe(before.currentStock)
    // 4 of the lot's 10 litres are on hand: 160 off the lot, 240 to 5060.
    expect(await entryLines(`supplier.credit_note:${res.json().id}`, tenantA)).toEqual(expect.arrayContaining([
      { code: '1210', type: 'credit', amount: 160 },
      { code: '5060', type: 'credit', amount: 240 },
    ]))
  })
})

describe('applying a credit note', () => {
  it('to another open bill of the same supplier; never another supplier\'s (422) or company\'s (404)', async () => {
    const other = await call('ceoA', 'POST', `/procurement/credit-notes/${cnPrice}/apply`, { applications: [{ billId: billOther, amountCents: 100 }] })
    expect(other.statusCode).toBe(400)
    expect(other.json().error.code).toBe('SUPPLIER_MISMATCH')
    const foreign = await call('ceoA', 'POST', `/procurement/credit-notes/${cnPrice}/apply`, { applications: [{ billId: billB, amountCents: 100 }] })
    expect(foreign.statusCode).toBe(404)
    const tooMuch = await call('ceoA', 'POST', `/procurement/credit-notes/${cnPrice}/apply`, { applications: [{ billId: bill3, amountCents: 956 }] })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json().error.code).toBe('OVER_ALLOCATED')

    const ok = await call('ceoA', 'POST', `/procurement/credit-notes/${cnPrice}/apply`, { applications: [{ billId: bill3, amountCents: 955 }] })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ appliedCents: 955, status: 'applied' })
    const b3 = await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill3 } })
    expect(Number(b3.creditedCents)).toBe(955)
    expect(b3.status).toBe('partially_paid')
  })

  it('company B gets 404 on company A\'s credit notes, and never lists them', async () => {
    expect((await call('ceoB', 'POST', `/procurement/credit-notes/${cnPrice}/apply`, { applications: [{ billId: billB, amountCents: 1 }] })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/procurement/credit-notes/${cnPrice}/void`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/procurement/credit-notes/${cnPrice}/unapply`, { billId: bill3 })).statusCode).toBe(404)
    const listB = (await call('ceoB', 'GET', '/procurement/bills?kind=credit_note')).json() as Array<{ id: string }>
    expect(listB).toHaveLength(0)
    const listA = (await call('ceoA', 'GET', '/procurement/bills?kind=credit_note')).json() as Array<{ id: string; originalBill: { billNumber: string } | null }>
    expect(listA.find((c) => c.id === cnReturn)?.originalBill?.billNumber).toBe('INV-1')
    // Bills only by default — the petty-cash and allocation pickers never see a credit note.
    const bills = (await call('ceoA', 'GET', '/procurement/bills')).json() as Array<{ id: string }>
    expect(bills.some((b) => b.id === cnReturn)).toBe(false)
  })

  it('a payment can\'t be applied to a credit note row', async () => {
    await expect(createPayment({
      supplierId: supA, paymentDate: today(), method: 'cash', amountCents: 100,
      applications: [{ billId: cnPrice, amountAppliedCents: 100 }], createdBy: users['ceoA']!.id,
    })).rejects.toMatchObject({ code: 'NOT_A_BILL' })
  })

  it('the statement lists credit notes, and the company\'s aging total still equals ledger AP 2010', async () => {
    const st = (await call('ceoA', 'GET', `/procurement/suppliers/${supA}/statement`)).json()
    expect(st.creditNotes.map((c: { billNumber: string }) => c.billNumber).sort()).toEqual(['CN-1', 'CN-2', 'CN-SHORT', 'CN-SUGAR'])
    expect(st.creditNotes.find((c: { billNumber: string }) => c.billNumber === 'CN-SUGAR').status).toBe('void')
    expect(st.bills.every((b: { kind: string }) => b.kind === 'bill')).toBe(true)
    const aging = await agingReport([tenantA], { includeUnassigned: false })
    expect(aging.total.total).toBe(await ledgerAp(tenantA))
  })
})

describe('voiding a credit note', () => {
  it('the bill can\'t be voided while a live credit note stands against it', async () => {
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/void`, { reason: 'wrong bill' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('HAS_CREDITS')
  })

  it('only while unapplied; then the entry is reversed, stock comes back, once', async () => {
    const applied = await call('ceoA', 'POST', `/procurement/credit-notes/${cnReturn}/void`, { reason: 'entered twice' })
    expect(applied.statusCode).toBe(422)
    expect(applied.json().error.code).toBe('CREDIT_NOTE_APPLIED')

    const un = await call('ceoA', 'POST', `/procurement/credit-notes/${cnReturn}/unapply`, { billId: bill1.id })
    expect(un.statusCode).toBe(200)
    expect(un.json()).toMatchObject({ amountCents: 4_500, billStatus: 'open' })
    const b1 = await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill1.id } })
    expect(Number(b1.creditedCents)).toBe(0)

    const stockBefore = (await item(flour)).currentStock
    const res = await call('ceoA', 'POST', `/procurement/credit-notes/${cnReturn}/void`, { reason: 'entered twice' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('void')
    expect((await item(flour)).currentStock).toBe(stockBefore + 4)
    expect(await entryLines(`supplier.credit_note.void:${cnReturn}`, tenantA)).toEqual(expect.arrayContaining([
      { code: '2010', type: 'credit', amount: 4_500 },
      { code: '2040', type: 'credit', amount: 180 },
      { code: '1210', type: 'debit', amount: 4_000 },
      { code: '1320', type: 'debit', amount: 680 },
    ]))
    const twice = await call('ceoA', 'POST', `/procurement/credit-notes/${cnReturn}/void`, { reason: 'again' })
    expect(twice.statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.credit_note.void:${cnReturn}` } })).toBe(1)
    expect((await item(flour)).currentStock).toBe(stockBefore + 4)
  })

  it('voiding a price credit restores the item\'s cost', async () => {
    expect((await call('ceoA', 'POST', `/procurement/credit-notes/${cnPrice}/unapply`, { billId: bill3 })).statusCode).toBe(200)
    const res = await call('ceoA', 'POST', `/procurement/credit-notes/${cnPrice}/void`, { reason: 'supplier withdrew it' })
    expect(res.statusCode).toBe(200)
    // CN-SHORT (still live) keeps 400 off the lot: (5,000 − 400) / 10.
    expect(await item(oil)).toEqual({ currentStock: 4, unitCostCents: 460 })
    // Nothing used since: no true-up needed.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.credit_note.void.price:${cnPrice}` } })).toBe(0)
  })

  it('after its credit notes are void and payments unapplied, the bill can be voided; aging still ties', async () => {
    const res = await call('ceoA', 'POST', `/procurement/bills/${bill1.id}/void`, { reason: 'wrong bill' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('void')
    const aging = await agingReport([tenantA], { includeUnassigned: false })
    expect(aging.total.total).toBe(await ledgerAp(tenantA))
  })
})
