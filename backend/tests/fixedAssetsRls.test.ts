// Fixed assets v2 — row-level security on the register's tables.
//
// With RLS_ENFORCE=1 a request in company A's context cannot read or update
// company B's rows in fixed_assets, fixed_asset_depreciation,
// fixed_asset_classes, fixed_asset_pools, fixed_asset_events,
// fixed_asset_tax_years and fixed_asset_runs; serviceClient (workers, boot)
// sees both companies.
//
// The test database is built with `db push` and has no RLS helpers, so this
// file installs them (the phase-2 functions and the wave-B policy block, read
// from the migrations — one copy of the SQL) and checks visibility under a
// role that does not bypass RLS (the test connects as a superuser, which
// always does).
//
// RLS_ENFORCE is read when lib/prisma.ts is first evaluated, and the shared
// setup already loaded it — so the modules are reset and imported again here.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Prisma } from '@prisma/client'

process.env.RLS_ENFORCE = '1'

type Clients = typeof import('../src/lib/prisma.js')
let prisma: Clients['prisma']
let serviceClient: Clients['serviceClient']
let runWithRlsContext: typeof import('../src/lib/rlsContext.js')['runWithRlsContext']

const ROLE = 'servd_rls_w3_fa_api'
const RUN = Math.random().toString(36).slice(2, 8)
const MODELS = ['fixedAsset', 'fixedAssetDepreciation', 'fixedAssetClass', 'fixedAssetPool', 'fixedAssetEvent', 'fixedAssetTaxYear', 'fixedAssetRun'] as const
type Model = (typeof MODELS)[number]
const ids: Record<'A' | 'B', Partial<Record<Model, string>> & { tenantId?: string }> = { A: {}, B: {} }

function migration(name: string): string {
  return readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')
}

/** Rows of one model, read inside `tx` (any model the register owns). */
function table(tx: Prisma.TransactionClient, model: Model) {
  return tx[model] as unknown as {
    findMany(a: unknown): Promise<Array<{ id: string; tenantId: string }>>
    updateMany(a: unknown): Promise<{ count: number }>
  }
}

const HARMLESS: Record<Model, Record<string, unknown>> = {
  fixedAsset: { notes: 'hijacked' },
  fixedAssetDepreciation: { postedPeriod: '1999-01' },
  fixedAssetClass: { label: 'hijacked' },
  fixedAssetPool: { label: 'hijacked' },
  fixedAssetEvent: { reason: 'hijacked by another company' },
  fixedAssetTaxYear: { rateBp: 9999 },
  fixedAssetRun: { error: 'hijacked' },
}

async function seed(key: 'A' | 'B') {
  const { ensureAssetClasses } = await import('../src/modules/fixedAssets/classes.js')
  const tenantId = (await serviceClient.tenant.create({ data: { name: `RLS ${key}`, slug: `fa-rls-${key.toLowerCase()}-${RUN}` } })).id
  await ensureAssetClasses(tenantId)
  const locationId = (await serviceClient.location.create({ data: { name: `RLS ${key} outlet`, slug: `fa-rls-l-${key.toLowerCase()}-${RUN}`, tenantId } })).id
  const asset = await serviceClient.fixedAsset.create({
    data: { tenantId, name: `${key} oven`, category: 'kitchen_equipment', acquiredAt: new Date(), inServiceAt: new Date(), costCents: 100_000, originalCostCents: 100_000, usefulLifeMonths: 60 },
  })
  ids[key] = {
    tenantId,
    fixedAsset: asset.id,
    fixedAssetDepreciation: (await serviceClient.fixedAssetDepreciation.create({ data: { tenantId, assetId: asset.id, period: '2026-01', amountCents: 1_000, accumCode: '1591' } })).id,
    fixedAssetClass: (await serviceClient.fixedAssetClass.findFirstOrThrow({ where: { tenantId, key: 'kitchen_equipment' } })).id,
    fixedAssetPool: (await serviceClient.fixedAssetPool.create({ data: { tenantId, locationId, classKey: 'smallwares', typeKey: 'plates', label: `${key} plates` } })).id,
    fixedAssetEvent: (await serviceClient.fixedAssetEvent.create({
      data: { tenantId, assetId: asset.id, kind: 'impairment', status: 'pending', effectiveDate: new Date(), payload: { amountCents: 1 }, reason: 'Burner damaged in a fire', requestedById: 'u' },
    })).id,
    fixedAssetTaxYear: (await serviceClient.fixedAssetTaxYear.create({
      data: {
        tenantId, assetId: asset.id, taxYear: 2026, rateBp: 1500, openingWdvCents: 0, additionsCents: 100_000, initialAllowanceCents: 25_000,
        depreciationCents: 11_250, disposalProceedsCents: 0, closingWdvCents: 63_750, frozenById: 'ceo',
      },
    })).id,
    fixedAssetRun: (await serviceClient.fixedAssetRun.create({ data: { tenantId, kind: 'depreciation', throughPeriod: '2026-01', triggeredBy: 'worker' } })).id,
  }
}

/** Run `fn` as a request of `tenantIds` (the RLS client sets the session vars) under the non-bypassing role. */
function asRequest<T>(tenantIds: string[], fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return runWithRlsContext({ tenantIds }, () => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`)
    return fn(tx)
  }))
}

beforeAll(async () => {
  vi.resetModules()
  ;({ prisma, serviceClient } = await import('../src/lib/prisma.js'))
  ;({ runWithRlsContext } = await import('../src/lib/rlsContext.js'))

  // The RLS helper functions (phase 2) and the wave-B policies, from the migrations.
  for (const fn of migration('20260603071500_enable_rls_phase2').match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) ?? []) {
    await serviceClient.$executeRawUnsafe(fn)
  }
  const waveB = migration('20261014090000_finance_wave_b')
  const rls = waveB.slice(waveB.indexOf('-- ─── Row-level security'))
  const block = rls.slice(rls.indexOf('DO $do$'), rls.lastIndexOf('$do$;') + '$do$;'.length)
  expect(block).toMatch(/'fixed_assets', 'fixed_asset_depreciation'/)
  await serviceClient.$executeRawUnsafe(block)
  await serviceClient.$executeRawUnsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} NOLOGIN; END IF; END $r$`)
  await serviceClient.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await serviceClient.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)

  await seed('A')
  await seed('B')
}, 60_000)

describe('row-level security on the fixed-asset tables', () => {
  // First: no connection of the pool has carried a request's session vars yet.
  it('serviceClient (service mode) sees both companies', async () => {
    const seen = await serviceClient.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`)
      const out: Record<string, string[]> = {}
      for (const m of MODELS) {
        out[m] = (await table(tx, m).findMany({ where: { tenantId: { in: [ids.A.tenantId, ids.B.tenantId] } }, select: { id: true, tenantId: true } })).map((r) => r.tenantId)
      }
      return out
    })
    for (const m of MODELS) {
      expect(new Set(seen[m]), m).toEqual(new Set([ids.A.tenantId, ids.B.tenantId]))
    }
  })

  it('company A\'s request reads only A\'s rows and cannot update B\'s', async () => {
    for (const m of MODELS) {
      const rows = await asRequest([ids.A.tenantId!], (tx) => table(tx, m).findMany({ where: {}, select: { id: true, tenantId: true } }))
      expect(rows.length, m).toBeGreaterThan(0)
      expect(rows.every((r) => r.tenantId === ids.A.tenantId), m).toBe(true)
      expect(rows.map((r) => r.id), m).not.toContain(ids.B[m])
      const byId = await asRequest([ids.A.tenantId!], (tx) => table(tx, m).findMany({ where: { id: ids.B[m] }, select: { id: true, tenantId: true } }))
      expect(byId, m).toEqual([])
      const upd = await asRequest([ids.A.tenantId!], (tx) => table(tx, m).updateMany({ where: { id: ids.B[m] }, data: HARMLESS[m] }))
      expect(upd.count, m).toBe(0)
      // Its own row it can update.
      const own = await asRequest([ids.A.tenantId!], (tx) => table(tx, m).updateMany({ where: { id: ids.A[m] }, data: HARMLESS[m] }))
      expect(own.count, m).toBe(1)
    }
    // B's rows are untouched.
    expect((await serviceClient.fixedAsset.findUniqueOrThrow({ where: { id: ids.B.fixedAsset! } })).notes).toBeNull()
    expect((await serviceClient.fixedAssetClass.findUniqueOrThrow({ where: { id: ids.B.fixedAssetClass! } })).label).toBe('Kitchen equipment')
    expect((await serviceClient.fixedAssetTaxYear.findUniqueOrThrow({ where: { id: ids.B.fixedAssetTaxYear! } })).rateBp).toBe(1500)
  })

  it('a request of both companies (portfolio) sees both', async () => {
    const rows = await asRequest([ids.A.tenantId!, ids.B.tenantId!], (tx) => table(tx, 'fixedAsset').findMany({ where: {}, select: { id: true, tenantId: true } }))
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([ids.A.tenantId, ids.B.tenantId]))
  })
})
