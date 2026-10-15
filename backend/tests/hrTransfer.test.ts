// "Move to head office" (D1 spec §5, A16) — hr/transfer.ts through the real
// routes (hr/transferRoutes.ts) on Fastify inject.
//
//   HO  (head office, the CEO's) ── live link ──▶ A, A2 (companies)
//   HO2 (head office, NOT the CEO's)            ── live link ──▶ A
//   B   (company, not linked to HO)
//
// Move month K = 2026-11 (effective 2026-11-01): the company pays through
// 2026-10, the head office from 2026-11.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { hrHeadOfficeTransferRoutes } from '../src/modules/hr/transferRoutes.js'
import { payableEmployees, leaveBalancesFor } from '../src/modules/hr/service.js'
import { LEFT_STATUSES } from '../src/modules/hr/separations.js'

const P = `hrt-${Date.now()}`
const EFFECTIVE = '2026-11-01'
const K = '2026-11'
const K_1 = '2026-10'
const EFF = new Date(Date.UTC(2026, 10, 1))

let app: FastifyInstance
let HO: string, HO2: string, A: string, A2: string, B: string
let annualA: string, deptFinance: string
const users: Record<string, { id: string; token: string }> = {}
const emp: Record<string, string> = {}

async function tenant(name: string, kind: 'company' | 'head_office' = 'company') {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}`, kind } })).id
}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}

async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: {
      tenantId, employeeCode: `E-${key}`, fullName: `Person ${key}`, status: 'active', employmentType: 'permanent',
      joiningDate: new Date(Date.UTC(2024, 0, 1)), basicSalaryCents: 15_000_000, grossSalaryCents: 26_000_000, ...extra,
    },
  })
  emp[key] = e.id
  return e.id
}

async function run(tenantId: string, period: string, status: string, employeeIds: string[]) {
  const r = await prisma.hrPayrollRun.create({ data: { tenantId, period, status, settings: {} } })
  for (const employeeId of employeeIds) {
    await prisma.hrPayslip.create({
      data: { runId: r.id, tenantId, employeeId, inputs: {}, lines: [], grossCents: 1, earningsCents: 1, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 1 },
    })
  }
  return r.id
}

function call(who: string, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url: `/api/v1/hr${url}`, headers: { authorization: `Bearer ${users[who]!.token}` }, payload: payload as never })
}
const body = (employeeIds: string[], extra: Record<string, unknown> = {}) => ({ employeeIds, headOfficeTenantId: HO, effectiveDate: EFFECTIVE, ...extra })

beforeAll(async () => {
  HO = await tenant('GS Head Office', 'head_office')
  HO2 = await tenant('Other Head Office', 'head_office')
  A = await tenant('GS Foods')
  A2 = await tenant('GS x Viva')
  B = await tenant('Unlinked Co')
  await mkUser('ceo', 'admin', A, [A, A2, B, HO])
  await mkUser('hr', 'hr', A, [A])
  for (const [h, c] of [[HO, A], [HO, A2], [HO2, A]] as const) {
    await prisma.headOfficeLink.create({ data: { tenantId: h, companyTenantId: c, createdById: users.ceo!.id } })
  }

  // Company A's HR master data.
  deptFinance = (await prisma.department.create({ data: { tenantId: A, name: 'Finance' } })).id
  const desig = (await prisma.hrOrgUnit.create({ data: { tenantId: A, kind: 'designation', name: 'Finance Manager' } })).id
  const grade = (await prisma.hrOrgUnit.create({ data: { tenantId: A, kind: 'grade', name: 'G5' } })).id
  annualA = (await prisma.hrRecord.create({
    data: { tenantId: A, section: 'leave_type', formVersion: 0, status: 'approved', quantity: 14, category: 'paid', data: { name: 'Annual Leave' } },
  })).id
  await prisma.hrRecord.create({
    data: { tenantId: A, section: 'leave_type', formVersion: 0, status: 'approved', quantity: 0, category: 'unpaid', data: { name: 'Unpaid Leave' } },
  })

  // mgr + staff move together; staff reports to mgr.
  const u1 = await mkUser('mgr', 'finance', A, [A, A2])
  const u2 = await mkUser('staff', 'finance', A, [A, A2, B])
  await mkEmp('mgr', A, { userId: u1, departmentId: deptFinance, designationId: desig, gradeId: grade, iban: 'PK00TEST', cnic: '42101-0000000-1' })
  await mkEmp('staff', A, { userId: u2, managerId: emp.mgr, departmentId: deptFinance })
  await prisma.hrDocument.create({ data: { tenantId: A, employeeId: emp.mgr!, docType: 'cnic_front', fileUrl: 'https://files.test/cnic.png' } })
  // mgr took 3 days of annual leave this year → 11 left.
  await prisma.hrRecord.create({
    data: {
      tenantId: A, section: 'leave', formVersion: 0, employeeId: emp.mgr, refId: annualA, status: 'approved', quantity: 3,
      startDate: new Date(Date.UTC(2026, 2, 2)), endDate: new Date(Date.UTC(2026, 2, 4)),
    },
  })
  // mgr's seat: shared share (100k of 260k) — moves at 100%.
  await prisma.position.create({
    data: { tenantId: A, departmentId: deptFinance, title: 'Finance Manager', monthlySalaryCents: 26_000_000, tenantCostShareCents: 10_000_000, filledByUserId: u1, status: 'filled' },
  })

  // Refusal cases.
  await mkEmp('loan', A)
  await prisma.hrRecord.create({
    data: { tenantId: A, section: 'loan', formVersion: 0, employeeId: emp.loan, status: 'approved', category: 'loan', amountCents: 5_000_000, quantity: 5, effectiveDate: new Date(Date.UTC(2026, 8, 1)) },
  })
  await mkEmp('open', A)
  await prisma.hrRecord.create({
    data: { tenantId: A, section: 'overtime', formVersion: 0, employeeId: emp.open, status: 'submitted', quantity: 2, startDate: new Date(Date.UTC(2026, 9, 3)) },
  })
  await mkEmp('paid', A)
  await run(A, '2026-12', 'approved', [emp.paid!])
  await mkEmp('unlinked', B)
  await mkEmp('gone', A, { status: 'resigned', lastWorkingDay: new Date(Date.UTC(2026, 5, 30)) })
  // One login with records in two linked companies (A and A2).
  const u3 = await mkUser('dup', 'finance', A, [A, A2])
  await mkEmp('dupA', A, { userId: u3 })
  await mkEmp('dupA2', A2, { userId: u3 })
  // A draft payroll for K only warns.
  await mkEmp('draft', A)
  await run(A, K, 'draft', [emp.draft!])

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(hrHeadOfficeTransferRoutes, { prefix: '/hr' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('access', () => {
  it('a non-CEO gets 403', async () => {
    const r = await call('hr', '/head-office-transfers/preview', body([emp.mgr!]))
    expect(r.statusCode).toBe(403)
    const w = await call('hr', '/head-office-transfers', body([emp.mgr!]))
    expect(w.statusCode).toBe(403)
  })

  it('a head office the CEO does not belong to is 404', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.mgr!], { headOfficeTenantId: HO2 }))
    expect(r.statusCode).toBe(404)
    const w = await call('ceo', '/head-office-transfers', body([emp.mgr!], { headOfficeTenantId: HO2 }))
    expect(w.statusCode).toBe(404)
  })

  it('a company (not a head office) as the target is 404', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.mgr!], { headOfficeTenantId: A2 }))
    expect(r.statusCode).toBe(404)
  })

  it('an employee of a company the CEO does not belong to is 404', async () => {
    const F = await tenant('Foreign Co')
    const id = (await prisma.hrEmployee.create({ data: { tenantId: F, employeeCode: 'F-1', fullName: 'Foreign' } })).id
    const r = await call('ceo', '/head-office-transfers', body([id]))
    expect(r.statusCode).toBe(404)
  })

  it('the move date must be the 1st of a month', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.mgr!], { effectiveDate: '2026-11-15' }))
    expect(r.statusCode).toBe(400)
  })

  it('a kept membership must be a company linked to the head office', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.mgr!], { keepCompanyMemberships: [B] }))
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BAD_KEEP_MEMBERSHIP')
  })
})

describe('refusals', () => {
  const refused = async (key: string, status: number, code: string) => {
    const r = await call('ceo', '/head-office-transfers', body([emp[key]!]))
    expect(r.statusCode, r.body).toBe(status)
    expect(r.json().error.code).toBe(code)
    const still = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp[key]! } })
    expect(still.status).not.toBe('transferred')
  }
  it('not in a linked company → 422 NOT_IN_LINKED_COMPANY', () => refused('unlinked', 422, 'NOT_IN_LINKED_COMPANY'))
  it('not a current employee → 422 NOT_IN_LINKED_COMPANY', () => refused('gone', 422, 'NOT_IN_LINKED_COMPANY'))
  it('an outstanding loan → 409 TRANSFER_LOAN_OUTSTANDING', () => refused('loan', 409, 'TRANSFER_LOAN_OUTSTANDING'))
  it('a submitted record → 409 TRANSFER_OPEN_RECORDS', () => refused('open', 409, 'TRANSFER_OPEN_RECORDS'))
  it('an approved payroll at/after the move month → 409 TRANSFER_PAYROLL_CONFLICT', () => refused('paid', 409, 'TRANSFER_PAYROLL_CONFLICT'))

  it('two records of one login in a batch → 409 DUPLICATE_LOGIN_IN_BATCH (no raw unique-key 500)', async () => {
    const r = await call('ceo', '/head-office-transfers', body([emp.dupA!, emp.dupA2!]))
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('DUPLICATE_LOGIN_IN_BATCH')
    expect(await prisma.hrEmployee.count({ where: { tenantId: HO } })).toBe(0)
  })

  it('a link ended since it was set up → 422 NOT_IN_LINKED_COMPANY', async () => {
    const link = await prisma.headOfficeLink.findFirstOrThrow({ where: { tenantId: HO, companyTenantId: A2 } })
    await prisma.tenant.update({ where: { id: A2 }, data: { isActive: false } })
    try {
      const r = await call('ceo', '/head-office-transfers', body([emp.dupA2!]))
      expect(r.statusCode, r.body).toBe(422)
      expect(r.json().error.code).toBe('NOT_IN_LINKED_COMPANY')
    } finally {
      await prisma.tenant.update({ where: { id: A2 }, data: { isActive: true } })
    }
    expect(link.endedAt).toBeNull()
  })

  it('one blocked person stops the whole batch (nothing moves)', async () => {
    const r = await call('ceo', '/head-office-transfers', body([emp.mgr!, emp.loan!]))
    expect(r.statusCode).toBe(409)
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.mgr! } })).status).toBe('active')
    expect(await prisma.hrEmployee.count({ where: { tenantId: HO } })).toBe(0)
  })

  it('the preview lists blockers instead of refusing', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.loan!, emp.open!]))
    expect(r.statusCode).toBe(200)
    const p = r.json()
    expect(p.ok).toBe(false)
    expect(p.employees[0].blockers.map((b: { code: string }) => b.code)).toContain('TRANSFER_LOAN_OUTSTANDING')
    expect(p.employees[1].blockers.map((b: { code: string }) => b.code)).toContain('TRANSFER_OPEN_RECORDS')
  })
})

describe('preview', () => {
  it('shows leave carried, the suggested adjustment (display only), seats and logins', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.mgr!, emp.staff!], { keepCompanyMemberships: [A2] }))
    expect(r.statusCode, r.body).toBe(200)
    const p = r.json()
    expect(p.ok).toBe(true)
    const mgr = p.employees.find((e: { employeeId: string }) => e.employeeId === emp.mgr)
    const annual = mgr.leave.find((l: { name: string }) => l.name === 'Annual Leave')
    expect(annual.days).toBe(11)
    expect(mgr.leave.find((l: { name: string }) => l.name === 'Unpaid Leave')).toBeUndefined()
    // daily rate = 260,000 / 26 = 10,000 PKR; 11 days → 110,000 PKR.
    expect(mgr.dailyRateCents).toBe(1_000_000)
    expect(mgr.suggestedAdjustmentCents).toBe(11_000_000)
    expect(mgr.department).toEqual({ name: 'Finance', match: 'create' })
    expect(mgr.positions).toEqual([expect.objectContaining({ moves: true })])
    expect(mgr.lastWorkingDay).toBe('2026-10-31')
    const staff = p.employees.find((e: { employeeId: string }) => e.employeeId === emp.staff)
    expect(staff.manager).toEqual(expect.objectContaining({ mapped: true }))
    expect(staff.login.removeMemberships).toEqual([A])
    expect(staff.login.keepMemberships).toEqual([A2])
    // Nothing written, nothing posted.
    expect(await prisma.hrEmployee.count({ where: { tenantId: HO } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: { in: [A, HO] } } })).toBe(0)
  })

  it('direct reports who stay in the company are listed as a warning', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.mgr!]))
    const p = r.json()
    expect(p.ok).toBe(true)
    expect(p.employees[0].warnings.join(' ')).toMatch(/1 direct report\(s\) stay in the company.*Person staff/)
    // Moving together: no warning.
    const both = (await call('ceo', '/head-office-transfers/preview', body([emp.mgr!, emp.staff!]))).json()
    expect(both.employees[0].warnings.join(' ')).not.toMatch(/direct report/)
  })

  it('a draft payroll at the move month only warns', async () => {
    const r = await call('ceo', '/head-office-transfers/preview', body([emp.draft!]))
    const p = r.json()
    expect(p.ok).toBe(true)
    expect(p.employees[0].warnings.join(' ')).toMatch(/draft payroll 2026-11/)
  })
})

describe('the move', () => {
  let res: { moved: Array<{ fromEmployeeId: string; toEmployeeId: string; toEmployeeCode: string; positionIds: string[]; removedMemberships: string[]; leaveAdjustmentIds: string[] }> }
  const toOf = (key: string) => res.moved.find((m) => m.fromEmployeeId === emp[key])!.toEmployeeId

  beforeAll(async () => {
    const r = await call('ceo', '/head-office-transfers', body([emp.staff!, emp.mgr!], { keepCompanyMemberships: [A2] }))
    expect(r.statusCode, r.body).toBe(201)
    res = r.json()
  })

  it('the old record becomes transferred, ending the day before', async () => {
    const old = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.mgr! } })
    expect(old.status).toBe('transferred')
    expect(old.lastWorkingDay?.toISOString().slice(0, 10)).toBe('2026-10-31')
    expect(LEFT_STATUSES).not.toContain('transferred')
    expect((old.data as Record<string, { tenantId: string }>).transferredTo!.tenantId).toBe(HO)
  })

  it('the head office record copies the master data, maps org lists and the manager', async () => {
    const n = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: toOf('mgr') } })
    expect(n.tenantId).toBe(HO)
    expect(n.employeeCode).toMatch(/^EMP-\d{4}$/)
    expect(n.iban).toBe('PK00TEST')
    expect(n.cnic).toBe('42101-0000000-1')
    expect(n.grossSalaryCents).toBe(26_000_000)
    expect(n.joiningDate?.toISOString().slice(0, 10)).toBe('2024-01-01')
    expect(n.locationId).toBeNull()
    expect((n.data as Record<string, { employeeId: string }>).transferredFrom!.employeeId).toBe(emp.mgr)
    const dept = await prisma.department.findUniqueOrThrow({ where: { id: n.departmentId! } })
    expect(dept).toEqual(expect.objectContaining({ tenantId: HO, name: 'Finance' }))
    const desig = await prisma.hrOrgUnit.findUniqueOrThrow({ where: { id: n.designationId! } })
    expect(desig).toEqual(expect.objectContaining({ tenantId: HO, kind: 'designation', name: 'Finance Manager' }))
    expect((await prisma.hrOrgUnit.findUniqueOrThrow({ where: { id: n.gradeId! } })).tenantId).toBe(HO)
    expect(await prisma.hrDocument.count({ where: { employeeId: n.id, tenantId: HO } })).toBe(1)
    const s = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: toOf('staff') } })
    expect(s.managerId).toBe(n.id)
    expect(s.departmentId).toBe(n.departmentId) // one twin department, not two
  })

  it('leave is carried over as approved system adjustments (types copied first)', async () => {
    const hoTypes = await prisma.hrRecord.findMany({ where: { tenantId: HO, section: 'leave_type' } })
    expect(hoTypes.map((t) => (t.data as { name: string }).name).sort()).toEqual(['Annual Leave', 'Unpaid Leave'])
    const bal = await leaveBalancesFor(HO, toOf('mgr'), EFF)
    expect(bal.find((b) => b.name === 'Annual Leave')!.balance).toBe(11)
    const adj = await prisma.hrRecord.findMany({ where: { tenantId: HO, section: 'leave_adjustment', employeeId: toOf('mgr') } })
    expect(adj).toHaveLength(1)
    expect(adj[0]).toEqual(expect.objectContaining({ status: 'approved', quantity: -3 }))
    // staff took nothing: full 14 in the head office, no adjustment needed.
    expect((await leaveBalancesFor(HO, toOf('staff'), EFF)).find((b) => b.name === 'Annual Leave')!.balance).toBe(14)
  })

  it('payableEmployees: the company pays through K−1, the head office from K', async () => {
    const ids = async (t: string, p: string) => (await payableEmployees(t, p)).map((e) => e.id)
    expect(await ids(A, K_1)).toContain(emp.mgr)
    expect(await ids(A, K)).not.toContain(emp.mgr)
    expect(await ids(HO, K)).toContain(toOf('mgr'))
    // Joining date kept (2024): still the head office never pays a month before K.
    expect(await ids(HO, K_1)).not.toContain(toOf('mgr'))
  })

  it('with keepJoiningDate=false the head office starts at K only', async () => {
    const r = await call('ceo', '/head-office-transfers', body([emp.draft!], { keepJoiningDate: false }))
    expect(r.statusCode, r.body).toBe(201)
    const to = r.json().moved[0].toEmployeeId
    const ids = async (t: string, p: string) => (await payableEmployees(t, p)).map((e) => e.id)
    expect(await ids(HO, K_1)).not.toContain(to)
    expect(await ids(HO, K)).toContain(to)
    expect(await ids(A, K_1)).toContain(emp.draft)
  })

  it('the login is kept: member of the head office, out of the linked companies except the kept ones', async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: users.staff!.id }, select: { tenantId: true, isActive: true } })
    expect(u.isActive).toBe(true)
    expect(u.tenantId).toBe(HO)
    const m = (await prisma.tenantMember.findMany({ where: { userId: users.staff!.id } })).map((x) => x.tenantId).sort()
    expect(m).toEqual([HO, A2, B].sort()) // A removed; A2 kept; B is not linked, untouched
    const mm = (await prisma.tenantMember.findMany({ where: { userId: users.mgr!.id } })).map((x) => x.tenantId).sort()
    expect(mm).toEqual([HO, A2].sort())
    // The new HO record is linked to the same login.
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: toOf('staff') } })).userId).toBe(users.staff!.id)
  })

  it('the seat moves to the head office at 100%', async () => {
    const pos = await prisma.position.findMany({ where: { filledByUserId: users.mgr!.id } })
    expect(pos).toHaveLength(1)
    expect(pos[0]!.tenantId).toBe(HO)
    expect(pos[0]!.conceptId).toBeNull()
    expect(pos[0]!.tenantCostShareCents).toBe(26_000_000)
    const n = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: toOf('mgr') } })
    expect(pos[0]!.departmentId).toBe(n.departmentId)
  })

  it('both companies\' identity trails get an hr.transfer entry', async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: 'hr.transfer', userId: users.ceo!.id, OR: [{ entityId: emp.mgr }, { entityId: toOf('mgr') }] } })
    expect(rows.map((r) => r.tenantId).sort()).toEqual([A, HO].sort())
    expect(rows.every((r) => r.category === 'identity')).toBe(true)
  })

  it('moving the same person again is refused', async () => {
    const r = await call('ceo', '/head-office-transfers', body([emp.mgr!]))
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NOT_IN_LINKED_COMPANY')
  })

  it('nothing is posted to either ledger', async () => {
    expect(await prisma.journalEntry.count({ where: { tenantId: { in: [A, A2, HO] } } })).toBe(0)
  })
})

describe('a login still employed in another linked company', () => {
  it('keeps that membership (preview warns), even when not picked to keep', async () => {
    const p = (await call('ceo', '/head-office-transfers/preview', body([emp.dupA!]))).json()
    expect(p.ok).toBe(true)
    const e = p.employees[0]
    expect(e.login.removeMemberships).toEqual([A])
    expect(e.login.keepMemberships).toEqual([A2])
    expect(e.warnings.join(' ')).toMatch(/Keeps the GS x Viva membership: their login is still a current employee there/)

    const r = await call('ceo', '/head-office-transfers', body([emp.dupA!]))
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().moved[0].removedMemberships).toEqual([A])
    const m = (await prisma.tenantMember.findMany({ where: { userId: users.dup!.id } })).map((x) => x.tenantId).sort()
    expect(m).toEqual([HO, A2].sort())
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.dupA2! } })).status).toBe('active')
  })
})

describe('an archived head-office department', () => {
  it('is brought back rather than left archived', async () => {
    const dept = (await prisma.department.create({ data: { tenantId: A, name: 'Stores' } })).id
    const archived = (await prisma.department.create({ data: { tenantId: HO, name: 'Stores', archivedAt: new Date() } })).id
    const id = await mkEmp('stores', A, { departmentId: dept })
    const r = await call('ceo', '/head-office-transfers', body([id]))
    expect(r.statusCode, r.body).toBe(201)
    const n = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: r.json().moved[0].toEmployeeId } })
    expect(n.departmentId).toBe(archived)
    expect((await prisma.department.findUniqueOrThrow({ where: { id: archived } })).archivedAt).toBeNull()
  })
})
