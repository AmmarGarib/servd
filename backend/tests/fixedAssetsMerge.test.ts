// Combining companies (POST /tenants/merge) — the fixed-asset register v2.
//
//   - assets, their events, pools, tax years, runs, depreciation rows and
//     prepayment releases move to the target; a colliding asset tag gets
//     '-<source slug>'; the source's classes merge into the target's by key
//     (a key the target lacks moves);
//   - the depreciation run keeps charging the moved asset in the target, on
//     the target's accounts;
//   - capitalising the moved asset's CapEx line again is 409
//     ALREADY_CAPITALISED (the register moved with its CapEx project);
//   - the merge needs the CEO of BOTH companies (404 otherwise).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { chargeThrough } from '../src/modules/fixedAssets/service.js'
import { createRequest } from '../src/modules/fixedAssets/events.js'
import { addMonths, currentPeriodPkt, startOfMonthPkt } from '../src/modules/fixedAssets/schedule.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'

const DAY = 86_400_000
const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k)
const mid = (p: string) => new Date(startOfMonthPkt(p).getTime() + 14 * DAY + 12 * 3_600_000)
const RUN = Date.now().toString(36)
let app: FastifyInstance
let S = '' // source
let D = '' // target
let sSlug = ''
let ceo: Who
let ceoS: Who
const ids: Record<string, string> = {}

async function company(name: string) {
  const slug = `fam-${name.toLowerCase()}-${RUN}`
  const id = (await prisma.tenant.create({ data: { name: `FA merge ${name}`, slug } })).id
  await ensureChartOfAccounts(id)
  await ensureAssetClasses(id)
  const conceptId = (await prisma.concept.create({ data: { name: `FAM ${name}`, slug: `fam-b-${name.toLowerCase()}-${RUN}`, type: 'restaurant', tenantId: id } })).id
  const locationId = (await prisma.location.create({ data: { slug: `fam-l-${name.toLowerCase()}-${RUN}`, name: `Outlet ${name}`, tenantId: id } })).id
  return { id, slug, conceptId, locationId }
}

beforeAll(async () => {
  const s = await company('Source')
  const d = await company('Target')
  S = s.id; D = d.id; sSlug = s.slug
  ceo = await mkUser('fam-ceo', 'admin', D)
  await prisma.tenantMember.create({ data: { tenantId: S, userId: ceo.id } })
  ceoS = await mkUser('fam-ceo-s', 'admin', S)

  // Source: an oven capitalised from a CapEx line, charged through m(-2).
  const project = await prisma.capexProject.create({ data: { tenantId: S, conceptId: s.conceptId, name: 'Source fit-out' } })
  const line = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'Equipment', item: 'Combi oven', unitCostCents: 120_000 } })
  ids.capexLine = line.id
  const oven = await prisma.fixedAsset.create({
    data: {
      tenantId: S, name: 'Combi oven', category: 'kitchen_equipment', assetTag: 'FA-00001', acquiredAt: mid(m(-3)), inServiceAt: mid(m(-3)),
      costCents: 120_000, originalCostCents: 120_000, usefulLifeMonths: 12, conceptId: s.conceptId, locationId: s.locationId, capexLineId: line.id,
    },
  })
  ids.oven = oven.id
  const run = await chargeThrough(S, m(-2), { postedBy: 'system' })
  expect(run.chargedCount).toBe(2)
  // A class the target does not have.
  await prisma.fixedAssetClass.create({ data: { tenantId: S, key: 'neon_signs', label: 'Neon signs', costAccountCode: '1520', accumAccountCode: '1593', defaultLifeMonths: 36 } })
  ids.pool = (await prisma.fixedAssetPool.create({ data: { tenantId: S, locationId: s.locationId, classKey: 'smallwares', typeKey: 'knives', label: 'Knives — Source' } })).id
  ids.event = (await prisma.fixedAssetEvent.create({
    data: { tenantId: S, assetId: oven.id, kind: 'impairment', status: 'pending', effectiveDate: new Date(), payload: { amountCents: 10_000 }, amountCents: 10_000, reason: 'Door hinge cracked', requestedById: ceoS.id },
  })).id
  ids.taxYear = (await prisma.fixedAssetTaxYear.create({
    data: { tenantId: S, assetId: oven.id, taxYear: 2026, rateBp: 1500, openingWdvCents: 0, additionsCents: 120_000, initialAllowanceCents: 30_000, depreciationCents: 13_500, disposalProceedsCents: 0, closingWdvCents: 76_500, frozenById: ceoS.id },
  })).id
  ids.release = (await prisma.prepaidRelease.create({ data: { tenantId: S, sourceType: 'capex_payment', sourceId: 'pay-1', period: m(-2), amountCents: 5_000 } })).id

  // Target: its own FA-00001.
  ids.targetAsset = (await prisma.fixedAsset.create({
    data: { tenantId: D, name: 'Chiller', category: 'kitchen_equipment', assetTag: 'FA-00001', acquiredAt: mid(m(-3)), inServiceAt: mid(m(-3)), costCents: 60_000, originalCostCents: 60_000, usefulLifeMonths: 12, conceptId: d.conceptId },
  })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

const merge = (who: Who) => app.inject({ method: 'POST', url: '/tenants/merge', headers: { authorization: `Bearer ${who.token}` }, payload: { sourceId: S, targetId: D } })

describe('merging moves the fixed-asset register', () => {
  it('needs the CEO of both companies', async () => {
    expect((await merge(ceoS)).statusCode).toBe(404)
  })

  it('assets, events, pools, tax years, runs, depreciation and prepaid releases move; the colliding tag is suffixed; classes merge by key', async () => {
    const res = await merge(ceo)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ assetTagsRenamed: 1 })

    const oven = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: ids.oven } })
    expect(oven).toMatchObject({ tenantId: D, assetTag: `FA-00001-${sSlug}` })
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: ids.targetAsset } })).assetTag).toBe('FA-00001')
    expect((await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: ids.event } })).tenantId).toBe(D)
    expect((await prisma.fixedAssetPool.findUniqueOrThrow({ where: { id: ids.pool } })).tenantId).toBe(D)
    expect((await prisma.fixedAssetTaxYear.findUniqueOrThrow({ where: { id: ids.taxYear } })).tenantId).toBe(D)
    expect((await prisma.prepaidRelease.findUniqueOrThrow({ where: { id: ids.release } })).tenantId).toBe(D)
    expect(await prisma.fixedAssetDepreciation.count({ where: { assetId: ids.oven, tenantId: D } })).toBe(2)
    expect(await prisma.fixedAssetRun.count({ where: { tenantId: S } })).toBe(0)
    for (const model of ['fixedAsset', 'fixedAssetEvent', 'fixedAssetPool', 'fixedAssetTaxYear', 'fixedAssetDepreciation', 'prepaidRelease', 'fixedAssetClass'] as const) {
      expect(await (prisma[model] as unknown as { count(a: unknown): Promise<number> }).count({ where: { tenantId: S } }), model).toBe(0)
    }
    // One row per class key in the target; the key it lacked came across.
    const classes = await prisma.fixedAssetClass.findMany({ where: { tenantId: D }, select: { key: true } })
    expect(classes.filter((c) => c.key === 'kitchen_equipment')).toHaveLength(1)
    expect(classes.some((c) => c.key === 'neon_signs')).toBe(true)
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: S } })).deletedAt).toBeInstanceOf(Date)
    // The ledger came across too: the moved charges sit on the target's 1591.
    const moved = await prisma.journalEntry.findFirstOrThrow({
      where: { reference: `fixed_asset.depreciation:${ids.oven}:${m(-3)}` }, include: { lines: { include: { account: true } } },
    })
    expect(moved.tenantId).toBe(D)
    expect(moved.lines.every((l) => l.account.tenantId === D)).toBe(true)
  })

  it('the depreciation run keeps charging the moved asset in the target', async () => {
    const run = await chargeThrough(D, m(-1), { postedBy: 'system' })
    const oven = run.results.find((r) => r.assetId === ids.oven)!
    expect(oven).toMatchObject({ status: 'charged' })
    expect(oven.months.map((x) => x.period)).toEqual([m(-1)])
    const e = await prisma.journalEntry.findFirstOrThrow({
      where: { reference: `fixed_asset.depreciation:${ids.oven}:${m(-1)}` }, include: { lines: { include: { account: true } } },
    })
    expect(e.tenantId).toBe(D)
    expect(e.lines.map((l) => [l.account.code, l.type]).sort()).toEqual([['1591', 'credit'], ['6150', 'debit']])
    expect(e.lines.every((l) => l.account.tenantId === D)).toBe(true)
  })

  it("capitalising the moved asset's CapEx line again is 409 ALREADY_CAPITALISED", async () => {
    await expect(createRequest(
      { kind: 'capitalise', capexLineId: ids.capexLine!, tenantId: D, reason: 'Capitalise the oven again', payload: { classKey: 'kitchen_equipment' } },
      { id: ceo.id, role: 'admin' },
    )).rejects.toMatchObject({ code: 'ALREADY_CAPITALISED', statusCode: 409 })
  })
})
