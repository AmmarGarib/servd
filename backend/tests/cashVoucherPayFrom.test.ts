// "To pay from" on a finance payee voucher (owner, 2026-10-19): Cash / Bank /
// Credit chosen at raise. Cash and bank prefill finance's pay (the existing
// moneyAccountCode path); credit hands no cash over — finance's pay books a
// SUPPLIER BILL through procurement's own engine (prepareBill + insertBillTx:
// Dr the voucher's 6xxx / Cr 2010, bill number = the voucher number), or, for
// equipment, the CapEx line on that supplier with its capitalisation request
// (the CEO's approval books Dr class cost / Cr 2012). Two companies: B gets 404
// on A's voucher, a supplier of B is 422 on A's voucher.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { applyEvent } from '../src/modules/fixedAssets/events.js'

const P = `cvpf${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const bank: Record<string, string> = {}
const loc: Record<string, string> = {}
const cls: Record<string, string> = {}
let brandA = ''
const sup: Record<string, string> = {}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n')

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cvpf.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })

const V = '/trustops/cash-vouchers'
type Row = {
  id: string; number: string; status: string; amountCents: number; category: string | null; assetClassId: string | null
  assetLocationId: string | null; capexLineId: string | null; capitaliseEventId: string | null; bookedAtPay: boolean
  payJournalEntryId: string | null; pettyCashMovementId: string | null; assetClassLabel: string | null; paidAccountCode?: string | null
}

/** finA raises a payee voucher for equipment; it goes straight to the CEO, who approves. */
async function approvedAsset(extra: Record<string, unknown>, amountCents = 250_000): Promise<Row> {
  const r = await call('finA', 'POST', V, { kind: 'expense', payeeName: 'Cool Tech Traders', purpose: `Chiller ${Math.random().toString(36).slice(2, 7)}`, amountCents, ...extra })
  expect(r.statusCode, r.body).toBe(201)
  const v = r.json() as Row
  const a = await call('ceoA', 'POST', `${V}/${v.id}/approve`, {})
  expect(a.statusCode, a.body).toBe(200)
  return a.json() as Row
}
async function entryLines(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, orderBy: { createdAt: 'desc' }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents
beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Asset Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Asset Co B', slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) { await ensureChartOfAccounts(t); await ensureAssetClasses(t) }
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('cashA', 'cashier', [T.A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }) }, { prefix: '/api/v1' })
  await app.ready()

  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Finance box', custodianId: U['finA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  const r = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box['A'], type: 'topup', amountCents: 1_000_000, reason: 'Float from Garibsons', source: 'garibsons' })
  expect(r.statusCode, r.body).toBe(201)
  if (!(await prisma.account.findFirst({ where: { tenantId: T.A, code: '1021' } }))) {
    await prisma.account.create({ data: { tenantId: T.A, code: '1021', name: 'Bank — HBL', type: 'asset', isActive: true } })
  }
  bank['A'] = (await prisma.bankAccount.create({ data: { tenantId: T.A, name: 'HBL Ops', bankName: 'HBL', accountCode: '1021', isActive: true } })).id
  loc['A'] = (await prisma.location.create({ data: { slug: `${P}-la`, name: 'Clifton', tenantId: T.A } })).id
  loc['B'] = (await prisma.location.create({ data: { slug: `${P}-lb`, name: 'B outlet', tenantId: T.B } })).id
  brandA = (await prisma.concept.create({ data: { name: 'Asset Cafe', slug: `${P}-c`, type: 'restaurant', tenantId: T.A, taxRateCash: 15, taxRateCard: 8 } })).id
  for (const t of ['A', 'B'] as const) {
    cls[t] = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: T[t], key: 'kitchen_equipment' } })).id
  }
  sup['A'] = (await prisma.supplier.create({ data: { name: 'Cool Tech Traders', tenantId: T.A, paymentTermsDays: 30, filerStatus: 'filer' } })).id
  sup['B'] = (await prisma.supplier.create({ data: { name: 'B Traders', tenantId: T.B, paymentTermsDays: 30, filerStatus: 'filer' } })).id
  cls['A_small'] = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: T.A, key: 'smallwares' } })).id
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})


async function raise(body: Record<string, unknown>): Promise<Row & Record<string, unknown>> {
  const r = await call('finA', 'POST', V, { kind: 'expense', payeeName: 'Fast Couriers', purpose: `Courier charges ${Math.random().toString(36).slice(2, 7)}`, categoryKey: 'transport', amountCents: 30_000, ...body })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}
async function approve(id: string): Promise<void> {
  const a = await call('ceoA', 'POST', `${V}/${id}/approve`, {})
  expect(a.statusCode, a.body).toBe(200)
}
const voucherEntries = async (id: string) =>
  prisma.journalEntry.count({ where: { tenantId: T.A, reference: { startsWith: 'cashvoucher.' }, AND: { reference: { contains: id } } } })

describe('"To pay from" at raise', () => {
  it('validates the plan in the voucher\'s company and only on a payee voucher', async () => {
    const code = async (who: string, body: Record<string, unknown>) =>
      (await call(who, 'POST', V, { kind: 'expense', payeeName: 'X', purpose: 'Courier', categoryKey: 'transport', amountCents: 1_000, ...body })).json().error?.code
    expect(await code('finA', { payFrom: 'credit' })).toBe('SUPPLIER_REQUIRED')
    expect(await code('finA', { payFrom: 'credit', supplierId: sup['B'] })).toBe('SUPPLIER_NOT_IN_COMPANY')
    expect(await code('finA', { payFrom: 'cash', supplierId: sup['A'] })).toBe('SUPPLIER_ONLY_ON_CREDIT')
    expect(await code('finA', { payFrom: 'cash', payFromBankAccountId: bank['A'] })).toBe('BANK_NOT_FOR_SOURCE')
    expect((await call('cookA', 'POST', V, { purpose: 'Courier', categoryKey: 'transport', amountCents: 1_000, payFrom: 'cash' })).json().error.code)
      .toBe('PAY_FROM_ONLY_ON_PAYEE_VOUCHER')
    const v = await raise({ payFrom: 'credit', supplierId: sup['A'] })
    expect(v).toMatchObject({ payFrom: 'credit', supplierId: sup['A'], supplierName: 'Cool Tech Traders' })
    // Company B never sees it.
    expect((await call('finB', 'GET', `${V}/${v.id}`)).statusCode).toBe(404)
    expect((await call('finB', 'PATCH', `${V}/${v.id}`, { supplierId: sup['B'] })).statusCode).toBe(404)
    // Re-pointing it at B's supplier from A is 422.
    expect((await call('finA', 'PATCH', `${V}/${v.id}`, { supplierId: sup['B'] })).json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
  })
})

describe('cash / bank prefill finance\'s pay', () => {
  it('bank: pay with no source uses the planned bank', async () => {
    const v = await raise({ payFrom: 'bank', payFromBankAccountId: bank['A'] })
    await approve(v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().voucher).toMatchObject({ paySource: 'bank', payAccountCode: '1021', payBankAccountId: bank['A'] })
    expect(await entryLines(`cashvoucher.pay:${v.id}`)).toEqual([['1021', 'credit', 30_000], ['6140', 'debit', 30_000]])
  })
  it('cash: cash on hand by default — finance may still pick another source at pay', async () => {
    const v = await raise({ payFrom: 'cash' })
    await approve(v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, {})
    expect(r.json().voucher).toMatchObject({ paySource: 'cash_on_hand', payAccountCode: '1010' })
    const w = await raise({ payFrom: 'cash' })
    await approve(w.id)
    const f0 = await floatOf(box['A']!)
    const r2 = await call('finA', 'POST', `${V}/${w.id}/pay`, { source: 'box', boxId: box['A'] })
    expect(r2.statusCode, r2.body).toBe(200)
    expect(await floatOf(box['A']!)).toBe(f0 - 30_000)
  })
})

describe('credit: finance\'s pay books a supplier bill', () => {
  it('ONE bill + its entry Dr 6xxx / Cr 2010, no cash entry; once; B 404', async () => {
    const v = await raise({ payFrom: 'credit', supplierId: sup['A'], conceptId: brandA })
    await approve(v.id)
    const f0 = await floatOf(box['A']!)
    expect((await call('finB', 'POST', `${V}/${v.id}/pay`, {})).statusCode).toBe(404)
    // Only finance books it.
    expect((await call('ceoA', 'POST', `${V}/${v.id}/pay`, {})).json().error.code).toBe('PAY_FINANCE_ONLY')
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { bankAccountId: bank['A'] })).json().error.code).toBe('BANK_NOT_FOR_SOURCE')
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { billDueDate: '2026-11-30' })
    expect(r.statusCode, r.body).toBe(200)
    const out = r.json() as { voucher: Record<string, unknown> & { supplierBill: { id: string; billNumber: string; status: string } } }
    expect(out.voucher).toMatchObject({ status: 'disbursed', paySource: 'credit', bookedAtPay: true, paidFrom: 'On credit — Cool Tech Traders', paidAccountCode: '2010' })
    const bills = await prisma.supplierBill.findMany({ where: { supplierId: sup['A'], billNumber: v.number }, include: { lines: true } })
    expect(bills).toHaveLength(1)
    expect(bills[0]!).toMatchObject({ status: 'open' })
    expect(Number(bills[0]!.totalCents)).toBe(30_000)
    expect(bills[0]!.dueDate.toISOString().slice(0, 10)).toBe('2026-11-30')
    expect(bills[0]!.lines.map((l) => [l.expenseAccountCode, Number(l.lineTotalCents)])).toEqual([['6140', 30_000]])
    expect(out.voucher.supplierBill.id).toBe(bills[0]!.id)
    expect(await entryLines(`supplier.bill:${bills[0]!.id}`)).toEqual([['2010', 'credit', 30_000], ['6140', 'debit', 30_000]])
    // No cash left: no voucher pay entry, no box movement.
    expect(await voucherEntries(v.id)).toBe(0)
    expect(await floatOf(box['A']!)).toBe(f0)
    expect(await prisma.pettyCashMovement.count({ where: { cashVoucherId: v.id } })).toBe(0)
    // Booking twice: 409.
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, {})).json().error.code).toBe('ALREADY_PAID')
    expect(await prisma.supplierBill.count({ where: { supplierId: sup['A'], billNumber: v.number } })).toBe(1)
    // The documents check books nothing.
    const n0 = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    await call('finA', 'POST', `${V}/${v.id}/documents`, { fileName: 'inv.pdf', mime: 'application/pdf', dataBase64: PDF.toString('base64') })
    expect((await call('ceoA', 'POST', `${V}/${v.id}/verify-docs`, {})).statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(n0)
  })

  it('pay-time choice of credit names a supplier of the voucher\'s company; equipment-looking purpose is USE_CAPEX', async () => {
    const v = await raise({})
    await approve(v.id)
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'credit' })).json().error.code).toBe('SUPPLIER_REQUIRED')
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { source: 'credit', supplierId: sup['B'] })).json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    const eq = await raise({ purpose: 'New deep freezer for the kitchen', categoryKey: 'repairs', payFrom: 'credit', supplierId: sup['A'] })
    await approve(eq.id)
    expect((await call('finA', 'POST', `${V}/${eq.id}/pay`, {})).json().error.code).toBe('USE_CAPEX')
    expect(await prisma.supplierBill.count({ where: { billNumber: eq.number, supplierId: sup['A'] } })).toBe(0)
  })

  it('equipment on credit: the CapEx line on the supplier, no entry until the CEO capitalises it → Dr cost / Cr 2012', async () => {
    const v = await raise({ categoryKey: undefined, purpose: 'Blast chiller', amountCents: 500_000, assetClassId: cls['A'], assetLocationId: loc['A'], payFrom: 'credit', supplierId: sup['A'] })
    await approve(v.id)
    const n0 = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, {})
    expect(r.statusCode, r.body).toBe(200)
    const paid = r.json().voucher as Row & { paySource: string; supplierBill: unknown }
    expect(paid).toMatchObject({ paySource: 'credit', bookedAtPay: true, supplierBill: null })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(n0)
    const line = await prisma.capexLine.findUniqueOrThrow({ where: { id: paid.capexLineId! } })
    expect(line).toMatchObject({ supplierId: sup['A'], treatment: 'capital', status: 'delivered' })
    expect(await prisma.capexPayment.count({ where: { lineId: line.id } })).toBe(0)
    expect(await prisma.supplierBill.count({ where: { billNumber: v.number } })).toBe(0)
    const ev = await applyEvent(paid.capitaliseEventId!, U['ceoA']!.id)
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ev.journalEntryId! }, include: { lines: { include: { account: { select: { code: true } } } } } })
    const lines = je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()
    const cost = (await prisma.fixedAssetClass.findUniqueOrThrow({ where: { id: cls['A']! } })).costAccountCode
    expect(lines).toEqual([['2012', 'credit', 500_000], [cost, 'debit', 500_000]].sort())
  })
})

describe('payment classification chosen at raise (2026-10-20)', () => {
  const clsOf = async (entryRef: string) => {
    const je = await prisma.journalEntry.findFirst({ where: { tenantId: T.A, reference: entryRef }, select: { id: true } })
    return je ? prisma.paymentClassification.findUnique({ where: { journalEntryId: je.id } }) : null
  }
  it('finance sets it at raise; the pay stamps it on the payment entry in the voucher\'s company', async () => {
    const v = await raise({ payFrom: 'cash', classification: 'unofficial', taxStatus: 'not_deducted', nonDeductionReason: 'Payee is an unregistered courier' })
    expect(v).toMatchObject({ classification: 'unofficial', taxStatus: 'not_deducted' })
    await approve(v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await clsOf(`cashvoucher.pay:${v.id}`)).toMatchObject({ tenantId: T.A, classification: 'unofficial', taxStatus: 'not_deducted' })
  })
  it('a pick at pay overrides the planned one', async () => {
    const v = await raise({ payFrom: 'cash', classification: 'unofficial' })
    await approve(v.id)
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { classification: 'official', taxStatus: 'not_applicable' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await clsOf(`cashvoucher.pay:${v.id}`)).toMatchObject({ classification: 'official' })
  })
  it('only finance / the CEO set it; reason rule; company B 404', async () => {
    expect((await call('cookA', 'POST', V, { purpose: 'Courier', categoryKey: 'transport', amountCents: 1_000, classification: 'official' })).json().error.code)
      .toBe('CLASSIFICATION_FINANCE_ONLY')
    expect((await call('finA', 'POST', V, { kind: 'expense', payeeName: 'X', purpose: 'Courier', categoryKey: 'transport', amountCents: 1_000, classification: 'official', taxStatus: 'not_deducted' })).statusCode).toBe(422)
    const v = await raise({ classification: 'official', sendTo: 'finance' })
    expect((await call('finB', 'PATCH', `${V}/${v.id}`, { classification: 'unofficial' })).statusCode).toBe(404)
    const p = await call('finA', 'PATCH', `${V}/${v.id}`, { classification: null })
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json()).toMatchObject({ classification: null, taxStatus: null })
  })
})
