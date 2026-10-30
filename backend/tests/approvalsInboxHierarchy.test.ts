// The approvals inbox follows the approval hierarchy (owner, 2026-10-30: "Items
// pending review or approval with Finance or any other designated user should
// not appear in the CEO's Approval tab … Each request should appear exclusively
// in the Approval tab of the user currently responsible for reviewing or
// approving it").
//
//   - payroll in finance_review → finance only (not the CEO); after finance
//     passes it (finance_checked) → the CEO as payroll_run, not finance.
//   - cash voucher `submitted` → finance only; `finance_approved` → the CEO only.
//   - HR leave at the HOD step → the reporting manager, not the CEO.
//   - stranded: company B has no finance login → its finance-step items show to
//     the CEO (never out of sight). The bell (approverIdsFor) and /approvals/counts agree.
//   - two companies: A's finance never sees B's items.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { trustopsRoutes } = await import('../src/modules/trustops/routes.js')
const { stockTransferRoutes } = await import('../src/modules/stockTransfers/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { approverIdsFor } = await import('../src/lib/approvalRights.js')

const P = `aih${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@aih.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const headersOf = (key: string) => {
  const u = U[key]!
  return {
    authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}`,
    'x-servd-portfolio': '1',
  }
}
type Inbox = { total: number; items: Array<{ type: string; id: string }>; types: Array<{ type: string; count: number }> }
async function inbox(key: string): Promise<Inbox> {
  const r = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: headersOf(key) })
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Inbox
}
async function has(key: string, type: string, id: string): Promise<boolean> {
  return (await inbox(key)).items.some((i) => i.type === type && i.id === id)
}
async function countOf(key: string, type: string): Promise<number> {
  const r = await app.inject({ method: 'GET', url: '/api/v1/approvals/counts', headers: headersOf(key) })
  expect(r.statusCode, r.body).toBe(200)
  return (r.json() as Inbox).types.find((t) => t.type === type)?.count ?? 0
}

let seq = 0
async function mkVoucher(tenantId: string, preparedBy: string, status: string) {
  seq += 1
  return prisma.cashVoucher.create({
    data: {
      tenantId, seq, number: `CV-${P.slice(-5)}${seq}`, voucherDate: new Date(), payeeName: 'Staff', purpose: 'Gas cylinder',
      amountCents: 450_000, preparedById: U[preparedBy]!.id, status: status as never, submittedAt: new Date(),
    },
  })
}
async function mkRun(tenantId: string, hrKey: string, period: string) {
  return prisma.hrPayrollRun.create({
    data: {
      tenantId, period, status: 'finance_review', settings: {}, createdById: U[hrKey]!.id,
      sentToFinanceById: U[hrKey]!.id, sentToFinanceAt: new Date(),
    },
  })
}

let empStaff = ''
let locA1 = ''
let locA2 = ''
let itemA = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', [T.A, T.B])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('hod', 'foh_management', [T.A])
  await mkUser('mgrA', 'fnb_manager', [T.A])
  await mkUser('staffA', 'cashier', [T.A])
  await mkUser('staffB', 'cashier', [T.B])
  const empHod = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Hod Person', userId: U.hod!.id } })).id
  empStaff = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Staff Person', userId: U.staffA!.id, managerId: empHod } })).id
  locA1 = (await prisma.location.create({ data: { slug: `${P}-l1`, name: 'Clifton', tenantId: T.A } })).id
  locA2 = (await prisma.location.create({ data: { slug: `${P}-l2`, name: 'DHA', tenantId: T.A } })).id
  itemA = (await prisma.inventoryItem.create({ data: { name: `${P} Flour`, unit: 'kg', tenantId: T.A } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(hrRoutes, { prefix: '/hr' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(stockTransferRoutes, { prefix: '/stock-transfers' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  for (const t of [T.A, T.B]) {
    await prisma.hrPayrollRun.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.hrRecord.deleteMany({ where: { tenantId: t } }).catch(() => {})
  }
  await app?.close()
})

describe('approvals inbox: only whoever must act now', () => {
  it('payroll: finance_review → finance only; finance_checked → the CEO only (payroll_run)', async () => {
    const run = await mkRun(T.A, 'hrA', '2027-05')
    expect(await has('finA', 'payroll_finance_review', run.id)).toBe(true)
    expect(await has('ceo', 'payroll_finance_review', run.id)).toBe(false)
    expect(await has('ceo', 'payroll_run', run.id)).toBe(false)
    expect((await approverIdsFor('payroll_finance_review', run.id))?.userIds).toEqual([U.finA!.id])

    await prisma.hrPayrollRun.update({ where: { id: run.id }, data: { status: 'finance_checked', financeCheckedById: U.finA!.id, financeCheckedAt: new Date() } })
    expect(await has('ceo', 'payroll_run', run.id)).toBe(true)
    expect(await has('finA', 'payroll_finance_review', run.id)).toBe(false)
    expect(await has('finA', 'payroll_run', run.id)).toBe(false)
    expect((await approverIdsFor('payroll_run', run.id))?.userIds).toEqual([U.ceo!.id])
  })

  it('cash voucher: submitted → finance only; finance_approved → the CEO only', async () => {
    const v = await mkVoucher(T.A, 'staffA', 'submitted')
    expect(await has('finA', 'cash_request_finance', v.id)).toBe(true)
    expect(await has('ceo', 'cash_request_finance', v.id)).toBe(false)
    expect(await has('ceo', 'cash_voucher', v.id)).toBe(false)
    expect((await approverIdsFor('cash_request_finance', v.id))?.userIds).toEqual([U.finA!.id])

    await prisma.cashVoucher.update({ where: { id: v.id }, data: { status: 'finance_approved', financeApprovedById: U.finA!.id, financeApprovedAt: new Date() } })
    expect(await has('ceo', 'cash_voucher', v.id)).toBe(true)
    expect(await has('finA', 'cash_request_finance', v.id)).toBe(false)
    expect(await has('finA', 'cash_voucher', v.id)).toBe(false)
  })

  it('HR leave at the HOD step → the reporting manager, not the CEO', async () => {
    const rec = await prisma.hrRecord.create({
      data: { tenantId: T.A, section: 'leave', formVersion: 0, status: 'submitted', currentStep: 0, employeeId: empStaff, createdById: U.staffA!.id, approvals: [] },
    })
    expect(await has('hod', 'hr_request', rec.id)).toBe(true)
    expect(await has('ceo', 'hr_request', rec.id)).toBe(false)
    expect(await has('hrA', 'hr_request', rec.id)).toBe(false)
  })

  it('stock transfer a manager decides → the manager, not the CEO', async () => {
    const t = await prisma.stockTransfer.create({
      data: { inventoryItemId: itemA, fromLocationId: locA1, toLocationId: locA2, quantity: 5, unit: 'kg', requestedById: U.staffA!.id, status: 'requested' },
    })
    expect(await has('mgrA', 'stock_transfer', t.id)).toBe(true)
    expect(await has('ceo', 'stock_transfer', t.id)).toBe(false)
  })

  it('stranded: company B has no finance login → its finance-step items go to the CEO; A\'s finance never sees them', async () => {
    const run = await mkRun(T.B, 'hrB', '2027-05')
    const v = await mkVoucher(T.B, 'staffB', 'submitted')
    expect(await has('ceo', 'payroll_finance_review', run.id)).toBe(true)
    expect(await has('ceo', 'cash_request_finance', v.id)).toBe(true)
    expect(await has('finA', 'payroll_finance_review', run.id)).toBe(false)
    expect(await has('finA', 'cash_request_finance', v.id)).toBe(false)
    expect((await approverIdsFor('payroll_finance_review', run.id))?.userIds).toEqual([U.ceo!.id])
    expect((await approverIdsFor('cash_request_finance', v.id))?.userIds).toEqual([U.ceo!.id])
  })

  it('the counts badge agrees with the list', async () => {
    for (const key of ['ceo', 'finA']) {
      const full = await inbox(key)
      for (const type of ['payroll_finance_review', 'cash_request_finance', 'payroll_run', 'cash_voucher', 'stock_transfer']) {
        expect(await countOf(key, type), `${key} ${type}`).toBe(full.items.filter((i) => i.type === type).length)
      }
    }
  })
})
