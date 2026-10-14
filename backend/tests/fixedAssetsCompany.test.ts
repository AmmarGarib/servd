// Fixed assets v2 — company separation on every /accounting/fixed-assets route.
//
//   - company B gets 404 on every row of company A (GET / PATCH /:id, requests,
//     approve / reject / cancel, pools, pool requests, counts, class PATCH);
//   - /depreciate and the tax freeze touch the ACTIVE company only; PATCH
//     /policy writes only that company's settings row;
//   - another company's outlet, brand, supplier or pool attached to A's row → 422;
//   - the portfolio view labels each row with its company and totals per company;
//   - lookups and policy are per company;
//   - the F&B manager reads everything (200) and writes nothing (403) but a
//     smallwares count; POST / is 422 USE_CAPEX;
//   - finance's requests wait for the CEO (202); the CEO approves / rejects
//     (note required); the requester cancels; the CEO's own applies (201).
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
import { ensureAssetClasses, getFixedAssetPolicy } from '../src/modules/fixedAssets/classes.js'
import { postAcquisition, nextAssetTag } from '../src/modules/fixedAssets/service.js'
import { findOrCreatePool } from '../src/modules/fixedAssets/pools.js'
import { addMonths, currentPeriodPkt, startOfMonthPkt } from '../src/modules/fixedAssets/schedule.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k)
const mid = (p: string) => new Date(startOfMonthPkt(p).getTime() + 14 * 86_400_000 + 12 * 3_600_000)
const BASE = '/accounting/fixed-assets'

let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; conceptId: string; concept2: string; locationId: string; location2: string; supplierId: string }
let A: Co, B: Co
let ovenA: FixedAsset, ovenB: FixedAsset, fryerA: FixedAsset
let poolA: FixedAssetPool, poolB: FixedAssetPool
let seq = 0

async function mkCo(name: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const s = `${++seq}-${RUN}`
  return {
    tenantId,
    conceptId: (await prisma.concept.create({ data: { name: `${name} brand`, slug: `fac-b-${s}`, type: 'restaurant', tenantId } })).id,
    concept2: (await prisma.concept.create({ data: { name: `${name} brand 2`, slug: `fac-b2-${s}`, type: 'restaurant', tenantId } })).id,
    locationId: (await prisma.location.create({ data: { name: `${name} outlet`, slug: `fac-l-${s}`, tenantId } })).id,
    location2: (await prisma.location.create({ data: { name: `${name} outlet 2`, slug: `fac-l2-${s}`, tenantId } })).id,
    supplierId: (await prisma.supplier.create({ data: { name: `${name} supplier`, tenantId } })).id,
  }
}

async function mkUser(key: string, role: string, tenantId: string, alsoMemberOf: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@facompany.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoMemberOf]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

async function mkAsset(co: Co, name: string, costCents: number, inServiceAt: Date, classKey = 'kitchen_equipment'): Promise<FixedAsset> {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name, category: classKey, assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: inServiceAt, inServiceAt,
        costCents, originalCostCents: costCents, usefulLifeMonths: 12, conceptId: co.conceptId, locationId: co.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: costCents, inputTaxCents: 0, inputTaxCode: null, natural: inServiceAt })
    return asset
  })
}

async function mkPool(co: Co, units: number, costCents: number): Promise<FixedAssetPool> {
  return prisma.$transaction(async (tx) => {
    const pool = await findOrCreatePool(tx, { tenantId: co.tenantId, locationId: co.locationId, conceptId: co.conceptId, classKey: 'smallwares', typeKey: 'plates' })
    const layer = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name: 'Dinner plates', category: 'smallwares', kind: 'pool_layer', poolId: pool.id, quantity: units, originalQuantity: units,
        assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: mid(m(-2)), inServiceAt: mid(m(-2)), costCents, originalCostCents: costCents,
        usefulLifeMonths: 24, conceptId: co.conceptId, locationId: co.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, layer, { advancedCents: 0, owedCents: costCents, inputTaxCents: 0, inputTaxCode: null, natural: mid(m(-2)) })
    return pool
  })
}

const call = (w: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { authorization: `Bearer ${who[w]!.token}`, ...headers }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code

beforeAll(async () => {
  A = await mkCo('FA Company A')
  B = await mkCo('FA Company B')
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('fnbA', 'fnb_manager', A.tenantId)
  await mkUser('ceoB', 'admin', B.tenantId)
  await mkUser('finB', 'finance', B.tenantId)
  await mkUser('ceoBoth', 'admin', A.tenantId, [B.tenantId])
  ovenA = await mkAsset(A, 'Combi oven A', 120_000, mid(m(-3)))
  fryerA = await mkAsset(A, 'Fryer A', 60_000, mid(m(-3)))
  ovenB = await mkAsset(B, 'Combi oven B', 240_000, mid(m(-3)))
  poolA = await mkPool(A, 10, 24_000)
  poolB = await mkPool(B, 20, 48_000)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(fixedAssetRoutes, { prefix: BASE })
  await app.ready()
}, 90_000)

afterAll(async () => { await app?.close() })

describe('reads stay inside the company', () => {
  it('the register, one asset, lookups, policy, pools and runs are per company', async () => {
    const regA = (await call('finA', 'GET', '/')).json()
    expect(regA.assets.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining([ovenA.id, fryerA.id]))
    expect(regA.assets.some((a: { tenantId: string }) => a.tenantId !== A.tenantId)).toBe(false)
    expect(regA.totals).toMatchObject({ tenantId: A.tenantId, costCents: 120_000 + 60_000 + 24_000 })
    expect(regA.totalsByCompany).toHaveLength(1)
    const regB = (await call('finB', 'GET', '/')).json().assets.map((a: { id: string }) => a.id)
    expect(regB).toContain(ovenB.id)
    expect(regB).not.toContain(ovenA.id)

    expect((await call('finA', 'GET', `/${ovenA.id}`)).statusCode).toBe(200)
    expect((await call('finB', 'GET', `/${ovenA.id}`)).statusCode).toBe(404)

    const lookA = (await call('finA', 'GET', '/lookups')).json()
    expect(new Set(lookA.classes.map((c: { tenantId: string }) => c.tenantId))).toEqual(new Set([A.tenantId]))
    expect(lookA.locations.map((l: { id: string }) => l.id).sort()).toEqual([A.locationId, A.location2].sort())
    expect(lookA.brands.map((l: { id: string }) => l.id).sort()).toEqual([A.conceptId, A.concept2].sort())
    expect(lookA.suppliers.map((s: { id: string }) => s.id)).toEqual([A.supplierId])
    expect(lookA.pools.map((p: { id: string }) => p.id)).toEqual([poolA.id])
    expect(lookA.capabilities).toEqual({ canWrite: true, canCount: true, canApprove: false })
    expect(lookA.depreciation).toBe('automatic')

    const polB = (await call('finB', 'GET', '/policy')).json()
    expect(polB.policies.map((p: { tenantId: string }) => p.tenantId)).toEqual([B.tenantId])
    expect(polB.policy).not.toHaveProperty('autoDepreciation')
    expect(polB.policy).not.toHaveProperty('deferredTaxRateBp')

    expect((await call('finB', 'GET', '/pools')).json().pools.map((p: { id: string }) => p.id)).toEqual([poolB.id])
    const pa = (await call('finA', 'GET', '/pools')).json().pools[0]
    expect(pa).toMatchObject({ id: poolA.id, unitsOnHand: 10, costCents: 24_000, tenantId: A.tenantId })
    expect((await call('finB', 'GET', '/classes')).json().classes.every((c: { tenantId: string }) => c.tenantId === B.tenantId)).toBe(true)
  })

  it('the portfolio view labels companies and totals each one', async () => {
    const r = (await call('ceoBoth', 'GET', '/', undefined, { 'x-servd-portfolio': '1' })).json()
    const ids = r.assets.map((a: { id: string }) => a.id)
    expect(ids).toEqual(expect.arrayContaining([ovenA.id, ovenB.id]))
    expect(r.assets.find((a: { id: string }) => a.id === ovenB.id).companyName).toBe('FA Company B')
    expect(r.assets.find((a: { id: string }) => a.id === ovenA.id).companyName).toBe('FA Company A')
    expect(r.totals).toBeNull()
    expect(r.totalsByCompany.map((t: { tenantId: string }) => t.tenantId).sort()).toEqual([A.tenantId, B.tenantId].sort())
    // The same operator in single-company view sees A only.
    expect((await call('ceoBoth', 'GET', '/')).json().assets.map((a: { id: string }) => a.id)).not.toContain(ovenB.id)
  })

  it('a brand filter of another company is 404', async () => {
    expect((await call('finA', 'GET', `/?conceptId=${B.conceptId}`)).statusCode).toBe(404)
    expect((await call('finA', 'GET', `/?conceptId=${A.conceptId}`)).statusCode).toBe(200)
  })
})

describe('company B gets 404 on every row of company A', () => {
  it('asset, requests, decisions, pools, counts and classes', async () => {
    const pending = await call('finA', 'POST', `/${fryerA.id}/requests`, { kind: 'impairment', reason: 'Burner damaged in a fire', payload: { amountCents: 5_000 } })
    expect(pending.statusCode).toBe(202)
    const evId = pending.json().event.id as string
    const classA = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: A.tenantId, key: 'kitchen_equipment' } })).id

    const attempts: Array<[string, 'GET' | 'POST' | 'PATCH', string, unknown]> = [
      ['read A\'s asset', 'GET', `/${ovenA.id}`, undefined],
      ['edit A\'s asset', 'PATCH', `/${ovenA.id}`, { name: 'Hijacked' }],
      ['request on A\'s asset', 'POST', `/${ovenA.id}/requests`, { kind: 'disposal', reason: 'Selling it off quietly', payload: { kind: 'scrap' } }],
      ['dispose A\'s asset', 'POST', `/${ovenA.id}/dispose`, { disposedAt: new Date().toISOString().slice(0, 10) }],
      ['approve A\'s request', 'POST', `/requests/${evId}/approve`, {}],
      ['reject A\'s request', 'POST', `/requests/${evId}/reject`, { note: 'no' }],
      ['cancel A\'s request', 'POST', `/requests/${evId}/cancel`, {}],
      ['write off A\'s pool', 'POST', `/pools/${poolA.id}/requests`, { kind: 'write_off', units: 1, reason: 'Broken in service today' }],
      ['count A\'s pool', 'POST', `/pools/${poolA.id}/counts`, { countedUnits: 1 }],
      ['edit A\'s class', 'PATCH', `/classes/${classA}`, { label: 'Hijacked' }],
    ]
    for (const [what, method, url, body] of attempts) {
      const r = await call('ceoB', method, url, body)
      expect(r.statusCode, what).toBe(404)
    }
    // Nothing moved.
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: ovenA.id } })).name).toBe('Combi oven A')
    expect((await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: evId } })).status).toBe('pending')
    expect((await prisma.fixedAssetClass.findUniqueOrThrow({ where: { id: classA } })).label).toBe('Kitchen equipment')
    expect(await prisma.fixedAssetEvent.count({ where: { poolId: poolA.id } })).toBe(0)
    // B's requests list never shows A's.
    expect((await call('ceoB', 'GET', '/requests?status=pending')).json().requests.map((e: { id: string }) => e.id)).not.toContain(evId)
    // A's CEO decides it (reject needs a note).
    expect(code(await call('ceoA', 'POST', `/requests/${evId}/reject`, {}))).toBe('NOTE_REQUIRED')
    const rej = await call('ceoA', 'POST', `/requests/${evId}/reject`, { note: 'Get a repair quote first' })
    expect(rej.statusCode).toBe(200)
    expect(rej.json().event).toMatchObject({ status: 'rejected', decisionNote: 'Get a repair quote first', tenantId: A.tenantId })
  })

  it('"charge now" and the tax freeze touch only the active company', async () => {
    const r = await call('ceoB', 'POST', '/depreciate', {})
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tenantId: B.tenantId, companyName: 'FA Company B', throughPeriod: m(-1) })
    expect(await prisma.fixedAssetDepreciation.count({ where: { tenantId: A.tenantId } })).toBe(0)
    expect(await prisma.fixedAssetDepreciation.count({ where: { assetId: ovenB.id } })).toBe(3)
    expect(await prisma.fixedAssetRun.count({ where: { tenantId: A.tenantId } })).toBe(0)
    // An unfinished month and a bad period.
    expect(code(await call('finA', 'POST', '/depreciate', { throughPeriod: cur }))).toBe('MONTH_NOT_ENDED')
    expect((await call('finA', 'POST', '/depreciate', { throughPeriod: '2026-13' })).statusCode).toBe(400)

    const frozen = await call('ceoB', 'POST', '/reports/tax/2025/freeze', {})
    expect(frozen.statusCode).toBe(201)
    expect(frozen.json().tenantId).toBe(B.tenantId)
    expect(await prisma.fixedAssetTaxYear.count({ where: { tenantId: A.tenantId } })).toBe(0)
  })

  it('PATCH /policy writes only the active company\'s settings', async () => {
    const before = await getFixedAssetPolicy(B.tenantId)
    const r = await call('ceoA', 'PATCH', '/policy', { capexUncapitalisedAlertDays: 21, assetTagPrefix: 'GS-' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ tenantId: A.tenantId, capexUncapitalisedAlertDays: 21, assetTagPrefix: 'GS-' })
    expect((await getFixedAssetPolicy(A.tenantId)).assetTagPrefix).toBe('GS-')
    expect(await getFixedAssetPolicy(B.tenantId)).toEqual(before)
    // No automatic-depreciation switch, no deferred tax (H24).
    expect((await call('ceoA', 'PATCH', '/policy', { autoDepreciation: false })).statusCode).toBe(400)
    expect((await call('ceoA', 'PATCH', '/policy', { deferredTaxRateBp: 2900 })).statusCode).toBe(400)
    await call('ceoA', 'PATCH', '/policy', { assetTagPrefix: 'FA-' })
  })
})

describe('another company\'s ids are refused (422); requests bind to the row\'s company', () => {
  it('transfer to B\'s outlet / brand, B\'s supplier, B\'s pool', async () => {
    const t1 = await call('finA', 'POST', `/${ovenA.id}/requests`, { kind: 'transfer', reason: 'Moving to the second kitchen', payload: { toLocationId: B.locationId } })
    expect(t1.statusCode).toBe(422)
    expect(code(t1)).toBe('LOCATION_NOT_IN_COMPANY')
    expect(code(await call('finA', 'POST', `/${ovenA.id}/requests`, { kind: 'transfer', reason: 'Moving to the other brand', payload: { toConceptId: B.conceptId } }))).toBe('CONCEPT_NOT_IN_COMPANY')
    expect(code(await call('finA', 'PATCH', `/${ovenA.id}`, { supplierId: B.supplierId }))).toBe('SUPPLIER_NOT_IN_COMPANY')
    expect(code(await call('finA', 'POST', `/pools/${poolA.id}/requests`, { kind: 'transfer_units', units: 2, reason: 'Sending plates across', payload: { toPoolId: poolB.id } }))).toBe('POOL_NOT_IN_COMPANY')
    expect(code(await call('finA', 'POST', `/pools/${poolA.id}/requests`, { kind: 'transfer_units', units: 2, reason: 'Sending plates across', payload: { toLocationId: B.locationId } }))).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await prisma.fixedAssetEvent.count({ where: { tenantId: B.tenantId } })).toBe(0)

    // A's own outlet: applied at once (no approval for a transfer), in A.
    const ok = await call('finA', 'POST', `/${ovenA.id}/requests`, { kind: 'transfer', reason: 'Moving to the second kitchen', payload: { toLocationId: A.location2 } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().event).toMatchObject({ tenantId: A.tenantId, status: 'posted', kind: 'transfer' })
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: ovenA.id } })).locationId).toBe(A.location2)
    const units = await call('finA', 'POST', `/pools/${poolA.id}/requests`, { kind: 'transfer_units', units: 2, reason: 'Sending plates to outlet 2', payload: { toLocationId: A.location2 } })
    expect(units.statusCode).toBe(201)
    expect(units.json().event.tenantId).toBe(A.tenantId)
  })

  it('PATCH edits descriptive fields only (audited); A\'s own supplier is fine', async () => {
    const r = await call('finA', 'PATCH', `/${ovenA.id}`, { name: 'Rational combi oven', serialNumber: 'RC-123', supplierId: A.supplierId, warrantyUntil: '2028-01-31' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ name: 'Rational combi oven', serialNumber: 'RC-123', supplierId: A.supplierId, costCents: 120_000 })
    const log = await prisma.auditLog.findFirst({ where: { action: 'fixed_asset.update', entityId: ovenA.id } })
    expect(log).toMatchObject({ tenantId: A.tenantId, category: 'accounting' })
    for (const field of ['costCents', 'usefulLifeMonths', 'conceptId', 'locationId', 'category', 'capexLineId', 'inServiceAt']) {
      const bad = await call('finA', 'PATCH', `/${ovenA.id}`, { [field]: 1 })
      expect(bad.statusCode, field).toBe(400)
      expect(code(bad)).toBe('FIELD_NOT_EDITABLE')
    }
  })
})

describe('roles', () => {
  it('the F&B manager reads (200) and writes nothing but a count (403)', async () => {
    const ev = (await prisma.fixedAssetEvent.findFirstOrThrow({ where: { tenantId: A.tenantId } })).id
    const classA = (await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: A.tenantId, key: 'it_equipment' } })).id
    for (const url of ['/', '/lookups', '/runs', '/requests', '/pools', '/classes', '/policy', `/${ovenA.id}`,
      '/reports/nbv', '/reports/schedule', '/reports/roll-forward', '/reports/tie-out', '/reports/advances', '/reports/tax']) {
      expect((await call('fnbA', 'GET', url)).statusCode, url).toBe(200)
    }
    const writes: Array<['POST' | 'PATCH', string, unknown]> = [
      ['POST', '/', { name: 'x' }],
      ['PATCH', `/${ovenA.id}`, { name: 'x' }],
      ['POST', `/${ovenA.id}/requests`, { kind: 'disposal', reason: 'Selling it off today', payload: { kind: 'scrap' } }],
      ['POST', `/${ovenA.id}/dispose`, { disposedAt: new Date().toISOString().slice(0, 10) }],
      ['POST', '/depreciate', {}],
      ['POST', `/requests/${ev}/approve`, {}],
      ['POST', `/requests/${ev}/reject`, { note: 'x' }],
      ['POST', `/requests/${ev}/cancel`, {}],
      ['PATCH', `/classes/${classA}`, { label: 'x' }],
      ['PATCH', '/policy', { capexAdvanceOverdueDays: 10 }],
      ['POST', `/pools/${poolA.id}/requests`, { kind: 'write_off', units: 1, reason: 'Broken in service today' }],
      ['POST', '/reports/tax/2025/freeze', {}],
    ]
    for (const [method, url, body] of writes) expect((await call('fnbA', method, url, body)).statusCode, `${method} ${url}`).toBe(403)
    const count = await call('fnbA', 'POST', `/pools/${poolA.id}/counts`, { countedUnits: 7, note: 'Monthly count' })
    expect(count.statusCode).toBe(201)
    expect(count.json()).toMatchObject({ countedUnits: 7, onHandUnits: 8, shortfallUnits: 1 })
    expect(count.json().event).toMatchObject({ kind: 'count', status: 'posted', tenantId: A.tenantId })
    expect((await call('finA', 'GET', '/pools')).json().pools.find((p: { id: string }) => p.id === poolA.id).lastCount).toMatchObject({ countedUnits: 7, shortfallUnits: 1 })
  })

  it('POST / is 422 USE_CAPEX', async () => {
    const r = await call('finA', 'POST', '/', { name: 'oven', category: 'kitchen_equipment', funding: 'cash', costCents: 100_000 })
    expect(r.statusCode).toBe(422)
    expect(r.json().error).toMatchObject({ code: 'USE_CAPEX', message: expect.stringMatching(/only through CapEx/) })
  })

  it('finance asks, the CEO approves; the requester cancels; the CEO\'s own applies at once', async () => {
    const r = await call('finA', 'POST', `/${fryerA.id}/dispose`, { disposedAt: new Date().toISOString().slice(0, 10), proceedsCents: 0 })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toMatchObject({ status: 'pending', applied: false })
    const id = r.json().event.id as string
    const asFin = (await call('finA', 'GET', '/requests?status=pending')).json().requests.find((e: { id: string }) => e.id === id)
    expect(asFin).toMatchObject({ canDecide: false, canCancel: true, kind: 'disposal', companyName: 'FA Company A' })
    const asCeo = (await call('ceoA', 'GET', '/requests?status=pending')).json().requests.find((e: { id: string }) => e.id === id)
    expect(asCeo).toMatchObject({ canDecide: true, canCancel: true })
    expect(code(await call('finA', 'POST', `/${fryerA.id}/dispose`, { disposedAt: new Date().toISOString().slice(0, 10) }))).toBe('REQUEST_PENDING')

    const ok = await call('ceoA', 'POST', `/requests/${id}/approve`, {})
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'posted', event: { status: 'posted', id } })
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: fryerA.id } })).status).toBe('disposed')
    expect(code(await call('ceoA', 'POST', `/requests/${id}/approve`, {}))).toBe('NOT_PENDING')
    expect(code(await call('finA', 'POST', `/${fryerA.id}/requests`, { kind: 'disposal', reason: 'Selling it off today', payload: { kind: 'scrap' } }))).toBe('ALREADY_DISPOSED')

    const est = await call('finA', 'POST', `/${ovenA.id}/requests`, { kind: 'change_estimate', reason: 'Heavier use than planned', payload: { remainingLifeMonths: 6 } })
    expect(est.statusCode).toBe(202)
    const c = await call('finA', 'POST', `/requests/${est.json().event.id}/cancel`, {})
    expect(c.statusCode).toBe(200)
    expect(c.json().event.status).toBe('cancelled')

    const own = await call('ceoA', 'POST', `/${ovenA.id}/requests`, { kind: 'change_estimate', reason: 'Heavier use than planned', payload: { remainingLifeMonths: 6 } })
    expect(own.statusCode).toBe(201)
    expect(own.json()).toMatchObject({ status: 'posted', applied: true })
    expect(code(await call('finA', 'POST', `/${ovenA.id}/requests`, { kind: 'disposal', effectiveDate: '2000-01-01', reason: 'Backdated far too early', payload: { kind: 'scrap' } }))).toBe('DISPOSAL_DATE')
    expect(code(await call('finA', 'POST', `/${ovenA.id}/requests`, { kind: 'impairment', reason: 'short', payload: { amountCents: 1 } }))).toBe('REASON_REQUIRED')

    // The audit trail carries the asset's company.
    expect(await prisma.auditLog.count({ where: { entityId: id, tenantId: A.tenantId } })).toBeGreaterThanOrEqual(2)
  })

  it('the CEO edits a class (codes fixed); one asset\'s page has its schedule, events and journal', async () => {
    const it = await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: A.tenantId, key: 'it_equipment' } })
    expect(code(await call('ceoA', 'PATCH', `/classes/${it.id}`, { costAccountCode: '1999' }))).toBe('FIELD_NOT_EDITABLE')
    const r = await call('ceoA', 'PATCH', `/classes/${it.id}`, { defaultLifeMonths: 48, taxRateBp: 2500 })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ defaultLifeMonths: 48, taxRateBp: 2500, costAccountCode: '1530' })
    const kitchen = await prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId: A.tenantId, key: 'kitchen_equipment' } })
    expect(code(await call('ceoA', 'PATCH', `/classes/${kitchen.id}`, { pooled: true }))).toBe('CLASS_IN_USE')

    const one = (await call('finA', 'GET', `/${ovenA.id}`)).json()
    expect(one.asset).toMatchObject({ id: ovenA.id, tenantId: A.tenantId, locationId: A.location2 })
    expect(one.schedule.upcoming.length).toBeGreaterThan(0)
    expect(one.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['transfer', 'change_estimate']))
    expect(one.journal.map((j: { reference: string }) => j.reference)).toContain(`fixed_asset.acquire:${ovenA.id}`)
    expect(one.tax.toConfirm).toBe(false)
  })
})
