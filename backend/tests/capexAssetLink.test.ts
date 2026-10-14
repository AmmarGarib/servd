// CapEx → the fixed-asset register (finance wave B, fixed assets v2).
//
//   • The link is FixedAsset.capexLineId — editing notes never unlinks and a
//     spoofed 'capex-line:' note never links.
//   • Capitalisation is a request: finance's waits for the CEO (202), a second
//     one or a done one is 409; the CEO's own applies at once (201). A line of
//     N units becomes N assets with sequential tags; a pooled class one layer.
//   • Locks: LINE_CAPITALISED (PATCH cost / quote winner), LINE_HAS_POSTINGS /
//     PROJECT_HAS_POSTINGS (delete), ADVANCE_APPLIED_TO_ASSET, TREATMENT_LOCKED.
//   • Withholding through lib/withholding.ts (gross / net / 2040, the
//     supplier's exemption certificate → 0, the override with a reason).
//   • H26: an architect's fee on a build-out is capital; a broker's is 6110.
//   • H25 deposits: 1360, returned / kept; a legacy 1310 deposit reclassed.
//   • Quick buy: bank only, one transaction, every id of the active company.
//   • A delivery month already closed: the capitalisation posts late and the
//     depreciation catches up.
//   • The cash seam (petty cash / cash requests): Dr 1340 / Cr 1011 | 1355.
//   • Two companies on every CapEx route: B gets 404 on A's rows.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { recordCapexPaymentFromCashTx, capexTreatmentOf } from '../src/modules/financePlanning/capexPosting.js'
import { applyEvent } from '../src/modules/fixedAssets/events.js'
import { chargeThrough } from '../src/modules/fixedAssets/service.js'
import { addMonths, currentPeriodPkt, lastCompletedPeriodPkt, lastDayPkt } from '../src/modules/fixedAssets/schedule.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string, tenantC: string
let conceptA: string, conceptB: string
let locA: string, locA2: string, locB: string
let supA: string, supB: string, supExempt: string
const bank: Record<string, string> = {}

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@capexlink.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? { ...je, rows: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, conceptId: l.conceptId, memo: l.memo ?? '' })) } : null
}
const amt = (rows: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)

async function project(tenantId: string, name: string, extra: Record<string, unknown> = {}) {
  return (await prisma.capexProject.create({ data: { tenantId, name: `${name} ${RUN}`, ...extra } })).id
}
async function line(projectId: string, item: string, extra: Record<string, unknown> = {}) {
  return (await prisma.capexLine.create({ data: { projectId, scope: 'Equipment', item, unitCostCents: 1_000_000, ...extra } })).id
}
const PAID = '2026-09-10'

async function withholdingOn(tenantId: string, on: boolean) {
  const row = await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })
  if (row) await prisma.operationsConfig.update({ where: { id: row.id }, data: { withholdingTaxEnabled: on } })
  else await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, withholdingTaxEnabled: on } })
  invalidateSetupCache()
}

beforeAll(async () => {
  tenantA = await company('CapexLink A')
  tenantB = await company('CapexLink B')
  tenantC = await company('CapexLink C')
  conceptA = (await prisma.concept.create({ data: { name: 'Link Cafe', slug: `link-cafe-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Link Diner', slug: `link-diner-${RUN}`, type: 'restaurant', tenantId: tenantB } })).id
  locA = (await prisma.location.create({ data: { tenantId: tenantA, name: `Clifton ${RUN}`, slug: `loc-${RUN}-clifton` } })).id
  locA2 = (await prisma.location.create({ data: { tenantId: tenantA, name: `DHA ${RUN}`, slug: `loc-${RUN}-dha` } })).id
  locB = (await prisma.location.create({ data: { tenantId: tenantB, name: `Saddar ${RUN}`, slug: `loc-${RUN}-saddar` } })).id
  supA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Oven House', filerStatus: 'filer' } })).id
  supExempt = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Exempt Steel', filerStatus: 'filer', whtExemptCertNo: 'EX-1', whtExemptUntil: new Date('2027-06-30T18:59:59Z') } })).id
  supB = (await prisma.supplier.create({ data: { tenantId: tenantB, name: 'B Ovens', filerStatus: 'filer' } })).id
  // A has one bank (1020); C has two (1020 + 1021) so naming one is required.
  bank.a = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL A', accountCode: '1020' } })).id
  bank.b = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'HBL B', accountCode: '1020' } })).id
  await prisma.account.create({ data: { tenantId: tenantC, code: '1021', name: 'Bank — MCB', type: 'asset', isActive: true } })
  bank.c1 = (await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'HBL C', accountCode: '1020' } })).id
  bank.c2 = (await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'MCB C', accountCode: '1021' } })).id

  await mkStaff('ceoA', 'admin', tenantA)
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('ceoB', 'admin', tenantB)
  await mkStaff('finB', 'finance', tenantB)
  await mkStaff('ceoC', 'admin', tenantC)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  // Every entry this suite wrote balances.
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [tenantA, tenantB, tenantC] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  await app.close()
})

describe('the link is a column', () => {
  it('editing notes never unlinks; a spoofed note never links', async () => {
    const p = await project(tenantA, 'Link build', { conceptId: conceptA })
    const l = await line(p, 'Salamander', { status: 'delivered', actualDeliveryDate: new Date('2026-09-05T12:00:00Z') })
    const cap = await call('ceoA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment' })
    expect(cap.statusCode, cap.body).toBe(201)
    const assetId = cap.json().assetIds[0] as string
    await prisma.fixedAsset.update({ where: { id: assetId }, data: { notes: 'moved to the back kitchen' } })
    let view = (await call('ceoA', 'GET', `/finance/capex/${p}`)).json()
    expect(view.lines[0].capitalisation.assetIds).toEqual([assetId])
    expect(view.books.capitalisedCents).toBe(1_000_000)

    // A hand-made asset with the old prefix does not link to another line.
    const other = await line(p, 'Griddle', { status: 'delivered', actualDeliveryDate: new Date('2026-09-05T12:00:00Z') })
    await prisma.fixedAsset.create({ data: { tenantId: tenantA, name: 'Spoof', category: 'kitchen_equipment', acquiredAt: new Date(), costCents: 1, usefulLifeMonths: 12, notes: `capex-line:${other} — spoof` } })
    view = (await call('ceoA', 'GET', `/finance/capex/${p}`)).json()
    expect(view.lines.find((x: { id: string }) => x.id === other).capitalisation.assetIds).toEqual([])
    // …so it can still be capitalised.
    expect((await call('ceoA', 'POST', `/finance/capex/lines/${other}/capitalise`, { classKey: 'kitchen_equipment' })).statusCode).toBe(201)
  })
})

describe('capitalisation goes through the CEO', () => {
  it('finance prepares (202 pending), a second request is 409, the CEO approves, then it is done (409)', async () => {
    const p = await project(tenantA, 'Request build', { conceptId: conceptA, locationId: locA })
    const l = await line(p, 'Blast chiller', { status: 'delivered', actualDeliveryDate: new Date('2026-09-08T12:00:00Z') })
    const r = await call('finA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment', usefulLifeMonths: 60 })
    expect(r.statusCode, r.body).toBe(202)
    expect(r.json()).toMatchObject({ applied: false, status: 'pending', assetIds: [] })
    expect(await prisma.fixedAsset.count({ where: { capexLineId: l } })).toBe(0)
    expect((await call('finA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment' })).json().error.code).toBe('CAPITALISATION_PENDING')
    // The tracker shows the pending request.
    const view = (await call('finA', 'GET', `/finance/capex/${p}`)).json()
    expect(view.lines[0].capitalisation.pendingEventId).toBe(r.json().eventId)
    // Line cost is frozen while it waits.
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { unitCostCents: 900_000 })).json().error.code).toBe('LINE_CAPITALISED')

    const ev = await applyEvent(r.json().eventId, staff.ceoA!.id)
    expect(ev.status).toBe('posted')
    const assets = await prisma.fixedAsset.findMany({ where: { capexLineId: l } })
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({ tenantId: tenantA, conceptId: conceptA, locationId: locA, category: 'kitchen_equipment' })
    expect((await call('finA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment' })).json().error.code).toBe('ALREADY_CAPITALISED')
  })

  it('a line of N units becomes N assets with sequential tags; a pooled class becomes one layer', async () => {
    const p = await project(tenantA, 'Split build', { locationId: locA })
    const l = await line(p, 'Prep table', { quantity: 3, unitCostCents: 100_000, status: 'delivered', actualDeliveryDate: new Date('2026-09-08T12:00:00Z') })
    const r = await call('ceoA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'furniture_fixtures' })
    expect(r.statusCode, r.body).toBe(201)
    const assets = await prisma.fixedAsset.findMany({ where: { capexLineId: l }, orderBy: { capexLineUnit: 'asc' } })
    expect(assets.map((a) => a.capexLineUnit)).toEqual([1, 2, 3])
    const tags = assets.map((a) => Number(a.assetTag!.replace(/\D/g, '')))
    expect(tags[1]! - tags[0]!).toBe(1)
    expect(tags[2]! - tags[1]!).toBe(1)
    expect(assets.reduce((t, a) => t + a.costCents, 0)).toBe(300_000)

    const plates = await line(p, 'Dinner plates', { quantity: 120, unitCostCents: 500, status: 'delivered', actualDeliveryDate: new Date('2026-09-08T12:00:00Z') })
    expect((await call('ceoA', 'POST', `/finance/capex/lines/${plates}/capitalise`, { classKey: 'smallwares' })).json().error.code).toBe('POOL_TYPE_REQUIRED')
    const pr = await call('ceoA', 'POST', `/finance/capex/lines/${plates}/capitalise`, { classKey: 'smallwares', pool: { typeKey: 'plates', conceptId: conceptA } })
    expect(pr.statusCode, pr.body).toBe(201)
    const layers = await prisma.fixedAsset.findMany({ where: { capexLineId: plates } })
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({ kind: 'pool_layer', quantity: 120, costCents: 60_000, conceptId: conceptA })
    // Another company's brand on the pool → 422.
    const cups = await line(p, 'Cups', { quantity: 10, unitCostCents: 500, status: 'delivered', actualDeliveryDate: new Date('2026-09-08T12:00:00Z') })
    expect((await call('ceoA', 'POST', `/finance/capex/lines/${cups}/capitalise`, { classKey: 'smallwares', pool: { typeKey: 'cutlery', conceptId: conceptB } })).json().error.code).toBe('CONCEPT_NOT_IN_COMPANY')
    expect((await call('ceoA', 'POST', `/finance/capex/lines/${cups}/capitalise`, { classKey: 'kitchen_equipment', locationId: locB })).json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
  })
})

describe('locks', () => {
  it('delete with postings, an applied advance, a capitalised line\'s cost, the quote winner, the treatment', async () => {
    const p = await project(tenantA, 'Lock build', { conceptId: conceptA })
    const l = await line(p, 'Dishwasher', { negotiatedCents: 1_000_000, status: 'ordered' })
    const dep = await call('finA', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'deposit', amountCents: 400_000, paidAt: PAID })
    expect(dep.statusCode, dep.body).toBe(201)
    const payId = dep.json().id as string
    // Treatment cannot change once an instalment is on the books.
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { treatment: 'expense' })).json().error.code).toBe('TREATMENT_LOCKED')
    // Line / project with postings: 409.
    expect((await call('finA', 'DELETE', `/finance/capex/lines/${l}`)).json().error.code).toBe('LINE_HAS_POSTINGS')
    expect((await call('finA', 'DELETE', `/finance/capex/${p}`)).json().error.code).toBe('PROJECT_HAS_POSTINGS')
    // A line with nothing on the books can go.
    const empty = await line(p, 'Spare shelf')
    expect((await call('finA', 'DELETE', `/finance/capex/lines/${empty}`)).statusCode).toBe(204)

    // Before capitalisation the advance can still be corrected.
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${payId}`, { paidAmountCents: 450_000 })).statusCode).toBe(200)
    await prisma.capexLine.update({ where: { id: l }, data: { status: 'delivered', actualDeliveryDate: new Date('2026-09-12T12:00:00Z') } })
    const q = await prisma.capexQuote.create({ data: { lineId: l, vendor: 'Other', totalCents: 900_000 } })
    const cap = await call('ceoA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment' })
    expect(cap.statusCode, cap.body).toBe(201)
    const acq = await entry(`fixed_asset.acquire:${cap.json().assetIds[0]}`)
    expect(amt(acq!.rows, '1340', 'credit')).toBe(450_000)
    expect(amt(acq!.rows, '2012', 'credit')).toBe(550_000)

    // The applied advance is frozen: amount, date, un-pay, delete.
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${payId}`, { paidAmountCents: 500_000 })).json().error.code).toBe('ADVANCE_APPLIED_TO_ASSET')
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${payId}`, { paidAt: '2026-09-11' })).json().error.code).toBe('ADVANCE_APPLIED_TO_ASSET')
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${payId}`, { paidAt: null })).json().error.code).toBe('ADVANCE_APPLIED_TO_ASSET')
    expect((await call('finA', 'DELETE', `/finance/capex/payments/${payId}`)).json().error.code).toBe('ADVANCE_APPLIED_TO_ASSET')
    // A note on it is fine and reposts nothing.
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${payId}`, { notes: 'receipt filed' })).statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: `capex.payment:${payId}` } } })).toBe(2) // the first posting + the amount fix (@2)
    // Cost fields and the quote winner: LINE_CAPITALISED.
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { quantity: 2 })).json().error.code).toBe('LINE_CAPITALISED')
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { actualDeliveryDate: '2026-09-13' })).json().error.code).toBe('LINE_CAPITALISED')
    expect((await call('finA', 'PATCH', `/finance/capex/quotes/${q.id}/winner`)).json().error.code).toBe('LINE_CAPITALISED')
    // Other fields stay editable.
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { notes: 'in service' })).statusCode).toBe(200)
  })
})

describe('a capitalised line is capital, whatever its text or treatment says', () => {
  it('bought on credit and capitalised with nothing paid: its treatment (or the text it is read from) cannot change, and a later payment settles 2012', async () => {
    const p = await project(tenantA, 'Credit buy', { conceptId: conceptA })
    const l = await line(p, 'Combi oven', { negotiatedCents: 1_000_000, status: 'delivered', actualDeliveryDate: new Date('2026-09-12T12:00:00Z') })
    const cap = await call('ceoA', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment' })
    expect(cap.statusCode, cap.body).toBe(201)
    expect(amt((await entry(`fixed_asset.acquire:${cap.json().assetIds[0]}`))!.rows, '2012', 'credit')).toBe(1_000_000)
    for (const change of [{ treatment: 'expense' }, { treatment: 'prepaid' }, { treatment: 'deposit' }, { item: 'Broker fee on the combi oven', scope: 'SoftCosts' }]) {
      const r = await call('finA', 'PATCH', `/finance/capex/lines/${l}`, change)
      expect(r.statusCode, JSON.stringify(change)).toBe(409)
      expect(r.json().error.code).toBe('LINE_CAPITALISED')
    }
    // Saying what it already is, or a note, is fine.
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { treatment: 'capital', notes: 'on the register' })).statusCode).toBe(200)
    // Even a line whose stored treatment was changed behind the route: the asset decides.
    await prisma.capexLine.update({ where: { id: l }, data: { treatment: 'expense' } })
    const pay = await call('finA', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'balance', amountCents: 1_000_000, paidAt: PAID })
    expect(pay.statusCode, pay.body).toBe(201)
    const je = (await entry(`capex.payment:${pay.json().id}`))!
    expect(amt(je.rows, '2012', 'debit')).toBe(1_000_000)
    expect(amt(je.rows, '6110', 'debit')).toBe(0)
    expect(je.rows.some((r) => /^132/.test(r.code))).toBe(false)
  })
})

describe('withholding on CapEx (lib/withholding.ts — the one resolver)', () => {
  it('gross / net / 2040 at the vendor\'s rate, fixed when first paid; the exemption → 0; the override with a reason', async () => {
    await withholdingOn(tenantA, true)
    const p = await project(tenantA, 'WHT build', { conceptId: conceptA, projectType: 'kitchen_buildout' })
    const l = await line(p, 'Civil works', { supplierId: supA, negotiatedCents: 2_000_000 })
    const r = await call('finA', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'deposit', amountCents: 1_000_000, paidAt: PAID })
    expect(r.statusCode, r.body).toBe(201)
    // A contractor on a build-out: s.153(1)(c), filer 7%.
    expect(r.json()).toMatchObject({ whtCents: 70_000, whtSection: '153_1_c', whtRateBps: 700, filerStatus: 'filer' })
    let je = await entry(`capex.payment:${r.json().id}`)
    expect(amt(je!.rows, '1340', 'debit')).toBe(1_000_000)
    expect(amt(je!.rows, '1020', 'credit')).toBe(930_000)
    expect(amt(je!.rows, '2040', 'credit')).toBe(70_000)
    // The rate is fixed: a later rate change does not move it; an amount edit recomputes at 7%.
    await prisma.operationsConfig.updateMany({ where: { tenantId: tenantA, scope: 'global' }, data: { withholdingRates: { '153_1_c': { filerBps: 1000, nonFilerBps: 2000 } } } })
    const fix = await call('finA', 'PATCH', `/finance/capex/payments/${r.json().id}`, { paidAmountCents: 1_200_000 })
    expect(fix.json().whtCents).toBe(84_000)
    je = await entry(`capex.payment:${r.json().id}@2`)
    expect(amt(je!.rows, '1020', 'credit')).toBe(1_116_000)
    expect(amt(je!.rows, '2040', 'credit')).toBe(84_000)
    await prisma.operationsConfig.updateMany({ where: { tenantId: tenantA, scope: 'global' }, data: { withholdingRates: undefined } })

    // The supplier's exemption certificate → 0.
    const ex = await line(p, 'Steel frame', { supplierId: supExempt })
    const er = await call('finA', 'POST', `/finance/capex/lines/${ex}/payments`, { label: 'deposit', amountCents: 500_000, paidAt: PAID })
    expect(er.json()).toMatchObject({ whtCents: 0, filerStatus: 'exempt' })
    expect(amt((await entry(`capex.payment:${er.json().id}`))!.rows, '1020', 'credit')).toBe(500_000)

    // The override needs its reason.
    const ov = await line(p, 'Ducting', { supplierId: supA })
    expect((await call('finA', 'POST', `/finance/capex/lines/${ov}/payments`, { label: 'deposit', amountCents: 100_000, paidAt: PAID, whtOverrideCents: 0 })).json().error.code).toBe('WHT_OVERRIDE_REASON_REQUIRED')
    const o = await call('finA', 'POST', `/finance/capex/lines/${ov}/payments`, { label: 'deposit', amountCents: 100_000, paidAt: PAID, whtOverrideCents: 3_000, whtOverrideReason: 'Certificate applied for, CA advised 3%' })
    expect(o.json()).toMatchObject({ whtCents: 3_000, whtOverrideReason: 'Certificate applied for, CA advised 3%' })
    expect(amt((await entry(`capex.payment:${o.json().id}`))!.rows, '2040', 'credit')).toBe(3_000)

    // Input tax on a fee line: Dr the authority's input account, WHT on the base without it.
    const fee = await line(p, 'Broker commission', { supplierId: supA, negotiatedCents: 115_000, inputTaxCents: 15_000, inputTaxAuthority: 'srb' })
    const fr = await call('finA', 'POST', `/finance/capex/lines/${fee}/payments`, { label: 'deposit', amountCents: 115_000, paidAt: PAID })
    expect(fr.statusCode, fr.body).toBe(201)
    je = await entry(`capex.payment:${fr.json().id}`)
    expect(amt(je!.rows, '6110', 'debit')).toBe(100_000)
    expect(amt(je!.rows, '1322', 'debit')).toBe(15_000)
    expect(amt(je!.rows, '2040', 'credit')).toBe(9_000) // s.153(1)(b) filer 9% of 100,000
    expect(amt(je!.rows, '1020', 'credit')).toBe(106_000)
    await withholdingOn(tenantA, false)
  })
})

describe('what a line is (H25 / H26)', () => {
  it('an architect\'s fee on a build-out is capital; on an equipment buy and a broker it is an expense', async () => {
    expect(capexTreatmentOf({ scope: 'SoftCosts', category: null, item: 'Architect fee' }, 'kitchen_buildout')).toBe('capital')
    expect(capexTreatmentOf({ scope: 'SoftCosts', category: null, item: 'Architect fee' }, 'equipment_only')).toBe('expense')
    expect(capexTreatmentOf({ scope: 'SoftCosts', category: null, item: 'Legal fees — lease' }, 'kitchen_buildout')).toBe('expense')
    expect(capexTreatmentOf({ scope: 'SoftCosts', category: null, item: 'Security deposit' }, 'kitchen_buildout')).toBe('deposit')
    expect(capexTreatmentOf({ scope: 'SoftCosts', category: null, item: 'Rent advance (6 months)' }, 'kitchen_buildout')).toBe('prepaid')
    expect(capexTreatmentOf({ scope: 'SoftCosts', category: null, item: 'Architect fee', treatment: 'expense' }, 'kitchen_buildout')).toBe('expense')

    const p = await project(tenantA, 'Fee build', { conceptId: conceptA, projectType: 'kitchen_buildout' })
    const arch = await line(p, 'Architect fee', { scope: 'SoftCosts', unitCostCents: 300_000, status: 'delivered', actualDeliveryDate: new Date('2026-09-15T12:00:00Z') })
    const ap = await call('finA', 'POST', `/finance/capex/lines/${arch}/payments`, { label: 'deposit', amountCents: 300_000, paidAt: PAID })
    expect(amt((await entry(`capex.payment:${ap.json().id}`))!.rows, '1340', 'debit')).toBe(300_000)
    const cap = await call('ceoA', 'POST', `/finance/capex/lines/${arch}/capitalise`, { classKey: 'leasehold' })
    expect(cap.statusCode, cap.body).toBe(201)
    expect(amt((await entry(`fixed_asset.acquire:${cap.json().assetIds[0]}`))!.rows, '1550', 'debit')).toBe(300_000)

    const broker = await line(p, 'Broker commission', { scope: 'SoftCosts', unitCostCents: 100_000 })
    const bp = await call('finA', 'POST', `/finance/capex/lines/${broker}/payments`, { label: 'deposit', amountCents: 100_000, paidAt: PAID })
    const bj = await entry(`capex.payment:${bp.json().id}`)
    expect(amt(bj!.rows, '6110', 'debit')).toBe(100_000)
    expect(bj!.rows.find((x) => x.code === '6110')!.conceptId).toBe(conceptA)
  })
})

describe('deposits (H25: 1360)', () => {
  it('a security deposit goes to 1360 with no withholding, then comes back (part kept)', async () => {
    await withholdingOn(tenantA, true)
    const p = await project(tenantA, 'Deposit build', { conceptId: conceptA })
    const d = await line(p, 'Security deposit — shop lease', { scope: 'SoftCosts', unitCostCents: 600_000, supplierId: supA })
    const dp = await call('finA', 'POST', `/finance/capex/lines/${d}/payments`, { label: 'deposit', amountCents: 600_000, paidAt: PAID })
    expect(dp.statusCode, dp.body).toBe(201)
    const je = await entry(`capex.payment:${dp.json().id}`)
    expect(amt(je!.rows, '1360', 'debit')).toBe(600_000)
    expect(amt(je!.rows, '1020', 'credit')).toBe(600_000)
    expect(amt(je!.rows, '2040', 'credit')).toBe(0)
    await withholdingOn(tenantA, false)
    expect((await call('ceoA', 'POST', `/finance/capex/lines/${d}/capitalise`, { classKey: 'kitchen_equipment' })).json().error.code).toBe('NOT_CAPITAL')

    const url = `/finance/capex/payments/${dp.json().id}/deposit-return`
    expect((await call('finA', 'POST', url, { returnedCents: 500_000, forfeitedCents: 200_000, reason: 'Paint damage', receivedAt: '2026-09-30' })).json().error.code).toBe('RETURN_EXCEEDS_DEPOSIT')
    expect((await call('finA', 'POST', url, { returnedCents: 500_000, forfeitedCents: 100_000, receivedAt: '2026-09-30' })).json().error.code).toBe('REASON_REQUIRED')
    expect((await call('finB', 'POST', url, { returnedCents: 500_000, receivedAt: '2026-09-30' })).statusCode).toBe(404)
    const ret = await call('finA', 'POST', url, { returnedCents: 500_000, forfeitedCents: 100_000, reason: 'Paint damage', receivedAt: '2026-09-30' })
    expect(ret.statusCode, ret.body).toBe(201)
    const rj = await entry(`capex.deposit_return:${dp.json().id}`)
    expect(amt(rj!.rows, '1020', 'debit')).toBe(500_000)
    expect(amt(rj!.rows, '6010', 'debit')).toBe(100_000)
    expect(rj!.rows.find((x) => x.code === '6010')!.conceptId).toBe(conceptA)
    expect(amt(rj!.rows, '1360', 'credit')).toBe(600_000)
    expect((await prisma.capexPayment.findUniqueOrThrow({ where: { id: dp.json().id } })).depositReturnedCents).toBe(500_000)
    // A returned deposit is locked.
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${dp.json().id}`, { paidAmountCents: 1 })).json().error.code).toBe('DEPOSIT_RETURNED')
    const view = (await call('finA', 'GET', `/finance/capex/${p}`)).json()
    expect(view.books.depositHeldCents).toBe(0)
  })

  it('a legacy deposit booked to 1310 is reclassed to 1360 by the CEO (dry run first)', async () => {
    const p = await project(tenantA, 'Legacy deposit', { conceptId: conceptA })
    const l = await line(p, 'Shop deposit (old booking)', { scope: 'SoftCosts', unitCostCents: 250_000 })
    const pay = await prisma.capexPayment.create({ data: { lineId: l, label: 'deposit', amountCents: 250_000, paidAmountCents: 250_000, paidAt: new Date('2026-08-05T12:00:00+05:00') } })
    await postJournalEntry({ tenantId: tenantA, sourceType: 'capex.payment', sourceId: pay.id, description: 'Legacy capex prepayment', entryDate: new Date('2026-08-05T12:00:00+05:00'), postedBy: 'test', lines: [
      { accountCode: '1310', type: 'debit', amountCents: 250_000 }, { accountCode: '1020', type: 'credit', amountCents: 250_000 },
    ] })
    const url = `/finance/capex/payments/${pay.id}/reclass-deposit`
    expect((await call('finA', 'POST', url, {})).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', url, { dryRun: false })).statusCode).toBe(404)
    const dry = await call('ceoA', 'POST', url, {})
    expect(dry.json()).toMatchObject({ dryRun: true, amountCents: 250_000 })
    expect(await entry(`capex.deposit_reclass:${pay.id}`)).toBeNull()
    const done = await call('ceoA', 'POST', url, { dryRun: false })
    expect(done.statusCode, done.body).toBe(201)
    const je = await entry(`capex.deposit_reclass:${pay.id}`)
    expect(amt(je!.rows, '1360', 'debit')).toBe(250_000)
    expect(amt(je!.rows, '1310', 'credit')).toBe(250_000)
    expect((await call('ceoA', 'POST', url, { dryRun: false })).json().error.code).toBe('ALREADY_RECLASSED')
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${pay.id}`, { paidAmountCents: 1 })).json().error.code).toBe('DEPOSIT_RECLASSED')
    expect((await prisma.capexLine.findUniqueOrThrow({ where: { id: l } })).treatment).toBe('deposit')
    // …and it can now be returned from 1360.
    const ret = await call('finA', 'POST', `/finance/capex/payments/${pay.id}/deposit-return`, { returnedCents: 250_000, receivedAt: '2026-10-01' })
    expect(ret.statusCode, ret.body).toBe(201)
  })
})

describe('a legacy deposit reclass is per payment', () => {
  it('reclassing one deposit never re-books a sibling rent advance on the same line (it keeps 1310 and its 2040 line)', async () => {
    const p = await project(tenantA, 'Lease line', { conceptId: conceptA })
    const l = await line(p, 'Shop lease — security deposit + advance rent', { scope: 'SoftCosts', unitCostCents: 1_800_000 })
    const at = new Date('2026-08-05T12:00:00+05:00')
    const p1 = await prisma.capexPayment.create({ data: { lineId: l, label: 'deposit', amountCents: 600_000, paidAmountCents: 600_000, paidAt: at } })
    const p2 = await prisma.capexPayment.create({ data: {
      lineId: l, label: 'deposit', amountCents: 1_200_000, paidAmountCents: 1_200_000, paidAt: at,
      whtCents: 60_000, whtSection: '155', whtRateBps: 500, filerStatus: 'filer',
    } })
    await postJournalEntry({ tenantId: tenantA, sourceType: 'capex.payment', sourceId: p1.id, description: 'Legacy deposit as prepayment', entryDate: at, postedBy: 'test', lines: [
      { accountCode: '1310', type: 'debit', amountCents: 600_000 }, { accountCode: '1020', type: 'credit', amountCents: 600_000 },
    ] })
    await postJournalEntry({ tenantId: tenantA, sourceType: 'capex.payment', sourceId: p2.id, description: 'Legacy rent advance', entryDate: at, postedBy: 'test', lines: [
      { accountCode: '1310', type: 'debit', amountCents: 1_200_000 }, { accountCode: '1020', type: 'credit', amountCents: 1_140_000 }, { accountCode: '2040', type: 'credit', amountCents: 60_000 },
    ] })
    const done = await call('ceoA', 'POST', `/finance/capex/payments/${p1.id}/reclass-deposit`, { dryRun: false })
    expect(done.statusCode, done.body).toBe(201)
    // The line keeps no 'deposit' treatment while a sibling is on the books as a rent advance.
    expect((await prisma.capexLine.findUniqueOrThrow({ where: { id: l } })).treatment).toBeNull()
    // Finance gives the advance its months: it re-syncs as what it is.
    const edit = await call('finA', 'PATCH', `/finance/capex/payments/${p2.id}`, { coversFrom: '2026-08', coversMonths: 12 })
    expect(edit.statusCode, edit.body).toBe(200)
    const live = await prisma.journalEntry.findMany({ where: { tenantId: tenantA, reference: { startsWith: `capex.payment:${p2.id}` } }, include: { lines: { include: { account: true } } }, orderBy: { createdAt: 'desc' } })
    const rows = live[0]!.lines.map((x) => ({ code: x.account.code, type: x.type, amount: x.amountCents }))
    expect(amt(rows, '1310', 'debit')).toBe(1_200_000)
    expect(amt(rows, '1360', 'debit')).toBe(0)
    expect(amt(rows, '2040', 'credit')).toBe(60_000)
    expect(amt(rows, '1020', 'credit')).toBe(1_140_000)
    expect(Number((await prisma.capexPayment.findUniqueOrThrow({ where: { id: p2.id } })).whtCents)).toBe(60_000)
  })
})

describe('Quick buy (bank only, one transaction)', () => {
  it('finance buys for an outlet: standing project, delivered line, posted payment, request for the CEO', async () => {
    const r = await call('finA', 'POST', '/finance/capex/quick-buy', {
      locationId: locA, item: 'Hand blender', classKey: 'kitchen_equipment', quantity: 1, unitCostCents: 80_000, supplierId: supA, paidAt: PAID,
    })
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json()
    expect(body.capitalisation).toMatchObject({ status: 'pending', applied: false })
    const proj = await prisma.capexProject.findUniqueOrThrow({ where: { id: body.projectId } })
    expect(proj).toMatchObject({ tenantId: tenantA, locationId: locA, isStanding: true, projectType: 'equipment_only' })
    const ln = await prisma.capexLine.findUniqueOrThrow({ where: { id: body.lineId } })
    expect(ln).toMatchObject({ status: 'delivered', supplierId: supA, vendor: 'Oven House', treatment: 'capital' })
    const je = await entry(`capex.payment:${body.paymentId}`)
    expect(amt(je!.rows, '1340', 'debit')).toBe(80_000)
    expect(amt(je!.rows, '1020', 'credit')).toBe(80_000)
    // The CEO approves → asset on the register against the advance.
    await applyEvent(body.capitalisation.eventId, staff.ceoA!.id)
    const asset = await prisma.fixedAsset.findFirstOrThrow({ where: { capexLineId: body.lineId } })
    expect(asset).toMatchObject({ locationId: locA, costCents: 80_000 })
    expect(amt((await entry(`fixed_asset.acquire:${asset.id}`))!.rows, '1340', 'credit')).toBe(80_000)

    // The same outlet's next buy reuses the standing project.
    const r2 = await call('finA', 'POST', '/finance/capex/quick-buy', { locationId: locA, item: 'Knives', classKey: 'smallwares', typeKey: 'knives', quantity: 12, unitCostCents: 2_000, paidAt: PAID })
    expect(r2.statusCode, r2.body).toBe(201)
    expect(r2.json().projectId).toBe(body.projectId)
  })

  it('the CEO\'s Quick buy is applied at once — a pooled class becomes a layer of the outlet\'s pool', async () => {
    const r = await call('ceoA', 'POST', '/finance/capex/quick-buy', {
      locationId: locA2, conceptId: conceptA, item: 'Soup bowls', classKey: 'smallwares', typeKey: 'bowls', quantity: 48, unitCostCents: 1_500, paidAt: PAID,
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().capitalisation).toMatchObject({ status: 'posted', applied: true })
    const layer = await prisma.fixedAsset.findFirstOrThrow({ where: { id: r.json().capitalisation.assetIds[0] }, include: { pool: true } })
    expect(layer).toMatchObject({ kind: 'pool_layer', quantity: 48, costCents: 72_000, conceptId: conceptA })
    expect(layer.pool).toMatchObject({ locationId: locA2, conceptId: conceptA, typeKey: 'bowls' })
  })

  it('cash is refused; every id must be the active company\'s; a refusal leaves nothing', async () => {
    const base = { locationId: locA, item: 'Mixer', classKey: 'kitchen_equipment', quantity: 1, unitCostCents: 50_000, paidAt: PAID }
    expect((await call('finA', 'POST', '/finance/capex/quick-buy', { ...base, payFrom: 'cash' })).json().error.code).toBe('QUICK_BUY_BANK_ONLY')
    expect((await call('finA', 'POST', '/finance/capex/quick-buy', { ...base, locationId: locB })).json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', '/finance/capex/quick-buy', { ...base, conceptId: conceptB })).json().error.code).toBe('CONCEPT_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', '/finance/capex/quick-buy', { ...base, supplierId: supB })).json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', '/finance/capex/quick-buy', { ...base, bankAccountId: bank.b })).json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', '/finance/capex/quick-buy', { ...base, classKey: 'smallwares' })).json().error.code).toBe('POOL_TYPE_REQUIRED')

    // Company C has two banks and none is named: refused inside the transaction — nothing is left.
    const locC = (await prisma.location.create({ data: { tenantId: tenantC, name: `Gulshan ${RUN}`, slug: `loc-${RUN}-gulshan` } })).id
    const before = { p: await prisma.capexProject.count({ where: { tenantId: tenantC } }), j: await prisma.journalEntry.count({ where: { tenantId: tenantC } }) }
    const refused = await call('ceoC', 'POST', '/finance/capex/quick-buy', { ...base, locationId: locC })
    expect(refused.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(await prisma.capexProject.count({ where: { tenantId: tenantC } })).toBe(before.p)
    expect(await prisma.capexLine.count({ where: { project: { tenantId: tenantC } } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC } })).toBe(before.j)
    expect(await prisma.fixedAssetEvent.count({ where: { tenantId: tenantC } })).toBe(0)
    // Named: it goes through, in C.
    const ok = await call('ceoC', 'POST', '/finance/capex/quick-buy', { ...base, locationId: locC, bankAccountId: bank.c2 })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(amt((await entry(`capex.payment:${ok.json().paymentId}`))!.rows, '1021', 'credit')).toBe(50_000)
    expect((await prisma.capexProject.findUniqueOrThrow({ where: { id: ok.json().projectId } })).tenantId).toBe(tenantC)
  })
})

describe('a delivery month already closed', () => {
  it('the capitalisation posts late into the open month and depreciation catches up', async () => {
    const m2 = addMonths(currentPeriodPkt(), -2)
    const m1 = addMonths(currentPeriodPkt(), -1)
    expect(lastCompletedPeriodPkt()).toBe(m1)
    const delivered = new Date(`${m2}-10T12:00:00+05:00`)
    const p = await project(tenantB, 'Late build', { conceptId: conceptB })
    const l = await line(p, 'Pizza oven', { unitCostCents: 1_200_000, status: 'delivered', actualDeliveryDate: delivered })
    const pay = await call('finB', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'balance', amountCents: 1_200_000, paidAt: `${m2}-09` })
    expect(pay.statusCode, pay.body).toBe(201)
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantB, lockedThrough: lastDayPkt(m2), lockedBy: staff.ceoB!.id } })
    try {
      const cap = await call('ceoB', 'POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment', usefulLifeMonths: 60 })
      expect(cap.statusCode, cap.body).toBe(201)
      const assetId = cap.json().assetIds[0] as string
      const acq = await entry(`fixed_asset.acquire:${assetId}`)
      expect(acq!.entryDate.getTime()).toBeGreaterThan(lock.lockedThrough.getTime())
      expect(acq!.rows.some((r) => /posted late/.test(r.memo))).toBe(true)
      await chargeThrough(tenantB, m1, { postedBy: 'test' })
      const rows = await prisma.fixedAssetDepreciation.findMany({ where: { assetId }, orderBy: { period: 'asc' } })
      expect(rows.map((r) => r.period)).toEqual([m2, m1])
      expect(rows.reduce((t, r) => t + r.amountCents, 0)).toBe(40_000)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})

describe('the cash seam (petty cash / cash requests)', () => {
  it('posts Dr 1340 / Cr 1011 or 1355, no withholding, and refuses another company\'s line', async () => {
    await withholdingOn(tenantA, true)
    const p = await project(tenantA, 'Cash build')
    const l = await line(p, 'Gas burner', { supplierId: supA })
    const r = await prisma.$transaction((tx) => recordCapexPaymentFromCashTx(tx, { tenantId: tenantA, lineId: l, spendLineId: `spend-${RUN}-1`, amountCents: 30_000, paidAt: new Date(`${PAID}T12:00:00+05:00`), creditCode: '1011', actorId: staff.finA!.id }))
    let je = await entry(`capex.payment:${r.capexPaymentId}`)
    expect(amt(je!.rows, '1340', 'debit')).toBe(30_000)
    expect(amt(je!.rows, '1011', 'credit')).toBe(30_000)
    expect(amt(je!.rows, '2040', 'credit')).toBe(0)
    expect(await prisma.capexPayment.findUniqueOrThrow({ where: { id: r.capexPaymentId } })).toMatchObject({ source: 'cash', paidAmountCents: 30_000 })
    const r2 = await prisma.$transaction((tx) => recordCapexPaymentFromCashTx(tx, { tenantId: tenantA, lineId: l, spendLineId: `spend-${RUN}-2`, amountCents: 20_000, paidAt: new Date(`${PAID}T12:00:00+05:00`), creditCode: '1355', actorId: staff.finA!.id }))
    je = await entry(`capex.payment:${r2.capexPaymentId}`)
    expect(amt(je!.rows, '1355', 'credit')).toBe(20_000)
    expect((await prisma.capexLine.findUniqueOrThrow({ where: { id: l } })).paidCents).toBe(50_000)
    // Corrected from the cash side, never here.
    expect((await call('finA', 'PATCH', `/finance/capex/payments/${r.capexPaymentId}`, { paidAmountCents: 1 })).json().error.code).toBe('PAID_FROM_CASH')
    expect((await call('finA', 'DELETE', `/finance/capex/payments/${r.capexPaymentId}`)).json().error.code).toBe('PAID_FROM_CASH')
    await withholdingOn(tenantA, false)

    const pb = await project(tenantB, 'B cash build')
    const lb = await line(pb, 'B burner')
    await expect(prisma.$transaction((tx) => recordCapexPaymentFromCashTx(tx, { tenantId: tenantA, lineId: lb, spendLineId: `spend-${RUN}-3`, amountCents: 1_000, paidAt: new Date(), creditCode: '1011', actorId: staff.finA!.id })))
      .rejects.toMatchObject({ code: 'CAPEX_LINE_NOT_IN_COMPANY', statusCode: 422 })
    const orphanProject = (await prisma.capexProject.create({ data: { tenantId: null, name: `No company ${RUN}` } })).id
    const ln = await line(orphanProject, 'Nobody\'s burner')
    await expect(prisma.$transaction((tx) => recordCapexPaymentFromCashTx(tx, { tenantId: tenantA, lineId: ln, spendLineId: `spend-${RUN}-4`, amountCents: 1_000, paidAt: new Date(), creditCode: '1011', actorId: staff.finA!.id })))
      .rejects.toMatchObject({ code: 'PROJECT_HAS_NO_COMPANY', statusCode: 422 })
    expect(await prisma.capexPayment.count({ where: { lineId: { in: [lb, ln] } } })).toBe(0)
  })
})

describe('two companies on every CapEx route', () => {
  it('B gets 404 on A\'s rows; another company\'s supplier is 422; creates bind to the active company', async () => {
    const p = await project(tenantA, 'Scoped build', { conceptId: conceptA })
    const l = await line(p, 'Fryer', { status: 'delivered', actualDeliveryDate: new Date('2026-09-15T12:00:00Z') })
    const pay = await call('finA', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'deposit', amountCents: 100_000, paidAt: PAID })
    const q = await prisma.capexQuote.create({ data: { lineId: l, vendor: 'Q', totalCents: 1 } })
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown]> = [
      ['GET', `/finance/capex/${p}`, undefined],
      ['PATCH', `/finance/capex/${p}`, { name: 'Hijack' }],
      ['DELETE', `/finance/capex/${p}`, undefined],
      ['POST', `/finance/capex/${p}/lines`, { scope: 'k', item: 'x', unitCostCents: 1 }],
      ['PATCH', `/finance/capex/lines/${l}`, { notes: 'x' }],
      ['DELETE', `/finance/capex/lines/${l}`, undefined],
      ['POST', `/finance/capex/lines/${l}/quotes`, { vendor: 'x', totalCents: 1 }],
      ['PATCH', `/finance/capex/quotes/${q.id}/winner`, undefined],
      ['DELETE', `/finance/capex/quotes/${q.id}`, undefined],
      ['POST', `/finance/capex/lines/${l}/payments`, { label: 'extra', amountCents: 1 }],
      ['PATCH', `/finance/capex/payments/${pay.json().id}`, { notes: 'x' }],
      ['DELETE', `/finance/capex/payments/${pay.json().id}`, undefined],
      ['POST', `/finance/capex/lines/${l}/capitalise`, { classKey: 'kitchen_equipment' }],
      ['POST', `/finance/capex/payments/${pay.json().id}/deposit-return`, { returnedCents: 1, receivedAt: '2026-09-30' }],
      ['POST', `/finance/capex/payments/${pay.json().id}/reclass-deposit`, { dryRun: false }],
      ['POST', `/finance/capex/${p}/post-payments`, { dryRun: false }],
    ]
    for (const [method, url, body] of routes) {
      expect((await call('ceoB', method, url, body)).statusCode, `${method} ${url}`).toBe(404)
    }
    expect((await call('ceoB', 'GET', '/finance/capex')).json().some((x: { id: string }) => x.id === p)).toBe(false)
    expect((await call('ceoA', 'GET', '/finance/capex')).json().some((x: { id: string }) => x.id === p)).toBe(true)

    // Another company's supplier on a line: 422 (create and patch).
    expect((await call('finA', 'POST', `/finance/capex/${p}/lines`, { scope: 'k', item: 'Hood', unitCostCents: 1, supplierId: supB })).json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    expect((await call('finA', 'PATCH', `/finance/capex/lines/${l}`, { supplierId: supB })).json().error.code).toBe('SUPPLIER_NOT_IN_COMPANY')
    const ok = await call('finA', 'POST', `/finance/capex/${p}/lines`, { scope: 'k', item: 'Hood', unitCostCents: 1, supplierId: supA })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().vendor).toBe('Oven House')
    // Lookups are the active company's.
    const lk = (await call('finA', 'GET', '/finance/capex/lookups')).json()
    expect(lk.tenantId).toBe(tenantA)
    expect(lk.lookups.suppliers.map((s: { id: string }) => s.id)).toContain(supA)
    expect(lk.lookups.suppliers.map((s: { id: string }) => s.id)).not.toContain(supB)
    expect(lk.assetClasses.map((c: { key: string }) => c.key)).toContain('smallwares')
    expect(lk.locations.map((x: { id: string }) => x.id)).not.toContain(locB)
  })

  it('an orphaned advance is listed and cleared by the CEO of its company only', async () => {
    const p = await project(tenantA, 'Orphan build')
    const l = await line(p, 'Walk-in')
    const pay = await call('finA', 'POST', `/finance/capex/lines/${l}/payments`, { label: 'deposit', amountCents: 70_000, paidAt: PAID })
    // An old soft-delete (before PROJECT_HAS_POSTINGS existed) left the entry live.
    await prisma.capexProject.update({ where: { id: p }, data: { deletedAt: new Date() } })
    const list = (await call('finA', 'GET', '/finance/capex/orphans')).json().orphans
    expect(list.find((o: { paymentId: string }) => o.paymentId === pay.json().id)).toMatchObject({ reason: 'project_deleted', amountCents: 70_000, tenantId: tenantA })
    expect((await call('ceoB', 'GET', '/finance/capex/orphans')).json().orphans.some((o: { paymentId: string }) => o.paymentId === pay.json().id)).toBe(false)
    expect((await call('ceoB', 'POST', `/finance/capex/orphans/${pay.json().id}/reverse`)).statusCode).toBe(404)
    expect((await call('finA', 'POST', `/finance/capex/orphans/${pay.json().id}/reverse`)).statusCode).toBe(403)
    const r = await call('ceoA', 'POST', `/finance/capex/orphans/${pay.json().id}/reverse`)
    expect(r.statusCode, r.body).toBe(201)
    expect(await entry(`capex.payment.reversal:${pay.json().id}`)).toBeTruthy()
    expect((await call('ceoA', 'POST', `/finance/capex/orphans/${pay.json().id}/reverse`)).statusCode).toBe(404)
    // A live instalment on a live project is not an orphan.
    const live = await project(tenantA, 'Live build')
    const ll = await line(live, 'Range')
    const lp = await call('finA', 'POST', `/finance/capex/lines/${ll}/payments`, { label: 'deposit', amountCents: 10_000, paidAt: PAID })
    expect((await call('ceoA', 'POST', `/finance/capex/orphans/${lp.json().id}/reverse`)).json().error.code).toBe('NOT_ORPHAN')
  })
})
