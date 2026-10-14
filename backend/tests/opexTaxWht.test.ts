// OpEx with a vendor, input tax by authority and withholding (finance wave B —
// H8 / H28; the equipment guard; budgets compare the expense).
//
//   • A line names its vendor as a Supplier of the category's company
//     (supplierId wins, fills `vendor`), a WHT section and its usual tax
//     authority. A section needs a vendor (422 VENDOR_REQUIRED_FOR_WHT).
//   • A paid payment: invoice 110,000 with 10,000 SRB input, s.153(1)(b)
//     filer 9% → WHT 9,000 on 100,000, cash 101,000; the entry is Dr 6xxx
//     100,000 / Dr 1322 10,000 / Cr bank 101,000 / Cr 2040 9,000. An edit
//     reposts @2; a reference alone does not.
//   • Rent s.155; an exempt vendor (certificate valid) → 0; the company's
//     switch off → 0; the old cash-only form on a withheld line → 422
//     INVOICE_AMOUNT_REQUIRED; input tax with no authority / too large → 422;
//     an override needs its reason.
//   • Payroll is still skipped; an equipment line → 422 USE_CAPEX (finance
//     may override with a reason, flagged).
//   • /actuals and the list compare the EXPENSE (not the cash, not the
//     entry's debit total); price_drift reads the expense.
//   • Two companies: B's supplier on A's line → 422; B patching A's payment
//     → 404; A's WHT is in A's 2040 only; wht-quote for B → 404.
// Every journal entry written here is checked to balance.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { opexRoutes } from '../src/modules/opex/routes.js'

const stamp = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string
let bankA: string
let guardsA: string, landlordA: string, exemptA: string, plainA: string, supplierB: string
let securityA: string, rentA: string, repairsA: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@opexwht.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined && { payload: payload as never }) })

async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  return je ? { ...je, rows: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), conceptId: l.conceptId, accountTenant: l.account.tenantId })) } : null
}
const amt = (rows: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)
const D = (iso: string) => `${iso}`
let seq = 0
const period = () => {
  // A distinct September period per payment (the tests never depend on it).
  seq += 1
  return { periodStart: D('2026-09-01'), periodEnd: D('2026-09-30'), expectedCents: 100_000 + seq }
}
const line = (categoryId: string, name: string, extra: Record<string, unknown> = {}) =>
  call('adminA', 'POST', '/opex/lines', { categoryId, name, amountCents: 100_000, bankAccountId: bankA, ...extra })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'OpEx WHT A', slug: `opex-wht-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'OpEx WHT B', slug: `opex-wht-b-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'WHT Cafe', slug: `wht-cafe-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  // Withholding on, at the CA placeholders (153(1)(b) 9% / 18%, s.155 15% / 30%).
  await prisma.operationsConfig.create({ data: { tenantId: tenantA, scope: 'global', scopeId: null, withholdingTaxEnabled: true } })
  await prisma.operationsConfig.create({ data: { tenantId: tenantB, scope: 'global', scopeId: null, withholdingTaxEnabled: true } })
  // One bank each.
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL', accountCode: '1020' } })).id
  await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'Meezan', accountCode: '1020' } })
  await prisma.account.create({ data: { tenantId: tenantA, code: '6200', name: 'Security services', type: 'expense', isActive: true } })

  guardsA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Guards A', taxId: '2222222-2', filerStatus: 'filer', defaultTaxAuthority: 'srb' } })).id
  landlordA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Landlord A', filerStatus: 'filer' } })).id
  exemptA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Exempt Co', filerStatus: 'filer', whtExemptCertNo: 'EX-1', whtExemptUntil: new Date('2099-12-31T18:59:59Z') } })).id
  plainA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Plain Co', filerStatus: 'unknown' } })).id
  supplierB = (await prisma.supplier.create({ data: { tenantId: tenantB, name: 'Guards B', filerStatus: 'filer' } })).id

  securityA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Security', expenseAccountCode: '6200', budgetMonthlyCents: 100_000 } })).id
  rentA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Rent', expenseAccountCode: '6010' } })).id
  repairsA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Repairs', expenseAccountCode: '6050' } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(opexRoutes, { prefix: '/opex' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  await app.close()
})

describe('OpEx lines: the vendor is a supplier of the company', () => {
  it('supplierId fills the vendor; a section needs a vendor; B\'s supplier is 422', async () => {
    const l = await line(securityA, 'Guards — Clifton', { supplierId: guardsA, whtSection: '153_1_b', inputTaxAuthority: 'srb', vendor: 'typed name' })
    expect(l.statusCode).toBe(201)
    expect(l.json()).toMatchObject({ supplierId: guardsA, vendor: 'Guards A', whtSection: '153_1_b', inputTaxAuthority: 'srb' })

    const noVendor = await line(securityA, 'Night watch', { whtSection: '153_1_b' })
    expect(noVendor.json().error.code).toBe('VENDOR_REQUIRED_FOR_WHT')
    // 'none' is no section.
    const none = await line(securityA, 'Night watch', { whtSection: 'none' })
    expect(none.statusCode).toBe(201)
    expect(none.json().whtSection).toBeNull()

    const foreign = await line(securityA, 'Guards — B', { supplierId: supplierB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    const patchForeign = await call('adminA', 'PATCH', `/opex/lines/${l.json().id}`, { supplierId: supplierB })
    expect(patchForeign.json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    // Dropping the vendor while the line withholds → 422.
    expect((await call('adminA', 'PATCH', `/opex/lines/${l.json().id}`, { supplierId: null })).json().error.code).toBe('VENDOR_REQUIRED_FOR_WHT')
    // Setting a supplier later fills the vendor name.
    const set = await call('adminA', 'PATCH', `/opex/lines/${none.json().id}`, { supplierId: plainA })
    expect(set.json()).toMatchObject({ supplierId: plainA, vendor: 'Plain Co' })
    // B cannot patch A's line at all.
    expect((await call('adminB', 'PATCH', `/opex/lines/${l.json().id}`, { name: 'x' })).statusCode).toBe(404)
  })
})

describe('OpEx payments: input tax by authority + withholding', () => {
  let lineId: string
  let paymentId: string

  it('SRB-taxed security invoice: WHT 9,000, cash 101,000; Dr 6200 100,000 / Dr 1322 10,000 / Cr bank 101,000 / Cr 2040 9,000', async () => {
    lineId = (await line(securityA, 'Guards — DHA', { supplierId: guardsA, whtSection: '153_1_b', inputTaxAuthority: 'srb', conceptId: conceptA })).json().id
    // The quote first: the page computes nothing.
    const q = await call('adminA', 'GET', `/opex/wht-quote?lineId=${lineId}&invoiceCents=110000&inputTaxCents=10000`)
    expect(q.statusCode).toBe(200)
    expect(q.json()).toEqual({ whtCents: 9_000, rateBps: 900, section: '153_1_b', filerStatus: 'filer', exempt: false, needsAtlCheck: false, cashCents: 101_000, expenseCents: 100_000 })

    const res = await call('adminA', 'POST', '/opex/payments', { lineId, ...period(), invoiceCents: 110_000, inputTaxCents: 10_000, paidAt: '2026-09-25' })
    expect(res.statusCode).toBe(201)
    paymentId = res.json().id
    expect(res.json()).toMatchObject({
      actualCents: 101_000, whtCents: 9_000, whtRateBps: 900, whtSection: '153_1_b', filerStatus: 'filer', inputTaxCents: 10_000, inputTaxAuthority: 'srb',
      amounts: { cashCents: 101_000, whtCents: 9_000, inputTaxCents: 10_000, invoiceCents: 110_000, expenseCents: 100_000 },
    })
    const je = (await entry(`opex.payment:${paymentId}`))!
    expect(je.tenantId).toBe(tenantA)
    expect(je.rows.every((r) => r.accountTenant === tenantA)).toBe(true)
    expect(amt(je.rows, '6200', 'debit')).toBe(100_000)
    expect(amt(je.rows, '1322', 'debit')).toBe(10_000)
    expect(amt(je.rows, '1020', 'credit')).toBe(101_000)
    expect(amt(je.rows, '2040', 'credit')).toBe(9_000)
    expect(je.rows).toHaveLength(4)
    expect(je.rows.find((r) => r.code === '6200')!.conceptId).toBe(conceptA)
  })

  it('an edit reposts @2 (the expense line and the bank picked by account); a reference alone does not', async () => {
    const ref = await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { paymentRef: 'CHQ-9' })
    expect(ref.json().ledger.outcome).toBe('unchanged')
    const edit = await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { invoiceCents: 121_000, inputTaxCents: 11_000 })
    expect(edit.statusCode).toBe(200)
    expect(edit.json()).toMatchObject({ actualCents: 111_100, whtCents: 9_900, ledger: { outcome: 'reposted' } })
    expect(await entry(`opex.payment.reversal:${paymentId}`)).toBeTruthy()
    const je = (await entry(`opex.payment:${paymentId}@2`))!
    expect(amt(je.rows, '6200', 'debit')).toBe(110_000)
    expect(amt(je.rows, '1322', 'debit')).toBe(11_000)
    expect(amt(je.rows, '1020', 'credit')).toBe(111_100)
    expect(amt(je.rows, '2040', 'credit')).toBe(9_900)
    // A category account change later never moves this payment's expense line.
    await prisma.opexCategory.update({ where: { id: securityA }, data: { expenseAccountCode: '6040' } })
    await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { paidAt: '2026-09-26' })
    const je3 = (await entry(`opex.payment:${paymentId}@3`))!
    expect(amt(je3.rows, '6200', 'debit')).toBe(110_000)
    expect(amt(je3.rows, '2040', 'credit')).toBe(9_900)
    await prisma.opexCategory.update({ where: { id: securityA }, data: { expenseAccountCode: '6200' } })
  })

  it('rent: s.155 at 15%', async () => {
    const l = (await line(rentA, 'Shop rent — Clifton', { supplierId: landlordA, whtSection: '155' })).json().id
    const res = await call('adminA', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 200_000, paidAt: '2026-09-05' })
    expect(res.json()).toMatchObject({ actualCents: 170_000, whtCents: 30_000, whtRateBps: 1500, whtSection: '155' })
    const je = (await entry(`opex.payment:${res.json().id}`))!
    expect(amt(je.rows, '6010', 'debit')).toBe(200_000)
    expect(amt(je.rows, '1020', 'credit')).toBe(170_000)
    expect(amt(je.rows, '2040', 'credit')).toBe(30_000)
  })

  it('an exempt vendor (certificate valid) → 0; the switch off → 0', async () => {
    const l = (await line(securityA, 'Cash escort', { supplierId: exemptA, whtSection: '153_1_b' })).json().id
    const ex = await call('adminA', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 50_000, paidAt: '2026-09-06' })
    expect(ex.json()).toMatchObject({ actualCents: 50_000, whtCents: 0, filerStatus: 'exempt' })
    expect(amt((await entry(`opex.payment:${ex.json().id}`))!.rows, '2040', 'credit')).toBe(0)

    await prisma.operationsConfig.updateMany({ where: { tenantId: tenantA }, data: { withholdingTaxEnabled: false } })
    const g = (await line(securityA, 'Gate guard', { supplierId: guardsA, whtSection: '153_1_b' })).json().id
    const off = await call('adminA', 'POST', '/opex/payments', { lineId: g, ...period(), invoiceCents: 60_000, paidAt: '2026-09-07' })
    expect(off.json()).toMatchObject({ actualCents: 60_000, whtCents: 0 })
    // Off, the old cash-only form is fine.
    const cashOnly = await call('adminA', 'POST', '/opex/payments', { lineId: g, ...period(), actualCents: 60_000, paidAt: '2026-09-08' })
    expect(cashOnly.statusCode).toBe(201)
    await prisma.operationsConfig.updateMany({ where: { tenantId: tenantA }, data: { withholdingTaxEnabled: true } })
  })

  it('refusals: a section without a vendor; the cash-only form on a withheld line; input tax with no authority / too large; an override with no reason — nothing saved', async () => {
    const before = await prisma.opexPayment.count()
    const noVendor = (await line(securityA, 'Watchman', {})).json().id
    expect((await call('adminA', 'POST', '/opex/payments', { lineId: noVendor, ...period(), invoiceCents: 10_000, whtSection: '153_1_b', paidAt: '2026-09-09' })).json().error.code).toBe('VENDOR_REQUIRED_FOR_WHT')
    expect((await call('adminA', 'POST', '/opex/payments', { lineId, ...period(), actualCents: 101_000, paidAt: '2026-09-09' })).json().error.code).toBe('INVOICE_AMOUNT_REQUIRED')
    // Plain Co charges no usual authority and the line names none.
    const plain = (await line(securityA, 'Patrol', { supplierId: plainA })).json().id
    expect((await call('adminA', 'POST', '/opex/payments', { lineId: plain, ...period(), invoiceCents: 10_000, inputTaxCents: 1_000, paidAt: '2026-09-09' })).json().error.code).toBe('INPUT_TAX_AUTHORITY_REQUIRED')
    expect((await call('adminA', 'POST', '/opex/payments', { lineId: plain, ...period(), invoiceCents: 10_000, inputTaxCents: 10_000, inputTaxAuthority: 'pra', paidAt: '2026-09-09' })).json().error.code).toBe('INPUT_TAX_TOO_LARGE')
    expect((await call('adminA', 'POST', '/opex/payments', { lineId, ...period(), invoiceCents: 110_000, inputTaxCents: 10_000, whtOverrideCents: 4_000, paidAt: '2026-09-09' })).json().error.code).toBe('WHT_OVERRIDE_REASON_REQUIRED')
    expect(await prisma.opexPayment.count()).toBe(before)

    // With a reason: the override is the withholding, and its reason is kept.
    const ov = await call('adminA', 'POST', '/opex/payments', { lineId, ...period(), invoiceCents: 110_000, inputTaxCents: 10_000, whtOverrideCents: 4_000, whtOverrideReason: 'Reduced-rate certificate 2026-14', paidAt: '2026-09-10' })
    expect(ov.json()).toMatchObject({ whtCents: 4_000, actualCents: 106_000, whtOverrideReason: 'Reduced-rate certificate 2026-14' })
    // Input tax named on the payment wins: PRA → 1321.
    const pra = await call('adminA', 'POST', '/opex/payments', { lineId: plain, ...period(), invoiceCents: 10_000, inputTaxCents: 1_000, inputTaxAuthority: 'pra', paidAt: '2026-09-10' })
    expect(amt((await entry(`opex.payment:${pra.json().id}`))!.rows, '1321', 'debit')).toBe(1_000)
    // An unknown filer status: the filer rate, and the ATL check is asked for.
    const unk = await call('adminA', 'POST', '/opex/payments', { lineId: plain, ...period(), invoiceCents: 10_000, whtSection: '153_1_b', paidAt: '2026-09-10' })
    expect(unk.json()).toMatchObject({ whtCents: 900, filerStatus: 'unknown', needsAtlCheck: true })
  })

  it('a payroll category is still skipped (no posting, no withholding)', async () => {
    const payroll = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Payroll' } })
    const l = (await line(payroll.id, 'Contract staff', { supplierId: guardsA, whtSection: '153_1_b' })).json().id
    const res = await call('adminA', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 50_000, actualCents: 50_000, paidAt: '2026-09-11' })
    expect(res.statusCode).toBe(201)
    expect(res.json().ledger.status).toBe('payroll')
    expect(res.json().whtCents).toBe(0)
    expect(await entry(`opex.payment:${res.json().id}`)).toBeNull()
  })

  it('an equipment line → 422 USE_CAPEX; finance may override with a reason (flagged)', async () => {
    const l = (await line(repairsA, 'Chest freezer')).json().id
    const before = await prisma.opexPayment.count({ where: { lineId: l } })
    const refused = await call('adminA', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 90_000, paidAt: '2026-09-12' })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('USE_CAPEX')
    expect(await prisma.opexPayment.count({ where: { lineId: l } })).toBe(before)
    // A forecast (not paid) books nothing and is not refused.
    expect((await call('adminA', 'POST', '/opex/payments', { lineId: l, ...period() })).statusCode).toBe(201)
    const ok = await call('finA', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 90_000, paidAt: '2026-09-12', notEquipment: true, notEquipmentReason: 'Rental of a freezer for one event' })
    expect(ok.statusCode).toBe(201)
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'equipment_override', entityId: ok.json().id } })
    expect(flag?.tenantId).toBe(tenantA)
  })

  it('budget and variance compare the EXPENSE, not the cash', async () => {
    // Expected 100,000; invoice 120,000 of which 20,000 is input tax → the
    // expense is on budget (the invoice would read +20%, a price jump).
    const l = (await line(securityA, 'Guards — Gulshan', { supplierId: guardsA, whtSection: '153_1_b', inputTaxAuthority: 'srb' })).json().id
    const onBudget = await call('adminA', 'POST', '/opex/payments', { lineId: l, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 100_000, invoiceCents: 120_000, inputTaxCents: 20_000, paidAt: '2026-09-15' })
    expect(onBudget.json().amounts).toMatchObject({ expenseCents: 100_000, cashCents: 111_000 })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'price_drift', entityId: onBudget.json().id } })).toBe(0)
    const jump = await call('adminA', 'POST', '/opex/payments', { lineId: l, periodStart: '2026-10-01', periodEnd: '2026-10-31', expectedCents: 100_000, invoiceCents: 130_000, paidAt: '2026-10-02' })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'price_drift', entityId: jump.json().id } })).toBe(1)

    const actuals = await call('adminA', 'GET', '/opex/actuals?dateFrom=2026-09-15T00:00:00Z&dateTo=2026-09-15T23:59:59Z')
    const sec = (actuals.json().byCategory as Array<{ categoryId: string; postedCents: number; cashCents: number; whtCents: number; inputTaxCents: number }>).find((c) => c.categoryId === securityA)!
    expect(sec).toMatchObject({ postedCents: 100_000, cashCents: 111_000, whtCents: 9_000, inputTaxCents: 20_000 })

    const list = (await call('adminA', 'GET', '/opex/categories')).json() as Array<{ id: string; lines: Array<{ supplier: { name: string } | null; payments: Array<{ id: string; amounts: { expenseCents: number } }> }> }>
    const rows = list.find((c) => c.id === securityA)!.lines
    expect(rows.find((x) => x.payments.some((p) => p.id === onBudget.json().id))!.supplier!.name).toBe('Guards A')
    expect(rows.flatMap((x) => x.payments).find((p) => p.id === onBudget.json().id)!.amounts.expenseCents).toBe(100_000)
  })
})

describe('two companies', () => {
  it('B patching A\'s payment → 404; wht-quote on A\'s line for B → 404; A\'s WHT is in A\'s 2040 only', async () => {
    const l = (await line(securityA, 'Guards — Saddar', { supplierId: guardsA, whtSection: '153_1_b' })).json().id
    const p = await call('adminA', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 100_000, paidAt: '2026-09-20' })
    expect(p.statusCode).toBe(201)
    const patched = await call('adminB', 'PATCH', `/opex/payments/${p.json().id}`, { invoiceCents: 1_000 })
    expect(patched.statusCode).toBe(404)
    expect((await prisma.opexPayment.findUniqueOrThrow({ where: { id: p.json().id } })).whtCents).toBe(9_000)
    expect((await call('adminB', 'GET', `/opex/wht-quote?lineId=${l}&invoiceCents=100000`)).statusCode).toBe(404)
    // B posting a payment on A's line: a row B cannot see (404), nothing saved.
    const countBefore = await prisma.opexPayment.count({ where: { lineId: l } })
    expect((await call('adminB', 'POST', '/opex/payments', { lineId: l, ...period(), invoiceCents: 100_000, paidAt: '2026-09-20' })).statusCode).toBe(404)
    expect(await prisma.opexPayment.count({ where: { lineId: l } })).toBe(countBefore)

    const balance = async (tenantId: string) => {
      const lines = await prisma.journalLine.findMany({ where: { account: { tenantId, code: '2040' } }, select: { type: true, amountCents: true } })
      return lines.reduce((t, x) => t + (x.type === 'credit' ? Number(x.amountCents) : -Number(x.amountCents)), 0)
    }
    expect(await balance(tenantA)).toBeGreaterThan(0)
    expect(await balance(tenantB)).toBe(0)

    // B's own line and payment land in B's books.
    const catB = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Security', expenseAccountCode: '6050' } })
    const lb = await call('adminB', 'POST', '/opex/lines', { categoryId: catB.id, name: 'Guards B', amountCents: 50_000, supplierId: supplierB, whtSection: '153_1_b' })
    expect(lb.statusCode).toBe(201)
    // A's supplier on B's line → 422.
    expect((await call('adminB', 'PATCH', `/opex/lines/${lb.json().id}`, { supplierId: guardsA })).json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    const pb = await call('adminB', 'POST', '/opex/payments', { lineId: lb.json().id, ...period(), invoiceCents: 50_000, paidAt: '2026-09-21' })
    expect(pb.json()).toMatchObject({ whtCents: 4_500, actualCents: 45_500 })
    const je = (await entry(`opex.payment:${pb.json().id}`))!
    expect(je.tenantId).toBe(tenantB)
    expect(je.rows.every((r) => r.accountTenant === tenantB)).toBe(true)
    expect(await balance(tenantB)).toBe(4_500)
  })
})
