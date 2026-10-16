// Cash requests (owner 2026-10-13; the 2026-10-15 flow: finance replaces the
// HOD, the expense is booked when finance verifies the documents — the
// verification itself is tested in cashVoucherFlow20261015.test.ts).
//
//   - Anyone raises in the ACTIVE company (submitted at once, holder = self by
//     default); the holder, box and brand must be that company's.
//   - Finance approves (403 NOT_FINANCE for anyone else; never its own: 409
//     SELF_APPROVE); the HOD step is retired (410 HOD_STEP_RETIRED).
//   - The final approval is the CEO's (ADMIN_ONLY), never the finance approver.
//   - POST /:id/pay (no photo) is FINANCE's only (owner, 2026-10-16: "Paying
//     a voucher should remain at Finance end" — role finance with the
//     accounting module; a box's cashier, a manager and the CEO get 403
//     PAY_FINANCE_ONLY). Finance may pay from any open box of the voucher's
//     company. It is the ONLY step that moves cash: Dr 1357 / Cr 1011 (held until the documents are verified),
//     dueBy set, float lowered — once, rolled back whole on
//     INSUFFICIENT_FLOAT. The old /disburse and /photo are gone.
//   - Two companies: B gets 404 on every route of A's request.
//   - Legacy rows with no holder are 'needs review': keepers only, until
//     finance names the holder.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
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
import { registerApprovalsPlugin } from '../src/modules/approvals/index.js'

const P = `cv${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const C: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}

const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
const PHOTO = { photo: JPEG_B64, mime: 'image/jpeg' }

async function mkUser(key: string, role: UserRole, tenants: string[], primary: string | null = tenants[0] ?? null) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cv.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: primary, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
function auth(key: string) {
  return { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: auth(key), ...(payload !== undefined && { payload: payload as object }) })

const V = '/trustops/cash-vouchers'
type Req = {
  id: string; tenantId: string; number: string; seq: number; status: string; stage: string; amountCents: number; boxId: string | null
  preparedById: string; payeeUserId: string | null; payeeName: string; category: string | null; hodSignedById: string | null
  directorSignedById: string | null; disbursedById: string | null; pettyCashMovementId: string | null; cashierName: string | null
  financeApprovedById: string | null; canFinanceApprove: boolean
  dueBy: string | null; companyName: string | null; holderName: string | null; canSignHod: boolean; canApprove: boolean; canPay: boolean
  remainingCents: number; needsReview: boolean
}

let n = 0
const draft = (overrides: Record<string, unknown> = {}) => ({ purpose: `Site visit cash ${++n}`, categoryKey: 'transport', amountCents: 10_000, ...overrides })
async function raise(key: string, overrides: Record<string, unknown> = {}): Promise<Req> {
  const r = await call(key, 'POST', V, draft(overrides))
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as Req
}
/** Raised by finA for cookA, approved by finance (finA2) and the CEO (ceoA). */
async function approved(overrides: Record<string, unknown> = {}): Promise<Req> {
  const v = await raise('finA', { holderUserId: U['cookA']!.id, ...overrides })
  const s = await call('finA2', 'POST', `${V}/${v.id}/finance-approve`)
  expect(s.statusCode, s.body).toBe(200)
  const r = await call('ceoA', 'POST', `${V}/${v.id}/approve`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Req
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents
const movementsOf = (id: string) => prisma.pettyCashMovement.count({ where: { boxId: id } })
async function linesOf(reference: string, tenantId: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Voucher Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Voucher Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  C.A = (await prisma.concept.create({ data: { name: `${P} brand A`, slug: `${P}-brand-a`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} brand B`, slug: `${P}-brand-b`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoA2', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finA2', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('mgrA', 'management', [T.A])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('cashA2', 'cashier', [T.A])
  await mkUser('cashA3', 'cashier', [T.A])
  await mkUser('cashB', 'cashier', [T.B])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('hodA', 'hr', [T.A])
  await mkUser('waiterA', 'foh', [T.A])
  await mkUser('cookB', 'boh', [T.B])
  await mkUser('finNoCompany', 'finance', [], null)
  await mkUser('finNoBooks', 'finance', [T.A])
  await prisma.user.update({ where: { id: U['finNoBooks']!.id }, data: { moduleDeny: ['accounting'] } })

  // HR's reporting line: cookA reports to hodA (a login that is no cash keeper).
  const hodEmp = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'HOD A', userId: U['hodA']!.id, status: 'active' } })
  await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Cook A', userId: U['cookA']!.id, managerId: hodEmp.id, status: 'active' } })
  await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-3`, fullName: 'Waiter A', userId: U['waiterA']!.id, status: 'active' } })

  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Head office box', custodianId: U['cashA']!.id, floatCents: 200_000 } })).id
  box['A_small'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Small box', custodianId: U['cashA']!.id, floatCents: 1_000 } })).id
  box['A_closed'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Closed box', custodianId: U['cashA']!.id, floatCents: 100_000, isActive: false } })).id
  box['A_one'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Kitchen box', custodianId: U['cashA3']!.id, floatCents: 50_000 } })).id
  box['B'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['cashB']!.id, floatCents: 50_000 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── Raise ────────────────────────────────────────────────────────────────────

describe('anyone raises a request in the active company', () => {
  it('a cashier and a cook raise: submitted at once, holder = self, numbered per company, category stored, no cash moves', async () => {
    const before = await floatOf(box['A']!)
    const a1 = await raise('cookA', { conceptId: C.A, department: 'Kitchen' })
    expect(a1).toMatchObject({
      tenantId: T.A, status: 'submitted', stage: 'waiting_finance', preparedById: U['cookA']!.id, payeeUserId: U['cookA']!.id,
      payeeName: `${P} cookA`, holderName: `${P} cookA`, category: 'transport', companyName: 'Voucher Co A', boxId: null, pettyCashMovementId: null,
    })
    expect(a1.number).toBe('CV-00001')
    const a2 = await raise('cashA')
    expect(a2).toMatchObject({ number: 'CV-00002', payeeUserId: U['cashA']!.id })
    const b1 = await raise('cookB')
    expect(b1).toMatchObject({ tenantId: T.B, number: 'CV-00001', seq: 1 })
    // Raising never puts anything in cash.
    expect(await floatOf(box['A']!)).toBe(before)
    expect(await movementsOf(box['A']!)).toBe(0)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'cash_voucher.create', entityId: a1.id } })
    expect(audit?.tenantId).toBe(T.A)
    // A keeper raises for someone else, names the box and an explicit 6xxx.
    const k = await raise('finA', { holderUserId: U['cookA']!.id, payeeName: 'Cook (market run)', boxId: box['A'], categoryKey: null, accountCode: '6170' })
    expect(k).toMatchObject({ payeeUserId: U['cookA']!.id, payeeName: 'Cook (market run)', boxId: box['A'], category: '6170', preparedById: U['finA']!.id })
  })

  it("another company's holder, box or brand is refused; the box is a keeper's pick; the category is checked", async () => {
    const holder = await call('finA', 'POST', V, draft({ holderUserId: U['cookB']!.id }))
    expect(holder.statusCode).toBe(422)
    expect(holder.json().error.code).toBe('PAYEE_NOT_IN_COMPANY')
    const foreignBox = await call('finA', 'POST', V, draft({ boxId: box['B'] }))
    expect(foreignBox.json().error.code).toBe('BOX_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', V, draft({ boxId: box['A_closed'] }))).json().error.code).toBe('BOX_NOT_IN_COMPANY')
    const notKeeper = await call('cookA', 'POST', V, draft({ boxId: box['A'] }))
    expect(notKeeper.statusCode).toBe(403)
    expect(notKeeper.json().error.code).toBe('BOX_PICK_KEEPERS_ONLY')
    expect((await call('finA', 'POST', V, draft({ conceptId: C.B }))).statusCode).toBe(404)
    // The category: required, never a kitchen 'cogs' key, an explicit code a keeper's only.
    expect((await call('cookA', 'POST', V, draft({ categoryKey: null }))).json().error.code).toBe('SPEND_CATEGORY_REQUIRED')
    expect((await call('cookA', 'POST', V, draft({ categoryKey: 'kitchen_food' }))).json().error.code).toBe('USE_STOCK_LINE')
    const explicit = await call('cookA', 'POST', V, draft({ categoryKey: null, accountCode: '6170' }))
    expect(explicit.statusCode).toBe(403)
    expect(explicit.json().error.code).toBe('EXPLICIT_ACCOUNT_NOT_ALLOWED')
    expect((await call('finA', 'POST', V, draft({ categoryKey: null, accountCode: '1210' }))).json().error.code).toBe('NOT_AN_EXPENSE_CODE')
    expect(await prisma.cashVoucher.count({ where: { tenantId: T.B, preparedById: U['finA']!.id } })).toBe(0)
  })

  it('amount must be positive and fit INT4; no active company → 422', async () => {
    expect((await call('cookA', 'POST', V, draft({ amountCents: 0 }))).statusCode).toBe(400)
    const big = await call('cookA', 'POST', V, draft({ amountCents: 2_147_483_648 }))
    expect(big.statusCode).toBe(422)
    expect(big.json().error.code).toBe('AMOUNT_TOO_LARGE')
    const none = await call('finNoCompany', 'POST', V, draft())
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('NO_ACTIVE_COMPANY')
  })
})

// ─── Finance ──────────────────────────────────────────────────────────────────

describe('finance approves (the HOD step is retired)', () => {
  it('a non-finance login → 403 NOT_FINANCE; the raiser / holder → 409 SELF_APPROVE; finance approves', async () => {
    const v = await raise('cookA')
    // Waiting for finance: finance sees it in its view, a stranger does not.
    const finList = (await call('finA', 'GET', `${V}?view=finance`)).json() as { items: Req[] }
    expect(finList.items.find((x) => x.id === v.id)!.canFinanceApprove).toBe(true)
    expect(((await call('waiterA', 'GET', `${V}?view=finance`)).json() as { items: Req[] }).items).toHaveLength(0)
    expect((await call('waiterA', 'GET', `${V}/${v.id}`)).statusCode).toBe(403)

    for (const who of ['waiterA', 'hodA', 'mgrA', 'cashA']) {
      const r = await call(who, 'POST', `${V}/${v.id}/finance-approve`)
      expect(r.statusCode, who).toBe(403)
      expect(r.json().error.code, who).toBe('NOT_FINANCE')
    }
    expect((await call('hodA', 'POST', `${V}/${v.id}/sign-hod`)).json().error.code).toBe('HOD_STEP_RETIRED')
    expect((await call('finNoBooks', 'POST', `${V}/${v.id}/finance-approve`)).statusCode).toBe(403)
    const own = await raise('finA', { holderUserId: U['cookA']!.id })
    expect((await call('finA', 'POST', `${V}/${own.id}/finance-approve`)).json().error.code).toBe('SELF_APPROVE')
    const held = await raise('finA2', { holderUserId: U['finA']!.id })
    expect((await call('finA', 'POST', `${V}/${held.id}/finance-approve`)).json().error.code).toBe('SELF_APPROVE')

    const ok = await call('finA', 'POST', `${V}/${v.id}/finance-approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'finance_approved', stage: 'waiting_ceo', financeApprovedById: U['finA']!.id })
    // Approved by finance: the raiser can no longer edit it.
    const late = await call('cookA', 'PATCH', `${V}/${v.id}`, { amountCents: 1 })
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('VOUCHER_NOT_DRAFT')
    expect((await call('cookA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office' })).statusCode).toBe(403)
  })

  it('finance can reject a submitted voucher with a note; the CEO a finance-approved one; nobody else', async () => {
    const d = await raise('cookA')
    expect((await call('waiterA', 'POST', `${V}/${d.id}/reject`, { note: 'not mine' })).statusCode).toBe(403)
    const r = await call('finA', 'POST', `${V}/${d.id}/reject`, { note: 'Use the market float' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ status: 'rejected', rejectNote: 'Use the market float' })
    const s = await raise('cookA')
    expect((await call('finA', 'POST', `${V}/${s.id}/finance-approve`)).statusCode).toBe(200)
    expect((await call('finA', 'POST', `${V}/${s.id}/reject`, { note: 'changed mind' })).statusCode).toBe(403)
    expect((await call('ceoA', 'POST', `${V}/${s.id}/reject`, { note: 'no' })).statusCode).toBe(400)
    expect((await call('ceoA', 'POST', `${V}/${s.id}/reject`, { note: 'Not this month' })).json().status).toBe('rejected')
    expect((await call('ceoA', 'POST', `${V}/${s.id}/approve`)).statusCode).toBe(409)
  })
})

// ─── Director ─────────────────────────────────────────────────────────────────

describe('the final approval is the CEO\'s, never the finance approver\'s', () => {
  it('finance / a manager → 403; the finance approver → 409 SAME_SIGNER; another CEO approves', async () => {
    const v = await raise('mgrA', { holderUserId: U['cookA']!.id })
    expect((await call('ceoA', 'POST', `${V}/${v.id}/approve`)).json().error.code).toBe('VOUCHER_NOT_FINANCE_APPROVED')
    expect((await call('ceoA', 'POST', `${V}/${v.id}/finance-approve`)).statusCode).toBe(200)
    expect((await call('finA', 'POST', `${V}/${v.id}/approve`)).statusCode).toBe(403)
    expect((await call('mgrA', 'POST', `${V}/${v.id}/approve`)).statusCode).toBe(403)
    const same = await call('ceoA', 'POST', `${V}/${v.id}/approve`)
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('SAME_SIGNER')
    const other = await call('ceoA2', 'POST', `${V}/${v.id}/approve`)
    expect(other.statusCode).toBe(200)
    expect(other.json()).toMatchObject({ status: 'approved', financeApprovedById: U['ceoA']!.id, directorSignedById: U['ceoA2']!.id })
  })
})

// ─── Pay ──────────────────────────────────────────────────────────────────────

describe('finance pays — no photo — and the money waits on 1357 for its documents', () => {
  it('pay posts Dr 1357 / Cr 1011, sets dueBy and lowers the float; only this moves cash', async () => {
    const boxId = box['A']!
    const start = await floatOf(boxId)
    const v = await approved({ amountCents: 25_000, purpose: 'Diesel for the generator', categoryKey: 'transport', conceptId: C.A })
    expect(await floatOf(boxId)).toBe(start)
    // Only finance pays: the box's own cashier, a manager and the CEO cannot.
    expect(((await call('cashA', 'GET', `${V}/${v.id}`)).json() as Req).canPay).toBe(false)
    expect(((await call('ceoA', 'GET', `${V}/${v.id}`)).json() as Req).canPay).toBe(false)
    expect(((await call('finA', 'GET', `${V}/${v.id}`)).json() as Req).canPay).toBe(true)
    for (const who of ['cashA', 'mgrA', 'ceoA']) {
      const r = await call(who, 'POST', `${V}/${v.id}/pay`, { boxId })
      expect(r.statusCode, who).toBe(403)
      expect(r.json().error.code, who).toBe('PAY_FINANCE_ONLY')
    }
    expect(await floatOf(boxId)).toBe(start)
    // finA holds no box and the company has several: finance must say which.
    const which = await call('finA', 'POST', `${V}/${v.id}/pay`, {})
    expect(which.statusCode).toBe(422)
    expect(which.json().error.code).toBe('BOX_REQUIRED')

    const paid = await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId })
    expect(paid.statusCode, paid.body).toBe(200)
    const body = paid.json() as { voucher: Req; movement: { id: string; amountCents: number; journalEntryId: string | null }; newFloatCents: number }
    // The cash comes out of cashA's box: he is the cashier on record; finance is who paid.
    expect(body.voucher).toMatchObject({ status: 'disbursed', stage: 'awaiting_docs', boxId, disbursedById: U['finA']!.id, cashierName: `${P} cashA`, remainingCents: 25_000 })
    expect(body.voucher.pettyCashMovementId).toBe(body.movement.id)
    const due = new Date(body.voucher.dueBy!).getTime() - Date.now()
    expect(due).toBeGreaterThan(29 * 86_400_000)
    expect(due).toBeLessThan(31 * 86_400_000)
    expect(body.movement.amountCents).toBe(-25_000)
    expect(body.movement.journalEntryId).toBeTruthy()
    expect(body.newFloatCents).toBe(start - 25_000)
    expect(await floatOf(boxId)).toBe(start - 25_000)
    // Held: Dr 1357 / Cr 1011 — no expense until finance verifies the documents, never 1355.
    expect(await linesOf(`pettycash.spend:${body.movement.id}`, T.A)).toEqual([['1011', 'credit', 25_000], ['1357', 'debit', 25_000]])
    const m = await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: body.movement.id }, include: { lines: true } })
    expect(m).toMatchObject({ type: 'spend', amountCents: -25_000, cashVoucherId: v.id, conceptId: C.A, createdById: U['finA']!.id, approvedById: U['ceoA']!.id, accountCode: '1357' })
    expect(m.lines).toHaveLength(0)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).expenseOnVerify).toBe(true)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A, lines: { some: { account: { code: '1355' } } } } })).toBe(0)

    // Paying twice is refused, and nothing moves.
    const again = await call('finA2', 'POST', `${V}/${v.id}/pay`, { boxId })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_PAID')
    expect(await floatOf(boxId)).toBe(start - 25_000)

    const steps = await prisma.auditLog.findMany({ where: { entity: 'CashVoucher', entityId: v.id, action: { not: 'approval.decide' } }, select: { action: true, tenantId: true } })
    expect(steps.map((s) => s.action).sort()).toEqual(['cash_voucher.approve', 'cash_voucher.create', 'cash_voucher.finance_approve', 'cash_voucher.pay'])
    expect(steps.every((s) => s.tenantId === T.A)).toBe(true)
  })

  it("finance holding ONE open box pays from it by default; any other open box of the company when named; a keeper's explicit category code is kept", async () => {
    await mkUser('finBoxA', 'finance', [T.A])
    box['A_fin'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Finance box', custodianId: U['finBoxA']!.id, floatCents: 50_000 } })).id
    const own = await approved({ amountCents: 2_000 })
    const d = await call('finBoxA', 'POST', `${V}/${own.id}/pay`, {})
    expect(d.statusCode, d.body).toBe(200)
    expect(d.json().voucher.boxId).toBe(box['A_fin'])
    expect(await floatOf(box['A_fin']!)).toBe(48_000)
    // The custodian of A_one (a cashier) cannot pay even from his own box; finance pays from it.
    const v = await approved({ amountCents: 3_000, categoryKey: null, accountCode: '6170' })
    expect((await call('cashA3', 'POST', `${V}/${v.id}/pay`, {})).json().error.code).toBe('PAY_FINANCE_ONLY')
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A_one'] })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().voucher.boxId).toBe(box['A_one'])
    expect(r.json().voucher.category).toBe('6170')
    expect(await linesOf(`pettycash.spend:${r.json().movement.id}`, T.A)).toEqual([['1011', 'credit', 3_000], ['1357', 'debit', 3_000]])
  })

  it('two pays at the same moment pay once', async () => {
    const boxId = box['A']!
    const v = await approved({ amountCents: 4_000 })
    const float = await floatOf(boxId)
    const moves = await movementsOf(boxId)
    const [r1, r2] = await Promise.all([
      call('finA', 'POST', `${V}/${v.id}/pay`, { boxId }),
      call('finBoxA', 'POST', `${V}/${v.id}/pay`, { boxId }),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409])
    expect([r1, r2].find((r) => r.statusCode === 409)!.json().error.code).toBe('ALREADY_PAID')
    expect(await floatOf(boxId)).toBe(float - 4_000)
    expect(await movementsOf(boxId)).toBe(moves + 1)
  })

  it('INSUFFICIENT_FLOAT rolls the whole payment back: still approved, no box, no movement, no entry', async () => {
    const boxId = box['A_small']!
    const v = await approved({ amountCents: 5_000 })
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const r = await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('INSUFFICIENT_FLOAT')
    const after = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(after).toMatchObject({ status: 'approved', boxId: null, pettyCashMovementId: null, disbursedAt: null, dueBy: null, cashierName: null })
    expect(await movementsOf(boxId)).toBe(0)
    expect(await floatOf(boxId)).toBe(1_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
  })

  it('anyone but finance (with the books) → 403; a closed or foreign box is refused; not approved → 409', async () => {
    const v = await approved({ amountCents: 1_000 })
    const other = await call('cashA2', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(other.statusCode).toBe(403)
    expect(other.json().error.code).toBe('PAY_FINANCE_ONLY')
    expect((await call('cashA2', 'POST', `${V}/${v.id}/pay`, {})).json().error.code).toBe('PAY_FINANCE_ONLY')
    expect((await call('cookA', 'POST', `${V}/${v.id}/pay`, {})).json().error.code).toBe('PAY_FINANCE_ONLY')
    const noBooks = await call('finNoBooks', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(noBooks.statusCode).toBe(403)
    expect(noBooks.json().error.code).toBe('PAY_FINANCE_ONLY')
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('approved')
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId: box['B'] })).json().error.code).toBe('BOX_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A_closed'] })).json().error.code).toBe('BOX_UNAVAILABLE')
    const d = await raise('cookA')
    const early = await call('finA', 'POST', `${V}/${d.id}/pay`, { boxId: box['A'] })
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('VOUCHER_NOT_APPROVED')
    // A box named on the request: its cashier still cannot pay; finance (a keeper) may change it.
    const named = await approved({ amountCents: 1_000, boxId: box['A_one'] })
    expect((await call('cashA3', 'POST', `${V}/${named.id}/pay`, {})).json().error.code).toBe('PAY_FINANCE_ONLY')
    const swap = await call('finA', 'POST', `${V}/${named.id}/pay`, { boxId: box['A'] })
    expect(swap.statusCode, swap.body).toBe(200)
    expect(swap.json().voucher.boxId).toBe(box['A'])
  })

  it('the old photo flow is gone: /disburse and /photo → 404', async () => {
    const v = await approved({ amountCents: 1_000 })
    expect((await call('cashA', 'POST', `${V}/${v.id}/disburse`, PHOTO)).statusCode).toBe(404)
    expect((await call('cashA', 'POST', `${V}/${v.id}/photo`, PHOTO)).statusCode).toBe(404)
    expect((await call('finA', 'GET', `${V}/${v.id}/photo`)).statusCode).toBe(404)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('approved')
  })
})

// ─── Category until paid ──────────────────────────────────────────────────────

describe('finance may change the category until the request is paid', () => {
  it('keeper PATCH after finance / the CEO; the raiser cannot; after pay 409', async () => {
    const v = await approved({ amountCents: 2_000, categoryKey: 'transport' })
    expect((await call('finA', 'PATCH', `${V}/${v.id}`, { amountCents: 5 })).json().error.code).toBe('VOUCHER_NOT_DRAFT')
    expect((await call('cookA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office' })).statusCode).toBe(403)
    const ok = await call('finA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'office' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().category).toBe('office')
    const paid = await call('finA', 'POST', `${V}/${v.id}/pay`, { boxId: box['A'] })
    expect(paid.json().voucher.category).toBe('office')
    expect(await linesOf(`pettycash.spend:${paid.json().movement.id}`, T.A)).toEqual([['1011', 'credit', 2_000], ['1357', 'debit', 2_000]])
    expect((await call('finA', 'PATCH', `${V}/${v.id}`, { categoryKey: 'transport' })).statusCode).toBe(409)
  })

  it('a legacy approved request with a free-text category cannot be paid until finance sets one', async () => {
    const legacy = await prisma.cashVoucher.create({
      data: {
        tenantId: T.A, seq: 900, number: 'CV-00900', voucherDate: new Date(), payeeName: 'Legacy payee', payeeUserId: U['cookA']!.id,
        purpose: 'Old voucher', category: 'fuel & transport', amountCents: 1_500, status: 'approved', preparedById: U['finA']!.id,
        hodSignedById: U['mgrA']!.id, hodSignedAt: new Date(), directorSignedById: U['ceoA']!.id, directorSignedAt: new Date(),
      },
    })
    const r = await call('finA', 'POST', `${V}/${legacy.id}/pay`, { boxId: box['A'] })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('SPEND_CATEGORY_UNKNOWN')
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('approved')
    expect((await call('finA', 'PATCH', `${V}/${legacy.id}`, { categoryKey: 'transport' })).statusCode).toBe(200)
    expect((await call('finA', 'POST', `${V}/${legacy.id}/pay`, { boxId: box['A'] })).statusCode).toBe(200)
  })
})

// ─── Lists and company B ──────────────────────────────────────────────────────

describe("company B never reaches company A's request", () => {
  it('404 on every route of an A request; the list is per company', async () => {
    const a = await approved({ amountCents: 1_000 })
    const p = await approved({ amountCents: 1_000 })
    expect((await call('finA', 'POST', `${V}/${p.id}/pay`, { boxId: box['A'] })).statusCode).toBe(200)
    const all = ['finB', 'ceoB', 'cashB']
    // [method, url, body, the B logins its role guard lets through to the lookup]
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown, string[]]> = [
      ['GET', `${V}/${a.id}`, undefined, all],
      ['PATCH', `${V}/${a.id}`, { amountCents: 1 }, all],
      ['POST', `${V}/${a.id}/sign-hod`, undefined, all],
      ['POST', `${V}/${a.id}/approve`, undefined, ['ceoB']],
      ['POST', `${V}/${a.id}/reject`, { note: 'not ours' }, all],
      ['POST', `${V}/${a.id}/cancel`, { note: 'not ours' }, all],
      ['POST', `${V}/${a.id}/pay`, { boxId: box['B'] }, all],
      ['GET', `${V}/${p.id}/attachments/whatever`, undefined, all],
      ['POST', `${V}/${p.id}/receipts`, PHOTO, all],
      ['DELETE', `${V}/${p.id}/receipts/whatever`, undefined, all],
      ['POST', `${V}/${p.id}/settlements`, { lines: [{ categoryKey: 'transport', amountCents: 100, description: 'x' }], receiptIds: ['x'] }, all],
      ['PATCH', `${V}/${p.id}/settlements/s/lines/l`, { categoryKey: 'office' }, ['finB', 'ceoB']],
      ['POST', `${V}/${p.id}/return-change`, { amountCents: 100, boxId: box['B'] }, all],
    ]
    for (const [method, url, body, whos] of routes) {
      for (const who of whos) {
        const r = await call(who, method, url, body)
        expect(r.statusCode, `${who} ${method} ${url}`).toBe(404)
      }
    }
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('approved')
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('disbursed')

    const listB = (await call('finB', 'GET', V)).json() as { items: Req[] }
    expect(listB.items.every((v) => v.tenantId === T.B)).toBe(true)
    expect(listB.items.map((v) => v.id)).not.toContain(a.id)
    const listA = (await call('finA', 'GET', V)).json() as { items: Req[] }
    expect(listA.items.map((v) => v.id)).toContain(a.id)
    expect(listA.items.every((v) => v.tenantId === T.A)).toBe(true)
  })

  it('who sees what: the cashier sees what he pays, the holder his own, nobody else a stranger\'s', async () => {
    const d = await raise('cookA')
    const ready = await approved({ amountCents: 1_000 })
    const cash = (await call('cashA', 'GET', V)).json() as { items: Req[] }
    const ids = cash.items.map((v) => v.id)
    expect(ids).toContain(ready.id)
    expect(ids).not.toContain(d.id)
    expect(cash.items.every((v) => v.tenantId === T.A && (['approved', 'disbursed', 'settled'].includes(v.status) || v.preparedById === U['cashA']!.id || v.payeeUserId === U['cashA']!.id))).toBe(true)
    const toPay = (await call('cashA', 'GET', `${V}?view=to_pay`)).json() as { items: Req[] }
    expect(toPay.items.map((v) => v.id)).toContain(ready.id)
    expect(toPay.items.every((v) => v.status === 'approved')).toBe(true)
    // cashA2 holds no box: only what he raised or holds himself.
    const c2 = (await call('cashA2', 'GET', V)).json() as { items: Req[] }
    expect(c2.items.every((v) => v.preparedById === U['cashA2']!.id || v.payeeUserId === U['cashA2']!.id)).toBe(true)
    // The holder sees his own requests.
    const mine = (await call('cookA', 'GET', `${V}?view=mine`)).json() as { items: Req[] }
    expect(mine.items.map((v) => v.id)).toEqual(expect.arrayContaining([d.id, ready.id]))
    // A cashier of company B never sees A's.
    const b = (await call('cashB', 'GET', V)).json() as { items: Req[] }
    expect(b.items.every((v) => v.tenantId === T.B)).toBe(true)
  })

  it('the list filters by status and pages with a cursor; a foreign cursor is refused; never file bytes', async () => {
    const page1 = (await call('finA', 'GET', `${V}?limit=2`)).json() as { items: Req[]; nextCursor: string | null }
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBe(page1.items[1]!.id)
    const page2 = (await call('finA', 'GET', `${V}?limit=2&cursor=${page1.nextCursor}`)).json() as { items: Req[] }
    expect(page2.items.length).toBeGreaterThan(0)
    for (const v of page2.items) expect(page1.items.map((x) => x.id)).not.toContain(v.id)
    const drafts = (await call('finA', 'GET', `${V}?status=submitted`)).json() as { items: Req[] }
    expect(drafts.items.length).toBeGreaterThan(0)
    expect(drafts.items.every((v) => v.status === 'submitted')).toBe(true)
    expect(JSON.stringify(drafts)).not.toContain('"data"')
    const bVoucher = await prisma.cashVoucher.findFirstOrThrow({ where: { tenantId: T.B } })
    expect((await call('finA', 'GET', `${V}?cursor=${bVoucher.id}`)).statusCode).toBe(400)
    expect((await call('finA', 'GET', `${V}?status=nope`)).statusCode).toBe(400)
    expect((await call('finA', 'GET', `${V}?view=nope`)).statusCode).toBe(400)
  })
})

// ─── Cancel ───────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('the raiser cancels a submitted voucher; a keeper until it is paid; never after payment', async () => {
    const d = await raise('cookA')
    expect((await call('cookA', 'POST', `${V}/${d.id}/cancel`, { note: 'x' })).statusCode).toBe(400)
    expect((await call('waiterA', 'POST', `${V}/${d.id}/cancel`, { note: 'not mine' })).statusCode).toBe(403)
    const c1 = await call('cookA', 'POST', `${V}/${d.id}/cancel`, { note: 'Raised twice' })
    expect(c1.statusCode).toBe(200)
    expect(c1.json()).toMatchObject({ status: 'cancelled', cancelNote: 'Raised twice' })

    const a = await approved({ amountCents: 1_000 })
    expect((await call('cookA', 'POST', `${V}/${a.id}/cancel`, { note: 'I changed my mind' })).statusCode).toBe(403)
    expect((await call('mgrA', 'POST', `${V}/${a.id}/cancel`, { note: 'Trip called off' })).json().status).toBe('cancelled')
    expect((await call('finA', 'POST', `${V}/${a.id}/pay`, { boxId: box['A'] })).statusCode).toBe(409)

    const p = await approved({ amountCents: 1_000 })
    expect((await call('finA', 'POST', `${V}/${p.id}/pay`, { boxId: box['A'] })).statusCode).toBe(200)
    const c3 = await call('finA', 'POST', `${V}/${p.id}/cancel`, { note: 'Too late now' })
    expect(c3.statusCode).toBe(409)
    expect(c3.json().error.code).toBe('VOUCHER_NOT_CANCELLABLE')
  })
})

// ─── Legacy rows ──────────────────────────────────────────────────────────────

describe('a legacy paid voucher with no holder is "needs review"', () => {
  it('keepers only; finance names the holder (audited); never shown to whoever prepared it', async () => {
    const legacy = await prisma.cashVoucher.create({
      data: {
        tenantId: T.A, seq: 950, number: 'CV-00950', voucherDate: new Date(), payeeName: 'Old payee', purpose: 'Old flow',
        amountCents: 2_000, boxId: box['A'], status: 'disbursed', preparedById: U['hodA']!.id, disbursedAt: new Date(),
      },
    })
    const hodList = (await call('hodA', 'GET', V)).json() as { items: Req[] }
    expect(hodList.items.map((v) => v.id)).not.toContain(legacy.id)
    expect((await call('hodA', 'GET', `${V}/${legacy.id}`)).statusCode).toBe(403)
    const review = (await call('finA', 'GET', `${V}?view=needs_review`)).json() as { items: Req[] }
    expect(review.items.find((v) => v.id === legacy.id)).toMatchObject({ stage: 'needs_review', needsReview: true })
    expect((await call('hodA', 'PATCH', `${V}/${legacy.id}`, { holderUserId: U['cookA']!.id })).statusCode).toBe(403)
    expect((await call('finA', 'PATCH', `${V}/${legacy.id}`, { amountCents: 5 })).statusCode).toBe(409)
    const named = await call('finA', 'PATCH', `${V}/${legacy.id}`, { holderUserId: U['cookA']!.id })
    expect(named.statusCode, named.body).toBe(200)
    expect(named.json()).toMatchObject({ payeeUserId: U['cookA']!.id, stage: 'paid', needsReview: false })
    expect(await prisma.auditLog.count({ where: { action: 'cash_voucher.name_holder', entityId: legacy.id, tenantId: T.A } })).toBe(1)
  })
})

// ─── Petty cash keeps one spend path ──────────────────────────────────────────

describe('the manual petty-cash spend goes through the same helper', () => {
  it('spend lowers the float; over the float is 400 INSUFFICIENT_FLOAT; a top-up still works', async () => {
    const boxId = box['A']!
    const float = await floatOf(boxId)
    const r = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId, type: 'spend', amountCents: 2_000, reason: 'Milk', vendorName: 'Dairy shop', categoryKey: 'cleaning' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().newFloatCents).toBe(float - 2_000)
    expect(await floatOf(boxId)).toBe(float - 2_000)
    const over = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box['A_small'], type: 'spend', amountCents: 5_000, reason: 'Too much', categoryKey: 'office' })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.code).toBe('INSUFFICIENT_FLOAT')
    const up = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId, type: 'topup', amountCents: 2_000, reason: 'Refill', source: 'safe' })
    expect(up.statusCode, up.body).toBe(201)
    expect(up.json().newFloatCents).toBe(float)
  })
})

// ─── Approvals inbox ──────────────────────────────────────────────────────────

type Inbox = {
  types: Array<{ type: string; count: number; link: string; module: string }>
  items: Array<{ type: string; id: string; tenantId: string | null; actions: Array<{ kind: string; method: string; path: string; body: Record<string, unknown>; input?: { field: string; required: boolean }; disabledReason?: string }> }>
}

describe('approvals inbox: the request waiting for the CEO', () => {
  it("lists company A's finance-approved request for A's CEO only; Approve calls the request route", async () => {
    const a = await raise('cookA', { purpose: 'Inbox item A' })
    expect((await call('finA', 'POST', `${V}/${a.id}/finance-approve`)).statusCode).toBe(200)
    const b = await raise('cookB', { purpose: 'Inbox item B' })
    expect((await call('finB', 'POST', `${V}/${b.id}/finance-approve`)).statusCode).toBe(200)

    const inboxA = (await call('ceoA', 'GET', '/approvals')).json() as Inbox
    const itemsA = inboxA.items.filter((i) => i.type === 'cash_voucher')
    expect(itemsA.map((i) => i.id)).toContain(a.id)
    expect(itemsA.map((i) => i.id)).not.toContain(b.id)
    expect(itemsA.every((i) => i.tenantId === T.A)).toBe(true)
    const idsB = ((await call('ceoB', 'GET', '/approvals')).json() as Inbox).items.filter((i) => i.type === 'cash_voucher').map((i) => i.id)
    expect(idsB).toContain(b.id)
    expect(idsB).not.toContain(a.id)

    const item = itemsA.find((i) => i.id === a.id)!
    const approve = item.actions.find((x) => x.kind === 'approve')!
    expect(approve).toMatchObject({ method: 'POST', path: `${V}/${a.id}/approve` })
    expect((await call('ceoB', 'POST', approve.path, approve.body)).statusCode).toBe(404)
    expect((await call('ceoA', 'POST', approve.path, approve.body)).statusCode).toBe(200)
    const after = (await call('ceoA', 'GET', '/approvals')).json() as Inbox
    expect(after.items.map((i) => i.id)).not.toContain(a.id)
  })
})
