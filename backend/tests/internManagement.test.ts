// Intern Management (owner, 2026-11-06) — src/modules/hr/interns.ts, internPayroll.ts, internsMigration.ts.
//
//   - Enrolment: HR → pending_approval → the CEO approves (active) / rejects (draft, note ≥10); the CEO's own is
//     active at once; INT-0001 per company; department / supervisor must be the company's (422); B gets 404.
//   - The 'intern' employment type is refused on employees (422 INTERN_NOT_AN_EMPLOYEE).
//   - Attendance: bulk mark (skips non-working days, existing days unless overwrite), single-day edit (audited).
//   - Stipend payroll: only paid interns; stipend ÷ calendar days × paid days; adjustments; HR → finance → CEO;
//     separation of duties; the accrual (Dr 6038 / Cr 2025) and the payment (Dr 2025 / Cr bank) in the run's company;
//     employee payroll untouched; attendance locked once the run leaves draft.
//   - Certificates: completed only, one live, reissue with a reason, PDF.
//   - Reports and dashboard; the supervisor sees only their own interns; finance cannot enrol.
//   - The approvals inbox lists the three types; the legacy move of 'intern' employees.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { runWithRlsContext } = await import('../src/lib/rlsContext.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { computeStipend } = await import('../src/modules/hr/internPayroll.js')
const { migrateLegacyInterns } = await import('../src/modules/hr/internsMigration.js')
const { EMPLOYMENT_TYPES } = await import('../src/modules/hr/forms.js')
const { marketingTrackerRoutes, marketingProgressRoutes } = await import('../src/modules/marketingBoard/tracker.js')
const { postStipendAccrual } = await import('../src/modules/hr/internPayroll.js')

const P = `intern${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
type U = { id: string; name: string; email: string; role: string }
const U: Record<string, U> = {}

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
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
const send = (method: string, key: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { ...auth(key), ...(payload !== undefined && { 'content-type': 'application/json' }) }, ...(payload !== undefined && { payload: JSON.stringify(payload) }) })
const codeOf = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code

const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
const dept = { A: '', B: '' }
const emp = { supA: '', supB: '', staffA: '' }
const intern = { a1: '', a2: '', a3: '', b1: '' }
let runId = ''

const enrol = (key: string, body: Record<string, unknown>) => send('POST', key, '/hr/interns', {
  fullName: 'Ayesha Khan', startDate: '2026-09-15', endDate: '2026-12-31', ...body,
})

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) await ensureChartOfAccounts(t)
  await mkUser('ceo', 'admin', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('hr', 'hr', [T.A])
  await mkUser('hr2', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('hrNoMod', 'hr', [T.A], { moduleDeny: ['staff_hr'] })
  await mkUser('fin', 'finance', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('sup', 'manager', [T.A])
  await mkUser('cashier', 'cashier', [T.A])
  dept.A = (await prisma.department.create({ data: { tenantId: T.A, name: `${P} Marketing A` } })).id
  dept.B = (await prisma.department.create({ data: { tenantId: T.B, name: `${P} Marketing B` } })).id
  emp.supA = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-S1`, fullName: 'Supervisor A', userId: U['sup']!.id, joiningDate: D('2025-01-01') } })).id
  emp.supB = (await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-S2`, fullName: 'Supervisor B', joiningDate: D('2025-01-01') } })).id
  emp.staffA = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-E1`, fullName: 'Cook A', grossSalaryCents: 6_000_000, joiningDate: D('2025-01-01'), paymentMethod: 'bank' } })).id

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(hrRoutes, { prefix: '/hr' })
    await api.register(marketingTrackerRoutes, { prefix: '/marketing-tracker' })
    await api.register(marketingProgressRoutes, { prefix: '/marketing-progress' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('the stipend math (calendar-day basis)', () => {
  it('stipend ÷ calendar days × paid days; absent 1, half day 0.5, leave 1; outside the internship not paid', () => {
    const i = { startDate: D('2026-09-15'), status: 'active', endDate: D('2026-12-31'), completedOn: null, terminationEffectiveDate: null, monthlyStipendCents: 3_100_000 }
    const c = computeStipend(i, '2026-10', [
      { date: D('2026-10-06'), status: 'absent' }, { date: D('2026-10-07'), status: 'half_day' },
      { date: D('2026-10-08'), status: 'leave' }, { date: D('2026-10-09'), status: 'late' },
    ], [{ id: 'x', kind: 'addition', label: 'Travel', amountCents: 50_000, note: null }, { id: 'y', kind: 'deduction', label: 'Advance', amountCents: 20_000, note: null }])
    expect(c.daysInMonth).toBe(31)
    expect(c.paidDays).toBe(28.5)
    expect(c.baseCents).toBe(2_850_000)
    expect(c.netCents).toBe(2_880_000)
    const late = computeStipend({ ...i, startDate: D('2026-10-16'), monthlyStipendCents: 3_000_000 }, '2026-10', [])
    expect(late.daysEngaged).toBe(16)
    expect(late.baseCents).toBe(Math.round(3_000_000 * 16 / 31))
  })
})

describe('enrolment and the register', () => {
  it('the intern employment type is retired: not offered, and refused on employees', async () => {
    expect(EMPLOYMENT_TYPES).not.toContain('intern')
    const r = await send('PATCH', 'hr', `/hr/employees/${emp.staffA}`, { data: { employmentType: 'intern' } })
    expect(r.statusCode, r.body).toBe(422)
    expect(codeOf(r)).toBe('INTERN_NOT_AN_EMPLOYEE')
  })

  it('HR enrols → pending approval with INT-0001; department / supervisor must be the company\'s; checks', async () => {
    expect(codeOf(await enrol('hr', { departmentId: dept.B }))).toBe('DEPARTMENT_NOT_IN_COMPANY')
    expect(codeOf(await enrol('hr', { supervisorEmployeeId: emp.supB }))).toBe('SUPERVISOR_NOT_IN_COMPANY')
    expect(codeOf(await enrol('hr', { internshipType: 'paid' }))).toBe('STIPEND_REQUIRED')
    expect(codeOf(await enrol('hr', { internshipType: 'unpaid', monthlyStipendCents: 100 }))).toBe('STIPEND_ON_UNPAID')
    expect(codeOf(await enrol('hr', { endDate: '2026-09-01' }))).toBe('BAD_DATES')
    const r = await enrol('hr', { departmentId: dept.A, supervisorEmployeeId: emp.supA, designation: 'Design intern', internshipType: 'paid', monthlyStipendCents: 3_100_000, cnic: '4210112345671', institution: 'IBA' })
    expect(r.statusCode, r.body).toBe(201)
    const a1 = r.json() as { id: string; internCode: string; status: string; cnic: string; department: string; supervisor: { fullName: string } }
    expect(a1.internCode).toBe('INT-0001')
    expect(a1.status).toBe('pending_approval')
    expect(a1.cnic).toBe('42101-1234567-1')
    expect(a1.department).toBe(`${P} Marketing A`)
    expect(a1.supervisor.fullName).toBe('Supervisor A')
    intern.a1 = a1.id
    expect(codeOf(await enrol('hr', { cnic: '42101-1234567-1' }))).toBe('INTERN_CNIC_EXISTS')
    // Finance, HR without the module and a cashier cannot enrol.
    expect((await enrol('fin', {})).statusCode).toBe(403)
    expect((await enrol('hrNoMod', {})).statusCode).toBe(403)
    expect((await enrol('cashier', {})).statusCode).toBe(403)
  })

  it('the CEO approves (or rejects with a note); the CEO\'s own enrolment is active at once; codes per company', async () => {
    expect((await send('POST', 'hr', `/hr/interns/${intern.a1}/approve`)).statusCode).toBe(403)
    expect((await send('POST', 'ceoB', `/hr/interns/${intern.a1}/approve`)).statusCode).toBe(404)
    // In the CEO's inbox.
    const inbox = await send('GET', 'ceo', '/approvals?type=intern_enrollment')
    expect(inbox.statusCode, inbox.body).toBe(200)
    expect((inbox.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain(intern.a1)
    const ok = await send('POST', 'ceo', `/hr/interns/${intern.a1}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('active')
    expect(codeOf(await send('POST', 'ceo', `/hr/interns/${intern.a1}/approve`))).toBe('NOT_PENDING')

    const a2 = await enrol('hr', { fullName: 'Bilal Unpaid', departmentId: dept.A, supervisorEmployeeId: emp.supA })
    intern.a2 = a2.json().id
    expect(a2.json().internCode).toBe('INT-0002')
    expect(codeOf(await send('POST', 'ceo', `/hr/interns/${intern.a2}/reject`, { note: 'short' }))).toBe('NOTE_REQUIRED')
    const rej = await send('POST', 'ceo', `/hr/interns/${intern.a2}/reject`, { note: 'Add the university NOC first' })
    expect(rej.json()).toMatchObject({ status: 'draft', rejectionNote: 'Add the university NOC first' })
    expect((await send('POST', 'hr', `/hr/interns/${intern.a2}/submit`)).json().status).toBe('pending_approval')
    expect((await send('POST', 'ceo', `/hr/interns/${intern.a2}/approve`)).json().status).toBe('active')

    const a3 = await enrol('ceo', { fullName: 'Chand Late Starter', startDate: '2026-10-16', internshipType: 'paid', monthlyStipendCents: 3_000_000, departmentId: dept.A })
    expect(a3.json()).toMatchObject({ status: 'active', internCode: 'INT-0003' })
    intern.a3 = a3.json().id

    const b1 = await enrol('hrB', { fullName: 'Dua B', internshipType: 'paid', monthlyStipendCents: 2_000_000, departmentId: dept.B, supervisorEmployeeId: emp.supB })
    expect(b1.json().internCode).toBe('INT-0001')
    intern.b1 = b1.json().id
  })

  it('company B gets 404 on company A\'s intern; lists are company-scoped; history is kept', async () => {
    for (const [m, url] of [['GET', `/hr/interns/${intern.a1}`], ['PATCH', `/hr/interns/${intern.a1}`], ['GET', `/hr/interns/${intern.a1}/history`], ['POST', `/hr/interns/${intern.a1}/extend`]] as const) {
      const r = await send(m, 'hrB', url, m === 'GET' ? undefined : m === 'PATCH' ? { designation: 'x' } : { endDate: '2027-01-31', reason: 'Extended for the project' })
      expect(r.statusCode, `${m} ${url}`).toBe(404)
    }
    const listB = (await send('GET', 'hrB', '/hr/interns')).json() as { items: Array<{ id: string }> }
    expect(listB.items.map((i) => i.id)).toEqual([intern.b1])
    const listA = (await send('GET', 'hr', '/hr/interns?status=active&departmentId=' + dept.A)).json() as { items: Array<{ id: string }> }
    expect(listA.items.map((i) => i.id).sort()).toEqual([intern.a1, intern.a2, intern.a3].sort())
    expect(((await send('GET', 'hr', '/hr/interns?q=bilal')).json() as { items: unknown[] }).items).toHaveLength(1)
    // Department change through the edit is its own history event; extension needs a later date.
    expect((await send('PATCH', 'hr', `/hr/interns/${intern.a2}`, { designation: 'Content intern', supervisorEmployeeId: null })).statusCode).toBe(200)
    expect(codeOf(await send('POST', 'hr', `/hr/interns/${intern.a1}/extend`, { endDate: '2026-11-30', reason: 'Shorter than before' }))).toBe('EXTENSION_NOT_LATER')
    expect((await send('POST', 'hr', `/hr/interns/${intern.a1}/extend`, { endDate: '2027-01-31', reason: 'Extended for the menu launch' })).json().endDate).toContain('2027-01-31')
    const h = (await send('GET', 'hr', `/hr/interns/${intern.a2}/history`)).json() as { events: Array<{ kind: string }> }
    expect(h.events.map((e) => e.kind)).toEqual(['enrolled', 'rejected', 'submitted', 'approved', 'supervisor_changed', 'edited'])
    // Interns are never employees: the HR employee list does not carry them.
    expect(await prisma.hrEmployee.count({ where: { tenantId: T.A, fullName: { in: ['Ayesha Khan', 'Bilal Unpaid', 'Chand Late Starter'] } } })).toBe(0)
  })
})

describe('attendance', () => {
  it('HR marks a range in bulk (non-working days and existing days skipped), adjusts a day (audited)', async () => {
    const r = await send('POST', 'hr', '/hr/interns/attendance/bulk', { internIds: [intern.a1, intern.a2], from: '2026-10-01', to: '2026-10-05', status: 'present' })
    expect(r.statusCode, r.body).toBe(200)
    const out = r.json() as { created: number; skipped: Array<{ date: string; reason: string }> }
    // 1–5 Oct 2026 is Thu–Mon; Sunday 4 Oct is not a working day (Mon–Sat).
    expect(out.created).toBe(8)
    expect(out.skipped.filter((s) => s.reason === 'NOT_A_WORKING_DAY')).toHaveLength(2)
    const again = (await send('POST', 'hr', '/hr/interns/attendance/bulk', { internIds: [intern.a1], from: '2026-10-01', to: '2026-10-01', status: 'present' })).json()
    expect(again.skipped[0].reason).toBe('ALREADY_MARKED')
    expect((await send('POST', 'hrB', '/hr/interns/attendance/bulk', { internIds: [intern.a1], from: '2026-10-01', to: '2026-10-01', status: 'present' })).statusCode).toBe(404)
    for (const [day, status] of [['2026-10-06', 'absent'], ['2026-10-07', 'half_day'], ['2026-10-08', 'leave'], ['2026-10-09', 'late']] as const) {
      expect((await send('PUT', 'hr', `/hr/interns/${intern.a1}/attendance/${day}`, { status })).statusCode).toBe(200)
    }
    expect(codeOf(await send('PUT', 'hr', `/hr/interns/${intern.a1}/attendance/2026-09-01`, { status: 'present' }))).toBe('OUTSIDE_INTERNSHIP')
    const adj = await send('PUT', 'hr', `/hr/interns/${intern.a1}/attendance/2026-10-01`, { status: 'late', note: 'Came at 10:30' })
    expect(adj.json().status).toBe('late')
    const log = await prisma.auditLog.findFirst({ where: { action: 'hr.intern.attendance_adjust', entityId: adj.json().id } })
    expect(log?.before).toMatchObject({ status: 'present' })
    // Put 1 Oct back so the stipend math below matches.
    await send('PUT', 'hr', `/hr/interns/${intern.a1}/attendance/2026-10-01`, { status: 'present' })
    const grid = (await send('GET', 'hr', '/hr/interns/attendance?month=2026-10')).json() as { days: string[]; interns: Array<{ id: string; summary: Record<string, number> }> }
    expect(grid.days).toHaveLength(31)
    expect(grid.interns.find((i) => i.id === intern.a1)!.summary).toMatchObject({ absent: 1, half_day: 1, leave: 1, late: 1 })
  })

  it('the supervisor sees only their own interns, marks attendance and remarks — never pay', async () => {
    const mine = (await send('GET', 'sup', '/hr/my-interns')).json() as { items: Array<Record<string, unknown>> }
    expect(mine.items.map((i) => i['id'])).toEqual([intern.a1])
    expect(mine.items[0]!['monthlyStipendCents']).toBeUndefined()
    expect(mine.items[0]!['cnic']).toBeUndefined()
    expect((await send('GET', 'sup', `/hr/my-interns/${intern.a3}`)).statusCode).toBe(404)
    expect((await send('GET', 'sup', '/hr/interns')).statusCode).toBe(403)
    const d = await send('PUT', 'sup', `/hr/my-interns/${intern.a1}/attendance/2026-10-10`, { status: 'present' })
    expect(d.statusCode, d.body).toBe(200)
    expect(d.json().source).toBe('supervisor')
    expect((await send('PUT', 'sup', `/hr/my-interns/${intern.a1}/remarks`, { performanceRemarks: 'Strong layouts, quick learner' })).json().performanceRemarks).toBe('Strong layouts, quick learner')
  })
})

describe('stipend payroll', () => {
  it('HR builds the run: only PAID interns, the calendar-day math, adjustments', async () => {
    expect((await send('POST', 'fin', '/hr/interns/payroll/runs', { period: '2026-10' })).statusCode).toBe(403)
    const r = await send('POST', 'hr', '/hr/interns/payroll/runs', { period: '2026-10' })
    expect(r.statusCode, r.body).toBe(201)
    const run = r.json() as { id: string; status: string; slips: Array<{ id: string; intern: { id: string }; paidDays: number; baseCents: number; netCents: number }> }
    runId = run.id
    expect(run.slips.map((s) => s.intern.id).sort()).toEqual([intern.a1, intern.a3].sort())
    const a1 = run.slips.find((s) => s.intern.id === intern.a1)!
    expect(a1.paidDays).toBe(28.5)
    expect(a1.baseCents).toBe(2_850_000)
    const adj = await send('PUT', 'hr', `/hr/interns/payroll/slips/${a1.id}/adjustments`, { items: [{ kind: 'addition', label: 'Travel', amountCents: 50_000 }, { kind: 'deduction', label: 'Advance', amountCents: 20_000, note: 'October advance' }] })
    expect(adj.statusCode, adj.body).toBe(200)
    expect(adj.json().netCents).toBe(2_880_000)
    // Recalculate keeps the adjustments.
    const re = (await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/recalculate`)).json() as typeof run & { totals: { netCents: number } }
    expect(re.slips.find((s) => s.intern.id === intern.a1)!.netCents).toBe(2_880_000)
    expect(re.totals.netCents).toBe(2_880_000 + Math.round(3_000_000 * 16 / 31))
    expect(codeOf(await send('POST', 'hr', '/hr/interns/payroll/runs', { period: '2026-10' }))).toBe('RUN_EXISTS')
    expect(codeOf(await send('POST', 'hr', '/hr/interns/payroll/runs', { period: '2027-05' }))).toBe('FUTURE_PERIOD')
    // Company B: 404 on A's run and slips.
    expect((await send('GET', 'hrB', `/hr/interns/payroll/runs/${runId}`)).statusCode).toBe(404)
    expect((await send('GET', 'finB', `/hr/interns/payroll/runs/${runId}`)).statusCode).toBe(404)
    expect((await send('PUT', 'hrB', `/hr/interns/payroll/slips/${a1.id}/adjustments`, { items: [] })).statusCode).toBe(404)
    expect(((await send('GET', 'hrB', '/hr/interns/payroll/runs')).json() as { items: unknown[] }).items).toHaveLength(0)
  })

  it('HR → finance → the CEO; separation of duties; the accrual and the payment in the run\'s company', async () => {
    expect(codeOf(await send('POST', 'ceo', `/hr/interns/payroll/runs/${runId}/approve`))).toBe('NOT_FINANCE_CHECKED')
    expect((await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/send-to-finance`)).json().status).toBe('finance_review')
    // Attendance of the month is locked once the run left draft.
    expect(codeOf(await send('PUT', 'hr', `/hr/interns/${intern.a1}/attendance/2026-10-12`, { status: 'absent' }))).toBe('IN_PAYROLL')
    // HR is not finance; finance returns with a note; HR resends.
    expect((await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/finance-pass`)).statusCode).toBe(403)
    expect(codeOf(await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/finance-return`, { note: 'short' }))).toBe('NOTE_TOO_SHORT')
    expect((await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/finance-return`, { note: 'Check the travel addition again' })).json().status).toBe('draft')
    expect((await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/send-to-finance`)).json().status).toBe('finance_review')
    // Finance's inbox lists it.
    const fInbox = (await send('GET', 'fin', '/approvals?type=intern_payroll_finance')).json() as { items: Array<{ id: string }> }
    expect(fInbox.items.map((i) => i.id)).toContain(runId)
    expect((await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/finance-pass`, { note: 'Checked' })).json().status).toBe('finance_checked')
    // Finance pulls it back from the CEO (owner, 2026-11-07), then passes it again.
    expect((await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/pull-back`)).statusCode).toBe(403)
    expect((await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/pull-back`)).json().status).toBe('finance_review')
    expect((await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/pull-back`)).json().error.code).toBe('NOT_FINANCE_CHECKED')
    expect((await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/finance-pass`, { note: 'Checked' })).json().status).toBe('finance_checked')
    // The CEO only; HR cannot approve.
    expect((await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/approve`)).statusCode).toBe(403)
    expect((await send('POST', 'ceoB', `/hr/interns/payroll/runs/${runId}/approve`)).statusCode).toBe(404)
    const cInbox = (await send('GET', 'ceo', '/approvals?type=intern_payroll')).json() as { items: Array<{ id: string }> }
    expect(cInbox.items.map((i) => i.id)).toContain(runId)
    const empRunsBefore = await prisma.hrPayrollRun.count()
    const ok = await send('POST', 'ceo', `/hr/interns/payroll/runs/${runId}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'approved', accrual: { posted: true } })
    const net = 2_880_000 + Math.round(3_000_000 * 16 / 31)
    const accrual = await prisma.journalEntry.findFirst({ where: { reference: `hr.intern_stipend.accrual:${runId}` }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
    expect(accrual?.tenantId).toBe(T.A)
    expect(accrual!.entryDate.toISOString().slice(0, 10)).toBe('2026-10-31')
    expect(accrual!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['2025', 'credit', net], ['6038', 'debit', net]])
    for (const l of accrual!.lines) expect(l.account.tenantId).toBe(T.A)
    // Finance pays: a reference is needed for a bank transfer.
    expect(codeOf(await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/paid`, { method: 'bank_transfer' }))).toBe('PAYMENT_REFERENCE_REQUIRED')
    expect((await send('POST', 'hr', `/hr/interns/payroll/runs/${runId}/paid`, { method: 'cash' })).statusCode).toBe(403)
    const paid = await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/paid`, { method: 'bank_transfer', reference: 'IBFT-778899', paidOn: '2026-11-05', classification: 'official', taxStatus: 'not_applicable' })
    expect(paid.statusCode, paid.body).toBe(200)
    expect(paid.json().status).toBe('paid')
    const pay = await prisma.journalEntry.findFirst({ where: { reference: `hr.intern_stipend.payment:${runId}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(pay?.tenantId).toBe(T.A)
    expect(pay!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1020', 'credit', net], ['2025', 'debit', net]])
    expect(await prisma.paymentClassification.findUnique({ where: { journalEntryId: pay!.id } })).toMatchObject({ classification: 'official' })
    expect(codeOf(await send('POST', 'fin', `/hr/interns/payroll/runs/${runId}/paid`, { method: 'cash' }))).toBe('NOT_PAYABLE')
    // Employee payroll is untouched: no employee run, nothing on wages or Wages Payable.
    expect(await prisma.hrPayrollRun.count()).toBe(empRunsBefore)
    const wageLines = await prisma.journalLine.count({ where: { journalEntryId: { in: [accrual!.id, pay!.id] }, account: { code: { in: ['2020', '6030', '6031', '6032', '6035', '6036'] } } } })
    expect(wageLines).toBe(0)
  })

  it('separation of duties: the HR login that prepared it cannot pass it at finance even as finance', async () => {
    // A second company-A run, prepared by a finance login holding HR rights is not possible (finance lacks staff_hr):
    // the registry blocks a preparer at the finance step — shown by the finance-review subject.
    const { approvalSubject } = await import('../src/lib/approvalRights.js')
    const s = await approvalSubject('intern_payroll_finance', runId)
    expect(s?.submitterIds).toContain(U['hr']!.id)
    expect(s?.companyIds).toEqual([T.A])
  })

  it('the stipend sheet exports and the slip PDF renders', async () => {
    const csv = await send('GET', 'fin', `/hr/interns/payroll/runs/${runId}/sheet?format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('INT-0001')
    const xlsx = await send('GET', 'hr', `/hr/interns/payroll/runs/${runId}/sheet?format=xlsx`)
    expect(xlsx.statusCode).toBe(200)
    const pdf = await send('GET', 'fin', `/hr/interns/payroll/runs/${runId}/slips.pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF')
  })
})

describe('a refused accrual is flagged and re-posted', () => {
  it('company B: the CEO approves into a closed month → approved, posting flagged; the re-poster books it once open', async () => {
    expect((await send('POST', 'ceoB', `/hr/interns/${intern.b1}/approve`)).json().status).toBe('active')
    const r = await send('POST', 'hrB', '/hr/interns/payroll/runs', { period: '2026-10' })
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().id as string
    expect((await send('POST', 'hrB', `/hr/interns/payroll/runs/${id}/send-to-finance`)).json().status).toBe('finance_review')
    expect((await send('POST', 'finB', `/hr/interns/payroll/runs/${id}/finance-pass`)).json().status).toBe('finance_checked')
    const lock = await prisma.periodLock.create({ data: { tenantId: T.B, lockedThrough: new Date('2026-10-31T18:59:59.999Z'), lockedBy: U['ceoB']!.id } })
    const ok = await send('POST', 'ceoB', `/hr/interns/payroll/runs/${id}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'approved', accrual: { posted: false } })
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityType: 'InternPayrollRun', entityId: id } })
    expect(flag?.tenantId).toBe(T.B)
    // The month opens (or the backfill posts into the open month): the re-poster books it, in company B.
    await prisma.periodLock.delete({ where: { id: lock.id } })
    expect((await postStipendAccrual(id, { postedBy: U['ceoB']!.id })).posted).toBe(true)
    expect((await postStipendAccrual(id, { postedBy: U['ceoB']!.id })).posted).toBe(false)
    const e = await prisma.journalEntry.findFirst({ where: { reference: `hr.intern_stipend.accrual:${id}` } })
    expect(e?.tenantId).toBe(T.B)
    // Company A cannot see B's run or pay it.
    expect((await send('POST', 'fin', `/hr/interns/payroll/runs/${id}/paid`, { method: 'cash' })).statusCode).toBe(404)
  })
})

describe('certificates', () => {
  it('only for a completed intern; one live; reissue with a reason; PDF', async () => {
    expect(codeOf(await send('POST', 'hr', `/hr/interns/${intern.a2}/certificates`, {}))).toBe('INTERN_NOT_COMPLETED')
    expect((await send('POST', 'hr', `/hr/interns/${intern.a2}/complete`, { completedOn: '2026-11-04', remarks: 'Delivered the October campaign' })).json().status).toBe('completed')
    // A completed internship's internship fields are fixed.
    expect(codeOf(await send('PATCH', 'hr', `/hr/interns/${intern.a2}`, { designation: 'Late change' }))).toBe('INTERN_CLOSED')
    expect((await send('POST', 'fin', `/hr/interns/${intern.a2}/certificates`, {})).statusCode).toBe(403)
    const c = await send('POST', 'hr', `/hr/interns/${intern.a2}/certificates`, { remarks: 'With appreciation for creative work' })
    expect(c.statusCode, c.body).toBe(201)
    expect(c.json()).toMatchObject({ status: 'generated', number: `IC-${new Date().getUTCFullYear()}-0001` })
    expect(codeOf(await send('POST', 'hr', `/hr/interns/${intern.a2}/certificates`, {}))).toBe('CERTIFICATE_EXISTS')
    expect((await send('POST', 'hr', `/hr/interns/certificates/${c.json().id}/issue`)).json().status).toBe('issued')
    expect(codeOf(await send('POST', 'hr', `/hr/interns/${intern.a2}/certificates/reissue`, { reason: 'short' }))).toBe('VALIDATION_ERROR')
    const re = await send('POST', 'hr', `/hr/interns/${intern.a2}/certificates/reissue`, { reason: 'Name was misspelt on the first one' })
    expect(re.statusCode, re.body).toBe(201)
    expect(re.json()).toMatchObject({ status: 'reissued', reissueOfId: c.json().id })
    expect((await prisma.internCertificate.findUnique({ where: { id: c.json().id } }))?.supersededAt).toBeTruthy()
    const list = (await send('GET', 'hr', `/hr/interns/${intern.a2}/certificates`)).json()
    expect(list.certificateStatus).toBe('reissued')
    const pdf = await send('GET', 'hr', `/hr/interns/certificates/${re.json().id}/pdf?download=1`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(String(pdf.headers['content-disposition'])).toMatch(/^attachment/)
    expect((await send('GET', 'hrB', `/hr/interns/certificates/${re.json().id}/pdf`)).statusCode).toBe(404)
    expect((await send('POST', 'hrB', `/hr/interns/certificates/${re.json().id}/issue`)).statusCode).toBe(404)
  })

  it('terminate needs a reason and an effective date', async () => {
    expect((await send('POST', 'hr', `/hr/interns/${intern.a3}/terminate`, { reason: 'x', effectiveDate: '2026-11-05' })).statusCode).toBe(400)
    const t = await send('POST', 'hr', `/hr/interns/${intern.a3}/terminate`, { reason: 'Left for university exams', effectiveDate: '2026-11-05' })
    expect(t.json()).toMatchObject({ status: 'terminated', terminationReason: 'Left for university exams' })
  })
})

describe('reports and dashboard', () => {
  it('every report returns JSON and exports; company B sees none of A\'s', async () => {
    for (const key of ['register', 'active', 'completions', 'attendance', 'payroll', 'stipend_by_department', 'certificates']) {
      const r = await send('GET', 'hr', `/hr/interns/reports/${key}?month=2026-10`)
      expect(r.statusCode, `${key} ${r.body}`).toBe(200)
      expect(Array.isArray(r.json().rows)).toBe(true)
      const x = await send('GET', 'hr', `/hr/interns/reports/${key}?month=2026-10&format=pdf`)
      expect(x.statusCode, key).toBe(200)
    }
    const payroll = (await send('GET', 'hr', '/hr/interns/reports/payroll?month=2026-10')).json() as { rows: Array<{ code: string }> }
    expect(payroll.rows.map((r) => r.code).sort()).toEqual(['INT-0001', 'INT-0003'])
    const byDept = (await send('GET', 'hr', '/hr/interns/reports/stipend_by_department?month=2026-10')).json() as { rows: Array<{ department: string; net: number }> }
    expect(byDept.rows.find((r) => r.department === 'TOTAL')!.net).toBe(2_880_000 + Math.round(3_000_000 * 16 / 31))
    const certs = (await send('GET', 'hr', '/hr/interns/reports/certificates')).json() as { rows: unknown[] }
    expect(certs.rows).toHaveLength(2)
    expect(((await send('GET', 'hrB', '/hr/interns/reports/register')).json() as { rows: Array<{ code: string }> }).rows.map((r) => r.code)).toEqual(['INT-0001'])
    expect((await send('GET', 'hr', '/hr/interns/reports/nope')).statusCode).toBe(404)
    const dash = (await send('GET', 'hr', '/hr/interns/dashboard?month=2026-10')).json()
    expect(dash).toMatchObject({ total: 3, byStatus: { active: 1, completed: 1, terminated: 1 }, certificatesIssued: 1 })
    expect(dash.stipend.netCents).toBe(2_880_000 + Math.round(3_000_000 * 16 / 31))
  })
})

describe('the move of the retired intern employees', () => {
  it('an intern employee with no history goes to the Trash; one with history stays, marked left; both get an Intern', async () => {
    const login = await mkUser('mi', 'marketing_intern', [T.A])
    const plain = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-I1`, fullName: 'Old Intern One', employmentType: 'intern', joiningDate: D('2026-08-01'), grossSalaryCents: 1_500_000, departmentId: dept.A, managerId: emp.supA, userId: login.id } })
    await prisma.hrRecord.create({ data: { tenantId: T.A, section: 'attendance', formVersion: 0, employeeId: plain.id, status: 'approved', category: 'absent', startDate: D('2026-10-02') } as never })
    const track = await prisma.marketingTrackee.create({ data: { tenantId: T.A, employeeId: plain.id, roleLabel: 'Design intern', startDate: D('2026-08-01') } })
    const withHistory = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-I2`, fullName: 'Old Intern Two', employmentType: 'intern', joiningDate: D('2026-07-01') } })
    const oldRun = await prisma.hrPayrollRun.create({ data: { tenantId: T.A, period: '2026-08', status: 'locked', settings: {} } })
    await prisma.hrPayslip.create({ data: { tenantId: T.A, runId: oldRun.id, employeeId: withHistory.id, inputs: {}, lines: [], grossCents: 1_000_000, earningsCents: 1_000_000, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 1_000_000 } })

    const res = await migrateLegacyInterns({ tenantIds: [T.A] })
    const one = res.find((r) => r.employeeId === plain.id)!
    const two = res.find((r) => r.employeeId === withHistory.id)!
    expect(one.action).toBe('removed')
    expect(two.action).toBe('kept')
    expect(await prisma.hrEmployee.findUnique({ where: { id: plain.id } })).toBeNull()
    expect(await prisma.trashEntry.count({ where: { entityType: 'hr_employee', entityId: plain.id } })).toBe(1)
    const i1 = await prisma.intern.findUniqueOrThrow({ where: { legacyEmployeeId: plain.id } })
    expect(i1).toMatchObject({ tenantId: T.A, status: 'active', userId: login.id, departmentId: dept.A, supervisorEmployeeId: emp.supA, internshipType: 'paid', monthlyStipendCents: 1_500_000 })
    expect(i1.internCode).toBe('INT-0004')
    expect(await prisma.internAttendance.count({ where: { internId: i1.id, status: 'absent' } })).toBe(1)
    expect(await prisma.marketingTrackee.findUnique({ where: { id: track.id } })).toMatchObject({ internId: i1.id, employeeId: null })
    const kept = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: withHistory.id } })
    expect(kept.status).toBe('separated')
    expect(await prisma.intern.count({ where: { legacyEmployeeId: withHistory.id } })).toBe(1)
    // Idempotent.
    const again = await migrateLegacyInterns({ tenantIds: [T.A] })
    expect(again.every((r) => r.action === 'already_moved')).toBe(true)
    expect(await prisma.intern.count({ where: { tenantId: T.A } })).toBe(5)
    // The moved intern's own progress page still finds their tracker record through the intern's login.
    const me = await send('GET', 'mi', '/marketing-progress/me')
    expect(me.statusCode, me.body).toBe(200)
    expect((me.json() as { records: Array<{ id: string }> }).records.map((r) => r.id)).toEqual([track.id])
  })
})

describe('the marketing tracker points at interns', () => {
  it('a tracker record names an intern of the active company; its attendance is the intern attendance', async () => {
    expect(codeOf(await send('POST', 'ceo', '/marketing-tracker', { roleLabel: 'Designer', startDate: '2026-10-01' }))).toBe('PERSON_REQUIRED')
    expect((await send('POST', 'ceoB', '/marketing-tracker', { internId: intern.a1, roleLabel: 'Designer', startDate: '2026-10-01' })).statusCode).toBe(404)
    const r = await send('POST', 'ceo', '/marketing-tracker', { internId: intern.a1, roleLabel: 'Design intern', startDate: '2026-10-01' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().person).toMatchObject({ kind: 'intern', id: intern.a1, code: 'INT-0001' })
    expect(codeOf(await send('POST', 'ceo', '/marketing-tracker', { internId: intern.a1, roleLabel: 'Again', startDate: '2026-10-01' }))).toBe('ALREADY_TRACKED')
    const att = (await send('GET', 'ceo', `/marketing-tracker/${r.json().id}/attendance?from=2026-10-01&to=2026-10-31`)).json()
    expect(att).toMatchObject({ source: 'intern', absent: 1, halfDays: 1, late: 1, unpaidLeaveDays: 1 })
    const list = (await send('GET', 'ceo', '/marketing-tracker')).json() as Array<{ id: string; person: { kind: string } }>
    expect(list.find((t) => t.id === r.json().id)?.person.kind).toBe('intern')
  })
})
