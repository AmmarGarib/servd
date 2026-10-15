// "Set up head office from today's records" (D1, spec §14.3, amendments A3,
// A15) — GET /head-offices/setup/preview and POST /head-offices/setup through
// the real auth middleware, on the seeded shape:
//
//   GS  "GS Foods"  (slug gs-foods-bukhari): HO departments Procurement /
//        Finance / Marketing, 800k of brand-less seats; a commissary seat
//   VV  "GS x Viva" (slug gs-x-viva-clifton): a brand seat; pays GS 500k a
//        month as a head_office contribution
//   F   a company the CEO is not a member of
//
//   ceo   admin, member of GS and VV
//   fin   finance, member of GS — 403 everywhere
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { budgetedLabour, planMonth } from '../src/lib/labour-budget.js'
import { headOfficeSetupApplied } from '../src/modules/headOffices/books.js'
import { headOfficeRoutes } from '../src/modules/headOffices/routes.js'
import { headOfficeSetupRoutes } from '../src/modules/headOffices/setup.js'
import { suggestSplit } from '../src/modules/positions/headOfficeSetup.js'

const P = `hosu-${Date.now()}`
const K = (pkr: number) => pkr * 100_000
let app: FastifyInstance
let GS: string, VV: string, F: string, HO: string, T1: string, T2: string
let hoContrib: string, sharedSeat: string, hodUser: string, strangerUser: string
const hoSeats: string[] = []
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
type Method = 'GET' | 'POST'
function call(who: string, method: Method, url: string, payload?: unknown) {
  return app.inject({
    method, url, headers: { authorization: `Bearer ${users[who]!.token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code

beforeAll(async () => {
  GS = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'gs-foods-bukhari' } })).id
  VV = (await prisma.tenant.create({ data: { name: 'GS x Viva', slug: 'gs-x-viva-clifton' } })).id
  F = (await prisma.tenant.create({ data: { name: 'Foreign', slug: `${P}-f` } })).id
  for (const t of [GS, VV, F]) await ensureChartOfAccounts(t)
  const flipd = (await prisma.concept.create({ data: { name: 'Flipd', slug: `${P}-flipd`, type: 'restaurant', tenantId: VV } })).id
  const band = await prisma.shiftBand.create({ data: { tenantId: GS, name: '10am-6pm', startTime: '10:00', endTime: '18:00' } })
  const depts: Record<string, string> = {}
  for (const [i, name] of ['Procurement', 'Finance', 'Marketing'].entries()) {
    depts[name] = (await prisma.department.create({ data: { tenantId: GS, name, isHeadOffice: true, order: i + 1 } })).id
  }
  const comm = await prisma.department.create({ data: { tenantId: GS, name: '42C Dish Team' } })
  await prisma.hrOrgUnit.create({ data: { tenantId: GS, kind: 'designation', name: 'Procurement Manager', code: 'PM' } })
  const roles: Array<[string, string, number]> = [
    ['Procurement', 'Procurement Manager', 100], ['Procurement', 'Veg + Fruit Procurement', 50], ['Procurement', 'Meat Procurement', 50],
    ['Procurement', 'Seafood Procurement', 50], ['Finance', 'Finance Officer', 100], ['Marketing', 'Brand Manager', 150],
    ['Marketing', 'Content Creation + Editing', 100], ['Marketing', 'Graphic Design', 100], ['Marketing', 'Content + Community Management', 100],
  ]
  hodUser = await mkUser('hod', 'management', GS, [GS])
  strangerUser = await mkUser('stranger', 'management', F, [F])
  for (const [d, title, k] of roles) {
    hoSeats.push((await prisma.position.create({
      data: {
        tenantId: GS, departmentId: depts[d]!, title, monthlySalaryCents: K(k), tenantCostShareCents: K(k), status: 'open',
        ...(title === 'Procurement Manager' ? { shiftBandId: band.id, status: 'filled', filledByUserId: hodUser } : {}),
      },
    })).id)
  }
  await prisma.position.create({ data: { tenantId: GS, departmentId: comm.id, title: 'Dish 1', monthlySalaryCents: K(30), tenantCostShareCents: K(30), status: 'filled' } })
  // A shared seat whose cost share is not its gross (normalised by the setup).
  sharedSeat = (await prisma.position.create({
    data: { tenantId: VV, conceptId: flipd, title: 'F&B Manager', monthlySalaryCents: K(100), tenantCostShareCents: K(100), status: 'filled' },
  })).id
  await prisma.position.create({ data: { tenantId: VV, conceptId: flipd, title: 'Commis', monthlySalaryCents: K(35), tenantCostShareCents: K(35), status: 'filled' } })
  hoContrib = (await prisma.tenantContribution.create({
    data: {
      sourceTenantId: VV, destinationTenantId: GS, category: 'head_office', monthlyCents: K(500), label: 'GS x Viva HO contribution',
      internalSplit: [{ label: 'Garibsons 40%', cents: K(200) }, { label: 'Viva 60%', cents: K(300) }],
    },
  })).id
  await prisma.hrEmployee.create({ data: { tenantId: GS, employeeCode: `${P}-1`, fullName: 'Head of Procurement', departmentId: depts.Procurement!, userId: hodUser } })

  // Two practice companies the CEO belongs to — the setup must refuse them.
  T1 = (await prisma.tenant.create({ data: { name: 'Practice A', slug: `${P}-t1`, isTest: true } })).id
  T2 = (await prisma.tenant.create({ data: { name: 'Practice B', slug: `${P}-t2`, isTest: true } })).id
  await mkUser('ceo', 'admin', GS, [GS, VV, T1, T2])
  await mkUser('fin', 'finance', GS, [GS])

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (ho) => {
    await ho.register(headOfficeRoutes)
    await ho.register(headOfficeSetupRoutes)
  }, { prefix: '/head-offices' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('who may', () => {
  it('is CEO only; a company the CEO is not in is 404', async () => {
    expect((await call('fin', 'GET', '/head-offices/setup/preview')).statusCode).toBe(403)
    expect((await call('fin', 'POST', '/head-offices/setup', {})).statusCode).toBe(403)
    expect((await call('ceo', 'GET', `/head-offices/setup/preview?companyIds=${GS},${F}`)).statusCode).toBe(404)
    expect((await call('ceo', 'POST', '/head-offices/setup', { companyIds: [GS, F] })).statusCode).toBe(404)
    expect(await prisma.tenant.count({ where: { kind: 'head_office' } })).toBe(0)
  })

  it('refuses test companies (422 TEST_COMPANY_NOT_ALLOWED); the platform marker stays off', async () => {
    const p = await call('ceo', 'GET', `/head-offices/setup/preview?companyIds=${T1},${T2}`)
    expect(p.statusCode).toBe(422)
    expect(code(p)).toBe('TEST_COMPANY_NOT_ALLOWED')
    const r = await call('ceo', 'POST', '/head-offices/setup', { companyIds: [T1, T2], split: [{ companyTenantId: T1, shareBps: 5000 }, { companyTenantId: T2, shareBps: 5000 }] })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('TEST_COMPANY_NOT_ALLOWED')
    const mix = await call('ceo', 'POST', '/head-offices/setup', { companyIds: [GS, T1] })
    expect(code(mix)).toBe('TEST_COMPANY_NOT_ALLOWED')
    expect(await prisma.tenant.count({ where: { kind: 'head_office' } })).toBe(0)
    expect(await headOfficeSetupApplied()).toBe(false)
  })
})

let preview: Record<string, any>

describe('preview', () => {
  it("lists today's records and suggests 3750 / 6250 from them", async () => {
    const res = await call('ceo', 'GET', '/head-offices/setup/preview')
    expect(res.statusCode, res.body).toBe(200)
    preview = res.json()
    expect(preview.alreadyApplied).toBeNull()
    expect(preview.rechargeStaysOff).toBe(true)
    expect(preview.effectiveFrom).toBe(planMonth())
    expect(preview.hoName).toBe('GS Head Office')
    expect(preview.companies.map((c: { id: string }) => c.id).sort()).toEqual([GS, VV].sort())
    expect(preview.contributions).toEqual([expect.objectContaining({ id: hoContrib, monthlyCents: K(500), sourceTenantId: VV, destinationTenantId: GS })])
    expect(preview.departments.map((d: { name: string }) => d.name)).toEqual(['Procurement', 'Finance', 'Marketing'])
    expect(preview.departments.flatMap((d: { seats: unknown[] }) => d.seats)).toHaveLength(9)
    expect(preview.departments[0].employees).toEqual([expect.objectContaining({ fullName: 'Head of Procurement', userId: hodUser })])
    expect(preview.hodCandidates).toEqual([expect.objectContaining({ userId: hodUser })])
    expect(preview.suggestedSplit.source).toBe('records')
    const bps = Object.fromEntries(preview.suggestedSplit.lines.map((l: { companyTenantId: string; shareBps: number }) => [l.companyTenantId, l.shareBps]))
    expect(bps).toEqual({ [GS]: 3750, [VV]: 6250 })
    // Planning before = after, per company and for the portfolio.
    const before = Object.fromEntries(preview.planning.before.companies.map((r: { tenantId: string; netMonthlyCents: number }) => [r.tenantId, r.netMonthlyCents]))
    const after = Object.fromEntries(preview.planning.after.companies.map((r: { tenantId: string; netMonthlyCents: number }) => [r.tenantId, r.netMonthlyCents]))
    expect(before).toEqual({ [GS]: K(330), [VV]: K(635) }) // 800 + 30 − 500; 135 + 500
    expect(after).toEqual(before)
    expect(preview.planning.after.companies.find((r: { tenantId: string }) => r.tenantId === GS).headOfficeChargesMonthlyCents).toBe(K(300))
    expect(preview.planning.after.companies.find((r: { tenantId: string }) => r.tenantId === VV).headOfficeChargesMonthlyCents).toBe(K(500))
    expect(preview.planning.after.headOffice).toMatchObject({ seatsMonthlyCents: K(800), rechargedOutMonthlyCents: K(800), netMonthlyCents: 0 })
    expect(preview.planning.after.portfolioNetMonthlyCents).toBe(preview.planning.before.portfolioNetMonthlyCents)
    expect(preview.planning.before.portfolioNetMonthlyCents).toBe(K(965))
  })

  it('lists seats whose share is not gross (and says they are normalised)', async () => {
    await prisma.position.update({ where: { id: sharedSeat }, data: { tenantCostShareCents: K(60) } })
    const p = (await call('ceo', 'GET', '/head-offices/setup/preview')).json()
    expect(p.seatsShareNotGross).toEqual([expect.objectContaining({ id: sharedSeat, monthlySalaryCents: K(100), tenantCostShareCents: K(60), moves: false })])
    // Normalising is a visible change: VV's planning goes up by 40k after.
    const vvAfter = p.planning.after.companies.find((r: { tenantId: string }) => r.tenantId === VV).netMonthlyCents
    const vvBefore = p.planning.before.companies.find((r: { tenantId: string }) => r.tenantId === VV).netMonthlyCents
    expect(vvAfter - vvBefore).toBe(K(40))
    await prisma.position.update({ where: { id: sharedSeat }, data: { tenantCostShareCents: K(100) } })
  })

  it('falls back to the owner split when the records do not add up, else equal shares', () => {
    const companies = [{ id: 'a', name: 'GS Foods', slug: 'gs-foods-bukhari' }, { id: 'b', name: 'GS x Viva', slug: 'gs-x-viva-clifton' }]
    const seat = { id: 's', tenantId: 'a', conceptId: null, departmentId: 'd', title: 't', status: 'open', headcount: 1, monthlySalaryCents: 800, tenantCostShareCents: 300, filledByUserId: null }
    const owner = suggestSplit({ companies, moving: [seat], headOfficeContributions: [] })
    expect(owner.source).toBe('owner_default')
    expect(owner.lines.map((l) => [l.companyTenantId, l.shareBps])).toEqual([['a', 3750], ['b', 6250]])
    const eq = suggestSplit({ companies: [{ id: 'x', name: 'X', slug: 'x' }, { id: 'y', name: 'Y', slug: 'y' }, { id: 'z', name: 'Z', slug: 'z' }], moving: [], headOfficeContributions: [] })
    expect(eq.source).toBe('equal')
    expect(eq.lines.reduce((s, l) => s + l.shareBps, 0)).toBe(10_000)
  })
})

describe('apply', () => {
  it('refuses an HOD login from outside the companies (nothing is created)', async () => {
    const r = await call('ceo', 'POST', '/head-offices/setup', { addHodMemberships: [strangerUser] })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('HOD_NOT_IN_COMPANIES')
    expect(await prisma.tenant.count({ where: { kind: 'head_office' } })).toBe(0)
    expect(await headOfficeSetupApplied()).toBe(false)
  })

  it('creates the head office, links, split v1, moves the people, ends the contribution, sets the marker', async () => {
    const beforeGS = (await budgetedLabour([GS])).netMonthlyCents
    const beforeVV = (await budgetedLabour([VV])).netMonthlyCents
    const beforeAll = (await budgetedLabour([GS, VV])).netMonthlyCents

    const res = await call('ceo', 'POST', '/head-offices/setup', { addHodMemberships: [hodUser] })
    expect(res.statusCode, res.body).toBe(201)
    const out = res.json()
    HO = out.headOffice.id
    expect(out.headOffice.name).toBe('GS Head Office')

    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: HO } })
    expect(t.kind).toBe('head_office')
    // Links (both live) and the charges accounts.
    const links = await prisma.headOfficeLink.findMany({ where: { tenantId: HO, endedAt: null } })
    expect(links.map((l) => l.companyTenantId).sort()).toEqual([GS, VV].sort())
    expect(out.links.every((l: { chargesAccountCode: string }) => /^62[0-4]\d$/.test(l.chargesAccountCode))).toBe(true)
    // Split v1 from this Karachi month.
    const split = await prisma.rechargeSplit.findFirstOrThrow({ where: { tenantId: HO }, include: { lines: true } })
    expect(split.effectiveFrom).toBe(planMonth())
    expect(Object.fromEntries(split.lines.map((l) => [l.companyTenantId, l.shareBps]))).toEqual({ [GS]: 3750, [VV]: 6250 })
    // Recharge stays OFF.
    const books = await prisma.headOfficeBooks.findUniqueOrThrow({ where: { tenantId: HO } })
    expect(books.rechargeEnabled).toBe(false)
    expect(books.setupAppliedAt).not.toBeNull()
    expect(books.setupAppliedById).toBe(users.ceo!.id)
    expect(await headOfficeSetupApplied()).toBe(true)
    // Departments copied, seats moved at share = gross with their band and designation.
    const hoDepts = await prisma.department.findMany({ where: { tenantId: HO }, orderBy: { order: 'asc' } })
    expect(hoDepts.map((d) => d.name)).toEqual(['Procurement', 'Finance', 'Marketing'])
    const moved = await prisma.position.findMany({ where: { id: { in: hoSeats } } })
    expect(moved.every((p) => p.tenantId === HO && p.tenantCostShareCents === p.monthlySalaryCents && hoDepts.some((d) => d.id === p.departmentId))).toBe(true)
    const pm = moved.find((p) => p.title === 'Procurement Manager')!
    expect(pm.filledByUserId).toBe(hodUser)
    const pmBand = await prisma.shiftBand.findUniqueOrThrow({ where: { id: pm.shiftBandId! } })
    expect(pmBand.tenantId).toBe(HO)
    expect(await prisma.hrOrgUnit.count({ where: { tenantId: HO, kind: 'designation', name: 'Procurement Manager' } })).toBe(1)
    expect(await prisma.position.count({ where: { tenantId: GS, title: 'Dish 1' } })).toBe(1) // commissary stays
    // The contribution is ended, kept.
    const c = await prisma.tenantContribution.findUniqueOrThrow({ where: { id: hoContrib } })
    expect(c.isActive).toBe(false)
    expect(c.endedAt).not.toBeNull()
    // A3: the HOD is a head-office member now; still a GS member.
    expect(await prisma.tenantMember.count({ where: { userId: hodUser, tenantId: HO } })).toBe(1)
    expect(await prisma.tenantMember.count({ where: { userId: hodUser, tenantId: GS } })).toBe(1)
    expect(out.hodMembershipsAdded).toEqual([hodUser])

    // Planning totals identical.
    expect((await budgetedLabour([GS])).netMonthlyCents).toBe(beforeGS)
    expect((await budgetedLabour([VV])).netMonthlyCents).toBe(beforeVV)
    expect((await budgetedLabour([GS, VV])).netMonthlyCents).toBe(beforeAll)
    expect(beforeGS).toBe(K(330))
    expect(beforeVV).toBe(K(635))
    // …and the preview's "after" is what planning now says.
    const afterRows = out.planning.after.companies as Array<{ tenantId: string; netMonthlyCents: number; headOfficeChargesMonthlyCents: number }>
    for (const r of afterRows) {
      const b = await budgetedLabour([r.tenantId])
      expect(b.netMonthlyCents).toBe(r.netMonthlyCents)
      expect(b.headOfficeChargesMonthlyCents).toBe(r.headOfficeChargesMonthlyCents)
    }

    // Audited in the head office's and each company's trail.
    const audits = await prisma.auditLog.findMany({ where: { action: 'ho.setup.apply', entityId: HO } })
    expect(audits.map((a) => a.tenantId).sort()).toEqual([GS, HO, VV].sort())
  })

  it('a second run is 409 SETUP_ALREADY_DONE; the preview says it is done', async () => {
    const r = await call('ceo', 'POST', '/head-offices/setup', {})
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('SETUP_ALREADY_DONE')
    expect(await prisma.tenant.count({ where: { kind: 'head_office' } })).toBe(1)
    const p = (await call('ceo', 'GET', '/head-offices/setup/preview')).json()
    expect(p.alreadyApplied).toMatchObject({ headOfficeId: HO, name: 'GS Head Office' })
  })
})
