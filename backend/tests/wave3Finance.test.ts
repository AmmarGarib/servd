// Wave 3 — role ↔ route alignment, stream B (UI-07, UI-09 part).
//
// The admin sidebar shows a role the modules it holds by default
// (lib/moduleAccess.ts); the routes behind those pages must let that role in,
// and only into its own company's rows.
//
//   UI-07: finance (owner of the Finance workspace) got 403 on gift cards,
//          capex, opex, petty cash, deposit drops, positions (the budgeted
//          payroll on OpEx / CapEx) and the AP reads. It now reads them and does
//          the workspace's normal work: capex / opex entries, opening and
//          counting petty-cash boxes, recording deposit drops, acknowledging
//          exceptions, ignoring statement lines. Approvals and the CEO's
//          postings stay where they were.
//   UI-09: HR reads positions (and edits them — the page is in HR's
//          workspace), reads the staff-meal log and works tip pools.
//
// Every widened route is checked with two companies: company B's finance / HR
// gets 404 or nothing on company A's rows, and creates bind to the active
// company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { DEFAULT_MODULE_ACCESS } from '../src/lib/moduleAccess.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { projectionsRoutes } from '../src/modules/projections/routes.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { setupRoutes } from '../src/modules/setup/routes.js'
import { opexRoutes } from '../src/modules/opex/routes.js'
import { positionRoutes } from '../src/modules/positions/routes.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

const stamp = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: { moduleAllow?: string[]; moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${stamp}@w3fin.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, ...extra,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
  ids[key] = u.id
  return u.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: tokens[who]! }, ...(payload !== undefined && { payload: payload as never }) })
const get = (who: string, url: string) => call(who, 'GET', url)
const idsOf = (body: unknown): string[] => (body as Array<{ id: string }>).map((r) => r.id)

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (w3)', slug: `gs-w3-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (w3)', slug: `kb-w3-${stamp}` } })).id

  await mkUser('finA', 'finance', tenantA)
  await mkUser('finB', 'finance', tenantB)
  await mkUser('hrA', 'hr', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  await mkUser('cashA', 'cashier', tenantA)
  await mkUser('cashB', 'cashier', tenantB)
  await mkUser('adminA', 'admin', tenantA)
  // Finance granted 'procurement' per person (Module Access), standing in for
  // the module gate admitting 'accounting' on the AP read paths.
  await mkUser('finAp', 'finance', tenantA, { moduleAllow: ['procurement'] })
  await mkUser('finBp', 'finance', tenantB, { moduleAllow: ['procurement'] })
  // Module Access really closes what wave 3 opened (W3B-RV-1): finance with
  // capital + accounting unticked, HR with staff_directory unticked, and a
  // manager tier that never held 'capital' (unchanged: MANAGERS passed before).
  await mkUser('finNoMods', 'finance', tenantA, { moduleDeny: ['capital', 'accounting'] })
  await mkUser('hrNoDir', 'hr', tenantA, { moduleDeny: ['staff_directory'] })
  await mkUser('fnbA', 'fnb_manager', tenantA)

  const cA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-w3-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  const cB = (await prisma.concept.create({ data: { name: 'Bun Kebab', slug: `bk-w3-${stamp}`, type: 'restaurant', tenantId: tenantB } })).id
  ids.cA = cA; ids.cB = cB

  // Gift cards + a redemption on A's card.
  ids.gA = (await prisma.giftCard.create({ data: { tenantId: tenantA, conceptId: cA, code: `W3A-${stamp}`, issuedAmountCents: 50_000, balanceCents: 30_000 } })).id
  ids.gB = (await prisma.giftCard.create({ data: { tenantId: tenantB, conceptId: cB, code: `W3B-${stamp}`, issuedAmountCents: 50_000, balanceCents: 50_000 } })).id
  await prisma.giftCardRedemption.create({ data: { giftCardId: ids.gA, amountCents: 20_000, balanceAfter: 30_000 } })

  // Capital + OpEx.
  ids.pA = (await prisma.capexProject.create({ data: { tenantId: tenantA, name: 'Clifton fit-out' } })).id
  ids.pB = (await prisma.capexProject.create({ data: { tenantId: tenantB, name: 'Saddar fit-out' } })).id
  ids.ocA = (await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Utilities' } })).id
  ids.ocB = (await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Utilities' } })).id

  // Cash: petty-cash boxes, deposit drops, bank accounts, statements.
  ids.boxA = (await prisma.pettyCashBox.create({ data: { tenantId: tenantA, name: 'FOH box', custodianId: ids.cashA!, floatCents: 100_000 } })).id
  ids.boxB = (await prisma.pettyCashBox.create({ data: { tenantId: tenantB, name: 'FOH box', custodianId: ids.cashB!, floatCents: 100_000 } })).id
  ids.dropA = (await prisma.depositDrop.create({ data: { tenantId: tenantA, amountCents: 10_000, expectedCents: 10_000, varianceCents: 0, droppedById: ids.cashA! } })).id
  ids.dropB = (await prisma.depositDrop.create({ data: { tenantId: tenantB, amountCents: 10_000, expectedCents: 10_000, varianceCents: 0, droppedById: ids.cashB! } })).id
  ids.bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops' } })).id
  ids.bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'MCB Ops' } })).id
  ids.impA = (await prisma.bankStatementImport.create({ data: { tenantId: tenantA, source: 'bank:hbl', accountCode: '1020', statementDate: new Date() } })).id
  ids.impB = (await prisma.bankStatementImport.create({ data: { tenantId: tenantB, source: 'bank:mcb', accountCode: '1020', statementDate: new Date() } })).id
  ids.lineA = (await prisma.bankStatementLine.create({ data: { importId: ids.impA, postedDate: new Date(), description: 'Unknown credit', amountCents: 5_000 } })).id
  ids.lineB = (await prisma.bankStatementLine.create({ data: { importId: ids.impB, postedDate: new Date(), description: 'Unknown credit', amountCents: 5_000 } })).id
  ids.shiftA = (await prisma.shift.create({ data: { tenantId: tenantA, userId: ids.cashA!, openingFloatCents: 5_000 } })).id
  ids.shiftB = (await prisma.shift.create({ data: { tenantId: tenantB, userId: ids.cashB!, openingFloatCents: 5_000 } })).id

  // Exceptions.
  ids.flagA = (await prisma.exceptionFlag.create({ data: { tenantId: tenantA, kind: 'cash_variance', severity: 'high', title: 'Drawer short', description: 'A' } })).id
  ids.flagB = (await prisma.exceptionFlag.create({ data: { tenantId: tenantB, kind: 'cash_variance', severity: 'high', title: 'Drawer short', description: 'B' } })).id

  // People: seats, a designation, staff meals, tip pools.
  ids.posA = (await prisma.position.create({ data: { tenantId: tenantA, conceptId: cA, title: 'Barista', monthlySalaryCents: 60_000_00, tenantCostShareCents: 60_000_00, status: 'filled' } })).id
  ids.bandA = (await prisma.shiftBand.create({ data: { tenantId: tenantA, name: `A-day-${stamp}`, startTime: '10:00', endTime: '18:00' } })).id
  ids.bandArchA = (await prisma.shiftBand.create({ data: { tenantId: tenantA, name: `A-old-${stamp}`, startTime: '06:00', endTime: '14:00', archivedAt: new Date() } })).id
  ids.bandB = (await prisma.shiftBand.create({ data: { tenantId: tenantB, name: `B-secret-night-${stamp}`, startTime: '22:00', endTime: '06:00' } })).id
  ids.posB = (await prisma.position.create({ data: { tenantId: tenantB, conceptId: cB, title: 'Cook', monthlySalaryCents: 50_000_00, tenantCostShareCents: 50_000_00, status: 'open' } })).id
  await prisma.hrOrgUnit.create({ data: { tenantId: tenantA, kind: 'designation', name: 'Barista' } })
  ids.mealA = (await prisma.staffMeal.create({ data: { conceptId: cA, staffId: ids.cashA!, approvedById: ids.adminA!, description: 'Club sandwich', estimatedCostCents: 40_000 } })).id
  ids.mealB = (await prisma.staffMeal.create({ data: { conceptId: cB, staffId: ids.cashB!, approvedById: ids.cashB!, description: 'Bun kebab', estimatedCostCents: 20_000 } })).id
  const now = new Date()
  ids.tpA = (await prisma.tipPool.create({ data: { tenantId: tenantA, conceptId: cA, name: 'Week A', periodStart: new Date(now.getTime() - 7 * 86_400_000), periodEnd: now } })).id
  ids.tpB = (await prisma.tipPool.create({ data: { tenantId: tenantB, conceptId: cB, name: 'Week B', periodStart: new Date(now.getTime() - 7 * 86_400_000), periodEnd: now } })).id

  // Payables.
  ids.supA = (await prisma.supplier.create({ data: { name: 'Mill Co', tenantId: tenantA, paymentTermsDays: 10 } })).id
  ids.supB = (await prisma.supplier.create({ data: { name: 'Dairy Co', tenantId: tenantB, paymentTermsDays: 10 } })).id
  ids.billA = (await prisma.supplierBill.create({ data: { supplierId: ids.supA, billNumber: `A-${stamp}`, billDate: now, dueDate: now, totalCents: 10_000, subtotalCents: 10_000 } })).id
  ids.billB = (await prisma.supplierBill.create({ data: { supplierId: ids.supB, billNumber: `B-${stamp}`, billDate: now, dueDate: now, totalCents: 10_000, subtotalCents: 10_000 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(reconciliationRoutes, { prefix: '/reconciliation' })
    await api.register(crosschecksRoutes, { prefix: '/crosschecks' })
    await api.register(giftCardRoutes, { prefix: '/gift-cards' })
    await api.register(financePlanningRoutes, { prefix: '/finance' })
    await api.register(projectionsRoutes, { prefix: '/projections' })
    await api.register(tipPoolRoutes, { prefix: '/tip-pools' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(setupRoutes, { prefix: '/setup' })
    await api.register(opexRoutes, { prefix: '/opex' })
    await api.register(positionRoutes, { prefix: '/positions' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('UI-07 finance reads every Finance-workspace page it is given — its own company only', () => {
  it('the defaults are what the sidebar shows', () => {
    for (const m of ['gift_cards', 'reconciliation', 'exceptions', 'capital', 'projections', 'payroll', 'accounting']) {
      expect(DEFAULT_MODULE_ACCESS.finance).toContain(m)
    }
  })

  it('every page read answers 200 (no red 403 toasts)', async () => {
    const reads = [
      '/reconciliation/summary', '/reconciliation/bank/imports', `/reconciliation/bank/imports/${ids.impA}/lines`,
      '/crosschecks/exceptions?status=open', '/crosschecks/exceptions/stats',
      '/gift-cards', `/gift-cards/${ids.gA}/redemptions`,
      '/finance/capex', `/finance/capex/${ids.pA}`, '/finance/capital-ledger',
      '/projections', '/tip-pools', `/tip-pools/${ids.tpA}`,
      '/trustops/petty-cash/boxes', '/trustops/deposit-drops', '/setup/bank-accounts',
      '/opex/categories', '/opex/cashflow', '/opex/payroll-snapshot', '/opex/actuals',
      '/positions', '/positions/summary', '/positions/departments', '/positions/shift-bands', '/positions/contributions',
    ]
    const bad: string[] = []
    for (const p of reads) {
      const r = await get('finA', p)
      if (r.statusCode !== 200) bad.push(`${p} → ${r.statusCode} ${r.body.slice(0, 120)}`)
    }
    expect(bad).toEqual([])
  })

  it('lists hold company A\'s rows for A\'s finance and never company B\'s', async () => {
    const pairs: Array<[string, string, string]> = [
      ['/gift-cards', 'gA', 'gB'],
      ['/finance/capex', 'pA', 'pB'],
      ['/opex/categories', 'ocA', 'ocB'],
      ['/trustops/petty-cash/boxes', 'boxA', 'boxB'],
      ['/trustops/deposit-drops', 'dropA', 'dropB'],
      ['/setup/bank-accounts', 'bankA', 'bankB'],
      ['/crosschecks/exceptions?status=open', 'flagA', 'flagB'],
      ['/reconciliation/bank/imports', 'impA', 'impB'],
      ['/tip-pools', 'tpA', 'tpB'],
      ['/positions', 'posA', 'posB'],
    ]
    for (const [url, mine, theirs] of pairs) {
      const a = idsOf((await get('finA', url)).json())
      const b = idsOf((await get('finB', url)).json())
      expect(a, `${url} A`).toContain(ids[mine])
      expect(a, `${url} A`).not.toContain(ids[theirs])
      expect(b, `${url} B`).toContain(ids[theirs])
      expect(b, `${url} B`).not.toContain(ids[mine])
    }
    const shifts = (await get('finA', '/reconciliation/summary')).json() as { shifts: Array<{ shiftId: string }> }
    expect(shifts.shifts.map((s) => s.shiftId)).toContain(ids.shiftA)
    expect(shifts.shifts.map((s) => s.shiftId)).not.toContain(ids.shiftB)
  })

  it('company B\'s finance gets 404 on company A\'s rows', async () => {
    for (const p of [`/gift-cards/${ids.gA}/redemptions`, `/finance/capex/${ids.pA}`, `/reconciliation/bank/imports/${ids.impA}/lines`, `/tip-pools/${ids.tpA}`]) {
      expect((await get('finB', p)).statusCode, p).toBe(404)
    }
  })

  it('a gift card\'s own history reads without the accounting audit log', async () => {
    const r = (await get('finA', `/gift-cards/${ids.gA}/redemptions`)).json() as { card: { balanceCents: number }; redemptions: Array<{ amountCents: number }> }
    expect(r.card.balanceCents).toBe(30_000)
    expect(r.redemptions.map((x) => x.amountCents)).toEqual([20_000])
  })

  it('the petty-cash box carries its custodian\'s name (finance cannot list logins)', async () => {
    const boxes = (await get('finA', '/trustops/petty-cash/boxes')).json() as Array<{ id: string; custodianName: string | null }>
    expect(boxes.find((b) => b.id === ids.boxA)?.custodianName).toBe('cashA person')
  })

  it('a role without the modules is still refused (no over-opening)', async () => {
    for (const p of ['/opex/categories', '/trustops/petty-cash/boxes', '/trustops/deposit-drops', '/finance/capex', '/positions']) {
      expect((await get('cashA', p)).statusCode, p).toBe(403)
    }
    // HR holds neither gift_cards nor capital / accounting pages.
    expect((await get('hrA', '/gift-cards')).statusCode).toBe(403)
    expect((await get('hrA', '/trustops/petty-cash/boxes')).statusCode).toBe(403)
    expect((await get('hrA', '/opex/categories')).statusCode).toBe(403)
  })
})

describe('UI-07 finance does the workspace\'s normal work, bound to its active company', () => {
  it('CapEx: a project lands in the active company; another company\'s is 404', async () => {
    const r = await call('finA', 'POST', '/finance/capex', { name: 'DHA kiosk' })
    expect(r.statusCode).toBe(201)
    expect((await prisma.capexProject.findUniqueOrThrow({ where: { id: r.json().id } })).tenantId).toBe(tenantA)
    const line = await call('finA', 'POST', `/finance/capex/${ids.pA}/lines`, { scope: 'kitchen', item: 'Combi oven', unitCostCents: 1_000_000 })
    expect(line.statusCode).toBe(201)
    ids.capexLineA = line.json().id
    expect((await call('finB', 'PATCH', `/finance/capex/${ids.pA}`, { name: 'Hijack' })).statusCode).toBe(404)
    expect((await call('finB', 'POST', `/finance/capex/${ids.pA}/lines`, { scope: 'k', item: 'x', unitCostCents: 1 })).statusCode).toBe(404)
  })

  it('OpEx: a category lands in the active company; B\'s category cannot be used or edited', async () => {
    const r = await call('finA', 'POST', '/opex/categories', { name: 'Rent' })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await call('finA', 'POST', '/opex/lines', { categoryId: ids.ocB, name: 'K-Electric', amountCents: 10_000 })).statusCode).toBe(422)
    expect((await call('finA', 'PATCH', `/opex/categories/${ids.ocB}`, { name: 'Mine now' })).statusCode).toBe(404)
    const line = await call('finA', 'POST', '/opex/lines', { categoryId: ids.ocA, name: 'K-Electric', amountCents: 10_000 })
    expect(line.statusCode).toBe(201)
  })

  it('petty cash: open a box in the active company, count it; B\'s box is 404', async () => {
    const r = await call('finA', 'POST', '/trustops/petty-cash/boxes', { name: 'Office box', custodianId: ids.finA })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await call('finA', 'POST', '/trustops/petty-cash/boxes', { name: 'Stolen', custodianId: ids.finB })).statusCode).toBe(422)
    const count = await call('finA', 'POST', `/trustops/petty-cash/boxes/${ids.boxA}/reconcile`, { countedCents: 100_000 })
    expect(count.statusCode).toBe(200)
    expect((await call('finB', 'POST', `/trustops/petty-cash/boxes/${ids.boxA}/reconcile`, { countedCents: 0 })).statusCode).toBe(404)
  })

  it('deposit drops: recorded against the active company; B\'s bank account is refused', async () => {
    const r = await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 25_000, receiptUrl: 'https://example.com/slip.jpg' })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 1_000, bankAccountId: ids.bankB })).statusCode).toBe(422)
    expect((await call('finA', 'POST', '/trustops/deposit-drops', { amountCents: 1_000, shiftId: ids.shiftB })).statusCode).toBe(422)
  })

  it('exceptions and statement lines: work A\'s, 404 on B\'s', async () => {
    expect((await call('finA', 'PATCH', `/crosschecks/exceptions/${ids.flagA}/acknowledge`, {})).statusCode).toBe(204)
    expect((await call('finA', 'PATCH', `/crosschecks/exceptions/${ids.flagB}/acknowledge`, {})).statusCode).toBe(404)
    expect((await call('finA', 'POST', `/reconciliation/bank/lines/${ids.lineA}/ignore`, {})).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/reconciliation/bank/lines/${ids.lineB}/ignore`, {})).statusCode).toBe(404)
  })

  it('approvals, CEO postings and governance stay where they were', async () => {
    const refused: Array<[string, 'POST' | 'DELETE', string, unknown]> = [
      ['adjust a statement line (journal)', 'POST', `/reconciliation/bank/lines/${ids.lineA}/adjust`, { memo: 'x', contraAccountCode: '6080' }],
      ['capitalise a capex line', 'POST', `/finance/capex/lines/${ids.capexLineA}/capitalise`, { category: 'kitchen_equipment', usefulLifeMonths: 60 }],
      ['post old capex instalments', 'POST', `/finance/capex/${ids.pA}/post-payments`, {}],
      ['post old opex payments', 'POST', '/opex/payments/post-unposted', {}],
      ['void a customer\'s gift card', 'POST', `/gift-cards/${ids.gA}/void`, { reason: 'test' }],
      ['post a tip pool', 'POST', `/tip-pools/${ids.tpA}/post`, {}],
      ['dismiss an exception', 'DELETE', `/crosschecks/exceptions/${ids.flagA}`, undefined],
      ['set headcount', 'POST', '/positions', { title: 'Barista', monthlySalaryCents: 1 }],
      ['move money between companies', 'POST', '/positions/contributions', { sourceTenantId: tenantA, destinationTenantId: tenantB, monthlyCents: 1, label: 'x' }],
      ['backfill unposted shifts', 'POST', '/reconciliation/backfill-unposted', {}],
    ]
    for (const [what, method, url, body] of refused) {
      expect((await call('finA', method, url, body)).statusCode, what).toBe(403)
    }
  })
})

describe('UI-07 finance reads the payables (AP) — and only reads them', () => {
  it('bills, payments, POs, supplier statements: 200, own company only', async () => {
    for (const p of ['/procurement/bills', '/procurement/payments', '/procurement/purchase-orders', `/procurement/bills/${ids.billA}`, `/procurement/bills/${ids.billA}/match`, `/procurement/suppliers/${ids.supA}/statement`]) {
      expect((await get('finAp', p)).statusCode, p).toBe(200)
    }
    expect(idsOf((await get('finAp', '/procurement/bills')).json())).toContain(ids.billA)
    expect(idsOf((await get('finAp', '/procurement/bills')).json())).not.toContain(ids.billB)
    expect(idsOf((await get('finBp', '/procurement/bills')).json())).not.toContain(ids.billA)
    expect((await get('finBp', `/procurement/bills/${ids.billA}`)).statusCode).toBe(404)
    expect((await get('finBp', `/procurement/suppliers/${ids.supA}/statement`)).statusCode).toBe(404)
  })

  it('finance sees every supplier of its company (not only ones assigned to it)', async () => {
    const list = idsOf((await get('finAp', '/procurement/suppliers')).json())
    expect(list).toContain(ids.supA)
    expect(list).not.toContain(ids.supB)
  })

  it('finance raises, approves, bills and pays nothing here', async () => {
    const refused: Array<[string, unknown]> = [
      ['/procurement/bills', { supplierId: ids.supA, billNumber: 'X1', billDate: '2026-10-01', lines: [{ description: 'Flour', quantity: 1, unitCostCents: 100 }] }],
      ['/procurement/payments', { supplierId: ids.supA, paymentDate: '2026-10-01', method: 'cash', amountCents: 100 }],
      ['/procurement/purchase-orders', { supplierId: ids.supA, lines: [{ inventoryItemId: ids.supA, quantityOrdered: 1, unitCostCents: 1 }] }],
      [`/procurement/bills/${ids.billA}/void`, { reason: 'x' }],
    ]
    for (const [url, body] of refused) expect((await call('finAp', 'POST', url, body)).statusCode, url).toBe(403)
  })
})

describe('UI-09 HR reads and edits positions, reads staff meals, works tip pools', () => {
  it('HR reads positions, the staff-meal log and tip pools: 200, own company only', async () => {
    for (const p of ['/positions', '/positions/summary', '/positions/departments', '/positions/shift-bands', '/positions/contributions', '/trustops/staff-meals?days=30', '/tip-pools']) {
      expect((await get('hrA', p)).statusCode, p).toBe(200)
    }
    const meals = (await get('hrA', '/trustops/staff-meals?days=30')).json() as Array<{ id: string; staffName: string | null }>
    expect(meals.map((m) => m.id)).toContain(ids.mealA)
    expect(meals.map((m) => m.id)).not.toContain(ids.mealB)
    expect(meals.find((m) => m.id === ids.mealA)?.staffName).toBe('cashA person')
    expect(idsOf((await get('hrB', '/trustops/staff-meals?days=30')).json())).not.toContain(ids.mealA)
    expect(idsOf((await get('hrB', '/positions')).json())).not.toContain(ids.posA)
    expect(idsOf((await get('hrB', '/tip-pools')).json())).not.toContain(ids.tpA)
    // Finance reads the budget, not the staff-meal log (no staff_directory).
    expect((await get('finA', '/trustops/staff-meals?days=30')).statusCode).toBe(403)
  })

  it('HR adds and edits seats in the active company; B\'s HR gets 404 on A\'s seat', async () => {
    const r = await call('hrA', 'POST', '/positions', { title: 'Barista', monthlySalaryCents: 55_000_00 })
    expect(r.statusCode).toBe(200)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await call('hrA', 'PATCH', `/positions/${ids.posA}`, { headcount: 2 })).statusCode).toBe(200)
    expect((await call('hrB', 'PATCH', `/positions/${ids.posA}`, { headcount: 9 })).statusCode).toBe(404)
    expect((await call('hrB', 'DELETE', `/positions/${ids.posA}`)).statusCode).toBe(404)
    expect((await prisma.position.findUniqueOrThrow({ where: { id: ids.posA } })).status).toBe('filled')
    const band = await call('hrA', 'POST', '/positions/shift-bands', { name: 'Morning', startTime: '08:00', endTime: '16:00' })
    expect(band.statusCode).toBe(200)
    expect(band.json().tenantId).toBe(tenantA)
    expect((await call('hrB', 'PATCH', `/positions/shift-bands/${band.json().id}`, { name: 'Mine' })).statusCode).toBe(404)
    // Finance reads seats but does not set them.
    expect((await call('finA', 'PATCH', `/positions/${ids.posA}`, { headcount: 3 })).statusCode).toBe(403)
  })

  it('HR drafts tip pools but does not post them (approvers only)', async () => {
    expect((await get('hrA', `/tip-pools/${ids.tpA}`)).statusCode).toBe(200)
    expect((await get('hrB', `/tip-pools/${ids.tpA}`)).statusCode).toBe(404)
    expect((await call('hrA', 'POST', `/tip-pools/${ids.tpA}/post`, {})).statusCode).toBe(403)
    expect((await call('hrA', 'POST', '/positions/contributions', { sourceTenantId: tenantA, destinationTenantId: tenantB, monthlyCents: 1, label: 'x' })).statusCode).toBe(403)
  })
})

describe('W3B-RV-1 Module Access closes what wave 3 opened to finance and HR', () => {
  it('finance with capital + accounting unticked: 403 on OpEx, petty cash, deposit drops and the seats', async () => {
    const refused: Array<['GET' | 'POST', string, unknown]> = [
      ['GET', '/opex/categories', undefined],
      ['POST', '/opex/categories', { name: 'Sneaky' }],
      ['POST', '/opex/payments', { lineId: 'x', periodStart: '2026-10-01', amountCents: 1 }],
      ['GET', '/opex/cashflow', undefined],
      ['GET', '/trustops/petty-cash/boxes', undefined],
      ['POST', '/trustops/petty-cash/boxes', { name: 'x', custodianId: ids.finA }],
      ['POST', `/trustops/petty-cash/boxes/${ids.boxA}/reconcile`, { countedCents: 0 }],
      ['GET', '/trustops/deposit-drops', undefined],
      ['POST', '/trustops/deposit-drops', { amountCents: 1_000 }],
      ['GET', '/positions', undefined],
      ['GET', '/positions/summary', undefined],
      ['GET', '/positions/contributions', undefined],
    ]
    for (const [method, url, body] of refused) {
      expect((await call('finNoMods', method, url, body)).statusCode, `${method} ${url}`).toBe(403)
    }
    // Nothing was written by the refused POSTs.
    expect(await prisma.opexCategory.count({ where: { name: 'Sneaky' } })).toBe(0)
  })

  it('HR with staff_directory unticked: 403 on the seats, shift bands and the staff-meal log', async () => {
    const refused: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown]> = [
      ['GET', '/positions', undefined],
      ['POST', '/positions', { title: 'Barista', monthlySalaryCents: 1 }],
      ['PATCH', `/positions/${ids.posA}`, { headcount: 7 }],
      ['DELETE', `/positions/${ids.posA}`, undefined],
      ['POST', '/positions/shift-bands', { name: 'Sneaky', startTime: '01:00', endTime: '02:00' }],
      ['GET', '/trustops/staff-meals?days=30', undefined],
    ]
    for (const [method, url, body] of refused) {
      expect((await call('hrNoDir', method, url, body)).statusCode, `${method} ${url}`).toBe(403)
    }
    expect((await prisma.position.findUniqueOrThrow({ where: { id: ids.posA } })).headcount).not.toBe(7)
  })

  it('the manager tiers pass exactly as before (fnb_manager holds no capital)', async () => {
    for (const p of ['/opex/categories', '/trustops/deposit-drops', '/positions']) {
      expect((await get('fnbA', p)).statusCode, p).toBe(200)
    }
  })
})

describe('W3B-RV-2 finance reads the gift-card register without the bearer codes', () => {
  it('finance sees masked codes and no buyer / recipient email; a manager sees the full card', async () => {
    await prisma.giftCard.update({ where: { id: ids.gA }, data: { buyerEmail: 'buyer@example.com', recipientEmail: 'friend@example.com', message: 'Happy birthday' } })
    const full = `W3A-${stamp}`
    const fin = (await get('finA', '/gift-cards')).json() as Array<{ id: string; code: string; buyerEmail: string | null; recipientEmail: string | null; message: string | null }>
    const card = fin.find((c) => c.id === ids.gA)!
    expect(card.code).toBe(`••••${full.slice(-4)}`)
    expect(card.buyerEmail).toBeNull()
    expect(card.recipientEmail).toBeNull()
    expect(card.message).toBeNull()
    expect(JSON.stringify(fin)).not.toContain(full)
    const hist = (await get('finA', `/gift-cards/${ids.gA}/redemptions`)).json() as { card: { code: string } }
    expect(hist.card.code).toBe(`••••${full.slice(-4)}`)
    const admin = (await get('adminA', '/gift-cards')).json() as Array<{ id: string; code: string; buyerEmail: string | null }>
    expect(admin.find((c) => c.id === ids.gA)?.code).toBe(full)
    expect(admin.find((c) => c.id === ids.gA)?.buyerEmail).toBe('buyer@example.com')
  })
})

describe('W3B-RV-3 a seat cannot take another company\'s shift band', () => {
  it('HR A: B\'s band on create or edit is 422; A\'s own band is fine; a new archived band is refused', async () => {
    const created = await call('hrA', 'POST', '/positions', { title: 'Barista', monthlySalaryCents: 1_000, shiftBandId: ids.bandB })
    expect(created.statusCode).toBe(422)
    expect(created.json().error.code).toBe('SHIFT_BAND_NOT_IN_COMPANY')
    const patched = await call('hrA', 'PATCH', `/positions/${ids.posA}`, { shiftBandId: ids.bandB })
    expect(patched.statusCode).toBe(422)
    expect((await prisma.position.findUniqueOrThrow({ where: { id: ids.posA } })).shiftBandId).not.toBe(ids.bandB)
    expect((await call('hrA', 'PATCH', `/positions/${ids.posA}`, { shiftBandId: ids.bandArchA })).statusCode).toBe(422)

    const own = await call('hrA', 'POST', '/positions', { title: 'Barista', monthlySalaryCents: 1_000, shiftBandId: ids.bandA })
    expect(own.statusCode).toBe(200)
    expect((await call('hrA', 'PATCH', `/positions/${ids.posA}`, { shiftBandId: ids.bandA })).statusCode).toBe(200)
    // B's band name never comes back to company A.
    expect((await get('hrA', '/positions')).body).not.toContain('B-secret-night')

    // A seat already on a band that was later archived can still be saved
    // with the edit form re-sending that band.
    await prisma.position.update({ where: { id: ids.posA }, data: { shiftBandId: ids.bandArchA } })
    expect((await call('hrA', 'PATCH', `/positions/${ids.posA}`, { shiftBandId: ids.bandArchA, headcount: 1 })).statusCode).toBe(200)
  })
})
