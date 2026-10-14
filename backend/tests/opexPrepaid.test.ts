// OpEx prepaid treatment (H25) and refundable deposits.
//
//   • A 'prepaid' payment (rent paid ahead) needs its coverage — coversFrom
//     (YYYY-MM) + coversMonths, else 422 PREPAID_TERM_REQUIRED — and posts
//     Dr 1310 Prepaid Expenses (the expense: invoice − input tax) instead of
//     the expense account; input tax and withholding post as for any payment.
//     The monthly release is accounting/prepaidReleases.ts (source
//     'opex_payment'), which books to the category's account — so the
//     category must be mapped (422 CATEGORY_NOT_MAPPED) and a different code
//     named on the payment is refused (422 PREPAID_USES_CATEGORY_ACCOUNT).
//   • Before any release, it may switch back to an expense (reposted @2).
//     Once a release exists: its amount, treatment, coverage and paid state
//     are fixed (409 PREPAID_RELEASING), nothing saved.
//   • A refundable deposit is never OpEx: 422 DEPOSIT_USE_CAPEX.
//   • Two companies: B cannot touch A's prepaid payment (404).
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
let tenantA: string, tenantB: string
let rentA: string, unmappedA: string, landlordA: string, bankA: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@opexprepaid.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined && { payload: payload as never }) })

async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), conceptId: l.conceptId })) : null
}
const amt = (rows: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)
const base = { periodStart: '2026-09-01', periodEnd: '2026-12-31', expectedCents: 600_000 }

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Prepaid A', slug: `prepaid-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Prepaid B', slug: `prepaid-b-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  await prisma.operationsConfig.create({ data: { tenantId: tenantA, scope: 'global', scopeId: null, withholdingTaxEnabled: true } })
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL', accountCode: '1020' } })).id
  landlordA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Landlord A', filerStatus: 'filer' } })).id
  rentA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Rent', expenseAccountCode: '6010' } })).id
  unmappedA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Sundry leases' } })).id

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

describe('OpEx prepaid (H25)', () => {
  let lineId: string
  let paymentId: string

  it('needs its coverage; posts Dr 1310 (with withholding) instead of the expense', async () => {
    lineId = (await call('adminA', 'POST', '/opex/lines', { categoryId: rentA, name: 'Shop rent — 4 months ahead', amountCents: 600_000, cadence: 'quarterly', bankAccountId: bankA, supplierId: landlordA, whtSection: '155' })).json().id
    const before = await prisma.opexPayment.count()
    const noTerm = await call('adminA', 'POST', '/opex/payments', { lineId, ...base, invoiceCents: 600_000, paidAt: '2026-09-01', treatment: 'prepaid' })
    expect(noTerm.statusCode).toBe(422)
    expect(noTerm.json().error.code).toBe('PREPAID_TERM_REQUIRED')
    expect((await call('adminA', 'POST', '/opex/payments', { lineId, ...base, invoiceCents: 600_000, paidAt: '2026-09-01', treatment: 'prepaid', coversFrom: '2026-09' })).json().error.code).toBe('PREPAID_TERM_REQUIRED')
    expect((await call('adminA', 'POST', '/opex/payments', { lineId, ...base, invoiceCents: 600_000, paidAt: '2026-09-01', treatment: 'prepaid', coversFrom: '2026-13', coversMonths: 4 })).statusCode).toBe(400)
    expect(await prisma.opexPayment.count()).toBe(before)

    const res = await call('adminA', 'POST', '/opex/payments', { lineId, ...base, invoiceCents: 600_000, paidAt: '2026-09-01', treatment: 'prepaid', coversFrom: '2026-09', coversMonths: 4 })
    expect(res.statusCode).toBe(201)
    paymentId = res.json().id
    expect(res.json()).toMatchObject({ treatment: 'prepaid', coversFrom: '2026-09', coversMonths: 4, whtCents: 90_000, actualCents: 510_000 })
    const je = (await entry(`opex.payment:${paymentId}`))!
    expect(amt(je, '1310', 'debit')).toBe(600_000)
    expect(amt(je, '6010', 'debit')).toBe(0)
    expect(amt(je, '1020', 'credit')).toBe(510_000)
    expect(amt(je, '2040', 'credit')).toBe(90_000)
  })

  it('a prepaid payment needs the category\'s account (its release books there)', async () => {
    const l = (await call('adminA', 'POST', '/opex/lines', { categoryId: unmappedA, name: 'Kiosk lease', amountCents: 100_000, bankAccountId: bankA })).json().id
    const res = await call('adminA', 'POST', '/opex/payments', { lineId: l, ...base, invoiceCents: 100_000, paidAt: '2026-09-02', treatment: 'prepaid', coversFrom: '2026-09', coversMonths: 2 })
    expect(res.json().error.code).toBe('CATEGORY_NOT_MAPPED')
    // A code named on a prepaid payment of a mapped category would be lost behind 1310: refused.
    const named = await call('adminA', 'POST', '/opex/payments', { lineId, ...base, invoiceCents: 100_000, paidAt: '2026-09-02', treatment: 'prepaid', coversFrom: '2026-09', coversMonths: 2, expenseAccountCode: '6040' })
    expect(named.json().error.code).toBe('PREPAID_USES_CATEGORY_ACCOUNT')
  })

  it('before any release it may switch back to an expense (reposted @2)', async () => {
    const res = await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { treatment: 'expense' })
    expect(res.statusCode).toBe(200)
    const je = (await entry(`opex.payment:${paymentId}@2`))!
    expect(amt(je, '6010', 'debit')).toBe(600_000)
    expect(amt(je, '1310', 'debit')).toBe(0)
    // …and back to prepaid (@3).
    const back = await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { treatment: 'prepaid' })
    expect(back.statusCode).toBe(200)
    expect(amt((await entry(`opex.payment:${paymentId}@3`))!, '1310', 'debit')).toBe(600_000)
  })

  it('once released: amount, treatment, coverage and paid state are fixed (409), nothing saved', async () => {
    // The release engine's row (accounting/prepaidReleases.ts) for September.
    await prisma.prepaidRelease.create({ data: { tenantId: tenantA, sourceType: 'opex_payment', sourceId: paymentId, period: '2026-09', amountCents: 150_000 } })
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    for (const body of [
      { invoiceCents: 700_000 },
      { treatment: 'expense' },
      { coversMonths: 6 },
      { paidAt: null },
    ]) {
      const r = await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, body)
      expect({ body, status: r.statusCode, code: r.json().error?.code }).toEqual({ body, status: 409, code: 'PREPAID_RELEASING' })
    }
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(entriesBefore)
    const p = await prisma.opexPayment.findUniqueOrThrow({ where: { id: paymentId } })
    expect(p).toMatchObject({ treatment: 'prepaid', coversMonths: 4, actualCents: 510_000 })
    expect(p.paidAt).not.toBeNull()
    // A note is still fine.
    expect((await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { paymentRef: 'TRF-1' })).statusCode).toBe(200)
  })

  it('a refundable deposit is never OpEx → 422 DEPOSIT_USE_CAPEX', async () => {
    const res = await call('adminA', 'POST', '/opex/payments', { lineId, ...base, invoiceCents: 300_000, paidAt: '2026-09-03', treatment: 'deposit' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('DEPOSIT_USE_CAPEX')
    expect((await call('adminA', 'PATCH', `/opex/payments/${paymentId}`, { treatment: 'deposit' })).json().error.code).toBe('DEPOSIT_USE_CAPEX')
  })

  it('two companies: B cannot touch A\'s prepaid payment', async () => {
    expect((await call('adminB', 'PATCH', `/opex/payments/${paymentId}`, { treatment: 'expense' })).statusCode).toBe(404)
  })
})
