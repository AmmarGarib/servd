// Employee profile — Employment information (Danish, owner-approved 2026-10-17):
//
//   - Sub department and Cost center are HR org units of the employee's OWN
//     company (another company's unit, or the wrong kind, is 422).
//   - Reporting line: the picker (GET /hr/lookups reportingLine) reads
//     "<Designation> — <Name>", sorted by designation then name, "CEO" first.
//     Choosing CEO points managerId at the CEO login's HR record when there is
//     one; otherwise managerId stays null and the data carries reportsToCeo,
//     and /hr/team + the HOD rule treat that person as reporting to the CEO.
//   - Company B never picks company A's people or units.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { managerUserIdOfEmployee, teamUserIdsUnder } from '../src/modules/hr/service.js'
import { EMPLOYEE_MASTER_FIELDS } from '../src/modules/hr/forms.js'

const PREFIX = 'hrline-test'
let app: FastifyInstance
let tenantA: string
let tenantB: string
const users: string[] = []
type U = { id: string; name: string | null; email: string | null; role: string }

async function makeUser(role: string, tenantId: string): Promise<U> {
  const n = users.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${role} ${n}`, email: `${PREFIX}.${role}.${n}.${Date.now()}@gsfoods.pk`,
      password: await bcrypt.hash('CorrectHorse-Battery-9', 4), role: role as never, tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  users.push(u.id)
  return u
}
const auth = (u: U) => ({ authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never }).accessToken}` })
const unit = (tenantId: string, kind: string, name: string) => prisma.hrOrgUnit.create({ data: { tenantId, kind, name }, select: { id: true } })
let seq = 0
const emp = (tenantId: string, fullName: string, extra: Record<string, unknown> = {}) =>
  prisma.hrEmployee.create({ data: { tenantId, employeeCode: `${PREFIX}-${++seq}`, fullName, ...extra } })

let ceoA: U, hrA: U, hrB: U
let chef: string, barista: string, pastryA: string, ccA: string, pastryB: string, ccB: string

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Line Co A', slug: `${PREFIX}-a-${Date.now()}` }, select: { id: true } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Line Co B', slug: `${PREFIX}-b-${Date.now()}` }, select: { id: true } })).id
  ceoA = await makeUser('admin', tenantA)
  hrA = await makeUser('hr', tenantA)
  hrB = await makeUser('hr', tenantB)
  chef = (await unit(tenantA, 'designation', 'Chef')).id
  barista = (await unit(tenantA, 'designation', 'Barista')).id
  pastryA = (await unit(tenantA, 'sub_department', 'Pastry')).id
  ccA = (await unit(tenantA, 'cost_center', 'CC Kitchen')).id
  pastryB = (await unit(tenantB, 'sub_department', 'Pastry B')).id
  ccB = (await unit(tenantB, 'cost_center', 'CC B')).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(hrRoutes, { prefix: '/api/v1/hr' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  const tenants = [tenantA, tenantB].filter(Boolean)
  await prisma.hrEmployee.updateMany({ where: { tenantId: { in: tenants } }, data: { managerId: null } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.hrOrgUnit.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: users } }, { tenantId: { in: tenants } }] } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenants } } })
})

describe('Employment information format', () => {
  it('has Sub department and Cost center right after Department, and "Reporting line"', () => {
    const keys = EMPLOYEE_MASTER_FIELDS.map((f) => f.key)
    const at = keys.indexOf('departmentId')
    expect(keys.slice(at, at + 3)).toEqual(['departmentId', 'subDepartmentId', 'costCenterId'])
    expect(EMPLOYEE_MASTER_FIELDS.find((f) => f.key === 'subDepartmentId')).toMatchObject({ type: 'orgunit', ref: 'sub_department', group: 'Employment information' })
    expect(EMPLOYEE_MASTER_FIELDS.find((f) => f.key === 'costCenterId')).toMatchObject({ type: 'orgunit', ref: 'cost_center', group: 'Employment information' })
    expect(EMPLOYEE_MASTER_FIELDS.find((f) => f.key === 'managerId')?.label).toBe('Reporting line')
  })
})

describe('Sub department and Cost center', () => {
  it('save on the profile data, and another company\'s (or the wrong kind of) unit is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/hr/employees', headers: auth(hrA), payload: { data: { fullName: 'Unit Person', subDepartmentId: pastryA, costCenterId: ccA } } })
    expect(res.statusCode).toBe(201)
    const id = res.json().id as string
    const row = await prisma.hrEmployee.findUniqueOrThrow({ where: { id } })
    expect(row.data).toMatchObject({ subDepartmentId: pastryA, costCenterId: ccA })

    for (const data of [{ subDepartmentId: pastryB }, { costCenterId: ccB }, { costCenterId: pastryA }]) {
      const bad = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${id}`, headers: auth(hrA), payload: { data } })
      expect(bad.statusCode, JSON.stringify(data)).toBe(422)
      expect(bad.json().error.code).toBe('BAD_REFERENCE')
    }
    // Company B's HR cannot create with A's units either.
    const fromB = await app.inject({ method: 'POST', url: '/api/v1/hr/employees', headers: auth(hrB), payload: { data: { fullName: 'B Person', subDepartmentId: pastryA } } })
    expect(fromB.statusCode).toBe(422)
    const after = await prisma.hrEmployee.findUniqueOrThrow({ where: { id } })
    expect(after.data).toMatchObject({ subDepartmentId: pastryA, costCenterId: ccA })
  })
})

describe('Reporting line', () => {
  let amy: string, bob: string, zed: string, carl: string
  beforeAll(async () => {
    amy = (await emp(tenantA, 'Amy', { designationId: chef })).id
    bob = (await emp(tenantA, 'Bob', { designationId: chef })).id
    zed = (await emp(tenantA, 'Zed', { designationId: barista })).id
    carl = (await emp(tenantA, 'Carl')).id
    await emp(tenantA, 'Gone', { designationId: chef, status: 'resigned' })
    await emp(tenantB, 'B Staff')
  })

  it('the picker lists CEO first, then designations only — a shared or missing designation adds the employee code, never a name (company A only, current staff)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/hr/lookups', headers: auth(hrA) })
    expect(res.statusCode).toBe(200)
    const line = res.json().reportingLine as Array<{ id: string; label: string; employeeId: string | null; ceo?: boolean }>
    expect(line[0]).toEqual({ id: 'ceo', label: 'CEO', employeeId: null, ceo: true })
    const code = async (id: string) => (await prisma.hrEmployee.findUniqueOrThrow({ where: { id } })).employeeCode
    const people = line.slice(1).filter((o) => [amy, bob, zed, carl].includes(o.id))
    expect(people.map((o) => o.label)).toEqual(['Barista', `Chef (${await code(amy)})`, `Chef (${await code(bob)})`, `No designation (${await code(carl)})`])
    expect(line.some((o) => /Amy|Bob|Zed|Carl|Gone|B Staff/.test(o.label))).toBe(false)
    const gone = await prisma.hrEmployee.findMany({ where: { tenantId: tenantA, status: { notIn: ['active', 'on_leave'] } }, select: { id: true } })
    expect(line.some((o) => gone.some((g) => g.id === o.id))).toBe(false)

    // Company B has no CEO login: no CEO option, and none of A's people.
    const b = (await app.inject({ method: 'GET', url: '/api/v1/hr/lookups', headers: auth(hrB) })).json().reportingLine as Array<{ id: string; label: string }>
    expect(b.some((o) => o.id === 'ceo')).toBe(false)
    expect(b).toHaveLength(1)
    expect(b[0]!.label.startsWith('No designation (')).toBe(true)
    expect(b.some((o) => [amy, bob, zed, carl].includes(o.id))).toBe(false)
  })

  it('CEO with no HR record: managerId stays null, reportsToCeo is set, and the line walks to the CEO', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${amy}`, headers: auth(hrA), payload: { data: { managerId: 'ceo' } } })
    expect(res.statusCode).toBe(200)
    let row = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: amy } })
    expect(row.managerId).toBeNull()
    expect(row.data).toMatchObject({ reportsToCeo: true })
    // No HR record was made for the CEO.
    expect(await prisma.hrEmployee.count({ where: { userId: ceoA.id } })).toBe(0)
    // Bob reports to Amy.
    await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${bob}`, headers: auth(hrA), payload: { data: { managerId: amy } } })

    const detail = (await app.inject({ method: 'GET', url: `/api/v1/hr/employees/${amy}`, headers: auth(hrA) })).json()
    expect(detail.labels.manager).toBe('CEO')
    // The Manager card shows the manager's designation, not their name.
    const bobDetail = (await app.inject({ method: 'GET', url: `/api/v1/hr/employees/${bob}`, headers: auth(hrA) })).json()
    expect(bobDetail.labels.manager).toBe('Chef')
    expect(await managerUserIdOfEmployee(tenantA, amy)).toBe(ceoA.id)
    expect(await managerUserIdOfEmployee(tenantA, zed)).toBeNull()
    expect(await teamUserIdsUnder(tenantA, ceoA.id)).toEqual([])

    const team = (await app.inject({ method: 'GET', url: '/api/v1/hr/team', headers: auth(ceoA) })).json()
    expect(team.me).toMatchObject({ id: null })
    const byId = new Map((team.team as Array<{ id: string; depth: number }>).map((t) => [t.id, t]))
    expect(byId.get(amy)).toMatchObject({ depth: 1, managerId: null })
    expect(byId.get(bob)).toMatchObject({ depth: 2, managerId: amy })
    expect(byId.has(zed)).toBe(false)

    // HR without a record of their own still sees no team.
    expect((await app.inject({ method: 'GET', url: '/api/v1/hr/team', headers: auth(hrA) })).json()).toMatchObject({ me: null, team: [] })

    // Choosing a person clears the flag.
    await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${amy}`, headers: auth(hrA), payload: { data: { managerId: zed } } })
    row = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: amy } })
    expect(row.managerId).toBe(zed)
    expect((row.data as Record<string, unknown>)['reportsToCeo']).toBe(false)
    expect(await managerUserIdOfEmployee(tenantA, amy)).toBeNull()   // Zed has no login
    // Back to CEO for the next test.
    await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${amy}`, headers: auth(hrA), payload: { data: { managerId: 'ceo' } } })
  })

  it('CEO with an HR record: CEO means that record; the flagged ones still count as the CEO\'s team; nobody reports to themselves', async () => {
    const ceoRec = await emp(tenantA, 'The CEO', { userId: ceoA.id, designationId: chef })
    const line = (await app.inject({ method: 'GET', url: '/api/v1/hr/lookups', headers: auth(hrA) })).json().reportingLine as Array<{ id: string; employeeId: string | null }>
    expect(line[0]).toMatchObject({ id: 'ceo', employeeId: ceoRec.id })
    expect(line.some((o) => o.id === ceoRec.id)).toBe(false)

    const res = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${zed}`, headers: auth(hrA), payload: { data: { managerId: 'ceo' } } })
    expect(res.statusCode).toBe(200)
    const z = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: zed } })
    expect(z.managerId).toBe(ceoRec.id)
    expect((z.data as Record<string, unknown>)['reportsToCeo']).toBeUndefined()

    const team = (await app.inject({ method: 'GET', url: '/api/v1/hr/team', headers: auth(ceoA) })).json()
    expect(team.me).toMatchObject({ id: ceoRec.id })
    const ids = (team.team as Array<{ id: string }>).map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining([zed, amy, bob]))   // Amy is still flagged reportsToCeo
    expect(ids).not.toContain(ceoRec.id)
    expect(await managerUserIdOfEmployee(tenantA, zed)).toBe(ceoA.id)
    expect(await managerUserIdOfEmployee(tenantA, amy)).toBe(ceoA.id)

    const self = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${ceoRec.id}`, headers: auth(hrA), payload: { data: { managerId: 'ceo' } } })
    expect(self.statusCode).toBe(400)
    expect(self.json().error.code).toBe('BAD_MANAGER')
  })

  it('company B cannot pick A\'s people, cannot edit A\'s employees, and has no CEO to pick', async () => {
    const bStaff = await prisma.hrEmployee.findFirstOrThrow({ where: { tenantId: tenantB } })
    const foreign = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${bStaff.id}`, headers: auth(hrB), payload: { data: { managerId: amy } } })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BAD_REFERENCE')
    const noCeo = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${bStaff.id}`, headers: auth(hrB), payload: { data: { managerId: 'ceo' } } })
    expect(noCeo.statusCode).toBe(422)
    expect(noCeo.json().error.code).toBe('NO_CEO')
    const other = await app.inject({ method: 'PATCH', url: `/api/v1/hr/employees/${amy}`, headers: auth(hrB), payload: { data: { managerId: 'ceo' } } })
    expect(other.statusCode).toBe(404)
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: bStaff.id } })).managerId).toBeNull()
  })
})
