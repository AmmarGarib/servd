// HR-R7 — tip pools per company, and staff with no login as pool members.
//
//   - TipPool.tenantId: created in the ACTIVE company, for that company's
//     brand (another of the operator's companies' brand → 422, a brand of a
//     company they are not in → 404); company B never sees or touches A's
//     pool; the pool's own company — not the operator's — takes the payout
//     entry and the flags.
//   - tip_pool_members.employeeId: kiosk / time-clock staff (an HR record, no
//     login) are members, their role read from their HR designation; every
//     member is of the pool's company (422 otherwise).
//   - Alert kinds: the outlier flag is 'tip_pool_outlier', the CapEx flag
//     'capex_over_budget' (and an open stand-in 'high_value_void' still
//     de-dups it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { tipPoolRoutes, hrRoleKey } from '../src/modules/tipPools/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { recordPunch } from '../src/modules/hr/attendance.js'
import { flagException, kindsMatching } from '../src/lib/exceptions.js'

const H = 3_600_000
const stamp = Date.now()

let app: FastifyInstance
let tenantA: string, tenantB: string
let brandA: string, brandB: string
let locA: string, locB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@tpco.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `TP-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), ...extra },
  })
  emps[key] = e.id
  return e.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}`, ...headers } })

async function setOps(tenantId: string, data: Record<string, unknown>) {
  await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data } })
  invalidateSetupCache()
}
const tipOrder = (conceptId: string, tipCents: number, at: Date) =>
  prisma.order.create({ data: { conceptId, source: 'pos', status: 'completed', completedAt: at, totalCents: 100_000 + tipCents, tipCents } })
async function shift(employeeId: string, tenantId: string, locationId: string, from: Date, hours: number, source: 'kiosk' | 'clock') {
  await recordPunch({ tenantId, employeeId, kind: 'in', at: from, source, locationId, geofenceMatched: true })
  await recordPunch({ tenantId, employeeId, kind: 'out', at: new Date(from.getTime() + hours * H), source })
}

// The pool windows, all over and none overlapping.
const w0 = new Date(Date.now() - 80 * H)
const w1 = new Date(w0.getTime() + 8 * H)
const w2 = new Date(w1.getTime() + 2 * H)
const w3 = new Date(w2.getTime() + 8 * H)

beforeAll(async () => {
  // The CHECK and the partial unique indexes live in migration
  // 20261012120000 (db push cannot build them) — as production has them.
  await prisma.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tip_pool_members_one_person') THEN
      ALTER TABLE "tip_pool_members" ADD CONSTRAINT "tip_pool_members_one_person" CHECK (("userId" IS NULL) <> ("employeeId" IS NULL));
    END IF; END $$`)
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "tip_pool_members_poolId_userId_key" ON "tip_pool_members"("poolId", "userId") WHERE "userId" IS NOT NULL`)
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "tip_pool_members_poolId_employeeId_key" ON "tip_pool_members"("poolId", "employeeId") WHERE "employeeId" IS NOT NULL`)

  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (tp)', slug: `gs-tp-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (tp)', slug: `kb-tp-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  // One brand each: a punch with no branch still counts for a one-brand company.
  brandA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-tp-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Bun Kebab', slug: `bk-tp-${stamp}`, type: 'restaurant', tenantId: tenantB } })).id
  locA = (await prisma.location.create({ data: { slug: `tp-a-${stamp}`, name: 'Clifton', tenantId: tenantA } })).id
  locB = (await prisma.location.create({ data: { slug: `tp-b-${stamp}`, name: 'Saddar', tenantId: tenantB } })).id
  await prisma.conceptLocation.create({ data: { conceptId: brandA, locationId: locA } })
  await prisma.conceptLocation.create({ data: { conceptId: brandB, locationId: locB } })
  await setOps(tenantA, { tipPoolEnabled: true, tipPoolDistribution: 'by_role_weight' })
  await setOps(tenantB, { tipPoolEnabled: true, tipPoolDistribution: 'equal' })

  // The head-office CEO belongs to both companies; A is their active one.
  await mkUser('ceoAB', 'admin', tenantA, [tenantB])
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('server', 'foh', tenantA)
  await mkUser('host', 'foh', tenantA)
  await mkUser('serverB', 'foh', tenantB)
  const cookDesignation = (await prisma.hrOrgUnit.create({ data: { tenantId: tenantA, kind: 'designation', name: 'Line Cook' } })).id
  await mkEmp('Sara Server', tenantA, { userId: users['server']!.id, locationId: locA })
  await mkEmp('Hamza Host', tenantA, { userId: users['host']!.id, locationId: locA })
  await mkEmp('Cook Ahmed', tenantA, { locationId: locA, designationId: cookDesignation }) // no login: kiosk
  await mkEmp('Dishwasher B', tenantB, { locationId: locB })                                // company B, no login

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tipPoolRoutes, { prefix: '/api/v1/tip-pools' })
  await app.register(financePlanningRoutes, { prefix: '/api/v1/finance' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('hrRoleKey — the tip-pool role of someone with no login', () => {
  it('reads the designation, then the department, and never guesses', () => {
    expect(hrRoleKey('Line Cook', null)).toBe('kitchen')
    expect(hrRoleKey('Head Chef', null)).toBe('kitchen')
    expect(hrRoleKey('Barista', 'Kitchen')).toBe('barista')
    expect(hrRoleKey('Waiter', null)).toBe('foh')
    expect(hrRoleKey('Cashier', null)).toBe('cashier')
    expect(hrRoleKey(null, 'Main Kitchen')).toBe('kitchen')
    expect(hrRoleKey('Security Guard', 'Admin')).toBeNull()
    expect(hrRoleKey(null, null)).toBeNull()
  })

  it('matches whole words, never a non-tip job, and reads the department only without a designation (D-RV-1)', () => {
    // Each of these used to land in the pool at foh or kitchen weight.
    expect(hrRoleKey('Security Guard', 'Security Services')).toBeNull()
    expect(hrRoleKey('Security Guard', 'Admin & Services')).toBeNull()
    expect(hrRoleKey('Accountant', 'Finance Services')).toBeNull()
    expect(hrRoleKey('Office Boy', 'Customer Service')).toBeNull()
    expect(hrRoleKey('Plumber', 'Hospitality Services')).toBeNull()
    expect(hrRoleKey('Ghost Kitchen Driver', null)).toBeNull()
    expect(hrRoleKey('Maintenance Helper', 'Kitchen')).toBeNull()
    expect(hrRoleKey('Electrician Helper', null)).toBeNull()
    // A designation set but not recognised: the department is not read.
    expect(hrRoleKey('Supervisor', 'Kitchen')).toBeNull()
    // No designation: only an exact department name counts.
    expect(hrRoleKey(null, 'Front of House')).toBe('foh')
    expect(hrRoleKey(null, ' BOH ')).toBe('kitchen')
    expect(hrRoleKey(null, 'Customer Service')).toBeNull()
    expect(hrRoleKey(null, 'Kitchen Services')).toBeNull()
    // The real tip roles still read.
    expect(hrRoleKey('Hostess', null)).toBe('foh')
    expect(hrRoleKey('Host', null)).toBe('foh')
    expect(hrRoleKey('Kitchen Helper', null)).toBe('kitchen')
    expect(hrRoleKey('Tandoori', null)).toBe('kitchen')
    expect(hrRoleKey('Expediter', null)).toBe('expediter')
  })
})

describe('a tip pool belongs to the active company', () => {
  let poolA: string
  let poolB: string

  it('binds a new pool to the active company, with the kiosk cook as a member by HR record', async () => {
    await shift(emps['Sara Server']!, tenantA, locA, new Date(w0.getTime() + H), 2, 'clock')
    await shift(emps['Cook Ahmed']!, tenantA, locA, new Date(w0.getTime() + H), 4, 'kiosk')
    await shift(emps['Dishwasher B']!, tenantB, locB, new Date(w0.getTime() + H), 4, 'kiosk')
    await tipOrder(brandA, 30_000, new Date(w0.getTime() + 2 * H))

    const r = await call('ceoAB', 'POST', '/tip-pools', { conceptId: brandA, name: 'A day', periodStart: w0.toISOString(), periodEnd: w1.toISOString() })
    expect(r.statusCode).toBe(201)
    poolA = r.json().id
    expect(r.json().tenantId).toBe(tenantA)
    const members = r.json().members as Array<{ userName: string; userId: string | null; employeeId: string | null; roleWeight: number; shareUnits: number; employee: { employeeCode: string } | null }>
    expect(members.map((m) => m.userName)).toEqual(['Cook Ahmed', 'server'])
    // The cook: no login, by HR record, the kitchen weight from 'Line Cook'.
    expect(members[0]).toMatchObject({ userId: null, employeeId: emps['Cook Ahmed'], roleWeight: 0.5, shareUnits: 2 })
    expect(members[0]!.employee?.employeeCode).toMatch(/^TP-/)
    expect(members[1]).toMatchObject({ userId: users['server']!.id, employeeId: null, roleWeight: 1, shareUnits: 2 })
    // Company B's dishwasher is nowhere in it.
    expect(JSON.stringify(r.json())).not.toContain('Dishwasher B')
    expect(r.json().review.blockers).toEqual([])
  })

  it('refuses another company\'s brand: 422 when the operator is in it, 404 when not', async () => {
    const cross = await call('ceoAB', 'POST', '/tip-pools', { conceptId: brandB, name: 'x', periodStart: w0.toISOString(), periodEnd: w1.toISOString() })
    expect(cross.statusCode).toBe(422)
    expect(cross.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
    expect((await call('ceoB', 'POST', '/tip-pools', { conceptId: brandA, name: 'x', periodStart: w2.toISOString(), periodEnd: w3.toISOString() })).statusCode).toBe(404)
    // Switched to B (the active-company header), the same operator pools B's brand, in B.
    const inB = await call('ceoAB', 'POST', '/tip-pools', { conceptId: brandB, name: 'B day', periodStart: w0.toISOString(), periodEnd: w1.toISOString() }, { 'x-servd-active-tenant': tenantB })
    expect(inB.statusCode).toBe(201)
    poolB = inB.json().id
    expect(inB.json().tenantId).toBe(tenantB)
    // B's dishwasher has no login and no designation: asked about, never guessed.
    expect(inB.json().members).toEqual([])
    expect(inB.json().review.staffWithoutRole.map((m: { name: string }) => m.name)).toEqual(['Dishwasher B'])
    expect(await prisma.tipPool.count({ where: { name: 'x' } })).toBe(0)
  })

  it('company B gets 404 on every route of A\'s pool, and never lists it', async () => {
    const member = await prisma.tipPoolMember.findFirstOrThrow({ where: { poolId: poolA } })
    expect((await call('ceoB', 'GET', `/tip-pools/${poolA}`)).statusCode).toBe(404)
    expect((await call('ceoB', 'GET', `/tip-pools/${poolA}/candidates`)).statusCode).toBe(404)
    expect((await call('ceoB', 'PATCH', `/tip-pools/members/${member.id}`, { shareUnits: 99 })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/tip-pools/${poolA}/members`, { employeeId: emps['Dishwasher B'], hoursWorked: 1, roleWeight: 1 })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/tip-pools/${poolA}/post`, {})).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/tip-pools/${poolA}/pay`, {})).statusCode).toBe(404)
    expect((await call('ceoB', 'DELETE', `/tip-pools/${poolA}`)).statusCode).toBe(404)
    const listB = (await call('ceoB', 'GET', '/tip-pools')).json() as Array<{ id: string }>
    expect(listB.map((p) => p.id)).toEqual([poolB])
    // The two-company operator sees the active company's, or both in portfolio view.
    expect(((await call('ceoAB', 'GET', '/tip-pools')).json() as Array<{ id: string }>).map((p) => p.id)).toEqual([poolA])
    const both = (await call('ceoAB', 'GET', '/tip-pools', undefined, { 'x-servd-portfolio': '1' })).json() as Array<{ id: string }>
    expect(both.map((p) => p.id).sort()).toEqual([poolA, poolB].sort())
    expect((await prisma.tipPoolMember.findUniqueOrThrow({ where: { id: member.id } })).shareUnits).not.toBe(99)
  })

  it('A\'s pool cannot take B\'s employee or B\'s login; candidates are A\'s staff only', async () => {
    const emp = await call('ceoAB', 'POST', `/tip-pools/${poolA}/members`, { employeeId: emps['Dishwasher B'], hoursWorked: 4, roleWeight: 0.5 })
    expect(emp.statusCode).toBe(422)
    expect(emp.json().error.code).toBe('MEMBER_NOT_IN_COMPANY')
    const login = await call('ceoAB', 'POST', `/tip-pools/${poolA}/members`, { userId: users['serverB']!.id, hoursWorked: 4 })
    expect(login.statusCode).toBe(422)
    expect(login.json().error.code).toBe('MEMBER_NOT_IN_COMPANY')
    const cands = (await call('ceoAB', 'GET', `/tip-pools/${poolA}/candidates`)).json() as Array<{ name: string; hasLogin: boolean }>
    // Sara and the cook are in already; only Hamza is left — and nobody of B's.
    expect(cands.map((c) => c.name)).toEqual(['Hamza Host'])
    // An employee with a login is added by that login, like the builder does.
    const host = await call('ceoAB', 'POST', `/tip-pools/${poolA}/members`, { employeeId: emps['Hamza Host'], hoursWorked: 0 })
    expect(host.statusCode).toBe(201)
    expect(host.json()).toMatchObject({ userId: users['host']!.id, employeeId: null, roleWeight: 1, shareUnits: 0 })
    expect((await call('ceoAB', 'POST', `/tip-pools/${poolA}/members`, { userId: users['host']!.id, hoursWorked: 1 })).statusCode).toBe(409)
  })

  it('pays the kiosk cook their share and posts the payout balanced in the POOL\'s company', async () => {
    const posted = await call('ceoAB', 'POST', `/tip-pools/${poolA}/post`, {})
    expect(posted.statusCode).toBe(200)
    const shares = Object.fromEntries((posted.json().members as Array<{ userName: string; shareCents: number }>).map((m) => [m.userName, m.shareCents]))
    // by_role_weight: server 2 h × 1.0, cook 4 h × 0.5 — equal units.
    expect(shares).toEqual({ 'Cook Ahmed': 15_000, 'Hamza Host': 0, server: 15_000 })

    // Paid while the operator has company B active: the entry is still A's.
    const paid = await call('ceoAB', 'POST', `/tip-pools/${poolA}/pay`, {}, { 'x-servd-active-tenant': tenantB })
    expect(paid.statusCode).toBe(200)
    expect(paid.json().status).toBe('paid')
    expect(paid.json().members.find((m: { userName: string }) => m.userName === 'Cook Ahmed')).toMatchObject({ employeeId: emps['Cook Ahmed'], shareCents: 15_000 })
    const entries = await prisma.journalEntry.findMany({ where: { reference: `tippool.payout:${poolA}` }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
    expect(entries).toHaveLength(1)
    const je = entries[0]!
    expect(je.tenantId).toBe(tenantA)
    const debit = je.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const credit = je.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    expect(debit).toBe(30_000)
    expect(credit).toBe(30_000)
    expect(je.lines.map((l) => [l.type, l.account.code]).sort()).toEqual([['credit', '1020'], ['debit', '2095']])
    expect(je.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tippool.distribute', after: { path: ['employeeId'], equals: emps['Cook Ahmed'] } } })
    expect(audit.tenantId).toBe(tenantA)
  })

  it('flags an outlier share as tip_pool_outlier, in the pool\'s company', async () => {
    await shift(emps['Sara Server']!, tenantA, locA, new Date(w2.getTime() + H), 6, 'clock')
    await shift(emps['Hamza Host']!, tenantA, locA, new Date(w2.getTime() + H), 1, 'clock')
    await shift(emps['Cook Ahmed']!, tenantA, locA, new Date(w2.getTime() + H), 1, 'kiosk')
    await tipOrder(brandA, 10_000, new Date(w2.getTime() + 2 * H))
    const pool = await call('ceoAB', 'POST', '/tip-pools', { conceptId: brandA, name: 'A evening', periodStart: w2.toISOString(), periodEnd: w3.toISOString() })
    expect(pool.statusCode).toBe(201)
    expect(pool.json().members).toHaveLength(3)
    // Posted by the operator with B active: the flag is still A's.
    expect((await call('ceoAB', 'POST', `/tip-pools/${pool.json().id}/post`, {}, { 'x-servd-active-tenant': tenantB })).statusCode).toBe(200)
    const flags = await prisma.exceptionFlag.findMany({ where: { entityType: 'TipPool', entityId: pool.json().id } })
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ kind: 'tip_pool_outlier', tenantId: tenantA, conceptId: brandA })
    expect(flags[0]!.title).toMatch(/^Tip pool: server taking \d+%$/)
  })

  it('keeps one row per person per pool, and every row a login OR an employee', async () => {
    await expect(prisma.tipPoolMember.create({ data: { poolId: poolB, userName: 'nobody', hoursWorked: 1, shareUnits: 1 } })).rejects.toThrow()
    await expect(prisma.tipPoolMember.create({ data: { poolId: poolB, userId: users['serverB']!.id, employeeId: emps['Dishwasher B'], userName: 'both', hoursWorked: 1, shareUnits: 1 } })).rejects.toThrow()
    await prisma.tipPoolMember.create({ data: { poolId: poolB, employeeId: emps['Dishwasher B'], userName: 'once', hoursWorked: 1, shareUnits: 1 } })
    await expect(prisma.tipPoolMember.create({ data: { poolId: poolB, employeeId: emps['Dishwasher B'], userName: 'again', hoursWorked: 1, shareUnits: 1 } })).rejects.toThrow()
    await prisma.tipPoolMember.create({ data: { poolId: poolB, userId: users['serverB']!.id, userName: 'once', hoursWorked: 1, shareUnits: 1 } })
    await expect(prisma.tipPoolMember.create({ data: { poolId: poolB, userId: users['serverB']!.id, userName: 'again', hoursWorked: 1, shareUnits: 1 } })).rejects.toThrow()
  })
})

describe('alert kinds of their own', () => {
  it('a CapEx project over budget is capex_over_budget, raised once, and an open stand-in flag still counts', async () => {
    expect(kindsMatching('capex_over_budget')).toEqual(['capex_over_budget', 'high_value_void'])
    const project = await prisma.capexProject.create({ data: { tenantId: tenantA, conceptId: brandA, name: 'Kitchen refit', budgetEnvelopeCents: 100_000 } })
    const over = await call('ceoAB', 'POST', `/finance/capex/${project.id}/lines`, { scope: 'BOH', item: 'Oven', quantity: 1, unitCostCents: 150_000 })
    expect(over.statusCode).toBe(201)
    await call('ceoAB', 'POST', `/finance/capex/${project.id}/lines`, { scope: 'BOH', item: 'Hood', quantity: 1, unitCostCents: 10_000 })
    const flags = await prisma.exceptionFlag.findMany({ where: { entityType: 'CapexProject', entityId: project.id } })
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ kind: 'capex_over_budget', tenantId: tenantA, title: 'CapEx project over budget: Kitchen refit' })

    // An open flag from before the re-kind (stand-in kind) is not raised again beside.
    const legacy = await prisma.capexProject.create({ data: { tenantId: tenantA, name: 'Old build', budgetEnvelopeCents: 100_000 } })
    await prisma.exceptionFlag.create({ data: { tenantId: tenantA, kind: 'high_value_void', title: 'CapEx project over budget: Old build', description: 'd', entityType: 'CapexProject', entityId: legacy.id } })
    await call('ceoAB', 'POST', `/finance/capex/${legacy.id}/lines`, { scope: 'BOH', item: 'Fryer', quantity: 1, unitCostCents: 150_000 })
    expect(await prisma.exceptionFlag.count({ where: { entityType: 'CapexProject', entityId: legacy.id } })).toBe(1)
  })

  it('a flag without metadata is written with a SQL NULL (no `as never` cast on the write)', async () => {
    const r = await flagException({ tenantId: tenantA, kind: 'manual_journal', title: 'no metadata', description: 'd' })
    expect(r?.id).toBeTruthy()
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: r!.id } })).metadata).toBeNull()
  })
})

describe('staff with no login: never paid on a guess, never dropped (D-RV-1, D-RV-2, D-RV-4)', () => {
  let tenantC: string, tenantD: string
  let brandC: string, brandD1: string
  let locC: string, locD: string
  // C: a one-brand company. Its window is long over.
  const c0 = new Date(Date.now() - 200 * H)
  const c1 = new Date(c0.getTime() + 8 * H)
  // D: two brands. Its window ended an hour ago, so a shift begun in it is
  // still open (and not yet a missed clock-out).
  const d1 = new Date(Date.now() - H)
  const d0 = new Date(d1.getTime() - 8 * H)
  let poolC: string

  beforeAll(async () => {
    tenantC = (await prisma.tenant.create({ data: { name: 'Clifton Co (tp)', slug: `cc-tp-${stamp}` } })).id
    tenantD = (await prisma.tenant.create({ data: { name: 'Defence Co (tp)', slug: `dc-tp-${stamp}` } })).id
    await ensureChartOfAccounts(tenantC)
    await ensureChartOfAccounts(tenantD)
    brandC = (await prisma.concept.create({ data: { name: 'Simmer', slug: `simmer-tp-${stamp}`, type: 'restaurant', tenantId: tenantC } })).id
    brandD1 = (await prisma.concept.create({ data: { name: 'Flipd', slug: `flipd-tp-${stamp}`, type: 'restaurant', tenantId: tenantD } })).id
    const brandD2 = (await prisma.concept.create({ data: { name: 'Stackd D', slug: `stackd-d-tp-${stamp}`, type: 'restaurant', tenantId: tenantD } })).id
    locC = (await prisma.location.create({ data: { slug: `tp-c-${stamp}`, name: 'Zamzama', tenantId: tenantC } })).id
    locD = (await prisma.location.create({ data: { slug: `tp-d-${stamp}`, name: 'DHA', tenantId: tenantD } })).id
    const locD2 = (await prisma.location.create({ data: { slug: `tp-d2-${stamp}`, name: 'Gulshan', tenantId: tenantD } })).id
    await prisma.conceptLocation.create({ data: { conceptId: brandC, locationId: locC } })
    await prisma.conceptLocation.create({ data: { conceptId: brandD1, locationId: locD } })
    await prisma.conceptLocation.create({ data: { conceptId: brandD2, locationId: locD2 } })
    await setOps(tenantC, { tipPoolEnabled: true, tipPoolDistribution: 'by_role_weight' })
    await setOps(tenantD, { tipPoolEnabled: true, tipPoolDistribution: 'by_role_weight' })
    await mkUser('ceoC', 'admin', tenantC)
    await mkUser('ceoD', 'admin', tenantD)
    await mkUser('serverC', 'foh', tenantC)
    await mkUser('serverD', 'foh', tenantD)
    await mkUser('cookGone', 'boh', tenantC)
    // The CEO deletes the cook's login; HR keeps the record and its link.
    await prisma.user.update({ where: { id: users['cookGone']!.id }, data: { deletedAt: new Date(), isActive: false } })

    const desig = async (tenantId: string, name: string) => (await prisma.hrOrgUnit.create({ data: { tenantId, kind: 'designation', name } })).id
    const securityDept = (await prisma.department.create({ data: { tenantId: tenantC, name: 'Security Services' } })).id
    await mkEmp('Sana Server C', tenantC, { userId: users['serverC']!.id, locationId: locC })
    await mkEmp('Ghulam Guard', tenantC, { locationId: locC, designationId: await desig(tenantC, 'Security Guard'), departmentId: securityDept })
    await mkEmp('Kamran Cook', tenantC, { userId: users['cookGone']!.id, locationId: locC, designationId: await desig(tenantC, 'Line Cook') })
    await mkEmp('Danish Server D', tenantD, { userId: users['serverD']!.id, locationId: locD })
    // D's guards: no login, no designation, no HR branch.
    await mkEmp('Night Guard', tenantD)
    await mkEmp('Gate Guard', tenantD)
  }, 60_000)

  it('C: a security guard is asked about, not paid; a cook whose login was deleted is a member by HR record', async () => {
    await shift(emps['Sana Server C']!, tenantC, locC, new Date(c0.getTime() + H), 4, 'clock')
    await shift(emps['Ghulam Guard']!, tenantC, locC, new Date(c0.getTime() + H), 4, 'kiosk')
    await shift(emps['Kamran Cook']!, tenantC, locC, new Date(c0.getTime() + H), 4, 'clock')
    await tipOrder(brandC, 30_000, new Date(c0.getTime() + 2 * H))

    const r = await call('ceoC', 'POST', '/tip-pools', { conceptId: brandC, name: 'C day', periodStart: c0.toISOString(), periodEnd: c1.toISOString() })
    expect(r.statusCode).toBe(201)
    poolC = r.json().id
    const members = r.json().members as Array<{ userName: string; userId: string | null; employeeId: string | null; roleWeight: number; shareUnits: number }>
    // The guard is not a member (his designation names no tip role)…
    expect(members.map((m) => m.userName)).toEqual(['Kamran Cook', 'serverC'])
    // …and the cook is, by HR record, at the kitchen weight — not dropped.
    expect(members[0]).toMatchObject({ userId: null, employeeId: emps['Kamran Cook'], roleWeight: 0.5, shareUnits: 2 })
    expect(r.json().review.blockers).toEqual([])
    expect(r.json().review.staffWithoutRole).toEqual([expect.objectContaining({ name: 'Ghulam Guard', employeeId: emps['Ghulam Guard'], hours: 4, reason: 'no_role' })])
  })

  it('C: posting is refused until the guard is left out by name; the pot goes to the tip staff', async () => {
    const refused = await call('ceoC', 'POST', `/tip-pools/${poolC}/post`, {})
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('STAFF_ROLE_UNKNOWN')
    expect(refused.json().error.message).toContain('Ghulam Guard')

    const posted = await call('ceoC', 'POST', `/tip-pools/${poolC}/post`, { leaveOutStaff: { employeeIds: [emps['Ghulam Guard']], reason: 'Security guard — not in the tip pool' } })
    expect(posted.statusCode).toBe(200)
    const shares = Object.fromEntries((posted.json().members as Array<{ userName: string; shareCents: number }>).map((m) => [m.userName, m.shareCents]))
    // by_role_weight: server 4 h × 1.0 = 4, cook 4 h × 0.5 = 2.
    expect(shares).toEqual({ 'Kamran Cook': 10_000, serverC: 20_000 })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tippool.post', entityId: poolC } })
    expect(audit.tenantId).toBe(tenantC)
    expect(audit.metadata).toMatchObject({ staffLeftOut: [{ employeeId: emps['Ghulam Guard'], name: 'Ghulam Guard', hours: 4 }], reason: 'Security guard — not in the tip pool' })
  })

  it('D: guards with no known role and no branch (one still on shift) are asked about by name, not blockers of their own', async () => {
    await shift(emps['Danish Server D']!, tenantD, locD, new Date(d0.getTime() + H), 4, 'clock')
    // No geofence match and no HR branch, in a two-brand company: no known place.
    await recordPunch({ tenantId: tenantD, employeeId: emps['Night Guard']!, kind: 'in', at: new Date(d0.getTime() + H), source: 'kiosk', geofenceMatched: false })
    await recordPunch({ tenantId: tenantD, employeeId: emps['Night Guard']!, kind: 'out', at: new Date(d0.getTime() + 4 * H), source: 'kiosk' })
    // Clocked in 3 h before the window ended, never out.
    await recordPunch({ tenantId: tenantD, employeeId: emps['Gate Guard']!, kind: 'in', at: new Date(d1.getTime() - 3 * H), source: 'kiosk', geofenceMatched: false })
    await tipOrder(brandD1, 12_000, new Date(d0.getTime() + 2 * H))

    const r = await call('ceoD', 'POST', '/tip-pools', { conceptId: brandD1, name: 'D shift', periodStart: d0.toISOString(), periodEnd: d1.toISOString() })
    expect(r.statusCode).toBe(201)
    const poolD = r.json().id as string
    expect((r.json().members as Array<{ userName: string }>).map((m) => m.userName)).toEqual(['serverD'])
    // No "set their branch in HR" / "still clocked in" blocker that leaving
    // them out could never clear.
    expect(r.json().review.blockers).toEqual([])
    const asked = (r.json().review.staffWithoutRole as Array<{ name: string; hours: number; reason: string }>).map((x) => [x.name, x.hours, x.reason])
    expect(asked).toEqual([['Gate Guard', 3, 'no_role'], ['Night Guard', 3, 'no_role']])

    const refused = await call('ceoD', 'POST', `/tip-pools/${poolD}/post`, { leaveOutStaff: { employeeIds: [emps['Night Guard']], reason: 'Guards are not in the tip pool' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('STAFF_ROLE_UNKNOWN')
    expect(refused.json().error.message).toContain('Gate Guard')
    expect(refused.json().error.message).not.toContain('Night Guard')

    const posted = await call('ceoD', 'POST', `/tip-pools/${poolD}/post`, { leaveOutStaff: { employeeIds: [emps['Night Guard'], emps['Gate Guard']], reason: 'Guards are not in the tip pool' } })
    expect(posted.statusCode).toBe(200)
    expect(posted.json().members).toEqual([expect.objectContaining({ userName: 'serverD', shareCents: 12_000 })])
  })

  it('D: a login holder\'s hours with no known branch still block posting (that rule is unchanged)', async () => {
    const e0 = new Date(d0.getTime() - 20 * H)
    const e1 = new Date(e0.getTime() + 8 * H)
    await recordPunch({ tenantId: tenantD, employeeId: emps['Danish Server D']!, kind: 'in', at: new Date(e0.getTime() + H), source: 'clock', geofenceMatched: false })
    await recordPunch({ tenantId: tenantD, employeeId: emps['Danish Server D']!, kind: 'out', at: new Date(e0.getTime() + 3 * H), source: 'clock' })
    await prisma.hrEmployee.update({ where: { id: emps['Danish Server D']! }, data: { locationId: null } })
    try {
      const r = await call('ceoD', 'POST', '/tip-pools', { conceptId: brandD1, name: 'D earlier', periodStart: e0.toISOString(), periodEnd: e1.toISOString() })
      expect(r.statusCode).toBe(201)
      expect((r.json().review.blockers as string[]).some((b) => b.startsWith('serverD: 2.0 h not counted'))).toBe(true)
    } finally {
      await prisma.hrEmployee.update({ where: { id: emps['Danish Server D']! }, data: { locationId: locD } })
    }
  })
})
