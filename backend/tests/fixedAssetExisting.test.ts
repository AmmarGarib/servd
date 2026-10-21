// "Add existing asset" (owner, 2026-10-21: "It only showing buy equipment, give
// an option to add asset also, so we can add previously bought / Transferred
// from related party assets").
//
//   POST /accounting/fixed-assets/existing → a fixed-asset request of kind
//   'add_existing' in the ACTIVE company; the CEO approves it through the ONE
//   fixed-asset queue (events.applyEvent). Nothing posts before approval.
//   - bought before servd → Dr class cost / Cr 3010 at today's value;
//   - related party: Garibsons → Cr 2210; owners → Cr 3010; another servd
//     company → 422 RELATED_COMPANY_NOT_YET (waits for the owner's answer);
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
import { applyEvent, rejectEvent } from '../src/modules/fixedAssets/events.js'
import { chargeThrough } from '../src/modules/fixedAssets/service.js'
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
let A: Co, B: Co, C: Co
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
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('finA', 'finance', A.tenantId, [C.tenantId])
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

  it('another servd company: a company the caller is not in → 422; one it is in → 422 RELATED_COMPANY_NOT_YET (owner question)', async () => {
    const n = await raise('finA', body(A, { source: 'related_party', counterparty: 'servd_company', counterpartyTenantId: B.tenantId }))
    expect(n.statusCode).toBe(422)
    expect(n.json().error.code).toBe('COUNTERPARTY_NOT_YOURS')
    const self = await raise('finA', body(A, { source: 'related_party', counterparty: 'servd_company', counterpartyTenantId: A.tenantId }))
    expect(self.json().error.code).toBe('COUNTERPARTY_NOT_YOURS')
    const y = await raise('finA', body(A, { source: 'related_party', counterparty: 'servd_company', counterpartyTenantId: C.tenantId }))
    expect(y.statusCode).toBe(422)
    expect(y.json().error.code).toBe('RELATED_COMPANY_NOT_YET')
    // A related party must be named.
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
