// Employee self-evaluation & performance appraisal (owner, 2026-11-06) — src/modules/hr/performance.ts.
//
//   - Scoring: rating ÷ 5 × weight; final = self × 30% + manager × 70%; categories at 90 / 80 / 70 / 60.
//   - HR makes a cycle (the nine standard areas, weights add to 100%); its areas lock once evaluations exist.
//   - Only the reporting manager assigns (403 NOT_YOUR_REPORT); another company's cycle / evaluation is 404.
//   - Employee: draft → submit (every question rated, overall rating + why); locked after submit.
//   - Manager: return (note ≥10) → employee resubmits → manager rates every area → approve = finalized + scores.
//   - The employee sees the manager's part only once finalized; acknowledges once.
//   - HR: results (company B sees none of A's), PDF export, reopen with a reason.
//   - The old "Performance reviews" section is moved here; a finalized evaluation blocks deleting the employee.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { runWithRlsContext } = await import('../src/lib/rlsContext.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { sectionByKey } = await import('../src/modules/hr/forms.js')
const { employeeHistory } = await import('../src/modules/hr/employeeDelete.js')
const Perf = await import('../src/modules/hr/performance.js')

const P = `perf${Date.now()}`
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
const send = (method: string, key: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { ...auth(key), ...(payload !== undefined && { 'content-type': 'application/json' }) }, ...(payload !== undefined && { payload: JSON.stringify(payload) }) })
const codeOf = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code

let n = 0
const mkEmp = async (tenantId: string, extra: Record<string, unknown> = {}) => {
  n += 1
  return prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${P}-${n}`, fullName: `${P} Person ${n}`, joiningDate: new Date('2025-01-01'), ...extra } })
}

const emp = { mgr: '', staff: '', other: '', b: '' }
let cycleId = ''
let evId = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hrB', 'hr', [T.B])
  await mkUser('mgrA', 'manager', [T.A])
  await mkUser('mgr2A', 'manager', [T.A])
  await mkUser('staffA', 'cashier', [T.A])
  await mkUser('staffB', 'cashier', [T.B])
  emp.mgr = (await mkEmp(T.A, { userId: U['mgrA']!.id })).id
  await mkEmp(T.A, { userId: U['mgr2A']!.id })
  emp.staff = (await mkEmp(T.A, { userId: U['staffA']!.id, managerId: emp.mgr })).id
  emp.other = (await mkEmp(T.A, { managerId: emp.mgr })).id
  emp.b = (await mkEmp(T.B, { userId: U['staffB']!.id })).id

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(hrRoutes, { prefix: '/hr' }) }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

const allSelf = (ev: { areas: Array<{ key: string }>; questions: Record<string, Array<{ id: string }>> }, r: number) => ({
  areas: Object.fromEntries(ev.areas.map((a) => {
    const qs = ev.questions[a.key] ?? []
    return [a.key, qs.length
      ? { comment: 'Comment', evidence: 'Evidence', answers: Object.fromEntries(qs.map((q) => [q.id, { rating: r, answer: 'Answer' }])) }
      : { rating: r, comment: 'Comment' }]
  })),
  overallRating: r, overallWhy: 'I delivered what was asked',
  achievements: [{ achievement: 'Launched menu', impact: '+10% sales', evidence: 'POS report' }],
  strengths: 'Speed', improve: 'Delegation', develop: 'Excel', training: 'Excel advanced training', goals: 'Three goals', support: 'Time', challenges: 'Late stock deliveries', other: '',
})
const allManager = (areas: Array<{ key: string }>, r: number) => ({
  areas: Object.fromEntries(areas.map((a) => [a.key, { rating: r, agree: 'disagree', comment: 'Strong' }])),
  overall: 'Excellent period', gaps: 'Delegation', training: 'Leadership course',
})

describe('scoring', () => {
  it('weights, final split and categories', () => {
    const all = (r: number) => Perf.weightedScore(Perf.STANDARD_AREAS, () => r)
    expect(Perf.STANDARD_AREAS.reduce((s, a) => s + a.weightBp, 0)).toBe(10000)
    expect(all(5)).toBe(10000)
    expect(all(4)).toBe(8000)
    expect(all(3)).toBe(6000)
    expect(Perf.weightedScore(Perf.STANDARD_AREAS, (k) => (k === 'quality' ? null : 5))).toBeNull()
    expect(Perf.finalScoreOf(8000, 10000, 3000)).toBe(9400)
    expect(Perf.categoryOf(9000)).toBe('exceptional')
    expect(Perf.categoryOf(8999)).toBe('exceeds')
    expect(Perf.categoryOf(7000)).toBe('meets')
    expect(Perf.categoryOf(6000)).toBe('needs_improvement')
    expect(Perf.categoryOf(5999)).toBe('unsatisfactory')
  })
})

describe('the appraisal cycle', () => {
  it('HR makes a cycle with the standard areas; weights must add to 100%; non-HR is refused', async () => {
    expect((await send('POST', 'staffA', '/hr/performance/admin/cycles', { name: 'H2 2026', periodFrom: '2026-07-01', periodTo: '2026-12-31' })).statusCode).toBe(403)
    const bad = await send('POST', 'hrA', '/hr/performance/admin/cycles', { name: 'Bad', periodFrom: '2026-07-01', periodTo: '2026-12-31', areas: [{ key: 'one', label: 'One', weightBp: 5000 }] })
    expect(bad.statusCode).toBe(400)
    const r = await send('POST', 'hrA', '/hr/performance/admin/cycles', { name: 'H2 2026', periodFrom: '2026-07-01', periodTo: '2026-12-31' })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: T.A, selfWeightBp: 3000 })
    expect((r.json().areas as unknown[]).length).toBe(9)
    cycleId = r.json().id
  })

  it('only the reporting manager assigns; another company is 404', async () => {
    const mine = { cycleId, assignments: [{ employeeId: emp.staff, questions: { job_knowledge: ['Which tools do I know best?', 'Where did I apply them?'], problem_solving: [] } }] }
    const notMine = await send('POST', 'mgr2A', '/hr/performance/evaluations', mine)
    expect(notMine.statusCode).toBe(403)
    expect(codeOf(notMine)).toBe('NOT_YOUR_REPORT')
    expect((await send('POST', 'hrB', '/hr/performance/evaluations', mine)).statusCode).toBe(404)
    const r = await send('POST', 'mgrA', '/hr/performance/evaluations', mine)
    expect(r.statusCode).toBe(201)
    evId = r.json().created[0]
    const again = await send('POST', 'mgrA', '/hr/performance/evaluations', mine)
    expect(codeOf(again)).toBe('ALREADY_ASSIGNED')
    const ev = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: evId } })
    expect(ev).toMatchObject({ tenantId: T.A, managerUserId: U['mgrA']!.id, managerEmployeeId: emp.mgr, status: 'pending_employee', selfWeightBp: 3000 })
    const q = ev.questions as Record<string, unknown[]>
    expect(q['job_knowledge']).toHaveLength(2)
    expect(q['problem_solving']).toHaveLength(0)
    expect(q['quality']).toHaveLength(1) // the standard prompt
    // The cycle's areas are now locked.
    const lock = await send('PATCH', 'hrA', `/hr/performance/admin/cycles/${cycleId}`, { selfWeightBp: 4000 })
    expect(codeOf(lock)).toBe('CYCLE_IN_USE')
  })

  it('company B and other staff get 404 on the evaluation', async () => {
    expect((await send('GET', 'staffB', `/hr/performance/evaluations/${evId}`)).statusCode).toBe(404)
    expect((await send('GET', 'hrB', `/hr/performance/evaluations/${evId}`)).statusCode).toBe(404)
    expect((await send('GET', 'mgr2A', `/hr/performance/evaluations/${evId}`)).statusCode).toBe(404)
  })

  it('the employee fills it in, submits; incomplete is 422, then locked', async () => {
    const view = await send('GET', 'staffA', `/hr/performance/evaluations/${evId}`)
    expect(view.statusCode).toBe(200)
    const v = view.json()
    expect(v.manager).toBeNull()
    expect(v.can.editSelf).toBe(true)
    expect(v.profile).toMatchObject({ employeeId: emp.staff, reportingManager: `${P} Person 1` })
    expect((await send('PUT', 'staffA', `/hr/performance/evaluations/${evId}/self`, { self: { overallRating: 4 } })).statusCode).toBe(200)
    expect((await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: evId } })).status).toBe('draft')
    const incomplete = await send('POST', 'staffA', `/hr/performance/evaluations/${evId}/submit`, { self: { overallRating: 4, overallWhy: 'why' } })
    expect(codeOf(incomplete)).toBe('RATINGS_MISSING')
    const ok = await send('POST', 'staffA', `/hr/performance/evaluations/${evId}/submit`, { self: allSelf(v, 4) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'submitted', scores: { selfScore: 8000 } })
    expect(codeOf(await send('PUT', 'staffA', `/hr/performance/evaluations/${evId}/self`, { self: allSelf(v, 5) }))).toBe('NOT_EDITABLE')
    // The manager cannot edit the employee's part, nor the questions now.
    expect(codeOf(await send('PUT', 'mgrA', `/hr/performance/evaluations/${evId}/questions`, { questions: { quality: ['New question here'] } }))).toBe('ALREADY_SUBMITTED')
  })

  it('the manager returns it (note ≥10); the employee resubmits', async () => {
    expect((await send('POST', 'mgrA', `/hr/performance/evaluations/${evId}/return`, { note: 'short' })).statusCode).toBe(400)
    expect((await send('POST', 'staffA', `/hr/performance/evaluations/${evId}/return`, { note: 'Not the manager here' })).statusCode).toBe(403)
    const r = await send('POST', 'mgrA', `/hr/performance/evaluations/${evId}/return`, { note: 'Add numbers to your achievements please' })
    expect(r.json()).toMatchObject({ status: 'returned', returnNote: 'Add numbers to your achievements please', returnCount: 1 })
    const v = (await send('GET', 'staffA', `/hr/performance/evaluations/${evId}`)).json()
    expect(v.can.editSelf).toBe(true)
    const re = await send('POST', 'staffA', `/hr/performance/evaluations/${evId}/submit`, { self: allSelf(v, 4) })
    expect(re.json()).toMatchObject({ status: 'resubmitted' })
    const ev = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: evId } })
    expect((ev.history as unknown[]).length).toBe(3)
  })

  it('the manager rates every area independently and approves = finalized with the scores', async () => {
    const v = (await send('GET', 'mgrA', `/hr/performance/evaluations/${evId}`)).json()
    expect(v.can.review).toBe(true)
    const partial = await send('POST', 'mgrA', `/hr/performance/evaluations/${evId}/approve`, { manager: { areas: { quality: { rating: 5 } }, overall: 'ok' } })
    expect(codeOf(partial)).toBe('RATINGS_MISSING')
    expect((await send('PUT', 'mgrA', `/hr/performance/evaluations/${evId}/manager`, { manager: { areas: { quality: { rating: 5 } } } })).json().status).toBe('manager_in_progress')
    const ok = await send('POST', 'mgrA', `/hr/performance/evaluations/${evId}/approve`, { manager: allManager(v.areas, 5) })
    expect(ok.statusCode).toBe(200)
    const ev = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: evId } })
    expect(ev).toMatchObject({ status: 'finalized', selfScore: 8000, managerScore: 10000, finalScore: 9400, category: 'exceptional' })
    // The employee's own ratings were never touched.
    expect(((ev.self as { overallRating: number }).overallRating)).toBe(4)
  })

  it('the employee now sees the manager part and acknowledges once', async () => {
    const v = (await send('GET', 'staffA', `/hr/performance/evaluations/${evId}`)).json()
    expect(v.manager).not.toBeNull()
    expect(v.scores).toMatchObject({ finalScore: 9400, categoryLabel: 'Exceptional' })
    expect((await send('POST', 'staffA', `/hr/performance/evaluations/${evId}/acknowledge`)).statusCode).toBe(200)
    expect(codeOf(await send('POST', 'staffA', `/hr/performance/evaluations/${evId}/acknowledge`))).toBe('NOT_FINALIZED')
    const mine = (await send('GET', 'staffA', '/hr/performance/mine')).json()
    expect(mine[0]).toMatchObject({ id: evId, finalScore: 9400, categoryLabel: 'Exceptional' })
  })

  it('HR results: company A sees it, company B nothing; PDF export', async () => {
    const r = (await send('GET', 'hrA', `/hr/performance/admin/results?cycleId=${cycleId}`)).json()
    expect(r.overview).toMatchObject({ finalized: 1, averageFinal: 9400 })
    expect(r.overview.notAssigned).toBeGreaterThanOrEqual(2)
    expect(r.distribution.find((d: { category: string }) => d.category === 'exceptional')).toMatchObject({ count: 1, pct: 100 })
    expect(r.selfVsManager[0]).toMatchObject({ selfScore: 8000, managerScore: 10000, gap: -2000 })
    expect(r.areas).toHaveLength(9)
    expect(r.development.trainingRequests.map((t: { term: string }) => t.term)).toContain('excel')
    expect(r.list.some((x: { status: string }) => x.status === 'not_assigned')).toBe(true)
    const b = (await send('GET', 'hrB', '/hr/performance/admin/results')).json()
    expect(b.cycles).toHaveLength(0)
    expect((await send('GET', 'hrB', `/hr/performance/admin/results?cycleId=${cycleId}`)).statusCode).toBe(404)
    const pdf = await send('GET', 'hrA', `/hr/performance/admin/results?cycleId=${cycleId}&format=pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toContain('pdf')
    const one = await send('GET', 'staffA', `/hr/performance/evaluations/${evId}/report?format=xlsx`)
    expect(one.statusCode).toBe(200)
    expect((await send('GET', 'staffA', '/hr/performance/admin/results')).statusCode).toBe(403)
  })

  it('a finalized evaluation blocks deleting the employee; HR reopens it with a reason', async () => {
    expect((await employeeHistory(prisma, { id: emp.staff, status: 'active' })).join(' ')).toMatch(/finalized performance evaluation/)
    expect((await send('POST', 'hrB', `/hr/performance/admin/evaluations/${evId}/reopen`, { reason: 'Wrong period rated' })).statusCode).toBe(404)
    expect((await send('POST', 'hrA', `/hr/performance/admin/evaluations/${evId}/reopen`, { reason: 'short' })).statusCode).toBe(400)
    const r = await send('POST', 'hrA', `/hr/performance/admin/evaluations/${evId}/reopen`, { reason: 'Manager rated the wrong period' })
    expect(r.json()).toMatchObject({ status: 'manager_in_progress' })
    const ev = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: evId } })
    expect(ev).toMatchObject({ finalScore: null, category: null, selfScore: 8000 })
  })

  it('the old Performance reviews section is moved here', () => {
    expect(sectionByKey('performance_review')?.movedTo?.path).toBe('/hr/performance')
  })
})
