// The withholding register (finance wave B, H8 / H28 —
// GET /accounting/withholding/register): one row per income-tax deduction
// from supplier bills (posted, not void, net of their live credit notes),
// paid OpEx payments and paid CapEx payments, for the CA's s.165 statement.
//
//   • A's rows never appear for B (and B's never for A); "All companies"
//     shows every company the operator belongs to.
//   • A credit note's withholding nets against its bill; a void / draft bill,
//     an unpaid OpEx payment and a void credit note are left out.
//   • The date filter, the totals, the CA note and the CSV columns.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { withholdingRoutes } from '../src/modules/accounting/withholdingRoutes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string
let billA: string, billB: string, opexA: string, capexA: string

const D = (iso: string) => new Date(`${iso}T12:00:00+05:00`)

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@whtreg.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${staff[who]!.token}`, ...headers } })

let billSeq = 0
async function bill(supplierId: string, opts: { date: string; subtotal: number; wht: number; status?: string; kind?: string; originalBillId?: string; section?: string; rate?: number }) {
  return (await prisma.supplierBill.create({
    data: {
      supplierId, billNumber: `B-${RUN}-${++billSeq}`, billDate: D(opts.date), dueDate: D(opts.date),
      status: opts.status ?? 'open', kind: opts.kind ?? 'bill', originalBillId: opts.originalBillId ?? null,
      subtotalCents: opts.subtotal, taxCents: 0, totalCents: opts.subtotal, whtCents: opts.wht,
      whtSection: opts.section ?? '153_1_a', whtRateBps: opts.rate ?? 500,
      voidedAt: opts.status === 'void' ? new Date() : null,
    },
  })).id
}

beforeAll(async () => {
  tenantA = await company('Register A')
  tenantB = await company('Register B')
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('adminB', 'admin', tenantB)
  await mkStaff('finAB', 'finance', tenantA, [tenantB])

  const supA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Meat Co A', taxId: '1111111-1', filerStatus: 'filer' } })).id
  const guardA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Guards A', taxId: '2222222-2', filerStatus: 'non_filer' } })).id
  const supB = (await prisma.supplier.create({ data: { tenantId: tenantB, name: 'Meat Co B', taxId: '3333333-3', filerStatus: 'filer' } })).id

  // A: a bill with WHT 5,000 on 100,000, part-credited (1,000 WHT on 20,000); a void and a draft bill; one outside the dates.
  billA = await bill(supA, { date: '2026-09-10', subtotal: 100_000, wht: 5_000 })
  await bill(supA, { date: '2026-09-20', subtotal: 20_000, wht: 1_000, kind: 'credit_note', originalBillId: billA })
  await bill(supA, { date: '2026-09-21', subtotal: 10_000, wht: 500, kind: 'credit_note', originalBillId: billA, status: 'void' })
  await bill(supA, { date: '2026-09-11', subtotal: 50_000, wht: 2_500, status: 'void' })
  await bill(supA, { date: '2026-09-12', subtotal: 50_000, wht: 2_500, status: 'draft' })
  await bill(supA, { date: '2026-08-31', subtotal: 40_000, wht: 2_000 })
  // B: its own bill.
  billB = await bill(supB, { date: '2026-09-15', subtotal: 80_000, wht: 4_000 })

  // A: an OpEx payment for security (s.153(1)(b), non-filer 18%): invoice 110,000 incl. 10,000 SRB → base 100,000.
  const cat = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Security' } })
  const line = await prisma.opexLine.create({ data: { categoryId: cat.id, name: 'Guards — Clifton', amountCents: 110_000, supplierId: guardA, whtSection: '153_1_b' } })
  opexA = (await prisma.opexPayment.create({
    data: {
      lineId: line.id, periodStart: D('2026-09-01'), periodEnd: D('2026-09-30'), expectedCents: 110_000,
      actualCents: 92_000, whtCents: 18_000, inputTaxCents: 10_000, inputTaxAuthority: 'srb',
      whtSection: '153_1_b', whtRateBps: 1800, filerStatus: 'non_filer', paidAt: D('2026-09-25'),
    },
  })).id
  // Not paid yet → not in the register.
  await prisma.opexPayment.create({ data: { lineId: line.id, periodStart: D('2026-10-01'), periodEnd: D('2026-10-31'), expectedCents: 110_000, whtCents: 18_000 } })

  // A: a CapEx contractor payment (s.153(1)(c), 7%) — WHT 7,000 on 100,000.
  const proj = await prisma.capexProject.create({ data: { tenantId: tenantA, name: 'Clifton build-out' } })
  const cl = await prisma.capexLine.create({ data: { projectId: proj.id, scope: 'Civil', item: 'Civil works', unitCostCents: 100_000, vendor: 'BuildCo' } })
  capexA = (await prisma.capexPayment.create({
    data: { lineId: cl.id, label: 'midpoint', amountCents: 100_000, paidAt: D('2026-09-28'), paidAmountCents: 93_000, whtCents: 7_000, whtSection: '153_1_c', whtRateBps: 700, filerStatus: 'filer' },
  })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(withholdingRoutes, { prefix: '/accounting/withholding' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

type Row = { tenantId: string; source: string; sourceId: string; date: string; vendor: string; ntn: string | null; filerStatus: string | null; section: string | null; rateBps: number | null; baseCents: number; whtCents: number; creditNoteWhtCents?: number }

describe('the withholding register', () => {
  it('A sees its bill (net of the credit note), OpEx and CapEx deductions — and nothing of B\'s', async () => {
    const res = await call('finA', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30')
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rows: Row[]; totals: { whtCents: number; baseCents: number; bySection: Record<string, number> }; note: string }
    expect(body.rows.map((r) => r.sourceId).sort()).toEqual([billA, opexA, capexA].sort())
    expect(body.rows.every((r) => r.tenantId === tenantA)).toBe(true)
    expect(body.rows.find((r) => r.sourceId === billB)).toBeUndefined()

    expect(body.rows.find((r) => r.sourceId === billA)).toMatchObject({
      source: 'supplier_bill', date: '2026-09-10', vendor: 'Meat Co A', ntn: '1111111-1', filerStatus: 'filer',
      section: '153_1_a', rateBps: 500, baseCents: 80_000, whtCents: 4_000, creditNoteWhtCents: 1_000,
    })
    expect(body.rows.find((r) => r.sourceId === opexA)).toMatchObject({
      source: 'opex', date: '2026-09-25', vendor: 'Guards A', ntn: '2222222-2', filerStatus: 'non_filer',
      section: '153_1_b', rateBps: 1800, baseCents: 100_000, whtCents: 18_000,
    })
    expect(body.rows.find((r) => r.sourceId === capexA)).toMatchObject({
      source: 'capex', date: '2026-09-28', vendor: 'BuildCo', section: '153_1_c', rateBps: 700, baseCents: 100_000, whtCents: 7_000,
    })
    expect(body.totals).toMatchObject({ whtCents: 29_000, baseCents: 280_000, bySection: { '153_1_a': 4_000, '153_1_b': 18_000, '153_1_c': 7_000 } })
    expect(body.note).toMatch(/s\.153 deducts it when the bill is PAID/)
  })

  it('B sees only its own bill', async () => {
    const res = await call('adminB', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30')
    expect(res.statusCode).toBe(200)
    expect((res.json().rows as Row[]).map((r) => r.sourceId)).toEqual([billB])
  })

  it('"All companies" shows both companies the operator belongs to; the active company alone otherwise', async () => {
    const one = await call('finAB', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30')
    expect(new Set((one.json().rows as Row[]).map((r) => r.tenantId))).toEqual(new Set([tenantA]))
    const all = await call('finAB', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30', { 'x-servd-portfolio': '1' })
    expect(new Set((all.json().rows as Row[]).map((r) => r.tenantId))).toEqual(new Set([tenantA, tenantB]))
    // B-only operator asking for "All companies" still sees only B.
    const bAll = await call('adminB', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30', { 'x-servd-portfolio': '1' })
    expect((bAll.json().rows as Row[]).map((r) => r.sourceId)).toEqual([billB])
  })

  it('a credit note covering the whole bill takes it off the register', async () => {
    const sup = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Veg Co A', filerStatus: 'filer' } })).id
    const b = await bill(sup, { date: '2026-09-05', subtotal: 10_000, wht: 500 })
    await bill(sup, { date: '2026-09-06', subtotal: 10_000, wht: 500, kind: 'credit_note', originalBillId: b })
    const res = await call('finA', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30')
    expect((res.json().rows as Row[]).find((r) => r.sourceId === b)).toBeUndefined()
  })

  it('the dates filter; a bad date is 422', async () => {
    const aug = await call('finA', '/accounting/withholding/register?from=2026-08-01&to=2026-08-31')
    expect((aug.json().rows as Row[]).map((r) => r.whtCents)).toEqual([2_000])
    const bad = await call('finA', '/accounting/withholding/register?from=2026-9-1')
    expect(bad.statusCode).toBe(422)
    const backwards = await call('finA', '/accounting/withholding/register?from=2026-09-30&to=2026-09-01')
    expect(backwards.statusCode).toBe(422)
  })

  it('CSV: the CA\'s columns, one row per deduction, amounts in rupees', async () => {
    const res = await call('finA', '/accounting/withholding/register?from=2026-09-01&to=2026-09-30&format=csv')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe('Company,Date,Source,Document,Vendor,NTN,Filer status,Section,Rate %,Base,WHT')
    expect(lines).toHaveLength(4)
    expect(lines.find((l) => l.includes('OpEx payment'))).toContain('Register A')
    expect(lines.find((l) => l.includes('OpEx payment'))).toContain('"1,000.00"')
    expect(lines.find((l) => l.includes('OpEx payment'))).toContain('180.00')
    expect(lines.find((l) => l.includes('OpEx payment'))).toContain('18.00')
    expect(lines.find((l) => l.includes('Supplier bill'))).toContain('1111111-1')
    const empty = await call('adminB', '/accounting/withholding/register?from=2026-01-01&to=2026-01-31&format=csv')
    expect(empty.body.replace(/^﻿/, '').trim()).toBe('Company,Date,Source,Document,Vendor,NTN,Filer status,Section,Rate %,Base,WHT')
  })
})
