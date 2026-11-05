// HR deletes an employee — with the CEO's approval (owner, 2026-11-05: "Give
// option to HR to delete employee from list with CEO's approval").
//
//   - HR asks → 202 { pendingApproval, request }; the employee stays. A second ask is 409 DELETE_PENDING.
//   - The CEO approves → employee gone, in the Trash (hr_employee) with its documents / records;
//     the CEO's restore brings it back with the same ids; a taken code refuses the restore.
//   - Reject needs a note ≥10; withdraw by the requester; HR never approves (403).
//   - Company B: 404 on company A's employee and request.
//   - History (a payslip) → 409 EMPLOYEE_HAS_HISTORY at the ask, and at approval when it appears after.
//   - A linked login → 409 EMPLOYEE_HAS_LOGIN.
//   - The CEO's own delete is immediate and closes a pending request.
//   - The registry and the approvals inbox know the type.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { runWithRlsContext } = await import('../src/lib/rlsContext.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { trashProvider } = await import('../src/modules/trash/registry.js')
const R = await import('../src/lib/approvalRights.js')

const P = `edr${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
type U = { id: string; name: string; email: string; role: string }
const U: Record<string, U> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
  return U[key]!
}
const auth = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const post = (key: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...auth(key), 'content-type': 'application/json' }, payload: JSON.stringify(payload) })
const get = (key: string, url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(key) })
const ask = (key: string, empId: string, reason = 'Duplicate entry created by mistake') => post(key, `/hr/employees/${empId}/delete-request`, { reason })
const decide = (key: string, id: string, action: 'approve' | 'reject' | 'withdraw', payload: Record<string, unknown> = {}) =>
  post(key, `/hr/employee-delete-requests/${id}/${action}`, payload)
const codeOf = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code

let n = 0
async function mkEmp(tenantId: string, extra: Record<string, unknown> = {}) {
  n += 1
  return prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${P}-${n}`, fullName: `${P} Person ${n}`, ...extra } })
}
async function addPayslip(tenantId: string, employeeId: string) {
  const run = await prisma.hrPayrollRun.create({ data: { tenantId, period: `20${10 + n}-01`, settings: {} } })
  await prisma.hrPayslip.create({
    data: { runId: run.id, tenantId, employeeId, inputs: {}, lines: [], grossCents: 0, earningsCents: 0, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 0 },
  })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrA2', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('cashA', 'cashier', [T.A])

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(hrRoutes, { prefix: '/hr' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('the registry', () => {
  it('employee_delete is a CEO-section type, never handed over; the Trash knows hr_employee (CEO only)', () => {
    expect(R.APPROVAL_TYPES).toContain('employee_delete')
    expect(R.APPROVAL_RIGHTS.employee_delete).toMatchObject({ section: 'ceo', delegable: false, roles: ['admin'], queueModule: 'staff_hr' })
    expect(trashProvider('hr_employee')).toMatchObject({ ceoOnly: true, strategy: 'snapshot', model: 'HrEmployee' })
  })
})

describe('HR asks, the CEO decides', () => {
  let empId = ''
  let reqId = ''
  let docId = ''
  let recId = ''
  it('HR asks → 202, the employee stays; a second ask is 409; a short reason is 400', async () => {
    const emp = await mkEmp(T.A)
    empId = emp.id
    docId = (await prisma.hrDocument.create({ data: { tenantId: T.A, employeeId: emp.id, docType: 'cnic', title: 'CNIC copy' } })).id
    recId = (await prisma.hrRecord.create({ data: { tenantId: T.A, section: 'attendance', formVersion: 1, employeeId: emp.id, status: 'approved', category: 'present', startDate: new Date('2026-10-01') } })).id
    expect((await ask('hrA', empId, 'short')).statusCode).toBe(400)
    const r = await ask('hrA', empId)
    expect(r.statusCode).toBe(202)
    expect(r.json()).toMatchObject({ pendingApproval: true, request: { status: 'pending', employeeId: empId, tenantId: T.A, requestedById: U['hrA']!.id, employeeCode: emp.employeeCode } })
    reqId = r.json().request.id
    expect(await prisma.hrEmployee.findUnique({ where: { id: empId } })).not.toBeNull()
    expect(await prisma.auditLog.findFirst({ where: { entityId: reqId, action: 'hr.employee.delete_request' } })).toMatchObject({ tenantId: T.A })
    const again = await ask('hrA2', empId)
    expect(again.statusCode).toBe(409)
    expect(codeOf(again)).toBe('DELETE_PENDING')
    expect((await R.approvalSubject('employee_delete', reqId))?.status).toBe('pending')
  })

  it('company B gets 404 on the employee and the request; HR cannot approve', async () => {
    expect((await ask('hrB', empId)).statusCode).toBe(404)
    expect((await decide('ceoB', reqId, 'approve')).statusCode).toBe(404)
    expect((await decide('hrB', reqId, 'withdraw')).statusCode).toBe(404)
    const list = await get('hrB', '/hr/employee-delete-requests?status=pending')
    expect(list.json().items.find((i: { id: string }) => i.id === reqId)).toBeUndefined()
    expect((await decide('hrA', reqId, 'approve')).statusCode).toBe(403)
    expect((await decide('hrA', reqId, 'reject', { note: 'Not my call to make' })).statusCode).toBe(403)
    expect((await ask('cashA', empId)).statusCode).toBe(403)
  })

  it('the CEO sees it in the list and in the approvals inbox', async () => {
    const list = await get('ceoA', '/hr/employee-delete-requests?status=pending')
    expect(list.statusCode).toBe(200)
    expect(list.json().items.find((i: { id: string }) => i.id === reqId)).toMatchObject({ requestedByName: U['hrA']!.name, blockedBy: [] })
    const inbox = await get('ceoA', '/approvals?type=employee_delete')
    expect(inbox.statusCode).toBe(200)
    const items = (inbox.json().items as Array<{ type: string; id: string }>).filter((i) => i.type === 'employee_delete')
    expect(items.map((i) => i.id)).toContain(reqId)
  })

  it('the CEO approves → gone, in the Trash with its documents and records; a second approve is 409', async () => {
    const r = await decide('ceoA', reqId, 'approve')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ approved: true, employeeId: empId })
    expect(await prisma.hrEmployee.findUnique({ where: { id: empId } })).toBeNull()
    expect(await prisma.hrDocument.findUnique({ where: { id: docId } })).toBeNull()
    expect(await prisma.hrRecord.findUnique({ where: { id: recId } })).toBeNull()
    const entry = await prisma.trashEntry.findFirst({ where: { entityType: 'hr_employee', entityId: empId, restoredAt: null } })
    expect(entry).toMatchObject({ tenantId: T.A, reason: 'Duplicate entry created by mistake' })
    expect((await prisma.employeeDeleteRequest.findUniqueOrThrow({ where: { id: reqId } })).status).toBe('approved')
    expect(await prisma.auditLog.findFirst({ where: { entityId: empId, action: 'hr.employee.deleted' } })).toMatchObject({ tenantId: T.A })
    expect(await prisma.auditLog.findFirst({ where: { entityId: reqId, action: 'hr.employee.delete_request.approve' } })).not.toBeNull()
    expect(codeOf(await decide('ceoA', reqId, 'approve'))).toBe('REQUEST_NOT_PENDING')
  })

  it('HR cannot restore it; company B cannot; the CEO restores with the same ids', async () => {
    expect((await post('hrA', `/trash/hr_employee/${empId}/restore`)).statusCode).toBeGreaterThanOrEqual(403)
    expect((await post('ceoB', `/trash/hr_employee/${empId}/restore`)).statusCode).toBe(404)
    const r = await post('ceoA', `/trash/hr_employee/${empId}/restore`)
    expect(r.statusCode).toBe(200)
    expect(await prisma.hrEmployee.findUnique({ where: { id: empId } })).toMatchObject({ tenantId: T.A })
    expect(await prisma.hrDocument.findUnique({ where: { id: docId } })).toMatchObject({ employeeId: empId })
    expect(await prisma.hrRecord.findUnique({ where: { id: recId } })).toMatchObject({ employeeId: empId })
  })

  it('a restore is refused while another employee holds the code', async () => {
    const emp = await mkEmp(T.A)
    const del = await ask('ceoA', emp.id, 'Wrong entry, made twice by HR')
    expect(del.statusCode).toBe(200)
    expect(del.json()).toMatchObject({ deleted: true })
    await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: emp.employeeCode, fullName: 'Someone new' } })
    const r = await post('ceoA', `/trash/hr_employee/${emp.id}/restore`)
    expect(r.statusCode).toBe(409)
    expect(codeOf(r)).toBe('EMPLOYEE_CODE_TAKEN')
  })
})

describe('reject and withdraw', () => {
  it('reject needs a note ≥10 and leaves the employee; the requester withdraws; another HR may not', async () => {
    const e1 = await mkEmp(T.A)
    const r1 = (await ask('hrA', e1.id)).json().request.id
    expect((await decide('ceoA', r1, 'reject', { note: 'no' })).statusCode).toBe(400)
    const rej = await decide('ceoA', r1, 'reject', { note: 'Keep them, the record is right' })
    expect(rej.statusCode).toBe(200)
    expect(await prisma.hrEmployee.findUnique({ where: { id: e1.id } })).not.toBeNull()
    expect((await prisma.employeeDeleteRequest.findUniqueOrThrow({ where: { id: r1 } })).status).toBe('rejected')

    const r2 = (await ask('hrA', e1.id)).json().request.id
    const other = await decide('hrA2', r2, 'withdraw')
    expect(other.statusCode).toBe(403)
    expect(codeOf(other)).toBe('NOT_YOUR_REQUEST')
    expect((await decide('hrA', r2, 'withdraw')).statusCode).toBe(200)
    expect(codeOf(await decide('hrA', r2, 'withdraw'))).toBe('REQUEST_NOT_PENDING')
    expect(await prisma.hrEmployee.findUnique({ where: { id: e1.id } })).not.toBeNull()
  })
})

describe('what blocks a delete', () => {
  it('a payslip → 409 EMPLOYEE_HAS_HISTORY at the ask', async () => {
    const e = await mkEmp(T.A)
    await addPayslip(T.A, e.id)
    const r = await ask('hrA', e.id)
    expect(r.statusCode).toBe(409)
    expect(codeOf(r)).toBe('EMPLOYEE_HAS_HISTORY')
    expect((r.json() as { error: { details: { history: string[] } } }).error.details.history.join(' ')).toMatch(/payslip/)
    expect(codeOf(await ask('ceoA', e.id, 'The CEO tries it directly'))).toBe('EMPLOYEE_HAS_HISTORY')
  })

  it('history that appears after the ask → 409 at approval, the request stays pending, nothing deleted', async () => {
    const e = await mkEmp(T.A)
    const reqId = (await ask('hrA', e.id)).json().request.id
    await addPayslip(T.A, e.id)
    const list = await get('ceoA', '/hr/employee-delete-requests?status=pending')
    expect(list.json().items.find((i: { id: string }) => i.id === reqId).blockedBy.join(' ')).toMatch(/payslip/)
    const r = await decide('ceoA', reqId, 'approve')
    expect(r.statusCode).toBe(409)
    expect(codeOf(r)).toBe('EMPLOYEE_HAS_HISTORY')
    expect(await prisma.hrEmployee.findUnique({ where: { id: e.id } })).not.toBeNull()
    expect((await prisma.employeeDeleteRequest.findUniqueOrThrow({ where: { id: reqId } })).status).toBe('pending')
    expect(await prisma.trashEntry.findFirst({ where: { entityType: 'hr_employee', entityId: e.id } })).toBeNull()
  })

  it('an approved pay record (a loan) is history', async () => {
    const e = await mkEmp(T.A)
    await prisma.hrRecord.create({ data: { tenantId: T.A, section: 'loan', formVersion: 1, employeeId: e.id, status: 'approved', amountCents: 100000 } })
    expect(codeOf(await ask('hrA', e.id))).toBe('EMPLOYEE_HAS_HISTORY')
  })

  it('a linked login → 409 EMPLOYEE_HAS_LOGIN', async () => {
    const e = await mkEmp(T.A, { userId: U['cashA']!.id })
    const r = await ask('hrA', e.id)
    expect(r.statusCode).toBe(409)
    expect(codeOf(r)).toBe('EMPLOYEE_HAS_LOGIN')
  })
})

describe("the CEO's own delete", () => {
  it('is immediate and closes a pending request', async () => {
    const e = await mkEmp(T.A)
    const reqId = (await ask('hrA', e.id)).json().request.id
    const r = await ask('ceoA', e.id, 'Duplicate, removing it myself')
    expect(r.statusCode).toBe(200)
    expect(await prisma.hrEmployee.findUnique({ where: { id: e.id } })).toBeNull()
    expect(await prisma.employeeDeleteRequest.findUniqueOrThrow({ where: { id: reqId } })).toMatchObject({ status: 'approved', decidedById: U['ceoA']!.id })
    expect(await prisma.trashEntry.findFirst({ where: { entityType: 'hr_employee', entityId: e.id } })).toMatchObject({ tenantId: T.A })
  })

  it("company B's CEO gets 404 on company A's employee", async () => {
    const e = await mkEmp(T.A)
    expect((await ask('ceoB', e.id, 'Not mine to delete at all')).statusCode).toBe(404)
    expect(await prisma.hrEmployee.findUnique({ where: { id: e.id } })).not.toBeNull()
  })
})
