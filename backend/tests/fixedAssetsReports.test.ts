// Fixed assets v2 — the reports (reports.ts).
//
//   - the roll-forward ties to the ledger per class;
//   - NBV as of 30 June by class / brand / outlet / pool, the brand as of that
//     date even after a later transfer;
//   - the tie-out uses posting dates: months posted late into the open month
//     are not on the books at the end of their own month; the 1590 residue;
//   - a manual journal to 1510 is refused without a reason; with one, the
//     next worker run raises fixed_asset_gl_mismatch (once);
//   - the 1340 advances report and its flags;
//   - tax (H23): initial allowance + WDV, smallwares listed "to confirm", the
//     CEO's freeze (409 twice, 422 while open), a frozen year never restated;
//   - no deferred-tax report (H24: not needed);
//   - CSV equals JSON; company B's scope never shows company A.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { FixedAsset, FixedAssetPool, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { taxYearOf } from '../src/modules/accounting/fiscalYear.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { postAcquisition, nextAssetTag, chargeThrough } from '../src/modules/fixedAssets/service.js'
import { findOrCreatePool } from '../src/modules/fixedAssets/pools.js'
import { addMonths, currentPeriodPkt, startOfMonthPkt, endOfMonthPkt, lastDayPkt } from '../src/modules/fixedAssets/schedule.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'
import { fixedAssetTieOut, pktDay } from '../src/modules/fixedAssets/reports.js'
import { runForTenant } from '../src/workers/depreciation.js'

const RUN = Math.random().toString(36).slice(2, 8)
const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k)
const mid = (p: string) => new Date(startOfMonthPkt(p).getTime() + 14 * 86_400_000 + 12 * 3_600_000)
const BASE = '/accounting/fixed-assets'
const DAY = 86_400_000
// The last 30 June that has passed, and an April before it.
const Y = taxYearOf(new Date()).taxYear - 1
const JUNE30 = `${Y}-06-30`
const APRIL = `${Y}-04`

let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; conceptId: string; concept2: string; locationId: string; location2: string }
let seq = 0
async function mkCo(name: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `far-${++seq}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const s = `${seq}-${RUN}`
  return {
    tenantId,
    conceptId: (await prisma.concept.create({ data: { name: `${name} Cafe`, slug: `far-b-${s}`, type: 'restaurant', tenantId } })).id,
    concept2: (await prisma.concept.create({ data: { name: `${name} Diner`, slug: `far-b2-${s}`, type: 'restaurant', tenantId } })).id,
    locationId: (await prisma.location.create({ data: { name: `${name} Clifton`, slug: `far-l-${s}`, tenantId } })).id,
    location2: (await prisma.location.create({ data: { name: `${name} DHA`, slug: `far-l2-${s}`, tenantId } })).id,
  }
}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@fareports.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkAsset(co: Co, o: { name: string; classKey: string; costCents: number; inServiceAt: Date; life: number; conceptId?: string; locationId?: string }): Promise<FixedAsset> {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name: o.name, category: o.classKey, assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: o.inServiceAt, inServiceAt: o.inServiceAt,
        costCents: o.costCents, originalCostCents: o.costCents, usefulLifeMonths: o.life, conceptId: o.conceptId ?? co.conceptId,
        locationId: o.locationId ?? co.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: o.costCents, inputTaxCents: 0, inputTaxCode: null, natural: o.inServiceAt })
    return asset
  })
}
async function mkLayer(co: Co, units: number, costCents: number, inServiceAt: Date): Promise<{ pool: FixedAssetPool; layer: FixedAsset }> {
  return prisma.$transaction(async (tx) => {
    const pool = await findOrCreatePool(tx, { tenantId: co.tenantId, locationId: co.locationId, conceptId: co.conceptId, classKey: 'smallwares', typeKey: 'plates' })
    const layer = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name: 'Dinner plates', category: 'smallwares', kind: 'pool_layer', poolId: pool.id, quantity: units, originalQuantity: units,
        assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: inServiceAt, inServiceAt, costCents, originalCostCents: costCents,
        usefulLifeMonths: 24, conceptId: co.conceptId, locationId: co.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, layer, { advancedCents: 0, owedCents: costCents, inputTaxCents: 0, inputTaxCode: null, natural: inServiceAt })
    return { pool, layer }
  })
}
const call = (w: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })

/** A small RFC 4180 reader: the BOM off, quoted cells, CRLF rows → records of strings. */
function parseCsv(text: string): Array<Record<string, string>> {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' } else if (ch === '\r') continue
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])))
}
const asStrings = (rows: Array<Record<string, unknown>>) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])))

let A: Co, B: Co, C: Co, D: Co
let oven: FixedAsset, laptop: FixedAsset, plates: { pool: FixedAssetPool; layer: FixedAsset }, ovenB: FixedAsset, ovenC: FixedAsset

beforeAll(async () => {
  A = await mkCo('Rep A')
  B = await mkCo('Rep B')
  C = await mkCo('Rep C')
  D = await mkCo('Rep D')
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('finB', 'finance', B.tenantId)
  await mkUser('finC', 'finance', C.tenantId)
  await mkUser('finD', 'finance', D.tenantId)

  oven = await mkAsset(A, { name: 'Combi oven', classKey: 'kitchen_equipment', costCents: 1_200_000, inServiceAt: mid(APRIL), life: 12 })
  laptop = await mkAsset(A, { name: 'Office laptop', classKey: 'it_equipment', costCents: 360_000, inServiceAt: mid(APRIL), life: 36, conceptId: A.concept2, locationId: A.location2 })
  plates = await mkLayer(A, 10, 240_000, mid(APRIL))
  await chargeThrough(A.tenantId, m(-1), { postedBy: 'system' })
  ovenB = await mkAsset(B, { name: 'B oven', classKey: 'kitchen_equipment', costCents: 480_000, inServiceAt: mid(m(-2)), life: 24 })
  await chargeThrough(B.tenantId, m(-1), { postedBy: 'system' })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(fixedAssetRoutes, { prefix: BASE })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

describe('roll-forward', () => {
  it('ties to the ledger per class, and its columns add up', async () => {
    const r = await call('finA', 'GET', `/reports/roll-forward?from=${APRIL}-01&to=${pktDay(new Date())}`)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ties).toBe(true)
    const kitchen = body.rows.find((x: { classKey: string }) => x.classKey === 'kitchen_equipment')
    const charged = (await prisma.fixedAssetDepreciation.findMany({ where: { assetId: oven.id } })).reduce((t, x) => t + Number(x.amountCents), 0)
    expect(kitchen).toMatchObject({
      tenantId: A.tenantId, openingCostCents: 0, additionsCents: 1_200_000, closingCostCents: 1_200_000, glCostCents: 1_200_000,
      depreciationCents: charged, closingAccumCents: charged, glAccumCents: charged, costDiffCents: 0, accumDiffCents: 0,
      costAccountCode: '1510', accumAccountCode: '1591',
    })
    expect(body.rows.map((x: { classKey: string }) => x.classKey).sort()).toEqual(['it_equipment', 'kitchen_equipment', 'smallwares'])
    for (const row of body.rows) {
      expect(row.closingCostCents).toBe(row.openingCostCents + row.additionsCents + row.transfersInCents + row.transfersOutCents + row.writeOffsCents + row.disposalsCents + row.voidsCents)
    }
    // Before April nothing; opening at May = April's addition.
    const may = (await call('finA', 'GET', `/reports/roll-forward?from=${Y}-05-01&to=${JUNE30}`)).json()
    expect(may.rows.find((x: { classKey: string }) => x.classKey === 'kitchen_equipment')).toMatchObject({ openingCostCents: 1_200_000, additionsCents: 0, openingAccumCents: 100_000, depreciationCents: 200_000, accumDiffCents: 0 })
  })
})

describe('NBV at a date', () => {
  it('as of 30 June by class, brand, outlet and pool — the brand as it was then', async () => {
    // The laptop moves brand AFTER 30 June: the report still files it under its old brand then.
    const moved = await call('finA', 'POST', `/${laptop.id}/requests`, { kind: 'transfer', reason: 'Moved to the cafe office', payload: { toConceptId: A.conceptId } })
    expect(moved.statusCode).toBe(201)
    const by = async (g: string, asOf = JUNE30) => Object.fromEntries(((await call('finA', 'GET', `/reports/nbv?asOf=${asOf}&groupBy=${g}`)).json().rows as Array<{ key: string; nbvCents: number }>).map((x) => [x.key, x.nbvCents]))
    expect(await by('class')).toEqual({ kitchen_equipment: 900_000, it_equipment: 330_000, smallwares: 210_000 })
    expect(await by('brand')).toEqual({ [A.conceptId]: 1_110_000, [A.concept2]: 330_000 })
    expect(await by('location')).toEqual({ [A.locationId]: 1_110_000, [A.location2]: 330_000 })
    expect(await by('pool')).toEqual({ [plates.pool.id]: 210_000, individual: 1_230_000 })
    const today = await by('brand', pktDay(new Date()))
    expect(Object.keys(today)).toEqual([A.conceptId])
    const one = (await call('finA', 'GET', `/reports/nbv?asOf=${JUNE30}&groupBy=class`)).json()
    expect(one.totals).toEqual({ costCents: 1_800_000, accumulatedCents: 360_000, nbvCents: 1_440_000 })
  })
})

describe('tie-out (posting dates)', () => {
  it('a month posted late is not on the books at the end of its own month; the register agrees', async () => {
    ovenC = await mkAsset(C, { name: 'C oven', classKey: 'kitchen_equipment', costCents: 120_000, inServiceAt: mid(m(-3)), life: 12 })
    await prisma.periodLock.create({ data: { tenantId: C.tenantId, lockedThrough: endOfMonthPkt(m(-2)), lockedBy: 'test' } })
    const run = await chargeThrough(C.tenantId, m(-1), { postedBy: 'system' })
    expect(run.lateCount).toBe(2)
    const endM2 = pktDay(lastDayPkt(m(-2)))
    const [then] = await fixedAssetTieOut(prisma, [C.tenantId], new Date(endOfMonthPkt(m(-2)).getTime()))
    expect(then!.ok).toBe(true)
    expect(then!.byClass.find((c) => c.classKey === 'kitchen_equipment')).toMatchObject({ registerCostCents: 120_000, registerAccumCents: 0, glAccumCents: 0 })
    const api = (await call('finC', 'GET', `/reports/tie-out?asOf=${endM2}`)).json()
    expect(api.companies[0]).toMatchObject({ tenantId: C.tenantId, ok: true, legacy1590Cents: 0 })
    // The economic view (NBV) counts the two months that ended then.
    expect((await call('finC', 'GET', `/reports/nbv?asOf=${endM2}&groupBy=class`)).json().rows[0]).toMatchObject({ accumulatedCents: 20_000, nbvCents: 100_000 })
    const [now] = await fixedAssetTieOut(prisma, [C.tenantId])
    expect(now!.ok).toBe(true)
    expect(now!.byClass.find((c) => c.classKey === 'kitchen_equipment')).toMatchObject({ registerAccumCents: 30_000, glAccumCents: 30_000 })
    void ovenC
  })

  it('a manual journal to 1510 needs a reason; then the worker flags the mismatch once; 1590 residue shows', async () => {
    await mkAsset(D, { name: 'D fryer', classKey: 'kitchen_equipment', costCents: 60_000, inServiceAt: mid(m(-2)), life: 6 })
    const manual = (controlledOverride?: { reason: string }) => postJournalEntry({
      tenantId: D.tenantId, sourceType: 'manual', sourceId: `fa-${RUN}-${controlledOverride ? 'ok' : 'no'}`, description: 'Hand adjustment',
      lines: [{ accountCode: '1510', type: 'debit', amountCents: 5_000 }, { accountCode: '1020', type: 'credit', amountCents: 5_000 }],
      ...(controlledOverride ? { controlledOverride } : {}),
    })
    await expect(manual()).rejects.toMatchObject({ code: 'REGISTER_CONTROLLED_ACCOUNT', statusCode: 422 })
    await manual({ reason: 'Correction agreed with the auditor' })
    await postJournalEntry({
      tenantId: D.tenantId, sourceType: 'manual', sourceId: `fa-${RUN}-1590`, description: 'Old accumulated depreciation',
      controlledOverride: { reason: 'Opening balance from the old books' },
      lines: [{ accountCode: '6150', type: 'debit', amountCents: 7_000 }, { accountCode: '1590', type: 'credit', amountCents: 7_000 }],
    })
    const t = (await call('finD', 'GET', '/reports/tie-out')).json().companies[0]
    expect(t.ok).toBe(false)
    expect(t.byClass.find((c: { classKey: string }) => c.classKey === 'kitchen_equipment')).toMatchObject({ costDiffCents: 5_000, accumDiffCents: 0 })
    expect(t).toMatchObject({ legacy1590Cents: 7_000, legacy1590RegisterCents: 0, legacy1590DiffCents: 7_000 })

    await runForTenant(D.tenantId)
    await runForTenant(D.tenantId)
    const flags = await prisma.exceptionFlag.findMany({ where: { tenantId: D.tenantId, kind: 'fixed_asset_gl_mismatch' } })
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ status: 'open', severity: 'high', entityId: D.tenantId })
    expect(flags[0]!.description).toMatch(/Kitchen equipment/)
    // The register's own postings never trip it.
    expect((await fixedAssetTieOut(prisma, [A.tenantId]))[0]!.ok).toBe(true)
  })
})

describe('1340 advances by CapEx line', () => {
  it('held per line with its age and flags; the ledger beside it', async () => {
    const project = (await prisma.capexProject.create({ data: { tenantId: A.tenantId, name: `Clifton kitchen ${RUN}`, locationId: A.locationId } })).id
    const mkLine = (item: string, extra: Record<string, unknown>) => prisma.capexLine.create({ data: { projectId: project, scope: 'Equipment', item, unitCostCents: 1_000_000, ...extra } })
    const pay = async (lineId: string | null, cents: number, daysAgo: number) => {
      const p = lineId ? await prisma.capexPayment.create({ data: { lineId, label: 'deposit', amountCents: cents, paidAt: new Date(Date.now() - daysAgo * DAY), paidAmountCents: cents } }) : null
      const id = p?.id ?? `gone-${RUN}-${cents}`
      await postJournalEntry({
        tenantId: A.tenantId, sourceType: 'capex.payment', sourceId: id, description: 'Advance', entryDate: new Date(Date.now() - daysAgo * DAY),
        lines: [{ accountCode: '1340', type: 'debit', amountCents: cents }, { accountCode: '1020', type: 'credit', amountCents: cents }],
      })
      return id
    }
    const delivered = await mkLine('Blast chiller', { status: 'delivered', actualDeliveryDate: new Date(Date.now() - 40 * DAY) })
    const late = await mkLine('Walk-in cold room', { status: 'ordered', expectedDeliveryDate: new Date(Date.now() - 90 * DAY) })
    const waiting = await mkLine('Ice machine', { status: 'delivered', actualDeliveryDate: new Date(Date.now() - 5 * DAY) })
    await pay(delivered.id, 300_000, 60)
    await pay(late.id, 500_000, 120)
    await pay(waiting.id, 100_000, 30)
    await pay(null, 50_000, 10) // the payment row is gone → an orphan advance
    await prisma.fixedAssetEvent.create({
      data: { tenantId: A.tenantId, capexLineId: waiting.id, kind: 'capitalise', status: 'pending', effectiveDate: new Date(), payload: { classKey: 'kitchen_equipment' }, reason: 'Delivered and installed', requestedById: who.finA!.id },
    })
    const r = (await call('finA', 'GET', '/reports/advances')).json()
    const row = (lineId: string) => r.rows.find((x: { lineId: string }) => x.lineId === lineId)
    expect(row(delivered.id)).toMatchObject({ heldCents: 300_000, flags: 'delivered_uncapitalised', ageDays: 60, deliveredDays: 40 })
    expect(row(late.id)).toMatchObject({ heldCents: 500_000, flags: 'overdue_delivery', ageDays: 120 })
    expect(row(waiting.id)).toMatchObject({ heldCents: 100_000, flags: 'capitalisation_pending' })
    expect(r.rows.find((x: { flags: string }) => x.flags === 'orphan')).toMatchObject({ heldCents: 50_000, lineId: null })
    expect(r.byCompany).toEqual([expect.objectContaining({ tenantId: A.tenantId, heldCents: 950_000, glCents: 950_000, diffCents: 0 })])
    // Company B sees none of it.
    expect((await call('finB', 'GET', '/reports/advances')).json().rows).toEqual([])
  })
})

describe('tax (H23) — smallwares to confirm; the CEO\'s freeze', () => {
  it('initial allowance then WDV; smallwares listed apart; a frozen year is never restated', async () => {
    const r = (await call('finA', 'GET', `/reports/tax?taxYear=${Y}`)).json()
    expect(r.rows.map((x: { assetId: string }) => x.assetId).sort()).toEqual([oven.id, laptop.id].sort())
    expect(r.rows.find((x: { assetId: string }) => x.assetId === oven.id)).toMatchObject({
      additionsCents: 1_200_000, initialAllowanceCents: 300_000, depreciationCents: 135_000, closingWdvCents: 765_000, frozen: 'no',
    })
    expect(r.rows.find((x: { assetId: string }) => x.assetId === laptop.id)).toMatchObject({ initialAllowanceCents: 90_000, depreciationCents: 81_000, closingWdvCents: 189_000 })
    expect(r.toConfirm).toEqual([expect.objectContaining({ assetId: plates.layer.id, classKey: 'smallwares' })])
    expect(r.toConfirmNote).toMatch(/smallwares/)
    expect(r.byClass.map((c: { classKey: string }) => c.classKey).sort()).toEqual(['it_equipment', 'kitchen_equipment'])
    expect(r.totals.closingWdvCents).toBe(765_000 + 189_000)

    expect((await call('finA', 'POST', `/reports/tax/${Y}/freeze`, {})).statusCode).toBe(403)
    const f = await call('ceoA', 'POST', `/reports/tax/${Y}/freeze`, {})
    expect(f.statusCode).toBe(201)
    expect(f.json()).toMatchObject({ tenantId: A.tenantId, taxYear: Y })
    const again = await call('ceoA', 'POST', `/reports/tax/${Y}/freeze`, {})
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('TAX_YEAR_FROZEN')
    expect((await call('ceoA', 'POST', `/reports/tax/${Y + 1}/freeze`, {})).json().error.code).toBe('TAX_YEAR_OPEN')

    const kitchen = await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: A.tenantId, key: 'kitchen_equipment' } })
    expect((await call('ceoA', 'PATCH', `/classes/${kitchen.id}`, { taxRateBp: 3000 })).statusCode).toBe(200)
    const frozen = (await call('finA', 'GET', `/reports/tax?taxYear=${Y}`)).json()
    expect(frozen.frozen).toBe(true)
    expect(frozen.rows.find((x: { assetId: string }) => x.assetId === oven.id)).toMatchObject({ depreciationCents: 135_000, closingWdvCents: 765_000, frozen: 'yes' })
    expect((await call('finA', 'GET', `/reports/tax?taxYear=${Y + 1}`)).json().rows.find((x: { assetId: string }) => x.assetId === oven.id)).toMatchObject({ openingWdvCents: 765_000, depreciationCents: 229_500 })
  })

  it('there is no deferred-tax report (H24: not needed)', async () => {
    expect((await call('finA', 'GET', `/reports/deferred-tax?taxYear=${Y}`)).statusCode).toBe(404)
  })
})

describe('the schedule, CSV and scope', () => {
  it('posted and still to charge by month', async () => {
    const r = (await call('finA', 'GET', `/reports/schedule?from=${APRIL}&to=${m(3)}&groupBy=class`)).json()
    const it = r.rows.filter((x: { key: string }) => x.key === 'it_equipment')
    expect(it.find((x: { period: string }) => x.period === APRIL)).toMatchObject({ postedCents: 10_000, forecastCents: 0 })
    expect(it.find((x: { period: string }) => x.period === m(1))).toMatchObject({ postedCents: 0, forecastCents: 10_000 })
    expect(r.totals.postedCents).toBe((await prisma.fixedAssetDepreciation.findMany({ where: { tenantId: A.tenantId, reversedAt: null } })).reduce((t, x) => t + Number(x.amountCents), 0))
    expect((await call('finA', 'GET', '/reports/schedule?from=2026-13&to=2027-01')).statusCode).toBe(400)
  })

  it('every report\'s CSV is its JSON rows', async () => {
    for (const url of [
      `/reports/nbv?asOf=${JUNE30}&groupBy=brand`, '/reports/tie-out', `/reports/roll-forward?from=${APRIL}-01`,
      `/reports/schedule?from=${APRIL}&to=${m(2)}&groupBy=asset`, '/reports/advances', `/reports/tax?taxYear=${Y}`, '/?status=all',
    ]) {
      const json = (await call('finA', 'GET', url)).json()
      const rows = (json.rows ?? json.assets) as Array<Record<string, unknown>>
      const csv = await call('finA', 'GET', `${url}${url.includes('?') ? '&' : '?'}format=csv`)
      expect(csv.headers['content-type'], url).toMatch(/text\/csv/)
      expect(rows.length, url).toBeGreaterThan(0)
      expect(parseCsv(csv.body), url).toEqual(asStrings(rows))
    }
  })

  it('company B\'s scope never shows company A', async () => {
    for (const url of ['/reports/nbv', '/reports/roll-forward', `/reports/schedule?from=${APRIL}&to=${m(1)}`]) {
      const rows = (await call('finB', 'GET', url)).json().rows as Array<{ tenantId: string }>
      expect(rows.length, url).toBeGreaterThan(0)
      expect(rows.every((x) => x.tenantId === B.tenantId), url).toBe(true)
    }
    const t = (await call('finB', 'GET', '/reports/tie-out')).json()
    expect(t.companies.map((c: { tenantId: string }) => c.tenantId)).toEqual([B.tenantId])
    expect(t.companies[0].ok).toBe(true)
    const tax = (await call('finB', 'GET', `/reports/tax?taxYear=${Y}`)).json()
    expect(tax.tenantId).toBe(B.tenantId)
    expect(tax.rows.every((x: { assetId: string }) => x.assetId === ovenB.id)).toBe(true)
    void ovenB
  })
})
