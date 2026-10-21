// /accounting/fixed-assets — the fixed-asset register (v2, wave B).
// Mounted under /accounting so the `accounting` module gate covers every path
// (no gate rule of its own, no page roles — critic). Roles, local to the
// module: READERS = FINANCIALS_VIEWERS; writers = events.ts FA_WRITER_ROLES
// (admin, owner, management, finance); the approver = the CEO (role admin);
// the F&B manager reads and records smallwares counts only.
//
//   GET    /                     the register, values as of ?asOf, per-company totals, each company's last run
//   GET    /lookups              everything the register's screens pick from (no other gated path needed)
//   GET    /runs                 the automatic runs (FixedAssetRun)
//   GET    /classes              classes per company · PATCH /classes/:id (CEO)
//   GET    /policy               per company · PATCH /policy (CEO, the ACTIVE company)
//   POST   /                     422 USE_CAPEX — bought equipment reaches the register through CapEx
//   POST   /existing             "Add existing asset" (owner, 2026-10-21): bought before servd or from a
//                                related party — a request the CEO approves (events.ts add_existing)
//   POST   /depreciate           "charge now / catch up" for the ACTIVE company (service.ts chargeThrough)
//   GET    /:id                  one asset: schedule (posted + to come), events, tax, CapEx link, journal refs
//   PATCH  /:id                  descriptive fields only (audited)
//   PUT    /:id/initial-allowance  finance or the CEO ticks "eligible for initial allowance" (H42; tax view only, audited)
//   + requests.ts (requests and the CEO's decisions), pools.routes.ts (smallwares), reports.ts (/reports/*)
//
// Depreciation is AUTOMATIC (workers/depreciation.ts, 03:20 PKT daily, the
// last completed month) — there is no switch. Reads go through the RLS
// client; another company's row is 404; another company's id attached to a
// row is 422; every write is audited with the row's company.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { Prisma, type FixedAsset, type UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { invalidateSetupCache } from '../../lib/setup-config.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'
import { taxYearOf } from '../accounting/fiscalYear.js'
import { assertSupplierOfCompany } from '../financePlanning/companyRefs.js'
import { getAssetClasses, getFixedAssetPolicy, SMALLWARE_TYPES, SMALLWARE_TYPE_LABELS } from './classes.js'
import {
  isPeriod, periodIndex, lastCompletedPeriodPkt, currentPeriodPkt, forecast, nextMonthlyCharge, planCharges,
} from './schedule.js'
import { chargeThrough, loadAssetStates, type AssetState } from './service.js'
import {
  FA_WRITER_ROLES, FA_COUNT_ROLES, FA_APPROVER_ROLE, DISPOSAL_KINDS, WRITE_OFF_CAUSES,
} from './events.js'
import { taxSchedule, initialAllowanceEligibleOf, setInitialAllowanceEligible } from './tax.js'
import { fixedAssetRequestRoutes, shapeEvents, actorOf, raiseRequest, ASSET_REQUEST_KINDS, REQUEST_KIND_LABELS } from './requests.js'
import { EXISTING_SOURCES, EXISTING_COUNTERPARTIES } from './events.js'
import { fixedAssetPoolRoutes } from './pools.routes.js'
import {
  fixedAssetReportRoutes, loadRegister, assetNbvAt, classOfAsset, pktDay, endOfPktDay, SMALLWARES_TAX_NOTE, type RegisterData,
} from './reports.js'

const READERS = FINANCIALS_VIEWERS
const FA_WRITERS = [...FA_WRITER_ROLES] as UserRole[]
const APPROVER = ADMIN_ONLY as UserRole[]
// H42: who ticks an asset's initial-allowance eligibility — finance and the CEO.
const IA_EDITORS = ['finance', 'admin'] as UserRole[]

const DISPOSAL_KIND_LABELS: Record<string, string> = { sale: 'Sold', scrap: 'Scrapped', lost: 'Lost', stolen: 'Stolen' }
const WRITE_OFF_CAUSE_LABELS: Record<string, string> = { breakage: 'Breakage', loss: 'Lost', theft: 'Stolen', worn_out: 'Worn out' }

const USE_CAPEX_MESSAGE = 'Equipment goes on the register only through CapEx (Finance → Project tracker or Quick buy)'
// A run older than this with no finish is a crashed run, not one in progress.
const RUN_STALE_MS = 15 * 60_000
const runningHere = new Set<string>()

// ─── Shaping ────────────────────────────────────────────────────────────────

type Names = { concept: Map<string, string>; location: Map<string, string>; pool: Map<string, string>; supplier: Map<string, string> }

async function namesOf(assets: FixedAsset[]): Promise<Names> {
  const ids = (f: (a: FixedAsset) => string | null) => [...new Set(assets.map(f).filter((x): x is string => !!x))]
  const [concepts, locations, pools, suppliers] = await Promise.all([
    prisma.concept.findMany({ where: { id: { in: ids((a) => a.conceptId) } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { id: { in: ids((a) => a.locationId) } }, select: { id: true, name: true } }),
    prisma.fixedAssetPool.findMany({ where: { id: { in: ids((a) => a.poolId) } }, select: { id: true, label: true } }),
    prisma.supplier.findMany({ where: { id: { in: ids((a) => a.supplierId) } }, select: { id: true, name: true } }),
  ])
  return {
    concept: new Map(concepts.map((c) => [c.id, c.name])),
    location: new Map(locations.map((l) => [l.id, l.name])),
    pool: new Map(pools.map((p) => [p.id, p.label])),
    supplier: new Map(suppliers.map((s) => [s.id, s.name])),
  }
}

/** Per asset: the next monthly charge, the months still owed through the last completed month. */
async function scheduleFacts(tenantIds: string[], assets: FixedAsset[]): Promise<Map<string, { next: number; owed: number; state: AssetState }>> {
  const out = new Map<string, { next: number; owed: number; state: AssetState }>()
  const last = lastCompletedPeriodPkt()
  for (const t of tenantIds) {
    const active = assets.filter((a) => a.tenantId === t && a.status === 'active')
    for (const s of await loadAssetStates(prisma, t, active)) {
      const depreciable = s.cls.depreciable && !!s.cls.accumAccountCode
      out.set(s.asset.id, {
        next: depreciable ? nextMonthlyCharge(s.schedule, s.charged, s.adjustments) : 0,
        owed: depreciable ? planCharges(s.schedule, s.charged, s.adjustments, last).length : 0,
        state: s,
      })
    }
  }
  return out
}

/** One register row — flat, so the CSV is exactly the JSON. */
function assetRow(
  data: RegisterData,
  names: Names,
  a: FixedAsset,
  asOf: Date,
  facts: { next: number; owed: number } | undefined,
  pending: number,
) {
  const v = assetNbvAt(data, a, asOf)
  const live = (data.rows.get(a.id) ?? []).filter((r) => !r.reversedAt).map((r) => r.period).sort()
  return {
    id: a.id,
    tenantId: a.tenantId,
    companyName: data.companies.get(a.tenantId) ?? '',
    assetTag: a.assetTag,
    name: a.name,
    classKey: a.category,
    classLabel: classOfAsset(data, a)?.label ?? a.category,
    kind: a.kind,
    poolId: a.poolId,
    poolLabel: a.poolId ? names.pool.get(a.poolId) ?? null : null,
    quantity: a.quantity,
    originalQuantity: a.originalQuantity,
    conceptId: a.conceptId,
    conceptName: a.conceptId ? names.concept.get(a.conceptId) ?? null : null,
    locationId: a.locationId,
    locationName: a.locationId ? names.location.get(a.locationId) ?? null : null,
    status: a.status,
    inServiceAt: pktDay(a.inServiceAt ?? a.acquiredAt),
    acquiredAt: pktDay(a.acquiredAt),
    disposedAt: a.disposedAt ? pktDay(a.disposedAt) : null,
    disposalKind: a.disposalKind,
    method: a.method,
    initialAllowanceEligible: initialAllowanceEligibleOf(a),
    usefulLifeMonths: a.usefulLifeMonths,
    leaseEndsAt: a.leaseEndsAt ? pktDay(a.leaseEndsAt) : null,
    originalCostCents: toCents(a.originalCostCents) || toCents(a.costCents),
    salvageCents: toCents(a.salvageCents),
    inputTaxCents: toCents(a.inputTaxCents),
    costCents: v.costCents,
    accumulatedCents: v.accumulatedCents,
    nbvCents: v.nbvCents,
    nextChargeCents: facts?.next ?? 0,
    unchargedMonths: facts?.owed ?? 0,
    lastChargedPeriod: live.at(-1) ?? null,
    pendingRequestCount: pending,
    capexLineId: a.capexLineId,
    supplierId: a.supplierId,
    supplierName: a.supplierId ? names.supplier.get(a.supplierId) ?? null : a.supplier,
    serialNumber: a.serialNumber,
    warrantyUntil: a.warrantyUntil ? pktDay(a.warrantyUntil) : null,
    notes: a.notes,
  }
}


// What the CEO / finance edit through a request instead of PATCH.
const NOT_PATCHABLE: Record<string, string> = {
  costCents: 'the cost is fixed once capitalised — void and capitalise again',
  originalCostCents: 'the cost is fixed once capitalised — void and capitalise again',
  salvageCents: 'raise a change of estimate',
  usefulLifeMonths: 'raise a change of estimate',
  acquiredAt: 'dates drive posted depreciation — void and capitalise again',
  inServiceAt: 'dates drive posted depreciation — void and capitalise again',
  leaseEndsAt: 'raise a change of estimate',
  category: 'the class is fixed once capitalised',
  classKey: 'the class is fixed once capitalised',
  conceptId: 'raise a transfer',
  locationId: 'raise a transfer',
  poolId: 'move units between pools',
  quantity: 'write units off or move them from the pool',
  capexLineId: 'the CapEx link is set by capitalisation',
  initialAllowanceEligible: 'use PUT /:id/initial-allowance (finance or the CEO)',
  status: 'raise a disposal, void or undo request',
  disposedAt: 'raise a disposal request',
  assetTag: 'tags are issued in sequence',
  tenantId: 'an asset belongs to one company',
}

const docList = z.array(z.object({ label: z.string().max(120).optional(), url: z.string().url().max(2000) })).max(50).nullable()
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  serialNumber: z.string().trim().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  documentUrls: docList.optional(),
  photoUrls: docList.optional(),
  supplierId: z.string().min(1).max(64).nullable().optional(),
}).strict()

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function fixedAssetRoutes(fastify: FastifyInstance) {
  await fastify.register(fixedAssetRequestRoutes)
  await fastify.register(fixedAssetPoolRoutes)
  await fastify.register(fixedAssetReportRoutes, { prefix: '/reports' })

  // GET / — the register. Values (cost, accumulated, NBV) as of ?asOf (end of
  // that PKT day; default now). One company: `totals`; every view:
  // `totalsByCompany` and each company's last automatic run.
  fastify.get('/', { preHandler: requireAuth(...READERS) }, async (req, reply) => {
    const q = z.object({
      asOf: z.string().optional(),
      status: z.enum(['active', 'disposed', 'voided', 'all']).optional(),
      classKey: z.string().max(40).optional(),
      conceptId: z.string().max(64).optional(),
      locationId: z.string().max(64).optional(),
      poolId: z.string().max(64).optional(),
      kind: z.enum(['individual', 'pool_layer']).optional(),
      uncharged: z.enum(['0', '1']).optional(),
      format: z.enum(['json', 'csv', 'xlsx', 'pdf']).optional(),
    }).parse(req.query)
    const asOf = q.asOf ? endOfPktDay(q.asOf) : new Date()
    const { tenantIds, portfolio } = await resolveTenantScope(req)
    // A brand filter must be one of the caller's (404 otherwise).
    if (q.conceptId) await assertConceptOwned(req, q.conceptId, 'read')
    const where: Prisma.FixedAssetWhereInput = {
      ...(q.status && q.status !== 'all' ? { status: q.status } : {}),
      ...(q.classKey ? { category: q.classKey } : {}),
      ...(q.conceptId ? { conceptId: q.conceptId } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.poolId ? { poolId: q.poolId } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    }
    const data = await loadRegister(prisma, tenantIds, where)
    const [names, facts, pending, runs] = await Promise.all([
      namesOf(data.assets),
      scheduleFacts(tenantIds, data.assets),
      data.assets.length === 0 ? [] : prisma.fixedAssetEvent.groupBy({
        by: ['assetId'], where: { assetId: { in: data.assets.map((a) => a.id) }, status: 'pending' }, _count: { _all: true },
      }),
      Promise.all(tenantIds.map((t) => prisma.fixedAssetRun.findFirst({ where: { tenantId: t, kind: 'depreciation' }, orderBy: { startedAt: 'desc' } }))),
    ])
    const pendingOf = new Map(pending.map((p) => [p.assetId, p._count._all]))
    let assets = data.assets.map((a) => assetRow(data, names, a, asOf, facts.get(a.id), pendingOf.get(a.id) ?? 0))
    if (q.uncharged === '1') assets = assets.filter((a) => a.unchargedMonths > 0)
    const exportAs = exportFormatOf(q.format)
    if (exportAs) {
      const rows = assets.map((r) => ({ ...r, initialAllowanceEligible: String(r.initialAllowanceEligible) }))
      return sendReportFor(req, reply, exportAs, `fixed-assets-${pktDay(asOf)}`, {
        title: 'Fixed asset register', period: `As at ${pktDay(asOf)}`, rows,
        hide: rows[0] ? Object.keys(rows[0]).filter((k) => k === 'tenantId' || /Id$/.test(k) || k === 'id' || k === 'notes') : [],
      })
    }

    const totalsByCompany = tenantIds.map((t) => {
      const mine = assets.filter((a) => a.tenantId === t)
      return {
        tenantId: t,
        companyName: data.companies.get(t) ?? '',
        assets: mine.filter((a) => a.costCents !== 0 || a.accumulatedCents !== 0).length,
        costCents: mine.reduce((s, a) => s + a.costCents, 0),
        accumulatedCents: mine.reduce((s, a) => s + a.accumulatedCents, 0),
        nbvCents: mine.reduce((s, a) => s + a.nbvCents, 0),
        monthlyCents: mine.filter((a) => a.status === 'active').reduce((s, a) => s + a.nextChargeCents, 0),
      }
    })
    const lastRuns = runs.flatMap((r) => (r ? [{
      tenantId: r.tenantId, companyName: data.companies.get(r.tenantId) ?? '', id: r.id, throughPeriod: r.throughPeriod,
      triggeredBy: r.triggeredBy, startedAt: r.startedAt, finishedAt: r.finishedAt, chargedCount: r.chargedCount,
      chargedCents: toCents(r.chargedCents), lateCount: r.lateCount, failedCount: r.failedCount, error: r.error,
    }] : []))
    return {
      asOf: pktDay(asOf),
      portfolio,
      assets,
      totals: tenantIds.length === 1 ? totalsByCompany[0] ?? null : null,
      totalsByCompany,
      lastRuns,
      lastCompletedPeriod: lastCompletedPeriodPkt(),
      currentPeriod: currentPeriodPkt(),
      depreciation: 'automatic',
    }
  })

  // GET /lookups — classes, smallwares types, outlets, brands, suppliers,
  // pools and bank accounts of the companies in view, and what the caller may do.
  fastify.get('/lookups', { preHandler: requireAuth(...READERS) }, async (req) => {
    const where = await scopeTenantWhere(req, 'read')
    const { tenantIds } = await resolveTenantScope(req)
    const role = req.staffUser!.role
    const [tenants, classLists, locations, brands, suppliers, pools, bankAccounts] = await Promise.all([
      prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      Promise.all(tenantIds.map(async (t) => [t, await getAssetClasses(t, prisma)] as const)),
      prisma.location.findMany({ where: { ...where, deletedAt: null }, select: { id: true, name: true, tenantId: true }, orderBy: { name: 'asc' } }),
      prisma.concept.findMany({ where: { ...where, deletedAt: null }, select: { id: true, name: true, tenantId: true }, orderBy: { name: 'asc' } }),
      prisma.supplier.findMany({ where: { ...where, deletedAt: null, systemKind: null }, select: { id: true, name: true, tenantId: true }, orderBy: { name: 'asc' } }),
      prisma.fixedAssetPool.findMany({ where: { ...where, isActive: true }, select: { id: true, label: true, tenantId: true, locationId: true, conceptId: true, classKey: true, typeKey: true }, orderBy: { label: 'asc' } }),
      prisma.bankAccount.findMany({ where: { ...where, deletedAt: null, isActive: true }, select: { id: true, name: true, tenantId: true, accountCode: true }, orderBy: { name: 'asc' } }),
    ])
    return {
      activeTenantId: req.staffUser!.tenantId,
      companies: tenants,
      classes: classLists.flatMap(([t, cs]) => cs.map((c) => ({
        id: c.id, tenantId: t, key: c.key, label: c.label, costAccountCode: c.costAccountCode, accumAccountCode: c.accumAccountCode,
        depreciable: c.depreciable, pooled: c.pooled, defaultLifeMonths: c.defaultLifeMonths, taxRateBp: c.taxRateBp,
        taxInitialAllowanceBp: c.taxInitialAllowanceBp, isActive: c.isActive,
      }))),
      smallwareTypes: SMALLWARE_TYPES.map((k) => ({ key: k, label: SMALLWARE_TYPE_LABELS[k] ?? k })),
      locations,
      brands,
      suppliers,
      pools,
      bankAccounts,
      disposalKinds: DISPOSAL_KINDS.map((k) => ({ key: k, label: DISPOSAL_KIND_LABELS[k] ?? k })),
      writeOffCauses: WRITE_OFF_CAUSES.map((k) => ({ key: k, label: WRITE_OFF_CAUSE_LABELS[k] ?? k })),
      requestKinds: ASSET_REQUEST_KINDS.map((k) => ({ key: k, label: REQUEST_KIND_LABELS[k] ?? k })),
      lastCompletedPeriod: lastCompletedPeriodPkt(),
      currentPeriod: currentPeriodPkt(),
      depreciation: 'automatic',
      capabilities: {
        canWrite: FA_WRITER_ROLES.includes(role),
        canCount: FA_COUNT_ROLES.includes(role),
        canApprove: role === FA_APPROVER_ROLE,
        canSetInitialAllowance: IA_EDITORS.includes(role),
      },
    }
  })

  // GET /runs — the automatic (and "charge now") runs.
  fastify.get('/runs', { preHandler: requireAuth(...READERS) }, async (req) => {
    const q = z.object({
      kind: z.enum(['depreciation', 'prepaid_release', 'checks']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query)
    const rows = await prisma.fixedAssetRun.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), ...(q.kind ? { kind: q.kind } : {}) },
      orderBy: { startedAt: 'desc' },
      take: q.limit,
    })
    const tenants = await prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true } })
    const name = new Map(tenants.map((t) => [t.id, t.name]))
    return { runs: rows.map((r) => ({ ...r, chargedCents: toCents(r.chargedCents), companyName: name.get(r.tenantId) ?? '' })) }
  })

  // GET /classes — each company's classes, with how many assets use each.
  fastify.get('/classes', { preHandler: requireAuth(...READERS) }, async (req) => {
    const { tenantIds } = await resolveTenantScope(req)
    const [lists, counts, tenants] = await Promise.all([
      Promise.all(tenantIds.map(async (t) => [t, await getAssetClasses(t, prisma)] as const)),
      tenantIds.length === 0 ? [] : prisma.fixedAsset.groupBy({ by: ['tenantId', 'category'], where: { tenantId: { in: tenantIds } }, _count: { _all: true } }),
      prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
    ])
    const name = new Map(tenants.map((t) => [t.id, t.name]))
    const count = new Map(counts.map((c) => [`${c.tenantId}|${c.category}`, c._count._all]))
    return {
      classes: lists.flatMap(([t, cs]) => cs.map((c) => ({
        ...c, companyName: name.get(t) ?? '', assetCount: count.get(`${t}|${c.key}`) ?? 0,
      }))),
      canEdit: req.staffUser!.role === FA_APPROVER_ROLE,
    }
  })

  // PATCH /classes/:id — the CEO: label, default life, tax rates, pooled,
  // active. Account codes are fixed per key.
  fastify.patch<{ Params: { id: string } }>('/classes/:id', { preHandler: requireAuth(...APPROVER) }, async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>
    for (const k of ['key', 'costAccountCode', 'accumAccountCode', 'depreciable', 'tenantId', 'sortOrder']) {
      if (k in raw) throw new AppError('FIELD_NOT_EDITABLE', `${k} is fixed for a class — its ledger accounts never change`, 400, { field: k })
    }
    const body = z.object({
      label: z.string().trim().min(1).max(80).optional(),
      defaultLifeMonths: z.number().int().min(1).max(600).nullable().optional(),
      taxRateBp: z.number().int().min(0).max(10_000).optional(),
      taxInitialAllowanceBp: z.number().int().min(0).max(10_000).optional(),
      pooled: z.boolean().optional(),
      isActive: z.boolean().optional(),
    }).strict().parse(raw)
    const cls = await prisma.fixedAssetClass.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!cls) throw new NotFoundError('FixedAssetClass', req.params.id)
    if (!cls.depreciable && body.defaultLifeMonths != null) {
      throw new AppError('NOT_DEPRECIABLE', `${cls.label} is never depreciated — it has no life`, 422)
    }
    if (cls.depreciable && body.defaultLifeMonths === null) throw new AppError('LIFE_REQUIRED', 'A depreciated class needs a default life', 422)
    if (body.pooled !== undefined && body.pooled !== cls.pooled) {
      const inUse = await prisma.fixedAsset.count({ where: { tenantId: cls.tenantId, category: cls.key } })
      if (inUse > 0) throw new AppError('CLASS_IN_USE', `${cls.label} already has assets on the register — whether it is pooled cannot change now`, 409, { assets: inUse })
    }
    const updated = await prisma.fixedAssetClass.update({ where: { id: cls.id }, data: body })
    const pick = (c: typeof cls) => ({ label: c.label, defaultLifeMonths: c.defaultLifeMonths, taxRateBp: c.taxRateBp, taxInitialAllowanceBp: c.taxInitialAllowanceBp, pooled: c.pooled, isActive: c.isActive })
    await audit({
      category: 'accounting', action: 'fixed_asset.class_update', entity: 'FixedAssetClass', entityId: cls.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: cls.tenantId,
      before: pick(cls), after: pick(updated), metadata: { key: cls.key },
    })
    return updated
  })

  // GET /policy — each company's register policy (depreciation is always automatic).
  fastify.get('/policy', { preHandler: requireAuth(...READERS) }, async (req) => {
    const { tenantIds } = await resolveTenantScope(req)
    const tenants = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
    const policies = await Promise.all(tenants.map(async (t) => {
      const p = await getFixedAssetPolicy(t.id)
      return {
        tenantId: t.id, companyName: t.name, depreciation: 'automatic',
        capexUncapitalisedAlertDays: p.capexUncapitalisedAlertDays, capexAdvanceOverdueDays: p.capexAdvanceOverdueDays, assetTagPrefix: p.assetTagPrefix,
      }
    }))
    return {
      policies,
      policy: policies.find((p) => p.tenantId === req.staffUser!.tenantId) ?? policies[0] ?? null,
      canEdit: req.staffUser!.role === FA_APPROVER_ROLE,
    }
  })

  // PATCH /policy — the CEO, for the ACTIVE company only. There is no
  // automatic-depreciation switch (owner: always automatic).
  fastify.patch('/policy', { preHandler: requireAuth(...APPROVER) }, async (req) => {
    const body = z.object({
      capexUncapitalisedAlertDays: z.number().int().min(1).max(365).optional(),
      capexAdvanceOverdueDays: z.number().int().min(1).max(365).optional(),
      assetTagPrefix: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only').optional(),
    }).strict().parse(req.body ?? {})
    const tenantId = activeTenantId(req, 'the register policy is per company')
    const before = await getFixedAssetPolicy(tenantId)
    const cfgId = await prisma.$transaction(async (tx) => {
      // One writer of a company's settings row at a time (scopeId is NULL, so the unique index cannot stop two creates).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${'operations-config'}::text))`
      const existing = await tx.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null }, select: { id: true } })
      const data = { ...body, updatedById: req.staffUser!.id }
      const row = existing
        ? await tx.operationsConfig.update({ where: { id: existing.id }, data, select: { id: true } })
        : await tx.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data }, select: { id: true } })
      return row.id
    })
    invalidateSetupCache()
    const after = await getFixedAssetPolicy(tenantId)
    const pick = (p: typeof before) => ({ capexUncapitalisedAlertDays: p.capexUncapitalisedAlertDays, capexAdvanceOverdueDays: p.capexAdvanceOverdueDays, assetTagPrefix: p.assetTagPrefix })
    await audit({
      category: 'accounting', action: 'fixed_asset.policy_update', entity: 'OperationsConfig', entityId: cfgId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, before: pick(before), after: pick(after),
    })
    return { tenantId, depreciation: 'automatic', ...pick(after) }
  })

  // POST / — the hand-added asset is gone: equipment comes through CapEx.
  fastify.post('/', { preHandler: requireAuth(...FA_WRITERS) }, async () => {
    throw new AppError('USE_CAPEX', USE_CAPEX_MESSAGE, 422)
  })

  // POST /existing — "Add existing asset" (owner, 2026-10-21: "give an option
  // to add asset also, so we can add previously bought / Transferred from
  // related party assets"). A request of kind 'add_existing' in the ACTIVE
  // company: 202 pending for finance, 201 applied for the CEO (as every
  // fixed-asset request). At today's value; depreciated from the in-service
  // date over the remaining life (default the class life). Nothing is booked
  // until the CEO approves; the documents go to
  // POST /record-files/fixed_asset/<requestId> and move to the asset then.
  fastify.post('/existing', { preHandler: requireAuth(...FA_WRITERS) }, async (req, reply) => {
    const body = z.object({
      source: z.enum(EXISTING_SOURCES),
      counterparty: z.enum(EXISTING_COUNTERPARTIES).nullable().optional(),
      counterpartyTenantId: z.string().min(1).max(64).nullable().optional(),
      classId: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(120),
      serial: z.string().trim().max(120).nullable().optional(),
      conceptId: z.string().min(1).max(64).nullable().optional(),
      locationId: z.string().min(1).max(64).nullable().optional(),
      valueCents: zMoneyCents('Today\'s value', { sign: 'positive' }),
      inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01'),
      remainingLifeMonths: z.number().int().min(1).max(1200).optional(),
      salvageCents: zMoneyCents('The salvage value').optional(),
      reason: z.string().max(1000),
    }).parse(req.body)
    if (body.reason.trim().length < 10) throw new AppError('REASON_REQUIRED', 'Give a reason (at least 10 characters)', 422)
    // Create mode: the ACTIVE company only. The class must be one of its classes.
    const tenantId = activeTenantId(req, 'the asset belongs to one company')
    const cls = await prisma.fixedAssetClass.findFirst({ where: { id: body.classId, tenantId } })
    if (!cls) throw new AppError('ASSET_CLASS_NOT_IN_COMPANY', 'That asset class is not one of this company\'s classes', 422)
    const r = await raiseRequest(req, {
      kind: 'add_existing',
      tenantId,
      memberTenantIds: req.staffUser!.memberTenantIds ?? [],
      reason: body.reason.trim(),
      payload: {
        source: body.source,
        counterparty: body.source === 'related_party' ? (body.counterparty ?? null) : null,
        counterpartyTenantId: body.counterparty === 'servd_company' ? (body.counterpartyTenantId ?? null) : null,
        classKey: cls.key,
        name: body.name,
        serial: body.serial ?? null,
        conceptId: body.conceptId ?? null,
        locationId: body.locationId ?? null,
        valueCents: body.valueCents,
        inServiceAt: body.inServiceDate,
        remainingLifeMonths: body.remainingLifeMonths ?? (cls.defaultLifeMonths ?? 12),
        ...(body.salvageCents !== undefined ? { salvageCents: body.salvageCents } : {}),
      },
    })
    return reply.status(r.statusCode).send(r.body)
  })

  // POST /depreciate { throughPeriod? } — "charge now / catch up" for the
  // ACTIVE company through a completed month (default: the last one). The
  // automatic run does the same every night; this never charges another company.
  fastify.post('/depreciate', { preHandler: requireAuth(...FA_WRITERS) }, async (req) => {
    const body = z.object({
      throughPeriod: z.string().max(7).optional(),
      period: z.string().max(7).optional(), // the old page's field name
    }).parse(req.body ?? {})
    const tenantId = activeTenantId(req, 'depreciation is charged per company')
    const through = body.throughPeriod ?? body.period ?? lastCompletedPeriodPkt()
    if (!isPeriod(through)) throw new AppError('BAD_PERIOD', 'The month must look like 2026-09', 400)
    if (periodIndex(through) > periodIndex(lastCompletedPeriodPkt())) {
      throw new AppError('MONTH_NOT_ENDED', `${through} has not ended yet — depreciation is charged for completed months (the last is ${lastCompletedPeriodPkt()})`, 422)
    }
    const running = runningHere.has(tenantId) || !!(await prisma.fixedAssetRun.findFirst({
      where: { tenantId, kind: 'depreciation', finishedAt: null, startedAt: { gte: new Date(Date.now() - RUN_STALE_MS) } },
      select: { id: true },
    }))
    if (running) throw new AppError('RUN_IN_PROGRESS', 'Depreciation is being charged for this company right now — try again in a minute', 409)
    runningHere.add(tenantId)
    let r: Awaited<ReturnType<typeof chargeThrough>>
    try {
      r = await chargeThrough(tenantId, through, { postedBy: req.staffUser!.id })
    } finally {
      runningHere.delete(tenantId)
    }
    const company = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
    await audit({
      category: 'accounting', action: 'fixed_asset.depreciate', entity: 'FixedAssetRun', entityId: r.runId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      after: { throughPeriod: through, chargedCount: r.chargedCount, chargedCents: r.chargedCents, lateCount: r.lateCount, failedCount: r.failedCount },
    })
    return { ...r, companyName: company?.name ?? '' }
  })

  // GET /:id — one asset of the caller's view.
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...READERS) }, async (req) => {
    const found = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) }, select: { id: true, tenantId: true } })
    if (!found) throw new NotFoundError('FixedAsset', req.params.id)
    const data = await loadRegister(prisma, [found.tenantId], { id: found.id })
    const a = data.assets[0]
    if (!a) throw new NotFoundError('FixedAsset', req.params.id)
    const now = new Date()
    const [names, facts, events, line] = await Promise.all([
      namesOf([a]),
      scheduleFacts([a.tenantId], [a]),
      prisma.fixedAssetEvent.findMany({ where: { tenantId: a.tenantId, assetId: a.id }, orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }] }),
      a.capexLineId ? prisma.capexLine.findUnique({
        where: { id: a.capexLineId },
        select: { id: true, item: true, status: true, quantity: true, actualDeliveryDate: true, project: { select: { id: true, name: true, tenantId: true } } },
      }) : null,
    ])
    const f = facts.get(a.id)
    const pending = events.filter((e) => e.status === 'pending').length
    const asset = assetRow(data, names, a, now, f, pending)
    const last = lastCompletedPeriodPkt()
    const posted = (data.rows.get(a.id) ?? []).map((r) => ({
      period: r.period, amountCents: toCents(r.amountCents), status: r.reversedAt ? 'reversed' : 'posted',
      accumCode: r.accumCode, postedPeriod: r.postedPeriod, conceptId: r.conceptId, locationId: r.locationId,
      revision: r.revision, postedAt: r.postedAt, reversedAt: r.reversedAt,
    }))
    const upcoming = f ? forecast(f.state.schedule, f.state.charged, f.state.adjustments).map((m) => ({
      period: m.period, amountCents: m.amountCents, status: periodIndex(m.period) <= periodIndex(last) ? 'due' : 'forecast',
    })) : []

    // Tax (H23; smallwares deducted in full in the year bought, H35).
    const cls = classOfAsset(data, a)
    const tax: { toConfirm: boolean; note: string | null; years: unknown[]; initialAllowance: { applicable: boolean; frozenTaxYear: number | null } } = {
      toConfirm: false, note: cls?.pooled ? SMALLWARES_TAX_NOTE : null, years: [], initialAllowance: { applicable: false, frozenTaxYear: null },
    }
    if (a.status !== 'voided' && !a.splitFromAssetId) {
      const first = taxYearOf(a.inServiceAt ?? a.acquiredAt).taxYear
      // H42: the same rule PUT /:id/initial-allowance applies (tax.ts setInitialAllowanceEligible).
      const frozenIa = await prisma.fixedAssetTaxYear.findFirst({ where: { tenantId: a.tenantId, taxYear: { gte: first } }, orderBy: { taxYear: 'asc' }, select: { taxYear: true } })
      tax.initialAllowance = { applicable: !cls?.pooled && cls?.depreciable !== false, frozenTaxYear: frozenIa?.taxYear ?? null }
      const lastYear = Math.min(taxYearOf(now).taxYear, first + 20)
      for (let y = first; y <= lastYear; y++) {
        const row = (await taxSchedule(a.tenantId, y, prisma)).rows.find((r) => r.assetId === a.id)
        if (row) tax.years.push({ taxYear: y, ...row })
      }
    }

    // Every ledger entry of this asset (acquisition, months, disposal, events).
    const eventIds = events.map((e) => e.id)
    const journal = await prisma.journalEntry.findMany({
      where: { tenantId: a.tenantId, OR: [{ reference: { contains: a.id } }, ...eventIds.map((id) => ({ reference: { contains: id } }))] },
      select: { id: true, reference: true, entryDate: true, description: true },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    })
    return {
      asset,
      schedule: { posted, upcoming, nextChargeCents: f?.next ?? 0 },
      events: await shapeEvents(prisma, events, actorOf(req)),
      tax,
      capex: line ? {
        lineId: line.id, item: line.item, status: line.status, quantity: line.quantity,
        actualDeliveryDate: line.actualDeliveryDate ? pktDay(line.actualDeliveryDate) : null,
        projectId: line.project.id, projectName: line.project.name, unit: a.capexLineUnit,
      } : null,
      journal,
      documentUrls: a.documentUrls,
      photoUrls: a.photoUrls,
    }
  })

  // PUT /:id/initial-allowance — H42 (Hasnain, 2026-10-16): finance (role
  // finance, which already holds the register's writer rights through the
  // accounting module) or the CEO ticks / unticks the asset's eligibility for
  // the initial allowance. Changes the TAX view only. 409 TAX_YEAR_FROZEN once
  // the asset's first tax year is frozen (the year the allowance falls in).
  fastify.put<{ Params: { id: string } }>('/:id/initial-allowance', { preHandler: requireAuth(...IA_EDITORS) }, async (req) => {
    const body = z.object({ eligible: z.boolean(), reason: z.string().trim().max(500).optional() }).strict().parse(req.body ?? {})
    const found = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true, tenantId: true } })
    if (!found) throw new NotFoundError('FixedAsset', req.params.id)
    const r = await setInitialAllowanceEligible(found.tenantId, found.id, body.eligible)
    if (r.changed) {
      await audit({
        category: 'accounting', action: 'fixed_asset.initial_allowance', entity: 'FixedAsset', entityId: found.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: found.tenantId,
        before: { initialAllowanceEligible: r.before }, after: { initialAllowanceEligible: r.after },
        metadata: { taxYear: r.taxYear, actorRole: req.staffUser!.role, ...(body.reason ? { reason: body.reason } : {}) },
      })
    }
    return { assetId: found.id, initialAllowanceEligible: r.after, taxYear: r.taxYear, changed: r.changed }
  })

  // PATCH /:id — descriptive fields only; what drives the books goes through a request.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...FA_WRITERS) }, async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>
    for (const [k, how] of Object.entries(NOT_PATCHABLE)) {
      if (k in raw) throw new AppError('FIELD_NOT_EDITABLE', `${k} cannot be edited here — ${how}`, 400, { field: k })
    }
    const body = patchSchema.parse(raw)
    const found = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!found) throw new NotFoundError('FixedAsset', req.params.id)
    if (body.supplierId) await assertSupplierOfCompany(found.tenantId, body.supplierId)
    const data: Prisma.FixedAssetUncheckedUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.serialNumber !== undefined ? { serialNumber: body.serialNumber || null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      ...(body.warrantyUntil !== undefined ? { warrantyUntil: body.warrantyUntil ? new Date(`${body.warrantyUntil}T12:00:00+05:00`) : null } : {}),
      ...(body.documentUrls !== undefined ? { documentUrls: body.documentUrls === null ? Prisma.DbNull : body.documentUrls } : {}),
      ...(body.photoUrls !== undefined ? { photoUrls: body.photoUrls === null ? Prisma.DbNull : body.photoUrls } : {}),
      ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
    }
    const updated = await prisma.fixedAsset.update({ where: { id: found.id }, data })
    const pick = (a: FixedAsset) => ({
      name: a.name, serialNumber: a.serialNumber, notes: a.notes, warrantyUntil: a.warrantyUntil,
      documentUrls: a.documentUrls, photoUrls: a.photoUrls, supplierId: a.supplierId,
    })
    await audit({
      category: 'accounting', action: 'fixed_asset.update', entity: 'FixedAsset', entityId: found.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: found.tenantId,
      before: pick(found), after: pick(updated),
    })
    return {
      ...updated,
      costCents: toCents(updated.costCents), originalCostCents: toCents(updated.originalCostCents), salvageCents: toCents(updated.salvageCents),
      inputTaxCents: toCents(updated.inputTaxCents), carriedAccumulatedCents: toCents(updated.carriedAccumulatedCents),
      disposalProceedsCents: toCents(updated.disposalProceedsCents),
    }
  })
}
