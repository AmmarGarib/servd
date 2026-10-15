// The accountant's answers of 2026-10-15 (Hasnain H33, H34, H35, H42).
//
//   - H33: a vendor whose filer status is unknown (or no supplier at all) is
//     withheld at the NON-filer rate, flagged for the ATL check; only a
//     confirmed filer gets the filer rate. A company with withholding off
//     withholds nothing (two companies).
//   - H42: the 25 % initial allowance is for kitchen equipment and generators
//     & power only. A NEW company is seeded with office / IT at 0; the
//     migration moves rows still on the old 2500 to 0 and keeps a rate the CEO
//     edited (and never touches kitchen).
//   - H35: smallwares are deducted in full for tax in the year bought —
//     depreciation = cost, closing WDV 0 — and have no row the year after.
//   - H34: packaging stock is eligible for the federal input cross set-off.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { computeWithholding, withholdingRatesFor } from '../src/lib/withholding.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { findOrCreatePool } from '../src/modules/fixedAssets/pools.js'
import { taxSchedule } from '../src/modules/fixedAssets/tax.js'
import { taxYearOf } from '../src/modules/accounting/fiscalYear.js'
import { CROSS_SETOFF_ELIGIBLE_CLASSES } from '../src/modules/accounting/salesTaxReturn.js'

const RUN = Math.random().toString(36).slice(2, 8)
const MIGRATION = fileURLToPath(new URL('../prisma/migrations/20261015100000_initial_allowance_kitchen_power/migration.sql', import.meta.url))
// A finished tax year (1 July – 30 June) and a day inside it.
const Y = taxYearOf(new Date()).taxYear - 1
const IN_Y = new Date(`${Y}-04-15T07:00:00Z`)

let tenantA: string, tenantB: string
let seq = 0
async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `h1015-${++seq}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
const cls = (tenantId: string, key: string) => prisma.fixedAssetClass.findFirstOrThrow({ where: { tenantId, key } })

beforeAll(async () => {
  tenantA = await company('H1015 A')
  tenantB = await company('H1015 B')
  // A withholds; B has withholding switched off.
  await prisma.operationsConfig.create({ data: { tenantId: tenantA, scope: 'global', scopeId: null, withholdingTaxEnabled: true } })
}, 60_000)

describe('H33 — unknown filer status is withheld at the non-filer rate', () => {
  const at = new Date('2026-10-10T07:00:00Z')

  it('unknown status and no supplier → the non-filer rate with needsAtlCheck; a confirmed filer → the filer rate', async () => {
    const cfg = await withholdingRatesFor(prisma, tenantA)
    expect(cfg.enabled).toBe(true)
    const r = cfg.rates['153_1_b']
    expect(r.nonFilerBps).toBeGreaterThan(r.filerBps)
    const base = 100_000
    const pct = (bps: number) => Math.round((base * bps) / 10_000)

    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { filerStatus: 'unknown', whtExemptUntil: null }, section: '153_1_b', baseCents: base, at }))
      .toEqual({ whtCents: pct(r.nonFilerBps), rateBps: r.nonFilerBps, section: '153_1_b', filerStatus: 'unknown', exempt: false, needsAtlCheck: true })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: null, section: '153_1_b', baseCents: base, at }))
      .toEqual({ whtCents: pct(r.nonFilerBps), rateBps: r.nonFilerBps, section: '153_1_b', filerStatus: 'unknown', exempt: false, needsAtlCheck: true })
    // 'exempt' with no valid certificate is unknown too.
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { filerStatus: 'exempt', whtExemptUntil: null }, section: '153_1_b', baseCents: base, at }))
      .toMatchObject({ rateBps: r.nonFilerBps, filerStatus: 'unknown', needsAtlCheck: true })
    expect(await computeWithholding(prisma, { tenantId: tenantA, supplier: { filerStatus: 'filer', whtExemptUntil: null }, section: '153_1_b', baseCents: base, at }))
      .toEqual({ whtCents: pct(r.filerBps), rateBps: r.filerBps, section: '153_1_b', filerStatus: 'filer', exempt: false, needsAtlCheck: false })
  })

  it('company B (withholding off) withholds nothing, whatever the status', async () => {
    expect(await computeWithholding(prisma, { tenantId: tenantB, supplier: null, section: '153_1_b', baseCents: 100_000, at }))
      .toMatchObject({ whtCents: 0, rateBps: 0, needsAtlCheck: false })
  })
})

describe('H42 — initial allowance on kitchen and power only', () => {
  it('a NEW company: office and IT at 0, kitchen and power at 2500', async () => {
    await ensureAssetClasses(tenantA)
    expect((await cls(tenantA, 'office_equipment')).taxInitialAllowanceBp).toBe(0)
    expect((await cls(tenantA, 'it_equipment')).taxInitialAllowanceBp).toBe(0)
    expect((await cls(tenantA, 'kitchen_equipment')).taxInitialAllowanceBp).toBe(2500)
    expect((await cls(tenantA, 'power_equipment')).taxInitialAllowanceBp).toBe(2500)
  })

  it('the migration: a row still on the old 2500 → 0; a CEO-edited rate and kitchen are kept; other companies untouched', async () => {
    await ensureAssetClasses(tenantB)
    // B was seeded before H42 (office at the old default) and the CEO edited IT to 10 %.
    await prisma.fixedAssetClass.update({ where: { id: (await cls(tenantB, 'office_equipment')).id }, data: { taxInitialAllowanceBp: 2500 } })
    await prisma.fixedAssetClass.update({ where: { id: (await cls(tenantB, 'it_equipment')).id }, data: { taxInitialAllowanceBp: 1000 } })
    // A's CEO later chose 5 % for office equipment.
    await prisma.fixedAssetClass.update({ where: { id: (await cls(tenantA, 'office_equipment')).id }, data: { taxInitialAllowanceBp: 500 } })

    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'))

    expect((await cls(tenantB, 'office_equipment')).taxInitialAllowanceBp).toBe(0)
    expect((await cls(tenantB, 'it_equipment')).taxInitialAllowanceBp).toBe(1000)
    expect((await cls(tenantB, 'kitchen_equipment')).taxInitialAllowanceBp).toBe(2500)
    expect((await cls(tenantB, 'power_equipment')).taxInitialAllowanceBp).toBe(2500)
    expect((await cls(tenantA, 'office_equipment')).taxInitialAllowanceBp).toBe(500)
    expect((await cls(tenantA, 'it_equipment')).taxInitialAllowanceBp).toBe(0)
  })
})

describe('H35 — smallwares deducted in full in the year bought', () => {
  it('taxSchedule: depreciation = cost and closing 0 in the year bought; no row the next year; B sees none of it', async () => {
    await ensureAssetClasses(tenantA)
    const conceptId = (await prisma.concept.create({ data: { name: 'H1015 Cafe', slug: `h1015-b-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
    const locationId = (await prisma.location.create({ data: { name: 'H1015 Clifton', slug: `h1015-l-${RUN}`, tenantId: tenantA } })).id
    const layer = await prisma.$transaction(async (tx) => {
      const pool = await findOrCreatePool(tx, { tenantId: tenantA, locationId, conceptId, classKey: 'smallwares', typeKey: 'plates' })
      return tx.fixedAsset.create({
        data: {
          tenantId: tenantA, name: 'Side plates', category: 'smallwares', kind: 'pool_layer', poolId: pool.id, quantity: 20, originalQuantity: 20,
          assetTag: `SW-${RUN}`, acquiredAt: IN_Y, inServiceAt: IN_Y, costCents: 150_000, originalCostCents: 150_000,
          usefulLifeMonths: 24, conceptId, locationId, acquisitionCreditCode: '2012',
        },
      })
    })

    const year = await taxSchedule(tenantA, Y)
    expect(year.rows.find((r) => r.assetId === layer.id)).toMatchObject({
      classKey: 'smallwares', openingWdvCents: 0, additionsCents: 150_000, initialAllowanceCents: 0, depreciationCents: 150_000, closingWdvCents: 0,
    })
    const next = await taxSchedule(tenantA, Y + 1)
    expect(next.rows.some((r) => r.assetId === layer.id)).toBe(false)
    expect((await taxSchedule(tenantB, Y)).rows.some((r) => r.assetId === layer.id)).toBe(false)
  })
})

describe('H34 — packaging is eligible for the cross set-off', () => {
  it('CROSS_SETOFF_ELIGIBLE_CLASSES includes packaging', () => {
    expect(CROSS_SETOFF_ELIGIBLE_CLASSES).toContain('packaging')
    expect([...CROSS_SETOFF_ELIGIBLE_CLASSES].sort()).toEqual(['beverage', 'food', 'packaging'])
  })
})
