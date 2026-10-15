// Head office in planning (D1, spec §8, amendment A15) — the head-office plan
// charges replace the old head_office contribution and the cost-share input,
// switched by the setup wizard's marker.
//
//   A  "GS Foods"  — carries the head-office seats today (HO department, 800k),
//                    a commissary seat (100k, no brand) and a brand seat (50k)
//   B  "GS x Viva" — a brand seat (70k); pays A 500k head_office + 20k commissary
//   C  a third company (A15 cases; never set up)
//   D  a fourth company (the "counts until linked" case)
//
// Before the wizard: today's numbers (A 430k, B 590k, portfolio 1,020k).
// The CEO runs POST /head-offices/setup for A and B (split 3750 / 6250).
// After: the same numbers, now from head-office charges (A 300k, B 500k).
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
import { budgetedLabour, headOfficePlanCharges, planMonth, contributionCounts } from '../src/lib/labour-budget.js'
import { monthlyLabourCents } from '../src/modules/projections/labour.js'
import { headOfficeSetupApplied } from '../src/modules/headOffices/books.js'
import { headOfficeRoutes } from '../src/modules/headOffices/routes.js'
import { headOfficeSetupRoutes } from '../src/modules/headOffices/setup.js'
import { positionRoutes } from '../src/modules/positions/routes.js'
import { opexRoutes } from '../src/modules/opex/routes.js'
import { projectionsRoutes } from '../src/modules/projections/routes.js'

const P = `lbho-${Date.now()}`
const K = (pkr: number) => pkr * 100_000 // thousands of PKR → paisa
let app: FastifyInstance
let A: string, B: string, C: string, D: string, HO: string
let brandA: string, brandB: string
let hoContribId: string, commissaryId: string, projB: string
const users: Record<string, { id: string; token: string }> = {}

async function tenant(name: string) {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}` } })).id
}
async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
function call(who: string, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url, headers: { authorization: `Bearer ${users[who]!.token}`, ...headers },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code

async function seat(tenantId: string, title: string, pkrK: number, extra: { conceptId?: string; departmentId?: string; shareK?: number; status?: 'open' | 'filled' | 'frozen' } = {}) {
  return (await prisma.position.create({
    data: {
      tenantId, title, conceptId: extra.conceptId ?? null, departmentId: extra.departmentId ?? null,
      monthlySalaryCents: K(pkrK), tenantCostShareCents: K(extra.shareK ?? pkrK), status: extra.status ?? 'filled',
    },
  })).id
}

/** Every consumer's figure for one company (active-company view of `who`). */
async function consumers(tenantId: string, who: string) {
  const b = await budgetedLabour([tenantId])
  const m = await monthlyLabourCents(tenantId)
  const snap = (await call(who, 'GET', '/opex/payroll-snapshot')).json().budget
  const summary = (await call(who, 'GET', '/positions/summary')).json()
  return { b, m, snap, summary }
}

beforeAll(async () => {
  A = await tenant('GS Foods')
  B = await tenant('GS x Viva')
  C = await tenant('Third Co')
  D = await tenant('Fourth Co')
  for (const t of [A, B, C, D]) await ensureChartOfAccounts(t)
  brandA = (await prisma.concept.create({ data: { name: 'Brand A', slug: `${P}-ba`, type: 'restaurant', tenantId: A } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Brand B', slug: `${P}-bb`, type: 'restaurant', tenantId: B } })).id

  const hoDept = await prisma.department.create({ data: { tenantId: A, name: 'Finance', isHeadOffice: true } })
  const comm = await prisma.department.create({ data: { tenantId: A, name: '42C Commissary' } })
  await seat(A, 'Finance Officer', 300, { departmentId: hoDept.id })
  await seat(A, 'Brand Manager', 300, { departmentId: hoDept.id })
  await seat(A, 'Buyer', 200, { departmentId: hoDept.id, status: 'open' })
  await seat(A, 'Frozen HO seat', 90, { departmentId: hoDept.id, status: 'frozen' })
  await seat(A, 'Prep', 100, { departmentId: comm.id })
  await seat(A, 'Chef', 50, { conceptId: brandA })
  await seat(B, 'Cook', 70, { conceptId: brandB })
  hoContribId = (await prisma.tenantContribution.create({
    data: { sourceTenantId: B, destinationTenantId: A, category: 'head_office', monthlyCents: K(500), label: 'JV HO contribution' },
  })).id
  commissaryId = (await prisma.tenantContribution.create({
    data: { sourceTenantId: B, destinationTenantId: A, category: 'commissary', monthlyCents: K(20), label: 'Commissary use' },
  })).id
  projB = (await prisma.projection.create({ data: { tenantId: B, name: 'B scenario' } })).id
  for (const [t, name] of [[C, 'Chef de Partie'], [C, 'Analyst'], [A, 'Chef']] as const) {
    await prisma.hrOrgUnit.create({ data: { tenantId: t, kind: 'designation', name } })
  }

  await mkUser('ceo', 'admin', A, [A, B, C, D])
  await mkUser('ceoB', 'admin', B, [A, B])
  await mkUser('bossC', 'admin', C, [C, D])

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
  await app.register(positionRoutes, { prefix: '/positions' })
  await app.register(opexRoutes, { prefix: '/opex' })
  await app.register(projectionsRoutes, { prefix: '/projections' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

let beforeA: Awaited<ReturnType<typeof consumers>>
let beforeB: Awaited<ReturnType<typeof consumers>>
let beforePortfolio: number
let beforeProjB: { headOfficeLabourCents: number }

describe('before the setup wizard: today\'s numbers, no plan charges', () => {
  it('nets the head_office and commissary contributions exactly as before', async () => {
    expect(await headOfficeSetupApplied()).toBe(false)
    beforeA = await consumers(A, 'ceo')
    beforeB = await consumers(B, 'ceoB')
    // A: 800 HO + 100 commissary + 50 brand − 500 − 20
    expect(beforeA.b.netMonthlyCents).toBe(K(430))
    expect(beforeA.m.netCents).toBe(K(430))
    expect(beforeA.snap.netMonthlyCents).toBe(K(430))
    expect(beforeA.summary.netMonthlyCents).toBe(K(430))
    expect(beforeA.m.companyLevelSeatsCents).toBe(K(900))
    expect(beforeA.m.headOfficeCents).toBe(K(900)) // the alias
    // B: 70 + 500 + 20
    expect(beforeB.b.netMonthlyCents).toBe(K(590))
    expect(beforeB.m.netCents).toBe(K(590))
    expect(beforeB.snap.netMonthlyCents).toBe(K(590))
    for (const x of [beforeA, beforeB]) {
      expect(x.b.headOfficeChargesMonthlyCents).toBe(0)
      expect(x.m.headOfficeChargesCents).toBe(0)
      expect(x.snap.headOfficeChargesMonthlyCents).toBe(0)
    }
    // Before setup the HO badge is the old department flag.
    expect(beforeA.b.byDepartment.find((d) => d.name === 'Finance')).toMatchObject({ headOffice: true, isHeadOffice: true })
    beforePortfolio = (await budgetedLabour([A, B])).netMonthlyCents
    expect(beforePortfolio).toBe(K(1020))
    const proj = (await call('ceoB', 'GET', `/projections/${projB}/computed`)).json()
    beforeProjB = proj.combined[0]
    expect(proj.labour.headOfficeChargesMonthlyCents).toBe(0)
    expect(beforeProjB.headOfficeLabourCents).toBe(K(520)) // company-level: no brand-less seats + 520 out (the brand seat is the brand's)
    expect(proj.labour.labels).toEqual({ headOfficeCharges: 'Head office charges (plan)', companyLevelSeats: 'Company-level seats', rechargedOut: 'Recharged to companies (plan)' })
  })

  it('A15: positions keep the cost-share input, and a salary edit scales the share', async () => {
    const r = await call('bossC', 'POST', '/positions', { title: 'Analyst', monthlySalaryCents: K(100), tenantCostShareCents: K(40), costShareNote: 'shared 40%' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ tenantCostShareCents: K(40), costShareNote: 'shared 40%' })
    const id = r.json().id as string
    const p = await call('bossC', 'PATCH', `/positions/${id}`, { monthlySalaryCents: K(200) })
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json().tenantCostShareCents).toBe(K(80)) // 40% kept
    const q = await call('bossC', 'PATCH', `/positions/${id}`, { monthlySalaryCents: K(250), tenantCostShareCents: K(50) })
    expect(q.json().tenantCostShareCents).toBe(K(50)) // an explicit share wins, as today
    const same = await call('bossC', 'PATCH', `/positions/${id}`, { headcount: 2 })
    expect(same.json().tenantCostShareCents).toBe(K(50))
  })

  it('A15: a scaled share that would not fit INT4 is 422 AMOUNT_TOO_LARGE (the seat is unchanged)', async () => {
    const r = await call('bossC', 'POST', '/positions', { title: 'Analyst', monthlySalaryCents: 100, tenantCostShareCents: 2_000_000_000 })
    expect(r.statusCode, r.body).toBe(200)
    const id = r.json().id as string
    const p = await call('bossC', 'PATCH', `/positions/${id}`, { monthlySalaryCents: 1_000 })
    expect(p.statusCode, p.body).toBe(422)
    expect(p.json().error.code).toBe('AMOUNT_TOO_LARGE')
    const big = await call('bossC', 'POST', '/positions', { title: 'Analyst', monthlySalaryCents: 3_000_000_000 })
    expect(big.json().error.code).toBe('AMOUNT_TOO_LARGE')
    const seat = await prisma.position.findUniqueOrThrow({ where: { id }, select: { monthlySalaryCents: true, tenantCostShareCents: true } })
    expect(seat).toEqual({ monthlySalaryCents: 100, tenantCostShareCents: 2_000_000_000 })
    await prisma.position.delete({ where: { id } })
  })

  it('A15: head_office contributions can still be recorded and corrected; the category is required', async () => {
    const none = await call('bossC', 'POST', '/positions/contributions', { sourceTenantId: D, destinationTenantId: C, monthlyCents: K(10), label: 'x' })
    expect(none.statusCode).toBe(400)
    const r = await call('bossC', 'POST', '/positions/contributions', { sourceTenantId: D, destinationTenantId: C, category: 'head_office', monthlyCents: K(10), label: 'D HO share' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().category).toBe('head_office')
    const patch = await call('bossC', 'PATCH', `/positions/contributions/${r.json().id}`, { monthlyCents: K(12) })
    expect(patch.statusCode, patch.body).toBe(200)
    expect(patch.json().monthlyCents).toBe(K(12))
  })
})

describe('the setup wizard runs: planning identical, now from head-office charges', () => {
  it('applies (split 3750 / 6250) and every consumer shows the head office charges', async () => {
    const res = await call('ceo', 'POST', '/head-offices/setup', { companyIds: [A, B], split: [{ companyTenantId: A, shareBps: 3750 }, { companyTenantId: B, shareBps: 6250 }] })
    expect(res.statusCode, res.body).toBe(201)
    HO = res.json().headOffice.id
    expect(await headOfficeSetupApplied()).toBe(true)

    const afterA = await consumers(A, 'ceo')
    const afterB = await consumers(B, 'ceoB')
    // Identical totals.
    for (const [x, want] of [[afterA, K(430)], [afterB, K(590)]] as const) {
      expect(x.b.netMonthlyCents).toBe(want)
      expect(x.m.netCents).toBe(want)
      expect(x.snap.netMonthlyCents).toBe(want)
      expect(x.summary.netMonthlyCents).toBe(want)
    }
    // …now made of head-office charges (salaries only: open + filled = 800k; the frozen seat is out).
    expect(afterA.b.headOfficeChargesMonthlyCents).toBe(K(300))
    expect(afterB.b.headOfficeChargesMonthlyCents).toBe(K(500))
    expect(afterB.b.headOfficeCharges).toEqual([expect.objectContaining({ headOfficeId: HO, companyTenantId: B, shareBps: 6250, monthlyCents: K(500) })])
    expect(afterA.m.headOfficeChargesCents).toBe(K(300))
    expect(afterA.m.companyLevelSeatsCents).toBe(K(100)) // the commissary seat stays
    expect(afterB.m.headOfficeChargesCents).toBe(K(500))
    expect(afterA.snap.headOfficeChargesMonthlyCents).toBe(K(300))
    expect(afterB.snap.headOfficeChargesMonthlyCents).toBe(K(500))
    expect(afterB.snap.labels.headOfficeCharges).toBe('Head office charges (plan)')
    expect(afterB.summary.headOfficeChargesMonthlyCents).toBe(K(500))
    // The commissary contribution still counts; the head_office one does not.
    expect(afterB.b.outgoingContributionMonthlyCents).toBe(K(20))
    // The retired head_office row is still listed, flagged ended, never summed.
    expect(afterB.b.contributions.map((c) => [c.id, c.ended === true])).toEqual([[commissaryId, false], [hoContribId, true]])
    expect(afterB.b.contributions.find((c) => c.id === hoContribId)).toMatchObject({ direction: 'outgoing', monthlyCents: K(500), ended: true })
    expect(afterA.b.contributions.find((c) => c.id === hoContribId)).toMatchObject({ direction: 'incoming', ended: true })
    expect(afterB.summary.contributions.find((c: { id: string }) => c.id === hoContribId)).toMatchObject({ ended: true })
    expect(afterB.summary.contributions.find((c: { id: string }) => c.id === commissaryId).ended).toBeUndefined()
    expect(afterA.b.incomingContributionMonthlyCents).toBe(K(20))

    const proj = (await call('ceoB', 'GET', `/projections/${projB}/computed`)).json()
    expect(proj.labour.headOfficeChargesMonthlyCents).toBe(K(500))
    expect(proj.labour.companyLevelSeatsMonthlyCents).toBe(0)
    expect(proj.combined[0].headOfficeLabourCents).toBe(beforeProjB.headOfficeLabourCents)
  })

  it('the head office in scope recharges out; a portfolio cancels the pair', async () => {
    const ho = await budgetedLabour([HO])
    expect(ho.shareMonthlyCents).toBe(K(800))
    expect(ho.rechargedOutMonthlyCents).toBe(K(800))
    expect(ho.netMonthlyCents).toBe(0)
    expect(ho.byDepartment).toEqual([expect.objectContaining({ name: 'Finance', headOffice: true, isHeadOffice: true })])
    expect((await monthlyLabourCents(HO)).netCents).toBe(0)

    expect((await budgetedLabour([A, B])).netMonthlyCents).toBe(beforePortfolio)
    const all = await budgetedLabour([A, B, HO])
    expect(all.headOfficeChargesMonthlyCents).toBe(0)
    expect(all.rechargedOutMonthlyCents).toBe(0)
    expect(all.netMonthlyCents).toBe(beforePortfolio)
    const plan = await headOfficePlanCharges([A, B, HO], planMonth())
    expect(plan.internal).toHaveLength(2)
    // A company with its head office: cancels that pair only.
    const aHo = await budgetedLabour([A, HO])
    expect(aHo.rechargedOutMonthlyCents).toBe(K(500)) // B is outside
    expect(aHo.headOfficeChargesMonthlyCents).toBe(0)
    // OpEx "All companies" (A, B, the head office, C, D for the CEO): pairs cancel.
    const snap = (await call('ceo', 'GET', '/opex/payroll-snapshot', undefined, { 'x-servd-portfolio': '1' })).json().budget
    expect(snap.headOfficeChargesMonthlyCents).toBe(0)
    expect(snap.rechargedOutMonthlyCents).toBe(0)
  })

  it('after setup the old department flag is not read: an HO department is one in a head office', async () => {
    const a = await budgetedLabour([A])
    expect(a.byDepartment.find((d) => d.name === '42C Commissary')).toMatchObject({ headOffice: false })
    const list = (await call('ceo', 'GET', '/positions')).json() as Array<{ department: { isHeadOffice: boolean } | null }>
    expect(list.every((p) => !p.department || p.department.isHeadOffice === false)).toBe(true)
  })
})

describe('contributions after the setup', () => {
  it('a head_office contribution counts until either of its companies is linked, then not', async () => {
    const dHo = await prisma.tenantContribution.findFirstOrThrow({ where: { sourceTenantId: D, destinationTenantId: C, category: 'head_office' } })
    expect(contributionCounts(dHo, true, new Set())).toBe(true)
    expect((await budgetedLabour([C])).incomingContributionMonthlyCents).toBe(K(12))
    const link = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: D })
    expect(link.statusCode, link.body).toBe(201)
    const cAfter = await budgetedLabour([C])
    expect(cAfter.incomingContributionMonthlyCents).toBe(0)
    // Replaced by the link: listed as ended, not summed.
    expect(cAfter.contributions.find((c) => c.id === dHo.id)).toMatchObject({ direction: 'incoming', ended: true })
    expect(cAfter.netMonthlyCents).toBe(cAfter.shareMonthlyCents + cAfter.headOfficeChargesMonthlyCents - cAfter.rechargedOutMonthlyCents)
    // D is linked but not in the % table yet: no charge.
    expect((await budgetedLabour([D])).headOfficeChargesMonthlyCents).toBe(0)
    const listed = (await call('bossC', 'GET', '/positions/contributions')).json()
    const row = listed.incoming.find((c: { id: string }) => c.id === dHo.id)
    expect(row).toMatchObject({ counts: false, readOnly: true })
    expect(listed.incomingMonthlyCents).toBe(0)
  })

  it('USE_HEAD_OFFICE: no new head_office contribution, no edit of one; other categories unchanged', async () => {
    const r = await call('bossC', 'POST', '/positions/contributions', { sourceTenantId: D, destinationTenantId: C, category: 'head_office', monthlyCents: K(1), label: 'late' })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('USE_HEAD_OFFICE')
    const dHo = await prisma.tenantContribution.findFirstOrThrow({ where: { sourceTenantId: D, destinationTenantId: C, category: 'head_office' } })
    const p = await call('bossC', 'PATCH', `/positions/contributions/${dHo.id}`, { monthlyCents: K(2) })
    expect(code(p)).toBe('USE_HEAD_OFFICE')
    const ok = await call('bossC', 'POST', '/positions/contributions', { sourceTenantId: D, destinationTenantId: C, category: 'shared_services', monthlyCents: K(3), label: 'IT' })
    expect(ok.statusCode, ok.body).toBe(201)
    const c = await budgetedLabour([C])
    expect(c.incomingContributionMonthlyCents).toBe(K(3))
    // The setup ended the old JV row: read-only in the list.
    const listed = (await call('ceo', 'GET', '/positions/contributions')).json()
    expect(listed.incoming.find((x: { id: string }) => x.id === hoContribId)).toMatchObject({ isActive: false, readOnly: true, counts: false })
  })
})

describe('positions after the setup: share = gross, the share input is ignored', () => {
  it('POST and PATCH strip tenantCostShareCents and costShareNote', async () => {
    const r = await call('bossC', 'POST', '/positions', { title: 'Chef de Partie', monthlySalaryCents: K(100), tenantCostShareCents: K(10), costShareNote: 'ignored' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ monthlySalaryCents: K(100), tenantCostShareCents: K(100), costShareNote: null })
    const id = r.json().id as string
    const p = await call('bossC', 'PATCH', `/positions/${id}`, { monthlySalaryCents: K(120), tenantCostShareCents: K(1), costShareNote: 'nope' })
    expect(p.json()).toMatchObject({ monthlySalaryCents: K(120), tenantCostShareCents: K(120), costShareNote: null })
    // The pre-setup seat (share 50k of 250k) follows its salary from now on.
    const old = await prisma.position.findFirstOrThrow({ where: { tenantId: C, title: 'Analyst' } })
    const q = await call('bossC', 'PATCH', `/positions/${old.id}`, { monthlySalaryCents: K(260), tenantCostShareCents: K(5) })
    expect(q.json()).toMatchObject({ tenantCostShareCents: K(260), costShareNote: 'shared 40%' })
  })
})
