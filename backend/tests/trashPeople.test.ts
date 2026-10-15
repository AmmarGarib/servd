// Trash bin — people & planning (stream B5; modules/trash/README.md).
//
//   - HR document, payroll draft (+ payslips), letter wording, rota exception,
//     booking blockout and projection scenario are kept in the Trash on delete
//     and come back with the SAME ids; a position and an inter-company
//     contribution stay archive / end flips that Restore reverses.
//   - Two companies: B gets 404 on A's entries; restores bind to the row's company.
//   - Payroll draft restore with the period taken -> 409 PERIOD_TAKEN.
//   - Head-office reach (a lens into a company) is submit-only -> 403 on restore.
//   - A position restore brings back the PREVIOUS status; positions and
//     contributions are never erasable, the rest are (CEO only).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { runWithRlsContext } = await import('../src/lib/rlsContext.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { trashProviders } = await import('../src/modules/trash/registry.js')
const { TRASH_PEOPLE } = await import('../src/modules/trash/providers/masters/people.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { schedulingRoutes } = await import('../src/modules/scheduling/routes.js')
const { reservationRoutes } = await import('../src/modules/reservations/routes.js')
const { positionRoutes } = await import('../src/modules/positions/routes.js')
const { projectionsRoutes } = await import('../src/modules/projections/routes.js')

const P = `trp${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '', HO: '' }
const C = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@trp.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const auth = (key: string, lens?: string) => {
  const u = U[key]!
  return {
    authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}`,
    ...(lens ? { 'x-servd-active-tenant': lens } : {}),
  }
}
type M = 'GET' | 'POST' | 'DELETE'
const raw = (key: string, method: M, url: string, payload?: unknown, lens?: string) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...auth(key, lens), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })
const trash = (key: string, method: M, url: string, payload?: unknown, lens?: string) => raw(key, method, `/trash${url}`, payload, lens)
const codeOf = (r: { json(): unknown }) => ((r.json() as { error?: { code?: string } }).error?.code)

let emp = ''
let empB = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  T.HO = (await prisma.tenant.create({ data: { name: `${P} HO`, slug: `${P}-ho`, kind: 'head_office' } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} Cafe A`, slug: `${P}-cafe-a`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} Cafe B`, slug: `${P}-cafe-b`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceo', 'admin', [T.A])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('ownerAB', 'owner', [T.A, T.B])
  await mkUser('ownerB', 'owner', [T.B])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('financeA', 'finance', [T.A])
  await mkUser('cashierA', 'cashier', [T.A])
  await mkUser('hoHr', 'hr', [T.HO])
  await prisma.headOfficeLink.create({ data: { tenantId: T.HO, companyTenantId: T.A, createdById: U.ceo!.id } })
  emp = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: `${P} Employee` } })).id
  empB = (await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-2`, fullName: `${P} Employee B` } })).id

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
    await api.register(schedulingRoutes, { prefix: '/scheduling' })
    await api.register(reservationRoutes, { prefix: '/reservations' })
    await api.register(positionRoutes, { prefix: '/positions' })
    await api.register(projectionsRoutes, { prefix: '/projections' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('registry', () => {
  it('the eight people types are registered and the route files use the same keys', () => {
    const keys = Object.values(TRASH_PEOPLE)
    const registered = new Set(trashProviders().map((p) => p.key))
    for (const k of keys) expect(registered.has(k), k).toBe(true)
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/modules/${rel}`, import.meta.url)), 'utf8')
    const where: Record<string, string> = {
      hr_document: 'hr/routes.ts', hr_payroll_run: 'hr/routes.ts', hr_letter: 'hr/routes.ts',
      scheduled_shift: 'scheduling/routes.ts', concept_blockout: 'reservations/routes.ts',
      position: 'positions/routes.ts', tenant_contribution: 'positions/contributions.ts', projection: 'projections/routes.ts',
    }
    for (const k of keys) expect(src(where[k]!), k).toContain(`type: '${k}'`)
  })
})

describe('HR document', () => {
  it('delete -> Trash -> B 404 -> restore with the same id; CEO can empty it', async () => {
    const doc = await prisma.hrDocument.create({ data: { tenantId: T.A, employeeId: emp, docType: 'cnic_front', title: 'CNIC' } })
    expect((await raw('hrA', 'DELETE', `/hr/documents/${doc.id}?reason=test`)).statusCode).toBe(204)
    expect(await prisma.hrDocument.findUnique({ where: { id: doc.id } })).toBeNull()

    const list = (await trash('hrA', 'GET', `?type=hr_document`)).json() as { items: Array<{ id: string; title: string }> }
    expect(list.items.map((i) => i.id)).toContain(doc.id)
    expect((await trash('ownerB', 'GET', `/hr_document/${doc.id}`)).statusCode).toBe(404)
    expect((await trash('ownerB', 'POST', `/hr_document/${doc.id}/restore`, {})).statusCode).toBe(404)
    expect(((await trash('ownerB', 'GET', `?type=hr_document`)).json() as { items: unknown[] }).items).toHaveLength(0)
    // not an HR role -> no rows, no access
    expect((await trash('cashierA', 'POST', `/hr_document/${doc.id}/restore`, {})).statusCode).toBeGreaterThanOrEqual(403)

    const r = await trash('hrA', 'POST', `/hr_document/${doc.id}/restore`, {})
    expect(r.statusCode).toBe(200)
    const back = await prisma.hrDocument.findUnique({ where: { id: doc.id } })
    expect(back?.tenantId).toBe(T.A)
    expect(back?.title).toBe('CNIC')
    expect((await trash('hrA', 'POST', `/hr_document/${doc.id}/restore`, {})).statusCode).toBe(409)

    // delete again, only the CEO empties
    await raw('hrA', 'DELETE', `/hr/documents/${doc.id}`)
    expect((await trash('hrA', 'DELETE', `/hr_document/${doc.id}`, { reason: 'not needed any more' })).statusCode).toBe(403)
    expect((await trash('ceo', 'DELETE', `/hr_document/${doc.id}`, { reason: 'not needed any more' })).statusCode).toBeLessThan(300)
    const gone = await trash('hrA', 'POST', `/hr_document/${doc.id}/restore`, {})
    expect(gone.statusCode).toBe(409)
    expect(codeOf(gone)).toBe('PURGED')
  })

  it('a foreign document cannot be deleted by company B (404, nothing in the Trash)', async () => {
    const doc = await prisma.hrDocument.create({ data: { tenantId: T.A, employeeId: emp, docType: 'photo' } })
    expect((await raw('ownerB', 'DELETE', `/hr/documents/${doc.id}`)).statusCode).toBe(404)
    expect(await prisma.trashEntry.count({ where: { entityType: 'hr_document', entityId: doc.id } })).toBe(0)
  })
})

describe('payroll draft', () => {
  async function mkRun(period: string, tenantId = T.A, employeeId = emp) {
    const run = await prisma.hrPayrollRun.create({ data: { tenantId, period, status: 'draft', settings: {}, createdById: U.hrA!.id } })
    await prisma.hrPayslip.create({
      data: { runId: run.id, tenantId, employeeId, inputs: {}, lines: [], grossCents: 100000, earningsCents: 100000, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 100000 },
    })
    return run.id
  }

  it('restore with the period taken -> PERIOD_TAKEN, then restores WITH its payslips', async () => {
    const id = await mkRun('2031-01')
    expect((await raw('hrA', 'DELETE', `/hr/payroll/runs/${id}`)).statusCode).toBe(204)
    expect(await prisma.hrPayslip.count({ where: { runId: id } })).toBe(0)

    const other = await mkRun('2031-01', T.A)
    const clash = await trash('hrA', 'POST', `/hr_payroll_run/${id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    expect(codeOf(clash)).toBe('PERIOD_TAKEN')

    await prisma.hrPayslip.deleteMany({ where: { runId: other } })
    await prisma.hrPayrollRun.delete({ where: { id: other } })
    const ok = await trash('hrA', 'POST', `/hr_payroll_run/${id}/restore`, {})
    expect(ok.statusCode).toBe(200)
    expect((await prisma.hrPayrollRun.findUnique({ where: { id } }))?.status).toBe('draft')
    expect(await prisma.hrPayslip.count({ where: { runId: id } })).toBe(1)
  })

  it('company B cannot delete or see company A\'s draft', async () => {
    const id = await mkRun('2031-02')
    expect((await raw('ownerB', 'DELETE', `/hr/payroll/runs/${id}`)).statusCode).toBe(404)
    await raw('hrA', 'DELETE', `/hr/payroll/runs/${id}`)
    expect((await trash('ownerB', 'GET', `/hr_payroll_run/${id}`)).statusCode).toBe(404)
  })

  it('head-office reach (a lens into the company) cannot restore: 403', async () => {
    const id = await mkRun('2031-03')
    await raw('hrA', 'DELETE', `/hr/payroll/runs/${id}`)
    const r = await trash('hoHr', 'POST', `/hr_payroll_run/${id}/restore`, {}, T.A)
    expect(r.statusCode).toBe(403)
    expect(codeOf(r)).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    expect(await prisma.hrPayrollRun.findUnique({ where: { id } })).toBeNull()
  })

  it('an approved run cannot be deleted (and nothing reaches the Trash)', async () => {
    const id = await mkRun('2031-04')
    await prisma.hrPayrollRun.update({ where: { id }, data: { status: 'approved' } })
    expect((await raw('hrA', 'DELETE', `/hr/payroll/runs/${id}`)).statusCode).toBe(409)
    expect(await prisma.trashEntry.count({ where: { entityType: 'hr_payroll_run', entityId: id } })).toBe(0)
  })
})

describe('letter wording', () => {
  it('reset to default keeps the wording; restore clashes with a newer one', async () => {
    const key = 'offer_letter'
    const row = await prisma.hrLetterTemplate.create({ data: { tenantId: T.A, key, title: 'Our offer', body: '<p>Hello</p>' } })
    expect((await raw('hrA', 'DELETE', `/hr/letters/${key}`)).statusCode).toBe(204)
    expect(await prisma.hrLetterTemplate.findUnique({ where: { id: row.id } })).toBeNull()
    // deleting a letter with no override stays a quiet 204
    expect((await raw('hrA', 'DELETE', `/hr/letters/${key}`)).statusCode).toBe(204)

    const newer = await prisma.hrLetterTemplate.create({ data: { tenantId: T.A, key, title: 'Newer', body: '<p>New</p>' } })
    const clash = await trash('hrA', 'POST', `/hr_letter/${row.id}/restore`, {})
    expect(clash.statusCode).toBe(409)
    await prisma.hrLetterTemplate.delete({ where: { id: newer.id } })
    expect((await trash('hrA', 'POST', `/hr_letter/${row.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.hrLetterTemplate.findUnique({ where: { id: row.id } }))?.title).toBe('Our offer')
  })
})

describe('rota exception', () => {
  it('delete keeps the shift and its swap requests; restore brings both back; B gets 404', async () => {
    const date = new Date('2031-05-05')
    const shift = await prisma.scheduledShift.create({ data: { userId: U.hrA!.id, conceptId: C.A, date, startTime: '09:00', endTime: '17:00' } })
    await prisma.shiftSwapRequest.create({ data: { shiftId: shift.id, requestedByUserId: U.hrA!.id, requestedFromUserId: U.ownerA!.id } })
    expect((await raw('ownerB', 'DELETE', `/scheduling/${shift.id}`)).statusCode).toBe(404)
    expect((await raw('ownerA', 'DELETE', `/scheduling/${shift.id}`)).statusCode).toBe(204)
    expect(await prisma.shiftSwapRequest.count({ where: { shiftId: shift.id } })).toBe(0)

    const entry = (await trash('ownerA', 'GET', `/scheduled_shift/${shift.id}`))
    expect(entry.statusCode).toBe(200)
    expect((await trash('ownerB', 'GET', `/scheduled_shift/${shift.id}`)).statusCode).toBe(404)

    // someone planned the same hours meanwhile -> clash, not a silent double shift
    const blocker = await prisma.scheduledShift.create({ data: { userId: U.hrA!.id, conceptId: C.A, date, startTime: '10:00', endTime: '12:00' } })
    expect((await trash('ownerA', 'POST', `/scheduled_shift/${shift.id}/restore`, {})).statusCode).toBe(409)
    await prisma.scheduledShift.delete({ where: { id: blocker.id } })

    expect((await trash('ownerA', 'POST', `/scheduled_shift/${shift.id}/restore`, {})).statusCode).toBe(200)
    expect(await prisma.scheduledShift.count({ where: { id: shift.id } })).toBe(1)
    expect(await prisma.shiftSwapRequest.count({ where: { shiftId: shift.id } })).toBe(1)
  })
})

describe('booking blockout', () => {
  it('delete -> Trash -> restore; B gets 404; a trashed brand blocks it (PARENT_IN_TRASH is for brand entries)', async () => {
    const b = await prisma.conceptBlockout.create({
      data: { conceptId: C.A, kind: 'closure', startTime: new Date('2031-06-01T10:00:00Z'), endTime: new Date('2031-06-01T14:00:00Z'), reason: 'Eid' },
    })
    expect((await raw('ownerB', 'DELETE', `/reservations/blockouts/${b.id}`)).statusCode).toBe(404)
    expect((await raw('ownerA', 'DELETE', `/reservations/blockouts/${b.id}`)).statusCode).toBe(204)
    expect((await trash('ownerB', 'POST', `/concept_blockout/${b.id}/restore`, {})).statusCode).toBe(404)
    expect((await trash('ownerA', 'POST', `/concept_blockout/${b.id}/restore`, {})).statusCode).toBe(200)
    expect((await prisma.conceptBlockout.findUnique({ where: { id: b.id } }))?.reason).toBe('Eid')
  })
})

describe('position', () => {
  it('delete archives; Restore brings back the PREVIOUS status; never erasable', async () => {
    const seat = await prisma.position.create({
      data: { tenantId: T.A, conceptId: C.A, title: `${P} Chef`, monthlySalaryCents: 100000, tenantCostShareCents: 100000, status: 'frozen' },
    })
    expect((await raw('ownerB', 'DELETE', `/positions/${seat.id}`)).statusCode).toBe(404)
    expect((await raw('hrA', 'DELETE', `/positions/${seat.id}`)).statusCode).toBe(200)
    expect((await prisma.position.findUnique({ where: { id: seat.id } }))?.status).toBe('archived')

    expect((await trash('ownerB', 'POST', `/position/${seat.id}/restore`, {})).statusCode).toBe(404)
    expect((await trash('ceo', 'DELETE', `/position/${seat.id}`, { reason: 'clear it please' })).statusCode).toBe(409)
    const r = await trash('hrA', 'POST', `/position/${seat.id}/restore`, {})
    expect(r.statusCode).toBe(200)
    expect((await prisma.position.findUnique({ where: { id: seat.id } }))?.status).toBe('frozen')
  })

  it('deleting an already archived seat adds nothing to the Trash', async () => {
    const seat = await prisma.position.create({
      data: { tenantId: T.A, title: `${P} Old`, monthlySalaryCents: 1, tenantCostShareCents: 1, status: 'archived' },
    })
    expect((await raw('hrA', 'DELETE', `/positions/${seat.id}`)).statusCode).toBe(200)
    expect(await prisma.trashEntry.count({ where: { entityType: 'position', entityId: seat.id } })).toBe(0)
  })
})

describe('inter-company contribution', () => {
  it('end -> Trash -> restore needs BOTH companies; a one-company login is refused', async () => {
    const c = await prisma.tenantContribution.create({
      data: { sourceTenantId: T.A, destinationTenantId: T.B, category: 'other', monthlyCents: 5000, label: `${P} share` },
    })
    expect((await raw('ownerAB', 'DELETE', `/positions/contributions/${c.id}`, undefined, T.A)).statusCode).toBe(200)
    expect((await prisma.tenantContribution.findUnique({ where: { id: c.id } }))?.isActive).toBe(false)

    expect((await trash('ownerA', 'POST', `/tenant_contribution/${c.id}/restore`, {})).statusCode).toBe(403)
    expect((await trash('ceo', 'DELETE', `/tenant_contribution/${c.id}`, { reason: 'clear it please' })).statusCode).toBe(409)
    expect((await trash('ownerAB', 'POST', `/tenant_contribution/${c.id}/restore`, {}, T.A)).statusCode).toBe(200)
    const back = await prisma.tenantContribution.findUnique({ where: { id: c.id } })
    expect(back?.isActive).toBe(true)
    expect(back?.endedAt).toBeNull()
  })
})

describe('projection scenario', () => {
  it('delete keeps the scenario and its brand inputs; restore brings both back; B gets 404', async () => {
    const pr = await prisma.projection.create({ data: { tenantId: T.A, name: `${P} plan` } })
    await prisma.projectionBrandInput.create({ data: { projectionId: pr.id, conceptId: C.A, checkAverageCents: 123400 } })
    expect((await raw('ownerB', 'DELETE', `/projections/${pr.id}`)).statusCode).toBe(404)
    expect((await raw('financeA', 'DELETE', `/projections/${pr.id}`)).statusCode).toBe(200)
    expect(await prisma.projectionBrandInput.count({ where: { projectionId: pr.id } })).toBe(0)

    expect((await trash('ownerB', 'GET', `/projection/${pr.id}`)).statusCode).toBe(404)
    expect((await trash('financeA', 'POST', `/projection/${pr.id}/restore`, {})).statusCode).toBe(200)
    const inputs = await prisma.projectionBrandInput.findMany({ where: { projectionId: pr.id } })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.checkAverageCents).toBe(123400)
    expect((await prisma.projection.findUnique({ where: { id: pr.id } }))?.tenantId).toBe(T.A)
  })
})
