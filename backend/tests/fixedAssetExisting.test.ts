// "Add existing asset" (owner, 2026-10-21: "It only showing buy equipment, give
// an option to add asset also, so we can add previously bought / Transferred
// from related party assets").
//
//   POST /accounting/fixed-assets/existing → a fixed-asset request of kind
//   'add_existing' in the ACTIVE company; the CEO approves it through the ONE
//   fixed-asset queue (events.applyEvent). Nothing posts before approval.
//   - bought before servd → Dr class cost / Cr 3010 at today's value;
//   - related party: Garibsons → Cr 2210; owners → Cr 3010; another servd
//     company (owner: "Book value, no gain or loss") → the giver's register
//     asset leaves at its NBV after the catch-up charge, the receiver's comes
//     in at that NBV, and the pair goes through the inter-company engine;
//   - dated the in-service date (a closed month: 422 PERIOD_LOCKED when raised,
//     refused and kept pending when approved), depreciation over the remaining
//     life through chargeThrough;
//   - company B gets 404 on company A's request; documents ride the
//     fixed_asset record-files provider and move to the asset on approval.
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
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { applyEvent, rejectEvent, createRequest } from '../src/modules/fixedAssets/events.js'
import { chargeThrough, postAcquisition, nextAssetTag } from '../src/modules/fixedAssets/service.js'
import { addMonths, currentPeriodPkt, endOfMonthPkt } from '../src/modules/fixedAssets/schedule.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'
import { recordFileRoutes } from '../src/modules/recordFiles/routes.js'
import '../src/modules/recordFiles/providers.js'

const RUN = Math.random().toString(36).slice(2, 8)
const BASE = '/accounting/fixed-assets'
const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k)
const day = (k: number) => `${m(k)}-15`

let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; conceptId: string; locationId: string; kitchen: string; smallwares: string; land: string }
let A: Co, B: Co, C: Co, D: Co, E: Co
let seq = 0

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n').toString('base64')

async function mkCo(name: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `fae-${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const s = `${++seq}-${RUN}`
  const cls = (key: string) => prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId, key } }).then((c) => c.id)
  return {
    tenantId,
    conceptId: (await prisma.concept.create({ data: { name: `${name} brand`, slug: `fae-b-${s}`, type: 'restaurant', tenantId } })).id,
    locationId: (await prisma.location.create({ data: { name: `${name} outlet`, slug: `fae-l-${s}`, tenantId } })).id,
    kitchen: await cls('kitchen_equipment'),
    smallwares: await cls('smallwares'),
    land: await cls('land'),
  }
}

async function mkUser(key: string, role: UserRole, tenantId: string, alsoMemberOf: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@faexisting.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoMemberOf]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${who[key]!.token}` }, ...(payload !== undefined && { payload: payload as object }) })

async function balance(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { account: { code, tenantId }, journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
async function trialBalance(tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
const entries = (tenantId: string) => prisma.journalEntry.count({ where: { tenantId } })

function body(co: Co, extra: Record<string, unknown> = {}) {
  return {
    source: 'pre_servd', classId: co.kitchen, name: 'Combi oven', serial: 'RAT-9921', conceptId: co.conceptId,
    valueCents: 240_000, inServiceDate: day(-1), remainingLifeMonths: 24, reason: 'Oven bought in 2024, before servd went live',
    ...extra,
  }
}

async function raise(key: string, b: Record<string, unknown>) {
  const r = await call(key, 'POST', `${BASE}/existing`, b)
  return r
}

beforeAll(async () => {
  A = await mkCo('Existing A')
  B = await mkCo('Existing B')
  C = await mkCo('Existing C')
  D = await mkCo('Existing D')
  E = await mkCo('Existing E')
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('ceoAD', 'admin', A.tenantId, [D.tenantId, E.tenantId])
  await mkUser('finA', 'finance', A.tenantId, [C.tenantId, D.tenantId, E.tenantId])
  await mkUser('finB', 'finance', B.tenantId)
  await mkUser('fnbA', 'fnb_manager', A.tenantId)
  await mkUser('finC', 'finance', C.tenantId)
  invalidateSetupCache()
  app = Fastify({ bodyLimit: 30 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(fixedAssetRoutes, { prefix: BASE })
  await app.register(recordFileRoutes, { prefix: '/record-files' })
  await app.ready()
}, 120_000)

afterAll(async () => { invalidateSetupCache(); await app?.close() })

describe('add an existing asset — bought before servd', () => {
  it('waits for the CEO and posts nothing; approved: Dr cost / Cr 3010 at the value, on the register, depreciated over the remaining life', async () => {
    const before = await entries(A.tenantId)
    const r = await raise('finA', body(A))
    expect(r.statusCode, r.body).toBe(202)
    const ev = r.json().event as { id: string; tenantId: string; kind: string; status: string; amountCents: number; existing: { sourceLabel: string; name: string } }
    expect(ev).toMatchObject({ kind: 'add_existing', status: 'pending', tenantId: A.tenantId, amountCents: 240_000, existing: { sourceLabel: 'Bought before servd', name: 'Combi oven' } })
    expect(await entries(A.tenantId)).toBe(before)
    expect(await prisma.fixedAsset.count({ where: { tenantId: A.tenantId } })).toBe(0)

    // The queue the approvals inbox reads lists it.
    const q = await call('ceoA', 'GET', `${BASE}/requests?status=pending`)
    expect((q.json().requests as Array<{ id: string }>).map((x) => x.id)).toContain(ev.id)

    // The purchase document rides the fixed_asset provider while it waits.
    const up = await call('finA', 'POST', `/record-files/fixed_asset/${ev.id}`, { files: [{ fileName: 'invoice.pdf', mime: 'application/pdf', dataBase64: PDF }] })
    expect(up.statusCode, up.body).toBe(201)
    expect((await call('finB', 'GET', `/record-files/fixed_asset/${ev.id}`)).statusCode).toBe(404)

    // Only the CEO approves.
    await expect(applyEvent(ev.id, who.finA!.id)).rejects.toMatchObject({ code: 'APPROVER_ONLY' })
    const done = await applyEvent(ev.id, who.ceoA!.id)
    expect(done.status).toBe('posted')
    const asset = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: done.assetId! } })
    expect(asset).toMatchObject({
      tenantId: A.tenantId, conceptId: A.conceptId, category: 'kitchen_equipment', status: 'active', kind: 'individual',
      usefulLifeMonths: 24, acquisitionCreditCode: '3010', serialNumber: 'RAT-9921', capexLineId: null,
    })
    expect(Number(asset.costCents)).toBe(240_000)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `fixed_asset.acquire:${asset.id}` }, include: { lines: { include: { account: true } } } })
    expect(je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1510', 'debit', 240_000], ['3010', 'credit', 240_000]])
    expect(je.entryDate.toISOString().slice(0, 10)).toBe(day(-1))
    expect(await balance(A.tenantId, '3010')).toBe(-240_000)

    // The document moved to the asset.
    const files = await call('finA', 'GET', `/record-files/fixed_asset/${asset.id}`)
    expect(files.statusCode, files.body).toBe(200)
    expect((files.json() as { files: unknown[] }).files).toHaveLength(1)

    // Depreciation: the first month = value ÷ remaining months.
    await chargeThrough(A.tenantId, m(-1), { postedBy: 'system' })
    const dep = await prisma.fixedAssetDepreciation.findFirstOrThrow({ where: { assetId: asset.id, period: m(-1), reversedAt: null } })
    expect(Number(dep.amountCents)).toBe(10_000)
    expect(await balance(A.tenantId, '1591')).toBe(-10_000)
    expect(await trialBalance(A.tenantId)).toBe(0)
  })

  it('the CEO\'s own request applies at once (201)', async () => {
    const r = await raise('ceoA', body(A, { name: 'Walk-in chiller', valueCents: 120_000, remainingLifeMonths: 12 }))
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().event.status).toBe('posted')
  })
})

describe('add an existing asset — from a related party', () => {
  it('Garibsons → Cr 2210; owners → Cr 3010', async () => {
    const g = await raise('finA', body(A, { source: 'related_party', counterparty: 'garibsons', name: 'Generator', valueCents: 500_000 }))
    expect(g.statusCode, g.body).toBe(202)
    expect(g.json().event.existing.sourceLabel).toMatch(/Garibsons/)
    const gDone = await applyEvent(g.json().event.id, who.ceoA!.id)
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: gDone.assetId! } })).acquisitionCreditCode).toBe('2210')
    expect(await balance(A.tenantId, '2210')).toBe(-500_000)

    const before3010 = await balance(A.tenantId, '3010')
    const o = await raise('finA', body(A, { source: 'related_party', counterparty: 'owners', name: 'Dining tables', valueCents: 90_000 }))
    expect(o.statusCode, o.body).toBe(202)
    expect(o.json().event.existing.sourceLabel).toBe('Contributed by the owners')
    await applyEvent(o.json().event.id, who.ceoA!.id)
    expect(await balance(A.tenantId, '3010')).toBe(before3010 - 90_000)
    expect(await trialBalance(A.tenantId)).toBe(0)
  })

  it('a related party must be named', async () => {
    expect((await raise('finA', body(A, { source: 'related_party' }))).statusCode).toBe(400)
  })

})

describe('rules', () => {
  it('reject → nothing posted, no asset', async () => {
    const before = await entries(A.tenantId)
    const assets = await prisma.fixedAsset.count({ where: { tenantId: A.tenantId } })
    const r = await raise('finA', body(A, { name: 'Ice machine' }))
    expect(r.statusCode).toBe(202)
    const done = await rejectEvent(r.json().event.id, who.ceoA!.id, 'No valuation attached')
    expect(done.status).toBe('rejected')
    expect(await entries(A.tenantId)).toBe(before)
    expect(await prisma.fixedAsset.count({ where: { tenantId: A.tenantId } })).toBe(assets)
    await expect(applyEvent(r.json().event.id, who.ceoA!.id)).rejects.toMatchObject({ code: 'NOT_PENDING' })
  })

  it('company B gets 404 on company A\'s request; the create binds to the active company', async () => {
    const r = await raise('finA', body(A, { name: 'Dough mixer' }))
    const id = r.json().event.id as string
    expect((await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id } })).tenantId).toBe(A.tenantId)
    expect((await call('finB', 'POST', `${BASE}/requests/${id}/cancel`)).statusCode).toBe(404)
    const list = await call('finB', 'GET', `${BASE}/requests?status=pending`)
    expect((list.json().requests as Array<{ id: string }>).map((x) => x.id)).not.toContain(id)
    // Company A's class / brand / outlet named from company B → 422.
    expect((await raise('finB', body(A))).json().error.code).toBe('ASSET_CLASS_NOT_IN_COMPANY')
    expect((await raise('finB', body(B, { conceptId: A.conceptId }))).json().error.code).toBe('CONCEPT_NOT_IN_COMPANY')
    expect((await raise('finB', body(B, { conceptId: null, locationId: A.locationId }))).json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    // A finance login in A and C, active company A: the request is A's.
    expect((await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id } })).tenantId).toBe(A.tenantId)
  })

  it('refuses: plain POST / (USE_CAPEX), F&B manager, short reason, pooled class, shared with no outlet, future date, life over twice the class', async () => {
    expect((await call('finA', 'POST', BASE, {})).json().error.code).toBe('USE_CAPEX')
    expect((await raise('fnbA', body(A))).statusCode).toBe(403)
    expect((await raise('finA', body(A, { reason: 'too short' }))).json().error.code).toBe('REASON_REQUIRED')
    expect((await raise('finA', body(A, { classId: A.smallwares, locationId: A.locationId }))).json().error.code).toBe('POOLED_CLASS_NOT_ALLOWED')
    expect((await raise('finA', body(A, { conceptId: null }))).json().error.code).toBe('LOCATION_REQUIRED_FOR_SHARED')
    const shared = await raise('finA', body(A, { conceptId: null, locationId: A.locationId, name: 'Shared fridge' }))
    expect(shared.statusCode, shared.body).toBe(202)
    expect((await raise('finA', body(A, { inServiceDate: day(1) }))).json().error.code).toBe('IN_SERVICE_DATE')
    expect((await raise('finA', body(A, { remainingLifeMonths: 121 }))).json().error.code).toBe('REMAINING_LIFE')
    expect((await raise('finA', body(A, { salvageCents: 240_000 }))).json().error.code).toBe('SALVAGE_TOO_HIGH')
    expect((await raise('finA', body(A, { valueCents: 0 }))).statusCode).toBe(400)
    // Default remaining life = the class life.
    const d = await raise('finA', body(A, { remainingLifeMonths: undefined, name: 'Range hood' }))
    expect(d.statusCode, d.body).toBe(202)
    expect(d.json().event.payload.remainingLifeMonths).toBe(60)
    // Land: not depreciated.
    const land = await raise('ceoA', body(A, { classId: A.land, name: 'Plot', remainingLifeMonths: undefined }))
    expect(land.statusCode, land.body).toBe(201)
    const plot = await prisma.fixedAsset.findFirstOrThrow({ where: { tenantId: A.tenantId, name: 'Plot' } })
    expect(plot).toMatchObject({ method: 'none', usefulLifeMonths: 0 })
    expect(await trialBalance(A.tenantId)).toBe(0)
  })

  it('a closed month: refused when raised (PERIOD_LOCKED); closed while waiting → the approval is refused and the request stays pending', async () => {
    const r = await raise('finC', body(C, { inServiceDate: day(-1) }))
    expect(r.statusCode, r.body).toBe(202)
    const id = r.json().event.id as string
    await prisma.periodLock.create({ data: { tenantId: C.tenantId, lockedThrough: endOfMonthPkt(m(-1)), lockedBy: who.finC!.id } })
    const closed = await raise('finC', body(C, { inServiceDate: day(-2) }))
    expect(closed.statusCode).toBe(422)
    expect(closed.json().error.code).toBe('PERIOD_LOCKED')
    const before = await entries(C.tenantId)
    const ceoC = await prisma.user.create({
      data: { name: 'ceoC', email: `ceoC.${RUN}@faexisting.test`, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId: C.tenantId },
    })
    await expect(applyEvent(id, ceoC.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    const ev = await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id } })
    expect(ev.status).toBe('pending')
    expect(ev.errorMessage).toMatch(/closed/)
    expect(await entries(C.tenantId)).toBe(before)
    expect(await prisma.fixedAsset.count({ where: { tenantId: C.tenantId } })).toBe(0)
    // Today's month is open.
    const ok = await raise('finC', body(C, { inServiceDate: day(0) }))
    expect(ok.statusCode, ok.body).toBe(202)
  })
})

// ─── Another servd company gave it (owner, 2026-10-21: "Book value, no gain or loss") ───

const mid = (k: number) => new Date(`${m(k)}-15T12:00:00+05:00`)
async function giverAsset(co: Co, name: string, costCents = 120_000, life = 12): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const a = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name, category: 'kitchen_equipment', assetTag: await nextAssetTag(tx, co.tenantId),
        acquiredAt: mid(-6), inServiceAt: mid(-6), costCents, originalCostCents: costCents, usefulLifeMonths: life,
        conceptId: co.conceptId, locationId: co.locationId, acquisitionCreditCode: '2012', serialNumber: `SN-${name}`,
      },
    })
    await postAcquisition(tx, a, { advancedCents: 0, owedCents: costCents, inputTaxCents: 0, inputTaxCode: null, natural: mid(-6) })
    return a.id
  })
}
const transferBody = (giver: Co, giverAssetId: string, extra: Record<string, unknown> = {}) => ({
  source: 'related_party', counterparty: 'servd_company', counterpartyTenantId: giver.tenantId, giverAssetId,
  conceptId: A.conceptId, inServiceDate: day(-1), reason: 'Oven moved from the D kitchen to the A kitchen', ...extra,
})
async function linesOf(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference }, include: { lines: { include: { account: true } } } })
  return je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()
}

describe('add an existing asset — another servd company gave it', () => {
  it('book value after the catch-up, no gain or loss, giver out / receiver in, the pair through the inter-company engine, depreciation continues', async () => {
    const oven = await giverAsset(D, 'Deck oven')
    // D charged m(-6) and m(-5) only; the approval must catch up m(-4)..m(-2) (the month before the transfer).
    await chargeThrough(D.tenantId, m(-5), { postedBy: 'system' })

    const pick = await call('finA', 'GET', `${BASE}/existing/giver-assets?giverTenantId=${D.tenantId}&date=${day(-1)}`)
    expect(pick.statusCode, pick.body).toBe(200)
    const listed = (pick.json().assets as Array<{ assetId: string; nbvCents: number; remainingLifeMonths: number }>).find((a) => a.assetId === oven)!
    expect(listed).toMatchObject({ nbvCents: 70_000, remainingLifeMonths: 7 })

    const beforeA = await entries(A.tenantId), beforeD = await entries(D.tenantId)
    const r = await raise('finA', transferBody(D, oven))
    expect(r.statusCode, r.body).toBe(202)
    const ev = r.json().event as { id: string; payload: Record<string, unknown>; existing: { sourceLabel: string } }
    expect(ev.payload).toMatchObject({ valueCents: 70_000, remainingLifeMonths: 7, classKey: 'kitchen_equipment', name: 'Deck oven', giverAssetId: oven })
    expect(ev.existing.sourceLabel).toBe('From Existing D')
    expect(await entries(A.tenantId)).toBe(beforeA)
    expect(await entries(D.tenantId)).toBe(beforeD)

    // The CEO must belong to both companies.
    await expect(applyEvent(ev.id, who.ceoA!.id)).rejects.toMatchObject({ code: 'NOT_IN_BOTH_COMPANIES', statusCode: 403 })
    expect((await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('pending')
    expect(await entries(D.tenantId)).toBe(beforeD)

    const done = await applyEvent(ev.id, who.ceoAD!.id)
    expect(done.status).toBe('posted')
    expect(Number(done.amountCents)).toBe(70_000)

    // Giver: caught up through m(-2), out at NBV — Dr accumulated + Dr 1395 / Cr cost, nothing on 8030.
    const charged = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: oven, reversedAt: null } })
    expect(charged.map((c) => c.period).sort()).toEqual([m(-6), m(-5), m(-4), m(-3), m(-2)])
    expect(await linesOf(D.tenantId, `fixed_asset.transfer_out:${oven}`)).toEqual([['1395', 'debit', 70_000], ['1510', 'credit', 120_000], ['1591', 'debit', 50_000]])
    const gone = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: oven } })
    expect(gone).toMatchObject({ status: 'disposed', disposalKind: 'transferred_out' })
    expect(Number(gone.disposalProceedsCents)).toBe(70_000)
    const out = await prisma.fixedAssetEvent.findFirstOrThrow({ where: { assetId: oven, kind: 'transfer_out' } })
    expect(out).toMatchObject({ tenantId: D.tenantId, status: 'posted', parentEventId: ev.id })

    // Receiver: in at NBV over the giver's remaining months.
    const got = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: done.assetId! } })
    expect(got).toMatchObject({ tenantId: A.tenantId, status: 'active', usefulLifeMonths: 7, conceptId: A.conceptId, serialNumber: 'SN-Deck oven' })
    expect(Number(got.costCents)).toBe(70_000)
    expect(await linesOf(A.tenantId, `fixed_asset.acquire:${got.id}`)).toEqual([['1395', 'credit', 70_000], ['1510', 'debit', 70_000]])

    // The pair: one inter-company transfer, posted in both books; 1395 back to zero; no gain or loss.
    const ic = await prisma.intercompanyTransfer.findFirstOrThrow({ where: { source: 'asset_transfer', sourceRef: `asset:${oven}` } })
    expect(ic).toMatchObject({ tenantId: A.tenantId, counterpartyTenantId: D.tenantId, status: 'posted', kind: 'charge' })
    expect(Number(ic.amountCents)).toBe(70_000)
    const dueTo = await prisma.account.findFirstOrThrow({ where: { tenantId: A.tenantId, controlledBy: 'intercompany', counterpartyTenantId: D.tenantId, type: 'liability' } })
    const dueFrom = await prisma.account.findFirstOrThrow({ where: { tenantId: D.tenantId, controlledBy: 'intercompany', counterpartyTenantId: A.tenantId, type: 'asset' } })
    expect(Number(dueTo.code)).toBeGreaterThanOrEqual(2150)
    expect(Number(dueFrom.code)).toBeGreaterThanOrEqual(1450)
    const aDue = await balance(A.tenantId, dueTo.code)
    const dDue = await balance(D.tenantId, dueFrom.code)
    expect(aDue).toBe(-70_000)
    expect(dDue).toBe(70_000)
    expect(aDue + dDue).toBe(0)
    for (const t of [A.tenantId, D.tenantId]) {
      expect(await balance(t, '1395')).toBe(0)
      expect(await balance(t, '8030')).toBe(0)
    }
    expect(await balance(D.tenantId, '1510')).toBe(0)
    expect(await balance(D.tenantId, '1591')).toBe(0)

    // Depreciation continues on the receiver at NBV ÷ remaining months.
    await chargeThrough(A.tenantId, m(-1), { postedBy: 'system' })
    const dep = await prisma.fixedAssetDepreciation.findFirstOrThrow({ where: { assetId: got.id, period: m(-1), reversedAt: null } })
    expect(Number(dep.amountCents)).toBe(10_000)
    await chargeThrough(D.tenantId, m(-1), { postedBy: 'system' })
    expect(await prisma.fixedAssetDepreciation.count({ where: { assetId: oven, period: m(-1), reversedAt: null } })).toBe(0)

    // Neither side is undone by hand: no un-dispose of the giver's, no void of the receiver's.
    await expect(createRequest({ kind: 'undispose', assetId: oven, tenantId: D.tenantId, reason: 'Bring the oven back please', payload: {} }, { id: who.finA!.id, role: 'finance' }))
      .rejects.toMatchObject({ code: 'TRANSFERRED_OUT' })
    await expect(createRequest({ kind: 'void', assetId: got.id, tenantId: A.tenantId, reason: 'Capitalised in error, void it', payload: {} }, { id: who.finA!.id, role: 'finance' }))
      .rejects.toMatchObject({ code: 'TRANSFERRED_IN' })
    // Gone from the giver's register: it cannot be transferred again.
    expect((await raise('finA', transferBody(D, oven))).json().error.code).toBe('ASSET_NOT_ON_GIVER_REGISTER')

    expect(await trialBalance(A.tenantId)).toBe(0)
    expect(await trialBalance(D.tenantId)).toBe(0)
  })

  it('refuses: a company the caller is not in, its own company, an asset not on the giver\'s register; reject → nothing', async () => {
    const fridge = await giverAsset(D, 'Fridge')
    expect((await raise('finB', transferBody(D, fridge))).json().error.code).toBe('COUNTERPARTY_NOT_YOURS')
    expect((await call('finB', 'GET', `${BASE}/existing/giver-assets?giverTenantId=${D.tenantId}`)).json().error.code).toBe('COUNTERPARTY_NOT_YOURS')
    expect((await raise('finA', transferBody(A, fridge))).json().error.code).toBe('COUNTERPARTY_NOT_YOURS')
    expect((await raise('finA', transferBody(B, fridge))).json().error.code).toBe('COUNTERPARTY_NOT_YOURS')
    // Named under the wrong company → not on that giver's register.
    expect((await raise('finA', transferBody(E, fridge))).json().error.code).toBe('ASSET_NOT_ON_GIVER_REGISTER')
    expect((await raise('finA', transferBody(D, 'no-such-asset'))).json().error.code).toBe('ASSET_NOT_ON_GIVER_REGISTER')
    // Company B never sees A's request.
    const beforeA = await entries(A.tenantId), beforeD = await entries(D.tenantId)
    const r = await raise('finA', transferBody(D, fridge))
    expect(r.statusCode, r.body).toBe(202)
    expect((await call('finB', 'POST', `${BASE}/requests/${r.json().event.id}/cancel`)).statusCode).toBe(404)
    expect((await rejectEvent(r.json().event.id, who.ceoAD!.id, 'Keep it at D for now')).status).toBe('rejected')
    expect(await entries(A.tenantId)).toBe(beforeA)
    expect(await entries(D.tenantId)).toBe(beforeD)
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: fridge } })).status).toBe('active')
    expect(await prisma.intercompanyTransfer.count({ where: { sourceRef: `asset:${fridge}` } })).toBe(0)
  })

  it('a closed month in the GIVER refuses it — when raised, and when it closed while waiting', async () => {
    const mixer = await giverAsset(E, 'Mixer')
    const r = await raise('finA', transferBody(E, mixer))
    expect(r.statusCode, r.body).toBe(202)
    await prisma.periodLock.create({ data: { tenantId: E.tenantId, lockedThrough: endOfMonthPkt(m(-1)), lockedBy: who.ceoAD!.id } })
    const beforeA = await entries(A.tenantId), beforeE = await entries(E.tenantId)
    await expect(applyEvent(r.json().event.id, who.ceoAD!.id)).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    expect((await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: r.json().event.id } })).status).toBe('pending')
    expect(await entries(A.tenantId)).toBe(beforeA)
    expect(await entries(E.tenantId)).toBe(beforeE)
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: mixer } })).status).toBe('active')
    const again = await raise('finA', transferBody(E, mixer))
    expect(again.statusCode).toBe(422)
    expect(again.json().error.code).toBe('PERIOD_LOCKED')
    expect(await trialBalance(E.tenantId)).toBe(0)
  })
})

// Owner, 2026-10-31: "1st the asset will go to chart of accounts, then will be transferred to Fixed assets register"
// — finance books it to an asset account, then moves it into the register; the CEO approves (Dr class / Cr that account).
describe('add an existing asset — already in the chart of accounts', () => {
  it('moves the value out of the account the CEO approves; refuses money accounts and more than the account holds', async () => {
    await mkUser('ceoChart', 'admin', C.tenantId)
    const acc = await prisma.account.create({ data: { tenantId: C.tenantId, code: '1710', name: 'Generator (booked by JV)', type: 'asset' } })
    const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
    await postJournalEntry({
      tenantId: C.tenantId, sourceType: 'manual', sourceId: `gen-${RUN}`, description: 'Generator bought', entryDate: new Date(`${day(0)}T07:00:00Z`),
      lines: [{ accountCode: '1710', type: 'debit', amountCents: 300_000 }, { accountCode: '1010', type: 'credit', amountCents: 300_000 }],
    })
    const b = { source: 'chart_account', sourceAccountCode: '1710', classId: C.kitchen, name: 'Generator', locationId: C.locationId, valueCents: 300_000, inServiceDate: day(0), remainingLifeMonths: 36, reason: 'Booked to 1710 first, now on the register' }

    // Never from cash, and never the related-party fields.
    expect((await raise('finC', { ...b, sourceAccountCode: '1010' })).json().error.code).toBe('SOURCE_ACCOUNT_NOT_ALLOWED')
    expect((await raise('finC', { ...b, valueCents: 300_001 })).json().error.code).toBe('SOURCE_ACCOUNT_SHORT')

    const before = await entries(C.tenantId)
    const r = await raise('finC', b)
    expect(r.statusCode, r.body).toBe(202)
    const ev = r.json().event as { id: string; existing: { sourceLabel: string } }
    expect(ev.existing.sourceLabel).toBe('Moved from account 1710')
    expect(await entries(C.tenantId)).toBe(before)
    // The pending move counts: nothing more can be moved out of 1710.
    expect((await raise('finC', { ...b, valueCents: 1 })).json().error.code).toBe('SOURCE_ACCOUNT_SHORT')
    // Another company's finance has no 1710 of its own to move.
    expect((await raise('finB', { ...b, classId: B.kitchen, locationId: B.locationId })).json().error.code).toBe('SOURCE_ACCOUNT_NOT_ALLOWED')

    await applyEvent(ev.id, who['ceoChart']!.id)
    expect(await balance(C.tenantId, '1710')).toBe(0)
    expect(await balance(C.tenantId, '1510')).toBe(300_000)
    expect(await trialBalance(C.tenantId)).toBe(0)
    const asset = await prisma.fixedAsset.findFirstOrThrow({ where: { tenantId: C.tenantId, name: 'Generator' } })
    expect(asset).toMatchObject({ costCents: 300_000, acquisitionCreditCode: '1710', usefulLifeMonths: 36 })
    expect(acc.id).toBeTruthy()
  })
})
