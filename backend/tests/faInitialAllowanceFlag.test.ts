// H42 (Hasnain, 2026-10-16): the 25 % initial allowance is decided PER ASSET.
//
//   - FixedAsset.initialAllowanceEligible starts ticked for kitchen equipment
//     and generators & power, unticked for office, IT and every other class
//     (capitalisation default + the migration's backfill of existing rows; a
//     NULL row reads as that same rule);
//   - the tax view (taxSchedule) gives the initial allowance only to a ticked
//     asset, at the class rate or the statutory 25 % when the class carries 0;
//     book depreciation and the ledger never move;
//   - PUT /:id/initial-allowance: finance or the CEO only (403 otherwise),
//     audited with the asset's company; company B gets 404 on A's asset;
//     PATCH cannot carry the field (400 FIELD_NOT_EDITABLE); smallwares 422;
//   - once the asset's first tax year is frozen (the year the allowance falls
//     in) the tick is final: 409 TAX_YEAR_FROZEN and the frozen year is not
//     restated; another company's freeze does not lock this one's asset.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { FixedAsset, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { postAcquisition, nextAssetTag } from '../src/modules/fixedAssets/service.js'
import { findOrCreatePool } from '../src/modules/fixedAssets/pools.js'
import {
  taxSchedule, freezeTaxYear, defaultInitialAllowanceEligible, initialAllowanceEligibleOf, initialAllowanceBpOf,
} from '../src/modules/fixedAssets/tax.js'
import { taxYearOf } from '../src/modules/accounting/fiscalYear.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const BASE = '/accounting/fixed-assets'
const MIGRATION = fileURLToPath(new URL('../prisma/migrations/20261017090000_fa_initial_allowance_flag/migration.sql', import.meta.url))
// A finished tax year (frozen in the test) and the current, open one.
const Y = taxYearOf(new Date()).taxYear - 1
const IN_Y = new Date(`${Y}-04-15T07:00:00Z`)
const NOW_Y = taxYearOf(new Date()).taxYear
const IN_NOW = new Date(Date.now() - 2 * 86_400_000)

let app: FastifyInstance
const who: Record<string, { id: string; token: string }> = {}
interface Co { tenantId: string; conceptId: string; locationId: string }
let A: Co, B: Co
let seq = 0

async function mkCo(name: string): Promise<Co> {
  const tenantId = (await prisma.tenant.create({ data: { name, slug: `fa-ia-${++seq}-${RUN}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  return {
    tenantId,
    conceptId: (await prisma.concept.create({ data: { name: `${name} brand`, slug: `fa-ia-b-${seq}-${RUN}`, type: 'restaurant', tenantId } })).id,
    locationId: (await prisma.location.create({ data: { name: `${name} outlet`, slug: `fa-ia-l-${seq}-${RUN}`, tenantId } })).id,
  }
}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@faia.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

/** An asset inserted the way older rows were — no tick (NULL) unless given. */
async function mkAsset(co: Co, name: string, classKey: string, costCents: number, inServiceAt: Date, eligible?: boolean | null): Promise<FixedAsset> {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name, category: classKey, assetTag: await nextAssetTag(tx, co.tenantId), acquiredAt: inServiceAt, inServiceAt,
        costCents, originalCostCents: costCents, usefulLifeMonths: 60, conceptId: co.conceptId, locationId: co.locationId, acquisitionCreditCode: '2012',
        ...(eligible !== undefined ? { initialAllowanceEligible: eligible } : {}),
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: costCents, inputTaxCents: 0, inputTaxCode: null, natural: inServiceAt })
    return asset
  })
}

const call = (w: string, method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `${BASE}${url}`, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code
const rowOf = async (tenantId: string, year: number, assetId: string) => (await taxSchedule(tenantId, year)).rows.find((r) => r.assetId === assetId)

beforeAll(async () => {
  A = await mkCo('FA IA A')
  B = await mkCo('FA IA B')
  await mkUser('ceoA', 'admin', A.tenantId)
  await mkUser('finA', 'finance', A.tenantId)
  await mkUser('mgmtA', 'management', A.tenantId)
  await mkUser('fnbA', 'fnb_manager', A.tenantId)
  await mkUser('ceoB', 'admin', B.tenantId)
  await mkUser('finB', 'finance', B.tenantId)

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

describe('the default tick', () => {
  it('kitchen and power start ticked; office, IT and every other class unticked; NULL reads as that rule', () => {
    expect(defaultInitialAllowanceEligible('kitchen_equipment')).toBe(true)
    expect(defaultInitialAllowanceEligible('power_equipment')).toBe(true)
    for (const k of ['office_equipment', 'it_equipment', 'furniture_fixtures', 'vehicles', 'leasehold', 'buildings', 'smallwares', 'land']) {
      expect(defaultInitialAllowanceEligible(k)).toBe(false)
    }
    expect(initialAllowanceEligibleOf({ category: 'kitchen_equipment', initialAllowanceEligible: null })).toBe(true)
    expect(initialAllowanceEligibleOf({ category: 'it_equipment', initialAllowanceEligible: null })).toBe(false)
    expect(initialAllowanceEligibleOf({ category: 'kitchen_equipment', initialAllowanceEligible: false })).toBe(false)
    // Ticked on a class carrying 0 → the statutory 25 %; pooled / not depreciable never.
    expect(initialAllowanceBpOf({ category: 'office_equipment', initialAllowanceEligible: true }, { pooled: false, depreciable: true, taxInitialAllowanceBp: 0 })).toBe(2500)
    expect(initialAllowanceBpOf({ category: 'office_equipment', initialAllowanceEligible: true }, { pooled: false, depreciable: true, taxInitialAllowanceBp: 1000 })).toBe(1000)
    expect(initialAllowanceBpOf({ category: 'smallwares', initialAllowanceEligible: true }, { pooled: true, depreciable: true, taxInitialAllowanceBp: 0 })).toBe(0)
    expect(initialAllowanceBpOf({ category: 'land', initialAllowanceEligible: true }, { pooled: false, depreciable: false, taxInitialAllowanceBp: 0 })).toBe(0)
  })

  it('the migration backfills existing rows by the class rule, in every company, and leaves a set tick alone', async () => {
    const oven = await mkAsset(A, 'Old oven', 'kitchen_equipment', 100_000, IN_NOW, null)
    const gen = await mkAsset(B, 'Old generator', 'power_equipment', 100_000, IN_NOW, null)
    const pc = await mkAsset(A, 'Old PC', 'it_equipment', 100_000, IN_NOW, null)
    const desk = await mkAsset(B, 'Old desk', 'office_equipment', 100_000, IN_NOW, null)
    const ticked = await mkAsset(A, 'Ticked laptop', 'it_equipment', 100_000, IN_NOW, true)
    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8').replace(/^ALTER TABLE[^;]*;/m, ''))
    const flag = async (id: string) => (await prisma.fixedAsset.findUniqueOrThrow({ where: { id } })).initialAllowanceEligible
    expect(await flag(oven.id)).toBe(true)
    expect(await flag(gen.id)).toBe(true)
    expect(await flag(pc.id)).toBe(false)
    expect(await flag(desk.id)).toBe(false)
    expect(await flag(ticked.id)).toBe(true)
  })
})

describe('the tax view follows the tick; the books do not move', () => {
  it('kitchen ticked → 25 %; office unticked → 0; finance ticks office → 25 % (statutory); unticking kitchen → 0', async () => {
    const oven = await mkAsset(A, 'Combi oven', 'kitchen_equipment', 100_000, IN_NOW, true)
    const printer = await mkAsset(A, 'Printer', 'office_equipment', 100_000, IN_NOW, false)
    expect(await rowOf(A.tenantId, NOW_Y, oven.id)).toMatchObject({ initialAllowanceBp: 2500, initialAllowanceCents: 25_000, depreciationCents: 11_250, closingWdvCents: 63_750 })
    expect(await rowOf(A.tenantId, NOW_Y, printer.id)).toMatchObject({ initialAllowanceBp: 0, initialAllowanceCents: 0, depreciationCents: 15_000, closingWdvCents: 85_000 })

    const booksBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    const depBefore = await prisma.fixedAssetDepreciation.count({ where: { assetId: { in: [oven.id, printer.id] } } })

    const r = await call('finA', 'PUT', `/${printer.id}/initial-allowance`, { eligible: true, reason: 'Plant used in the bakery line' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ initialAllowanceEligible: true, changed: true, taxYear: NOW_Y })
    expect(await rowOf(A.tenantId, NOW_Y, printer.id)).toMatchObject({ initialAllowanceBp: 2500, initialAllowanceCents: 25_000, closingWdvCents: 63_750 })

    expect((await call('ceoA', 'PUT', `/${oven.id}/initial-allowance`, { eligible: false })).statusCode).toBe(200)
    expect(await rowOf(A.tenantId, NOW_Y, oven.id)).toMatchObject({ initialAllowanceBp: 0, initialAllowanceCents: 0, closingWdvCents: 85_000 })

    // Tax view only: no journal entry, no depreciation row.
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(booksBefore)
    expect(await prisma.fixedAssetDepreciation.count({ where: { assetId: { in: [oven.id, printer.id] } } })).toBe(depBefore)

    // Audited with the asset's company; a repeat is a no-op with no second row.
    const audits = await prisma.auditLog.findMany({ where: { action: 'fixed_asset.initial_allowance', entityId: printer.id } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ tenantId: A.tenantId, userId: who.finA!.id, before: { initialAllowanceEligible: false }, after: { initialAllowanceEligible: true } })
    expect((await call('finA', 'PUT', `/${printer.id}/initial-allowance`, { eligible: true })).json()).toMatchObject({ changed: false })
    expect(await prisma.auditLog.count({ where: { action: 'fixed_asset.initial_allowance', entityId: printer.id } })).toBe(1)

    // The asset page shows the tick.
    expect((await call('finA', 'GET', `/${printer.id}`)).json().asset.initialAllowanceEligible).toBe(true)
  })
})

describe('who may tick, and company separation', () => {
  it('company B (finance or CEO) gets 404 on A\'s asset; management and the F&B manager get 403; PATCH cannot carry it', async () => {
    const pc = await mkAsset(A, 'Back-office PC', 'it_equipment', 80_000, IN_NOW, false)
    const ovenB = await mkAsset(B, 'Oven B', 'kitchen_equipment', 90_000, IN_NOW, true)
    expect((await call('finB', 'PUT', `/${pc.id}/initial-allowance`, { eligible: true })).statusCode).toBe(404)
    expect((await call('ceoB', 'PUT', `/${pc.id}/initial-allowance`, { eligible: true })).statusCode).toBe(404)
    expect((await call('finA', 'PUT', `/${ovenB.id}/initial-allowance`, { eligible: false })).statusCode).toBe(404)
    expect((await call('mgmtA', 'PUT', `/${pc.id}/initial-allowance`, { eligible: true })).statusCode).toBe(403)
    expect((await call('fnbA', 'PUT', `/${pc.id}/initial-allowance`, { eligible: true })).statusCode).toBe(403)
    const p = await call('finA', 'PATCH', `/${pc.id}`, { initialAllowanceEligible: true })
    expect(p.statusCode).toBe(400)
    expect(code(p)).toBe('FIELD_NOT_EDITABLE')
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: pc.id } })).initialAllowanceEligible).toBe(false)
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: ovenB.id } })).initialAllowanceEligible).toBe(true)
    // B's own finance ticks B's asset.
    expect((await call('finB', 'PUT', `/${ovenB.id}/initial-allowance`, { eligible: false })).statusCode).toBe(200)
  })

  it('smallwares → 422 INITIAL_ALLOWANCE_NOT_APPLICABLE', async () => {
    const layer = await prisma.$transaction(async (tx) => {
      const pool = await findOrCreatePool(tx, { tenantId: A.tenantId, locationId: A.locationId, conceptId: A.conceptId, classKey: 'smallwares', typeKey: 'plates' })
      return tx.fixedAsset.create({
        data: {
          tenantId: A.tenantId, name: 'Plates', category: 'smallwares', kind: 'pool_layer', poolId: pool.id, quantity: 10, originalQuantity: 10,
          assetTag: await nextAssetTag(tx, A.tenantId), acquiredAt: IN_NOW, inServiceAt: IN_NOW, costCents: 20_000, originalCostCents: 20_000,
          usefulLifeMonths: 24, conceptId: A.conceptId, locationId: A.locationId, acquisitionCreditCode: '2012', initialAllowanceEligible: false,
        },
      })
    })
    const r = await call('finA', 'PUT', `/${layer.id}/initial-allowance`, { eligible: true })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('INITIAL_ALLOWANCE_NOT_APPLICABLE')
  })
})

describe('a frozen tax year is never restated', () => {
  it('after the CEO freezes the first-use year the tick is final (409); B\'s asset in the same year is unaffected by A\'s freeze', async () => {
    const mixer = await mkAsset(A, 'Planetary mixer', 'kitchen_equipment', 200_000, IN_Y, true)
    const mixerB = await mkAsset(B, 'Mixer B', 'kitchen_equipment', 200_000, IN_Y, true)
    const before = await rowOf(A.tenantId, Y, mixer.id)
    expect(before).toMatchObject({ initialAllowanceCents: 50_000 })

    await freezeTaxYear(A.tenantId, Y, who.ceoA!.id)
    const r = await call('ceoA', 'PUT', `/${mixer.id}/initial-allowance`, { eligible: false })
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('TAX_YEAR_FROZEN')
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: mixer.id } })).initialAllowanceEligible).toBe(true)
    expect(await rowOf(A.tenantId, Y, mixer.id)).toMatchObject({ frozen: true, initialAllowanceCents: 50_000, closingWdvCents: before!.closingWdvCents })
    expect(await prisma.auditLog.count({ where: { action: 'fixed_asset.initial_allowance', entityId: mixer.id } })).toBe(0)

    // B has not frozen year Y: its finance may still untick B's asset.
    expect((await call('finB', 'PUT', `/${mixerB.id}/initial-allowance`, { eligible: false })).statusCode).toBe(200)
    expect(await rowOf(B.tenantId, Y, mixerB.id)).toMatchObject({ initialAllowanceCents: 0, frozen: false })
  })
})

describe('a frozen LATER year also makes the tick final (gate fix)', () => {
  it('first year open but a later year frozen → 409; the detail page reports it; the same tick is a 200 no-op', async () => {
    const IN_Y1 = new Date(`${Y - 1}-04-15T07:00:00Z`)
    const fryer = await mkAsset(B, 'Fryer', 'kitchen_equipment', 100_000, IN_Y1, true)
    const desk = await mkAsset(B, 'Desk', 'office_equipment', 100_000, IN_Y1, false)
    // Before any freeze: applicable, not frozen.
    expect((await call('finB', 'GET', `/${fryer.id}`)).json().tax.initialAllowance).toEqual({ applicable: true, frozenTaxYear: null })

    // The CEO freezes year Y only (the fryer's SECOND year); its first year Y-1 stays open.
    await freezeTaxYear(B.tenantId, Y, who.ceoB!.id)
    const r = await call('finB', 'PUT', `/${fryer.id}/initial-allowance`, { eligible: false })
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('TAX_YEAR_FROZEN')
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: fryer.id } })).initialAllowanceEligible).toBe(true)
    expect((await call('finB', 'GET', `/${fryer.id}`)).json().tax.initialAllowance).toEqual({ applicable: true, frozenTaxYear: Y })
    // The open first year still shows the allowance, and the frozen second year is untouched.
    expect(await rowOf(B.tenantId, Y - 1, fryer.id)).toMatchObject({ initialAllowanceCents: 25_000, frozen: false })
    expect(await rowOf(B.tenantId, Y, fryer.id)).toMatchObject({ frozen: true })

    // Re-sending the tick it already has is a no-op, not a 409, and writes no audit row.
    const same = await call('finB', 'PUT', `/${fryer.id}/initial-allowance`, { eligible: true })
    expect(same.statusCode).toBe(200)
    expect(same.json()).toMatchObject({ changed: false, initialAllowanceEligible: true })
    expect((await call('ceoB', 'PUT', `/${desk.id}/initial-allowance`, { eligible: true })).statusCode).toBe(409)
    expect(await prisma.auditLog.count({ where: { action: 'fixed_asset.initial_allowance', entityId: { in: [fryer.id, desk.id] } } })).toBe(0)
  })

  it('smallwares / land report not applicable on the detail page', async () => {
    const plot = await mkAsset(A, 'Plot', 'land', 500_000, IN_NOW, false)
    expect((await call('finA', 'GET', `/${plot.id}`)).json().tax.initialAllowance.applicable).toBe(false)
    const r = await call('finA', 'PUT', `/${plot.id}/initial-allowance`, { eligible: true })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('INITIAL_ALLOWANCE_NOT_APPLICABLE')
  })
})
