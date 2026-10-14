// Company separation — finance planning surfaces (2026-09-27 sweep).
//
// Two companies, one admin in each. What these defend:
//   - Cost-allocation rules and runs belong to one company: B can't list,
//     run or delete A's rule (404), can't weight a rule onto A's brand (422),
//     and both companies can keep a rule for the same source account.
//   - A run posts to the RULE's company's ledger and stamps the run with it.
//   - Projections: one company per scenario; B can't read, compute, edit,
//     delete or add a brand to A's scenario; brands must be the scenario's
//     company's; computed actuals come from that company only.
//   - Capex / capital ledger / opex / fixed assets refuse another company's
//     brand, location, owner, bank account (422), including on partial PATCH;
//     equipment reaches the register only through CapEx (POST / is 422 USE_CAPEX).
//   - Payment gateway overrides are scoped through the brand.
//   - Contributions need both sides to be the operator's companies, and fail
//     with a real HTTP status, not `{ error }` + 200.
//
// Drives the real route handlers through Fastify inject. Needs the disposable
// test database (DATABASE_URL must contain "test") and Redis.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { allocationRoutes } = await import('../src/modules/allocations/routes.js')
const { projectionsRoutes } = await import('../src/modules/projections/routes.js')
const { financePlanningRoutes } = await import('../src/modules/financePlanning/routes.js')
const { opexRoutes } = await import('../src/modules/opex/routes.js')
const { fixedAssetRoutes } = await import('../src/modules/fixedAssets/routes.js')
const { paymentGatewayRoutes } = await import('../src/modules/paymentGateways/routes.js')
const { contributionRoutes } = await import('../src/modules/positions/contributions.js')

const PREFIX = `sepfin-${Date.now()}`
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let locationA: string, locationB: string
let userA: string, userB: string, userBoth: string
let tokenA: string, tokenB: string, tokenBoth: string
const users: string[] = []

async function makeAdmin(tenantId: string, alsoMemberOf: string[] = []) {
  const n = users.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} admin ${n}`,
      email: `${PREFIX}.admin.${n}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: 'admin',
      tenantId,
      isActive: true,
      accountStatus: 'active',
      tenantMemberships: { create: [tenantId, ...alsoMemberOf].map((t) => ({ tenant: { connect: { id: t } }, role: 'admin' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  users.push(u.id)
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never })
  return { id: u.id, token: `Bearer ${s.accessToken}` }
}

const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: token }, ...(payload !== undefined ? { payload: payload as object } : {}) })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SepFin A', slug: `${PREFIX}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SepFin B', slug: `${PREFIX}-b` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'SepFin A brand', slug: `${PREFIX}-ca`, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'SepFin B brand', slug: `${PREFIX}-cb`, type: 'restaurant', tenantId: tenantB } })).id
  locationA = (await prisma.location.create({ data: { name: 'A kitchen', slug: `${PREFIX}-la`, tenantId: tenantA } })).id
  locationB = (await prisma.location.create({ data: { name: 'B kitchen', slug: `${PREFIX}-lb`, tenantId: tenantB } })).id
  const a = await makeAdmin(tenantA); userA = a.id; tokenA = a.token
  const b = await makeAdmin(tenantB); userB = b.id; tokenB = b.token
  const both = await makeAdmin(tenantA, [tenantB]); userBoth = both.id; tokenBoth = both.token
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(allocationRoutes, { prefix: '/allocations' })
  await app.register(projectionsRoutes, { prefix: '/projections' })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.register(opexRoutes, { prefix: '/opex' })
  await app.register(fixedAssetRoutes, { prefix: '/accounting/fixed-assets' })
  await app.register(paymentGatewayRoutes, { prefix: '/payment-gateways' })
  await app.register(contributionRoutes, { prefix: '/positions/contributions' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  const tenants = [tenantA, tenantB]
  await prisma.journalLine.deleteMany({ where: { journalEntry: { tenantId: { in: tenants } } } })
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.costAllocationRun.deleteMany({ where: { rule: { tenantId: { in: tenants } } } })
  await prisma.costAllocationRule.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.projection.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.tenantContribution.deleteMany({ where: { OR: [{ sourceTenantId: { in: tenants } }, { destinationTenantId: { in: tenants } }] } })
  await prisma.opexLine.deleteMany({ where: { category: { tenantId: { in: tenants } } } })
  await prisma.opexCategory.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.bankAccount.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.capexProject.deleteMany({ where: { tenantId: { in: tenants } } })
  await prisma.paymentGatewayConfig.deleteMany({ where: { conceptId: { in: [conceptA, conceptB] } } })
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {})
  await prisma.tenantMember.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.location.deleteMany({ where: { id: { in: [locationA, locationB] } } })
  await prisma.concept.deleteMany({ where: { id: { in: [conceptA, conceptB] } } })
  await prisma.account.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {})
  await prisma.tenant.deleteMany({ where: { id: { in: tenants } } }).catch(() => {})
})

describe('cost allocation rules are per company', () => {
  let ruleA: string

  it('A creates a rule on its own brand, stamped with A', async () => {
    const r = await call(tokenA, 'POST', '/allocations/rules', {
      name: 'A rent', sourceAccountCode: '6010', driver: 'fixed_pct',
      weights: [{ conceptId: conceptA, weightBps: 10_000 }],
    })
    expect(r.statusCode).toBe(201)
    ruleA = r.json().id
    expect((await prisma.costAllocationRule.findUnique({ where: { id: ruleA } }))?.tenantId).toBe(tenantA)
  })

  it('B can have a rule for the same source account without touching A\'s', async () => {
    const r = await call(tokenB, 'POST', '/allocations/rules', {
      name: 'B rent', sourceAccountCode: '6010', driver: 'fixed_pct',
      weights: [{ conceptId: conceptB, weightBps: 10_000 }],
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().id).not.toBe(ruleA)
    const a = await prisma.costAllocationRule.findUnique({ where: { id: ruleA }, include: { weights: true } })
    expect(a?.name).toBe('A rent')
    expect(a?.weights.map((w) => w.conceptId)).toEqual([conceptA])
  })

  it('B cannot weight a rule onto A\'s brand (422)', async () => {
    const r = await call(tokenB, 'POST', '/allocations/rules', {
      name: 'grab', sourceAccountCode: '6020', driver: 'fixed_pct',
      weights: [{ conceptId: conceptA, weightBps: 10_000 }],
    })
    expect(r.statusCode).toBe(422)
    expect(await prisma.costAllocationRule.count({ where: { tenantId: tenantB, sourceAccountCode: '6020' } })).toBe(0)
  })

  it('B does not see A\'s rule in its list', async () => {
    const r = await call(tokenB, 'GET', '/allocations/rules')
    expect(r.statusCode).toBe(200)
    const ids = (r.json() as Array<{ id: string; tenantId: string }>).map((x) => x.id)
    expect(ids).not.toContain(ruleA)
    expect((r.json() as Array<{ tenantId: string }>).every((x) => x.tenantId === tenantB)).toBe(true)
  })

  it('B cannot run or delete A\'s rule (404)', async () => {
    const run = await call(tokenB, 'POST', `/allocations/rules/${ruleA}/run`, { periodStart: '2026-01-01', periodEnd: '2026-01-31' })
    expect(run.statusCode).toBe(404)
    const del = await call(tokenB, 'DELETE', `/allocations/rules/${ruleA}`)
    expect(del.statusCode).toBe(404)
    expect(await prisma.costAllocationRule.count({ where: { id: ruleA } })).toBe(1)
  })

  it('A\'s run posts to A\'s ledger and B cannot see the run', async () => {
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'test.rent', sourceId: `${PREFIX}-rent`,
      description: 'rent', entryDate: new Date('2026-01-15'), postedBy: userA,
      lines: [
        { accountCode: '6010', type: 'debit', amountCents: 100_000 },
        { accountCode: '1020', type: 'credit', amountCents: 100_000 },
      ],
    })
    const r = await call(tokenA, 'POST', `/allocations/rules/${ruleA}/run`, { periodStart: '2026-01-01', periodEnd: '2026-01-31' })
    expect(r.statusCode).toBe(201)
    const runId = r.json().runId as string
    expect((await prisma.costAllocationRun.findUnique({ where: { id: runId } }))?.tenantId).toBe(tenantA)
    const je = await prisma.journalEntry.findFirst({ where: { reference: `allocation.run:${runId}` }, include: { lines: { include: { account: { select: { tenantId: true } } } } } })
    expect(je?.tenantId).toBe(tenantA)
    expect(je?.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)

    const runsB = await call(tokenB, 'GET', '/allocations/runs')
    expect((runsB.json() as Array<{ id: string }>).map((x) => x.id)).not.toContain(runId)
    const runsA = await call(tokenA, 'GET', '/allocations/runs')
    expect((runsA.json() as Array<{ id: string }>).map((x) => x.id)).toContain(runId)
  })

  it('A can delete its own rule', async () => {
    const tmp = await call(tokenA, 'POST', '/allocations/rules', {
      name: 'tmp', sourceAccountCode: '6021', driver: 'fixed_pct',
      weights: [{ conceptId: conceptA, weightBps: 10_000 }],
    })
    expect(tmp.statusCode).toBe(201)
    expect((await call(tokenA, 'DELETE', `/allocations/rules/${tmp.json().id}`)).statusCode).toBe(204)
  })
})

describe('projections are one company per scenario', () => {
  let projA: string

  it('A creates a scenario stamped with A; B\'s brand is refused (422)', async () => {
    const bad = await call(tokenA, 'POST', '/projections', { name: 'mixed', brands: [{ conceptId: conceptA }, { conceptId: conceptB }] })
    expect(bad.statusCode).toBe(422)
    const r = await call(tokenA, 'POST', '/projections', {
      name: 'A plan', brands: [{ conceptId: conceptA, checkAverageCents: 100_000, dailyCoversAtSS: 10 }],
    })
    expect(r.statusCode).toBe(200)
    projA = r.json().id
    expect((await prisma.projection.findUnique({ where: { id: projA } }))?.tenantId).toBe(tenantA)
  })

  it('B cannot list, compute, edit, add a brand to, or delete A\'s scenario', async () => {
    const list = await call(tokenB, 'GET', '/projections')
    expect((list.json() as Array<{ id: string }>).map((x) => x.id)).not.toContain(projA)
    expect((await call(tokenB, 'GET', `/projections/${projA}/computed`)).statusCode).toBe(404)
    expect((await call(tokenB, 'PATCH', `/projections/${projA}`, { name: 'pwned' })).statusCode).toBe(404)
    expect((await call(tokenB, 'PUT', `/projections/${projA}/brands/${conceptB}`, { launchMonth: 2 })).statusCode).toBe(404)
    expect((await call(tokenB, 'DELETE', `/projections/${projA}/brands/${conceptA}`)).statusCode).toBe(404)
    expect((await call(tokenB, 'DELETE', `/projections/${projA}`)).statusCode).toBe(404)
    const still = await prisma.projection.findUnique({ where: { id: projA }, include: { brands: true } })
    expect(still?.name).toBe('A plan')
    expect(still?.brands).toHaveLength(1)
  })

  it('even a member of both companies cannot add B\'s brand to A\'s scenario (422)', async () => {
    const r = await call(tokenBoth, 'PUT', `/projections/${projA}/brands/${conceptB}`, { launchMonth: 2 })
    expect(r.statusCode).toBe(422)
  })

  it('computed output only uses A\'s actuals', async () => {
    // A stray position filed under company B against A's brand must not
    // land in A's projection.
    await prisma.position.create({ data: { tenantId: tenantB, conceptId: conceptA, title: 'stray', monthlySalaryCents: 9_999_00, tenantCostShareCents: 9_999_00, status: 'filled' } })
    await prisma.position.create({ data: { tenantId: tenantA, conceptId: conceptA, title: 'chef', monthlySalaryCents: 50_000_00, tenantCostShareCents: 50_000_00, status: 'filled' } })
    await prisma.position.create({ data: { tenantId: tenantA, conceptId: conceptA, title: 'frozen', monthlySalaryCents: 70_000_00, tenantCostShareCents: 70_000_00, status: 'frozen' } })
    const r = await call(tokenA, 'GET', `/projections/${projA}/computed`)
    expect(r.statusCode).toBe(200)
    const brands = r.json().brands as Array<{ conceptId: string; staffMonthlyCents: number }>
    expect(brands.map((b) => b.conceptId)).toEqual([conceptA])
    expect(brands[0]!.staffMonthlyCents).toBe(50_000_00)
    await prisma.position.deleteMany({ where: { conceptId: conceptA } })
  })
})

describe('finance planning references stay inside the company', () => {
  it('capex: another company\'s location or owner is refused (422); own is fine', async () => {
    expect((await call(tokenA, 'POST', '/finance/capex', { name: 'x', locationId: locationB })).statusCode).toBe(422)
    expect((await call(tokenA, 'POST', '/finance/capex', { name: 'x', ownerId: userB })).statusCode).toBe(422)
    expect((await call(tokenA, 'POST', '/finance/capex', { name: 'x', conceptId: conceptB })).statusCode).toBe(422)
    const ok = await call(tokenA, 'POST', '/finance/capex', { name: 'A fitout', conceptId: conceptA, locationId: locationA, ownerId: userA })
    expect(ok.statusCode).toBe(201)
    const id = ok.json().id as string
    expect((await call(tokenA, 'PATCH', `/finance/capex/${id}`, { locationId: locationB })).statusCode).toBe(422)
    const line = await call(tokenA, 'POST', `/finance/capex/${id}/lines`, { scope: 'k', item: 'oven', unitCostCents: 100, assignedToId: userB })
    expect(line.statusCode).toBe(422)
  })

  it('opex: a partial PATCH cannot re-bind a line to B\'s bank account or brand', async () => {
    const cat = await prisma.opexCategory.create({ data: { name: 'Rent', tenantId: tenantA } })
    const bankB = await prisma.bankAccount.create({ data: { name: 'B bank', tenantId: tenantB } as never })
    const bankA = await prisma.bankAccount.create({ data: { name: 'A bank', tenantId: tenantA } as never })
    expect((await call(tokenA, 'POST', '/opex/lines', { categoryId: cat.id, name: 'rent', amountCents: 100, bankAccountId: bankB.id })).statusCode).toBe(422)
    const line = await call(tokenA, 'POST', '/opex/lines', { categoryId: cat.id, name: 'rent', amountCents: 100, bankAccountId: bankA.id })
    expect(line.statusCode).toBe(201)
    const id = line.json().id as string
    expect((await call(tokenA, 'PATCH', `/opex/lines/${id}`, { bankAccountId: bankB.id })).statusCode).toBe(422)
    expect((await call(tokenA, 'PATCH', `/opex/lines/${id}`, { conceptId: conceptB })).statusCode).toBe(422)
    expect((await call(tokenB, 'PATCH', `/opex/lines/${id}`, { amountCents: 1 })).statusCode).toBe(404)
    const after = await prisma.opexLine.findUnique({ where: { id } })
    expect(after?.bankAccountId).toBe(bankA.id)
    expect(after?.conceptId).toBeNull()
  })

  it('fixed assets: no hand-added asset (422 USE_CAPEX); another company\'s location on the capitalise body is refused (422)', async () => {
    const r = await call(tokenA, 'POST', '/accounting/fixed-assets', {
      name: 'oven', category: 'kitchen_equipment', funding: 'cash', acquiredAt: '2026-01-10',
      costCents: 100_000, usefulLifeMonths: 60, locationId: locationB,
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('USE_CAPEX')
    const project = await prisma.capexProject.create({ data: { tenantId: tenantA, name: 'A kitchen', locationId: locationA } })
    const line = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'Equipment', item: 'Combi oven', unitCostCents: 100_000, status: 'delivered', actualDeliveryDate: new Date() } })
    const cap = await call(tokenA, 'POST', `/finance/capex/lines/${line.id}/capitalise`, { classKey: 'kitchen_equipment', locationId: locationB })
    expect(cap.statusCode).toBe(422)
    expect(cap.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect((await call(tokenB, 'POST', `/finance/capex/lines/${line.id}/capitalise`, { classKey: 'kitchen_equipment' })).statusCode).toBe(404)
    expect(await prisma.fixedAsset.count({ where: { tenantId: tenantA } })).toBe(0)
    expect(await prisma.fixedAssetEvent.count({ where: { tenantId: tenantA } })).toBe(0)
  })
})

describe('payment gateways are scoped through the brand', () => {
  it('A cannot write or read B\'s brand override (404); can write its own', async () => {
    expect((await call(tokenA, 'PATCH', `/payment-gateways/keenu?conceptId=${conceptB}`, { isEnabled: true })).statusCode).toBe(404)
    expect((await call(tokenA, 'GET', `/payment-gateways?conceptId=${conceptB}`)).statusCode).toBe(404)
    const ok = await call(tokenA, 'PATCH', `/payment-gateways/keenu?conceptId=${conceptA}`, { isEnabled: true, merchantId: 'A-123' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().conceptId).toBe(conceptA)
    const mine = await call(tokenA, 'GET', `/payment-gateways?conceptId=${conceptA}`)
    const keenu = (mine.json() as Array<{ provider: string; config: { merchantId: string } | null }>).find((g) => g.provider === 'keenu')
    expect(keenu?.config?.merchantId).toBe('A-123')
  })

  it('an unknown provider is a 404, not a 200 with an error body', async () => {
    expect((await call(tokenA, 'PATCH', '/payment-gateways/paypal', { isEnabled: true })).statusCode).toBe(404)
  })
})

describe('contributions need both sides to be the operator\'s companies', () => {
  it('a member of A only cannot book a transfer out of B (403)', async () => {
    const r = await call(tokenA, 'POST', '/positions/contributions', {
      sourceTenantId: tenantB, destinationTenantId: tenantA, monthlyCents: 500_000, label: 'grab',
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
  })

  it('a member of both can, and a one-sided member cannot edit or end it', async () => {
    const r = await call(tokenBoth, 'POST', '/positions/contributions', {
      sourceTenantId: tenantB, destinationTenantId: tenantA, monthlyCents: 500_000, label: 'HO contribution',
    })
    expect(r.statusCode).toBe(201)
    const id = r.json().id as string
    expect((await call(tokenA, 'PATCH', `/positions/contributions/${id}`, { monthlyCents: 1 })).statusCode).toBe(403)
    expect((await call(tokenA, 'DELETE', `/positions/contributions/${id}`)).statusCode).toBe(403)
    expect((await call(tokenA, 'PATCH', '/positions/contributions/00000000-0000-4000-8000-000000000000', { monthlyCents: 1 })).statusCode).toBe(404)
    const row = await prisma.tenantContribution.findUnique({ where: { id } })
    expect(row?.monthlyCents).toBe(500_000)
    expect(row?.isActive).toBe(true)
  })
})
