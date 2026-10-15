// Finance planning module: the CapEx project tracker (quotes, status,
// budget), Quick buy, deposits, prepaid releases, and the read-only history
// of the old capital ledger.
//
// ONE path for capital spend (owner decision 24, fixed assets v2 — finance
// wave B, financePlanning/capexPosting.ts): a capex instalment marked paid
// posts as an advance to the supplier (or a prepayment / a deposit / a fee,
// by what the LINE is — the line's treatment is the only override), with the
// income tax withheld (lib/withholding.ts); a delivered item is prepared for
// the fixed-asset register and the CEO approves the capitalisation
// (fixedAssets/events.ts — the one request queue). Equipment comes onto the
// register ONLY through here (owner: "equipment only via CapEx"). The old
// capital-ledger writer and the ProForma scenarios are gone (/projections is
// the one projections module).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, FINANCE_TEAM } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope, assertConceptOwned } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import {
  syncCapexPaymentPosting, capexLedgerState, capexTreatmentOf, recalcLinePaid, assertPaymentRemovable,
  prepareCapitalisation, checkCapitalisable, insertCapitaliseRequestTx, recordDepositReturn, reclassLegacyDeposit,
  findOrphanAdvances, pendingCapitalisation, CAPEX_TREATMENTS, CAPEX_SOURCE,
  DEPOSIT_RETURN_SOURCE, DEPOSIT_RECLASS_SOURCE, type CapexLineLedger,
} from './capexPosting.js'
import { liveRevision, syncSourcePosting } from '../accounting/sourcePosting.js'
import { releasePrepaidThrough } from '../accounting/prepaidReleases.js'
import { flagException, kindsMatching } from '../../lib/exceptions.js'
import {
  requireActiveCompany, assertConceptAttachable, assertLocationOfCompany, assertConceptOfCompany,
  assertMemberOfCompany, assertSupplierOfCompany, assertBankAccountOfCompany,
} from './companyRefs.js'
import { type DbMoney, assertMoneyFits, toCents, zMoneyCents } from '../../lib/money.js'
import { moneyAccountCode, zReceiptMethod, zPaymentRef, assertPaymentReference } from '../../lib/bankAccounts.js'
import { findPaymentReferenceUses } from '../../lib/paymentRefs.js'
import { TAX_AUTHORITY_KEYS } from '../accounting/taxAuthorities.js'
import { WHT_SECTIONS } from '../../lib/withholding.js'
import { getAssetClasses, classOf, SMALLWARE_TYPES, SMALLWARE_TYPE_LABELS } from '../fixedAssets/classes.js'
import { FA_WRITER_ROLES, FA_APPROVER_ROLE, applyEvent } from '../fixedAssets/events.js'
import { lastCompletedPeriodPkt } from '../fixedAssets/schedule.js'

// Capital (the CapEx tracker and the old capital ledger) is the Finance
// workspace's: finance reads it as well as the manager tiers. Every /finance
// route is narrowed by the 'capital' module (lib/moduleAccess.ts), so a
// FOH/BOH manager without it is refused.
const CAPITAL_READERS = FINANCE_TEAM
// Working the tracker — projects, lines, quotes, instalments, Quick buy,
// deposit returns — is finance's normal job (wave 3, UI-07). An instalment
// marked paid posts in the same transaction (capexPosting.ts).
const CAPITAL_WRITERS = FINANCE_TEAM
// Preparing a capitalisation and running the prepaid release: the
// fixed-asset writers (fixedAssets/events.ts FA_WRITER_ROLES — one list).
// The CEO approves every capitalisation (FA_APPROVER_ROLE).
const FA_WRITERS = [...FA_WRITER_ROLES] as Array<(typeof FINANCE_TEAM)[number]>

const STATUS_ENUM = ['not_quoted', 'quoted', 'ordered', 'partial_paid', 'delivered', 'installed', 'commissioned', 'snag', 'done'] as const
const WHT_SECTION_INPUT = [...WHT_SECTIONS, 'none'] as const
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a date like 2026-09-30')
const periodStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-09')

// Scope is a free-form string per project — operators define their own
// section headings via CapexProject.scopeConfig.
const lineSchema = z.object({
  scope:           z.string().min(1).max(40),
  category:        z.string().max(80).nullable().optional(),
  item:            z.string().min(1).max(200),
  quantity:        z.number().int().positive().default(1),
  // Money: BIGINT paisa, one amount ≤ PKR 900bn (lib/money.ts), else 422.
  unitCostCents:   zMoneyCents('A line\'s unit cost'),
  vendor:          z.string().max(120).nullable().optional(),
  vendorContact:   z.string().max(120).nullable().optional(),
  quotedCents:     zMoneyCents('A quoted amount').nullable().optional(),
  negotiatedCents: zMoneyCents('A negotiated amount').nullable().optional(),
  paidCents:       zMoneyCents('A paid amount').optional(),
  status:          z.enum(STATUS_ENUM).optional(),
  priority:        z.enum(['must_have', 'nice_to_have', 'future']).optional(),
  leadTimeDays:    z.number().int().min(0).nullable().optional(),
  expectedDeliveryDate: z.string().nullable().optional(),
  actualDeliveryDate:   z.string().nullable().optional(),
  installedDate:        z.string().nullable().optional(),
  documentUrls: z.array(z.object({ label: z.string(), url: z.string().url() })).nullable().optional(),
  photoUrls:    z.array(z.string().url()).nullable().optional(),
  warrantyMonths: z.number().int().min(0).nullable().optional(),
  assignedToId:   z.string().uuid().nullable().optional(),
  notes:          z.string().nullable().optional(),
  sortOrder:      z.number().int().optional(),
  // Wave B: the vendor (a Supplier of the PROJECT's company), the ONE
  // treatment override, the sales tax charged (by which authority) and the
  // withholding section ('none' = no WHT).
  supplierId:        z.string().min(1).nullable().optional(),
  treatment:         z.enum(CAPEX_TREATMENTS).nullable().optional(),
  inputTaxCents:     zMoneyCents('The sales tax on this line').optional(),
  inputTaxAuthority: z.enum(TAX_AUTHORITY_KEYS).nullable().optional(),
  whtSection:        z.enum(WHT_SECTION_INPUT).nullable().optional(),
})
type LineBody = z.infer<typeof lineSchema>

// Line fields frozen once the line is on the register (or waiting for the
// CEO): void the asset(s) and capitalise again instead.
const COST_FIELDS = ['quantity', 'unitCostCents', 'negotiatedCents', 'actualDeliveryDate', 'installedDate', 'inputTaxCents', 'inputTaxAuthority'] as const

const toDate = (s: string | null | undefined) => (s ? new Date(s) : null)

// Compute roll-ups for a project: budgeted (line item totals), quoted (sum of
// won quotes), committed (negotiatedCents sum), paid (paidCents sum),
// remaining (envelope - committed), variance vs envelope.
function withRollups<T extends { lines: Array<{ unitCostCents: DbMoney; quantity: number; quotedCents: DbMoney | null; negotiatedCents: DbMoney | null; paidCents: DbMoney; status: string }>; consultantFeesCents: DbMoney; taxCents: DbMoney; budgetEnvelopeCents: DbMoney; contingencyPct: number }>(p: T) {
  const budgeted   = p.lines.reduce((s, l) => s + toCents(l.unitCostCents) * l.quantity, 0)
  const quoted     = p.lines.reduce((s, l) => s + toCents(l.quotedCents ?? 0), 0)
  const committed  = p.lines.reduce((s, l) => s + (l.negotiatedCents != null ? toCents(l.negotiatedCents) : toCents(l.unitCostCents) * l.quantity), 0)
  const paid       = p.lines.reduce((s, l) => s + toCents(l.paidCents), 0)
  const totalAsk   = budgeted + toCents(p.consultantFeesCents) + toCents(p.taxCents)
  const contingency = Math.round(budgeted * p.contingencyPct)
  const envelope   = toCents(p.budgetEnvelopeCents)
  return {
    ...p,
    rollups: {
      budgetedCents: budgeted,
      quotedCents: quoted,
      committedCents: committed,
      paidCents: paid,
      remainingCents: envelope - committed,
      contingencyCents: contingency,
      totalAskCents: totalAsk,
      varianceVsEnvelopeCents: committed - envelope,
    },
  }
}

// What a CapEx screen picks from, per company: the register's classes, the
// smallwares types, the company's suppliers (system suppliers excluded) and
// its smallwares pools.
async function companyLookups(tenantId: string) {
  const [classes, suppliers, pools] = await Promise.all([
    getAssetClasses(tenantId, prisma),
    prisma.supplier.findMany({
      where: { tenantId, deletedAt: null, systemKind: null },
      select: { id: true, name: true, filerStatus: true, whtExemptUntil: true, whtExemptCertNo: true, defaultWhtSection: true, defaultTaxAuthority: true },
      orderBy: { name: 'asc' },
    }),
    prisma.fixedAssetPool.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, label: true, locationId: true, conceptId: true, classKey: true, typeKey: true },
      orderBy: { label: 'asc' },
    }),
  ])
  return {
    assetClasses: classes.filter((c) => c.isActive).map((c) => ({
      key: c.key, label: c.label, pooled: c.pooled, depreciable: c.depreciable, defaultLifeMonths: c.defaultLifeMonths, costAccountCode: c.costAccountCode,
    })),
    lookups: { suppliers, pools, smallwareTypes: SMALLWARE_TYPES.map((k) => ({ key: k, label: SMALLWARE_TYPE_LABELS[k] ?? k })) },
  }
}

// The books' view of each project (owner decision 24, M-04): per line what
// its posted instalments put on the books and the asset(s) it became; per
// project the totals — capitalised excludes disposed and voided assets.
async function withLedger<P extends { tenantId: string | null; lines: Array<{ id: string; payments: Array<{ id: string; whtCents?: DbMoney }> }> }>(tenantIds: string[], projects: P[]) {
  const state = await capexLedgerState(tenantIds, projects.flatMap((p) => p.lines))
  const lookupsByCompany = new Map<string, Awaited<ReturnType<typeof companyLookups>>>()
  for (const t of new Set(projects.map((p) => p.tenantId).filter((x): x is string => !!x))) {
    lookupsByCompany.set(t, await companyLookups(t))
  }
  return projects.map((p) => {
    const lines = p.lines.map((l) => {
      const ledger = state.get(l.id) ?? null
      return {
        ...l,
        payments: l.payments.map((pay) => ({
          ...pay,
          whtCents: toCents(pay.whtCents ?? 0),
          releasedCents: ledger?.payments[pay.id]?.releasedCents ?? 0,
        })),
        ledger,
        capitalisation: ledger?.capitalisation ?? { assetIds: [], pendingEventId: null },
      }
    })
    const sum = (f: (x: CapexLineLedger) => number) => lines.reduce((t, l) => t + (l.ledger ? f(l.ledger) : 0), 0)
    const advancedCents = sum((x) => x.advancedCents)
    const advancedOnCapitalised = lines.reduce((t, l) => t + (l.ledger && l.ledger.capitalisation.assetIds.length > 0 ? l.ledger.advancedCents : 0), 0)
    const lk = p.tenantId ? lookupsByCompany.get(p.tenantId) : undefined
    return {
      ...p,
      lines,
      assetClasses: lk?.assetClasses ?? [],
      lookups: lk?.lookups ?? { suppliers: [], pools: [], smallwareTypes: [] },
      books: {
        capitalisedCents: sum((x) => x.capitalisedCents),
        disposedCents: sum((x) => x.disposedCents),
        advancedCents,
        notYetCapitalisedCents: advancedCents - advancedOnCapitalised,
        prepaidCents: sum((x) => x.prepaidCents),
        releasedCents: sum((x) => x.releasedCents),
        depositHeldCents: sum((x) => x.depositHeldCents),
        expensedCents: sum((x) => x.expensedCents),
        whtCents: sum((x) => x.whtCents),
      },
    }
  })
}

// Fire flag when a line takes a project over the budget envelope.
async function maybeFireOverBudgetFlag(projectId: string, lineId: string): Promise<void> {
  const project = await prisma.capexProject.findUnique({
    where: { id: projectId },
    include: { lines: { select: { negotiatedCents: true, unitCostCents: true, quantity: true, item: true } } },
  })
  if (!project || project.isStanding) return
  const envelope = toCents(project.budgetEnvelopeCents)
  if (envelope === 0) return
  const committed = project.lines.reduce((s, l) => s + (l.negotiatedCents != null ? toCents(l.negotiatedCents) : toCents(l.unitCostCents) * l.quantity), 0)
  if (committed <= envelope) return
  const overBy = committed - envelope
  // Don't double-flag — only if no open over-budget flag exists for this project.
  const existing = await prisma.exceptionFlag.findFirst({
    // Its own kind since 2026-10-12; an open flag raised before that carries
    // the stand-in 'high_value_void' and must still count.
    where: { kind: { in: kindsMatching('capex_over_budget') }, status: 'open', entityType: 'CapexProject', entityId: projectId },
    select: { id: true },
  })
  if (existing) return
  await flagException({
    kind: 'capex_over_budget',
    tenantId: project.tenantId,
    conceptId: project.conceptId,
    severity: overBy > envelope * 0.1 ? 'high' : 'medium',
    title: `CapEx project over budget: ${project.name}`,
    description: `Committed PKR ${(committed / 100).toLocaleString()} on a PKR ${(envelope / 100).toLocaleString()} envelope. Over by PKR ${(overBy / 100).toLocaleString()}.`,
    entityType: 'CapexProject',
    entityId: projectId,
    amountCents: overBy,
    metadata: { committed, envelope, lineId },
  })
}

/** True when anything of the line is on the books: a live capex.* entry, an asset (any status) or a pending capitalisation. */
async function lineHasPostings(tenantId: string | null, lineId: string): Promise<boolean> {
  if (await prisma.fixedAsset.count({ where: { capexLineId: lineId } }) > 0) return true
  if (!tenantId) return false
  if (await pendingCapitalisation(tenantId, lineId)) return true
  for (const p of await prisma.capexPayment.findMany({ where: { lineId }, select: { id: true } })) {
    for (const src of [CAPEX_SOURCE, DEPOSIT_RETURN_SOURCE, DEPOSIT_RECLASS_SOURCE]) {
      if ((await liveRevision(tenantId, src, p.id)).live) return true
    }
  }
  return false
}

/** 409 LINE_CAPITALISED when the line is on the register or its capitalisation waits for the CEO. */
async function assertLineNotCapitalised(tenantId: string | null, lineId: string): Promise<void> {
  if (!tenantId) return
  const live = await prisma.fixedAsset.count({ where: { tenantId, capexLineId: lineId, status: { not: 'voided' } } })
  if (live > 0 || await pendingCapitalisation(tenantId, lineId)) {
    throw new AppError('LINE_CAPITALISED', 'This item is on the fixed-asset register (or waiting for the CEO) — its cost, quantity and dates are fixed. Void the asset and capitalise again to change them', 409)
  }
}

/** Input tax needs its authority; it cannot exceed the line. */
function assertLineTax(inputTaxCents: number, authority: string | null | undefined, lineTotal: number): void {
  if (inputTaxCents > 0 && !authority) {
    throw new AppError('INPUT_TAX_AUTHORITY_REQUIRED', 'Say which authority charged the sales tax (FBR or SRB)', 422)
  }
  if (inputTaxCents > 0 && inputTaxCents >= lineTotal) throw new AppError('INPUT_TAX_TOO_LARGE', 'The sales tax must be less than the line\'s cost', 422)
}

function lineData<B extends Partial<LineBody>>(body: B) {
  const { expectedDeliveryDate, actualDeliveryDate, installedDate, documentUrls, photoUrls, ...rest } = body
  return {
    ...rest,
    ...(expectedDeliveryDate !== undefined ? { expectedDeliveryDate: toDate(expectedDeliveryDate) } : {}),
    ...(actualDeliveryDate !== undefined ? { actualDeliveryDate: toDate(actualDeliveryDate) } : {}),
    ...(installedDate !== undefined ? { installedDate: toDate(installedDate) } : {}),
    ...(documentUrls !== undefined ? { documentUrls: documentUrls === null ? Prisma.JsonNull : (documentUrls as Prisma.InputJsonValue) } : {}),
    ...(photoUrls !== undefined ? { photoUrls: photoUrls === null ? Prisma.JsonNull : (photoUrls as Prisma.InputJsonValue) } : {}),
  }
}

const actorOf = (req: FastifyRequest) => ({ id: req.staffUser!.id, role: req.staffUser!.role as string })

/** The company ids a scope covers (an empty scope denies: []). */
async function writeScopeIds(req: FastifyRequest): Promise<string[]> {
  const w = await scopeTenantWhere(req, 'write')
  return typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in
}

export async function financePlanningRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // Capital Ledger (read-only history)
  // ════════════════════════════════════════════════════════════════════════

  // Read-only history of the old Excel-mirror capital ledger. Nothing writes
  // to it any more and nothing counts it: capital spend is the capex tracker's
  // payments (posted as advances) and the fixed-asset register.
  fastify.get<{ Querystring: { conceptId?: string; projectId?: string; days?: string } }>(
    '/capital-ledger',
    { preHandler: requireAuth(...CAPITAL_READERS) },
    async (req) => {
      const { conceptId, projectId } = req.query
      if (conceptId) await assertConceptOwned(req, conceptId, 'read')
      const days = req.query.days ? parseInt(req.query.days, 10) : 365 * 5
      const since = new Date(Date.now() - days * 86_400_000)
      const entries = await prisma.capitalLedgerEntry.findMany({
        where: {
          deletedAt: null,
          ...(await scopeTenantWhere(req, 'read')),
          date: { gte: since },
          ...(conceptId && { conceptId }),
          ...(projectId && { projectId }),
        },
        orderBy: { date: 'desc' },
      })
      const totalCents = entries.reduce((s, e) => s + e.amountCents, 0)
      return { entries, totalCents, count: entries.length, readOnly: true, note: 'Historical entries only — capital spend is booked through CapEx payments and the fixed-asset register.' }
    },
  )

  // ════════════════════════════════════════════════════════════════════════
  // CapEx projects
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/capex', { preHandler: requireAuth(...CAPITAL_READERS) }, async (req) => {
    const projects = await prisma.capexProject.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { quotes: true, payments: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return withLedger((await resolveTenantScope(req)).tenantIds, projects.map((p) => withRollups(p)))
  })

  // What the Quick buy form and the capitalise panel pick from, for the
  // ACTIVE company: classes, smallwares types, suppliers, pools, outlets,
  // brands and bank accounts. The page calls no other gated path.
  fastify.get('/capex/lookups', { preHandler: requireAuth(...CAPITAL_READERS) }, async (req) => {
    const tenantId = requireActiveCompany(req)
    const [base, locations, brands, bankAccounts] = await Promise.all([
      companyLookups(tenantId),
      prisma.location.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.concept.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }),
      prisma.bankAccount.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, bankName: true, accountCode: true }, orderBy: { name: 'asc' } }),
    ])
    return { tenantId, ...base, locations, brands, bankAccounts, treatments: CAPEX_TREATMENTS, whtSections: WHT_SECTION_INPUT, taxAuthorities: TAX_AUTHORITY_KEYS }
  })

  // Live 'capex.payment' entries whose instalment row is gone or whose project
  // was deleted (CEO clears them with POST /capex/orphans/:paymentId/reverse).
  fastify.get('/capex/orphans', { preHandler: requireAuth(...CAPITAL_READERS) }, async (req) => {
    return { orphans: await findOrphanAdvances((await resolveTenantScope(req)).tenantIds) }
  })

  fastify.get<{ Params: { id: string } }>(
    '/capex/:id',
    { preHandler: requireAuth(...CAPITAL_READERS) },
    async (req) => {
      const p = await prisma.capexProject.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
        include: {
          lines: {
            orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }],
            include: { quotes: true, payments: { orderBy: { dueDate: 'asc' } } },
          },
        },
      })
      if (!p) throw new NotFoundError('CapexProject', req.params.id)
      return (await withLedger((await resolveTenantScope(req)).tenantIds, [withRollups(p)]))[0]
    },
  )

  fastify.post('/capex', { preHandler: requireAuth(...CAPITAL_WRITERS) }, async (req, reply) => {
    const body = z.object({
      name:       z.string().min(1).max(120),
      conceptId:  z.string().uuid().optional(),
      locationId: z.string().uuid().nullable().optional(),
      projectType: z.enum(['kitchen_buildout', 'refurb', 'expansion', 'new_brand', 'equipment_only']).default('kitchen_buildout'),
      phase:       z.enum(['planning', 'quoting', 'executing', 'snagging', 'live']).default('planning'),
      budgetEnvelopeCents: zMoneyCents('The budget envelope').default(0),
      contingencyPct:      z.number().min(0).max(0.5).default(0.10),
      consultantFeesCents: zMoneyCents('The consultant fees').default(0),
      taxCents:            zMoneyCents('The tax').default(0),
      targetOpeningDate:   z.string().nullable().optional(),
      address:             z.string().max(500).nullable().optional(),
      floorAreaSqft:       z.number().int().positive().nullable().optional(),
      ownerId:             z.string().uuid().nullable().optional(),
      notes:               z.string().optional(),
      // Project-level JV. Independent of tenant-level JV — a single build
      // can be co-funded by partners even when the parent tenant is
      // wholly-owned. UI renders partner chips on every cost row.
      isJointVenture:      z.boolean().default(false),
      jvPartners:          z.array(z.object({
        label: z.string().min(1).max(80),
        pct:   z.number().min(0).max(100),
      })).nullable().optional(),
    }).parse(req.body)
    // Bound to the ACTIVE company; brand, location and owner must all be its.
    const tenantId = requireActiveCompany(req)
    if (body.conceptId)  await assertConceptAttachable(req, body.conceptId)
    if (body.locationId) await assertLocationOfCompany(tenantId, body.locationId)
    if (body.ownerId)    await assertMemberOfCompany(tenantId, body.ownerId)
    const project = await prisma.capexProject.create({
      data: {
        ...body, tenantId,
        targetOpeningDate: body.targetOpeningDate ? new Date(body.targetOpeningDate) : null,
        jvPartners: body.jvPartners ?? undefined,
      },
    })
    return reply.status(201).send(project)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/capex/:id',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object({
        name:                z.string().min(1).max(120).optional(),
        locationId:          z.string().uuid().nullable().optional(),
        projectType:         z.enum(['kitchen_buildout', 'refurb', 'expansion', 'new_brand', 'equipment_only']).optional(),
        phase:               z.enum(['planning', 'quoting', 'executing', 'snagging', 'live']).optional(),
        budgetEnvelopeCents: zMoneyCents('The budget envelope').optional(),
        contingencyPct:      z.number().min(0).max(0.5).optional(),
        consultantFeesCents: zMoneyCents('The consultant fees').optional(),
        taxCents:            zMoneyCents('The tax').optional(),
        targetOpeningDate:   z.string().nullable().optional(),
        actualOpeningDate:   z.string().nullable().optional(),
        address:             z.string().max(500).nullable().optional(),
        floorAreaSqft:       z.number().int().positive().nullable().optional(),
        ownerId:             z.string().uuid().nullable().optional(),
        status:              z.enum(['planning', 'in_progress', 'completed', 'on_hold']).optional(),
        notes:               z.string().nullable().optional(),
        // Custom scope sections — array of { key, label, emoji?, hint? }.
        scopeConfig:         z.array(z.object({
          key:   z.string().min(1).max(40),
          label: z.string().min(1).max(80),
          emoji: z.string().max(8).nullable().optional(),
          hint:  z.string().max(200).nullable().optional(),
        })).max(30).nullable().optional(),
        // JV flag + partner split per project (independent of tenant flag)
        isJointVenture:      z.boolean().optional(),
        jvPartners:          z.array(z.object({
          label: z.string().min(1).max(80),
          pct:   z.number().min(0).max(100),
        })).nullable().optional(),
      }).parse(req.body)
      const owned = await prisma.capexProject.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
      // Re-pointing the location or owner: must be the PROJECT's company's.
      if (body.locationId) await assertLocationOfCompany(owned.tenantId, body.locationId)
      if (body.ownerId)    await assertMemberOfCompany(owned.tenantId, body.ownerId)
      // The standing Quick-buy project keeps its outlet and type.
      if (owned.isStanding && ((body.locationId !== undefined && body.locationId !== owned.locationId) || (body.projectType && body.projectType !== owned.projectType))) {
        throw new AppError('STANDING_PROJECT', 'The outlet\'s "Equipment & smallwares" project keeps its outlet and type', 409)
      }
      const { scopeConfig, jvPartners, ...rest } = body
      return prisma.capexProject.update({
        where: { id: req.params.id },
        data: {
          ...rest,
          targetOpeningDate: body.targetOpeningDate !== undefined ? toDate(body.targetOpeningDate) : undefined,
          actualOpeningDate: body.actualOpeningDate !== undefined ? toDate(body.actualOpeningDate) : undefined,
          ...(scopeConfig !== undefined && {
            scopeConfig: scopeConfig === null ? Prisma.JsonNull : (scopeConfig as Prisma.InputJsonValue),
          }),
          ...(jvPartners !== undefined && {
            jvPartners: jvPartners === null ? Prisma.JsonNull : (jvPartners as Prisma.InputJsonValue),
          }),
        },
      })
    },
  )

  // Soft-delete a CapEx project. Refused (409 PROJECT_HAS_POSTINGS) while any
  // of its lines has something on the books — an instalment, a deposit
  // return / reclass, an asset or a pending capitalisation — so no advance is
  // ever orphaned again.
  fastify.delete<{ Params: { id: string } }>(
    '/capex/:id',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const owned = await prisma.capexProject.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        include: { lines: { select: { id: true } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
      for (const l of owned.lines) {
        if (await lineHasPostings(owned.tenantId, l.id)) {
          throw new AppError('PROJECT_HAS_POSTINGS', 'This project has instalments or assets on the books — reverse them (or void the assets) before deleting it', 409)
        }
      }
      await prisma.capexProject.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
      return reply.status(204).send()
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/capex/:id/lines',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = lineSchema.parse(req.body)
      assertMoneyFits(body.unitCostCents * body.quantity, 'This line (quantity × unit cost)')
      const project = await prisma.capexProject.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      })
      if (!project) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
      if (body.assignedToId) await assertMemberOfCompany(project.tenantId, body.assignedToId)
      if (body.supplierId) await assertSupplierOfCompany(project.tenantId, body.supplierId)
      const total = body.negotiatedCents ?? body.unitCostCents * body.quantity
      assertLineTax(body.inputTaxCents ?? 0, body.inputTaxAuthority, total)
      let vendor = body.vendor
      if (body.supplierId && !vendor) vendor = (await prisma.supplier.findUnique({ where: { id: body.supplierId }, select: { name: true } }))?.name ?? null
      const line = await prisma.capexLine.create({
        data: { ...lineData({ ...body, vendor }), projectId: req.params.id },
      })
      // Over-budget flag — when the line takes the project past its envelope.
      await maybeFireOverBudgetFlag(req.params.id, line.id)
      return reply.status(201).send(line)
    },
  )

  fastify.patch<{ Params: { lineId: string } }>(
    '/capex/lines/:lineId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = lineSchema.partial().parse(req.body)
      const owned = await prisma.capexLine.findFirst({
        where: { id: req.params.lineId, project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        include: { project: { select: { tenantId: true, projectType: true } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      const tenantId = owned.project.tenantId
      assertMoneyFits((body.unitCostCents ?? toCents(owned.unitCostCents)) * (body.quantity ?? owned.quantity), 'This line (quantity × unit cost)')
      // On the register (or waiting for the CEO) the line IS capital: a change
      // of its treatment — stated, or through the scope / category / item text
      // the treatment is read from when none is stated — would send its later
      // instalments to an expense / prepaid / deposit instead of settling the
      // supplier, and claim its input tax a second time (409 LINE_CAPITALISED).
      const nextTreatment = capexTreatmentOf({
        scope: body.scope ?? owned.scope,
        category: body.category !== undefined ? body.category : owned.category,
        item: body.item ?? owned.item,
        treatment: body.treatment !== undefined ? body.treatment : owned.treatment,
      }, owned.project.projectType)
      if (nextTreatment !== capexTreatmentOf(owned, owned.project.projectType)) await assertLineNotCapitalised(tenantId, owned.id)
      if (body.assignedToId) await assertMemberOfCompany(tenantId, body.assignedToId)
      if (body.supplierId) await assertSupplierOfCompany(tenantId, body.supplierId)

      // Cost, quantity and dates are frozen on the register.
      const changes = (k: (typeof COST_FIELDS)[number]): boolean => {
        const next = body[k]
        if (next === undefined) return false
        const now = owned[k]
        if (k === 'actualDeliveryDate' || k === 'installedDate') {
          return ((now as Date | null)?.getTime() ?? null) !== (next ? new Date(next as string).getTime() : null)
        }
        if (k === 'inputTaxAuthority') return (now ?? null) !== (next ?? null)
        return (now == null ? null : toCents(now as DbMoney)) !== (next ?? null)
      }
      if (COST_FIELDS.some(changes)) await assertLineNotCapitalised(tenantId, owned.id)

      // The treatment is locked once an instalment of the line is on the books.
      if (body.treatment !== undefined && (body.treatment ?? null) !== (owned.treatment ?? null) && tenantId) {
        for (const p of await prisma.capexPayment.findMany({ where: { lineId: owned.id }, select: { id: true } })) {
          if ((await liveRevision(tenantId, CAPEX_SOURCE, p.id)).live) {
            throw new AppError('TREATMENT_LOCKED', 'An instalment of this line is already on the books as it is — the treatment can no longer change', 409)
          }
        }
      }
      const total = (body.negotiatedCents !== undefined ? body.negotiatedCents : (owned.negotiatedCents != null ? toCents(owned.negotiatedCents) : null))
        ?? (body.unitCostCents ?? toCents(owned.unitCostCents)) * (body.quantity ?? owned.quantity)
      assertLineTax(body.inputTaxCents ?? toCents(owned.inputTaxCents), body.inputTaxAuthority !== undefined ? body.inputTaxAuthority : owned.inputTaxAuthority, total)

      const updated = await prisma.capexLine.update({
        where: { id: req.params.lineId },
        data: lineData(body),
      })
      await maybeFireOverBudgetFlag(updated.projectId, updated.id)
      return updated
    },
  )

  fastify.delete<{ Params: { lineId: string } }>(
    '/capex/lines/:lineId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const owned = await prisma.capexLine.findFirst({
        where: { id: req.params.lineId, project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        include: { project: { select: { tenantId: true } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      if (await lineHasPostings(owned.project.tenantId, owned.id)) {
        throw new AppError('LINE_HAS_POSTINGS', 'This line has instalments or an asset on the books — reverse them (or void the asset) before deleting it', 409)
      }
      await prisma.capexLine.delete({ where: { id: req.params.lineId } })
      return reply.status(204).send()
    },
  )

  // ─── Quotes ───────────────────────────────────────────────────────────────

  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/quotes',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object({
        vendor:       z.string().min(1).max(120),
        contactName:  z.string().max(120).nullable().optional(),
        contactPhone: z.string().max(40).nullable().optional(),
        totalCents:   zMoneyCents('A quote\'s total'),
        leadTimeDays: z.number().int().min(0).nullable().optional(),
        validUntil:   z.string().nullable().optional(),
        fileUrl:      z.string().url().nullable().optional(),
        notes:        z.string().nullable().optional(),
      }).parse(req.body)
      const ownedLine = await prisma.capexLine.findFirst({
        where: { id: req.params.lineId, project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      })
      if (!ownedLine) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      const q = await prisma.capexQuote.create({
        data: { ...body, lineId: req.params.lineId, validUntil: toDate(body.validUntil) },
      })
      return reply.status(201).send(q)
    },
  )

  fastify.patch<{ Params: { quoteId: string } }>('/capex/quotes/:quoteId/winner',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req) => {
      const q = await prisma.capexQuote.findFirst({
        where: { id: req.params.quoteId, line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        include: { line: { select: { project: { select: { tenantId: true } } } } },
      })
      if (!q) throw new NotFoundError('CapexQuote', req.params.quoteId)
      // The winner rewrites the line's vendor and negotiated cost: never on a
      // line already on the register (or waiting for the CEO).
      await assertLineNotCapitalised(q.line.project.tenantId, q.lineId)
      await prisma.$transaction([
        prisma.capexQuote.updateMany({ where: { lineId: q.lineId }, data: { isWinner: false } }),
        prisma.capexQuote.update({ where: { id: q.id }, data: { isWinner: true } }),
        prisma.capexLine.update({
          where: { id: q.lineId },
          data: { vendor: q.vendor, negotiatedCents: q.totalCents, leadTimeDays: q.leadTimeDays, status: 'quoted' },
        }),
      ])
      return prisma.capexLine.findUnique({ where: { id: q.lineId }, include: { quotes: true } })
    },
  )

  fastify.delete<{ Params: { quoteId: string } }>('/capex/quotes/:quoteId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const owned = await prisma.capexQuote.findFirst({
        where: { id: req.params.quoteId, line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Quote not found in your active company' } })
      await prisma.capexQuote.delete({ where: { id: req.params.quoteId } })
      return reply.status(204).send()
    },
  )

  // ─── Payments ─────────────────────────────────────────────────────────────

  // Marking an instalment paid posts it to the books in the SAME transaction
  // (capexPosting.ts): by the LINE's treatment, net of the income tax
  // withheld, from the bank (or cash). A payment the ledger refuses (closed
  // month, project with no company) is not saved. There is no per-payment
  // treatment — the line's is the only override.
  const capexPaymentBody = {
    paidAt:          z.string().nullable().optional(),
    paidAmountCents: zMoneyCents('A paid amount').nullable().optional(),
    paymentRef:      z.string().max(120).nullable().optional(),
    notes:           z.string().nullable().optional(),
    payFrom:         z.enum(['bank', 'cash']).optional(),
    // The company bank account it is paid from — the PROJECT's company's
    // (lib/bankAccounts.ts moneyAccountCode; 422 otherwise). Stored on the
    // instalment; null = the company's only bank.
    bankAccountId:   z.string().min(1).nullable().optional(),
    // A rent advance: the months it covers (released monthly to rent, H25).
    coversFrom:      periodStr.nullable().optional(),
    coversMonths:    z.number().int().min(1).max(240).nullable().optional(),
    // The operator's own withholding figure, with the reason (e.g. the
    // vendor's certificate is not on file yet). null reason = computed.
    whtOverrideCents:  zMoneyCents('The income tax withheld').optional(),
    whtOverrideReason: z.string().trim().max(500).nullable().optional(),
  }
  type PaymentBody = { [K in keyof typeof capexPaymentBody]?: z.infer<(typeof capexPaymentBody)[K]> }

  function overrideData(body: PaymentBody): { whtCents?: number; whtOverrideReason?: string | null; whtRateBps?: null } {
    if (body.whtOverrideReason === null) return { whtOverrideReason: null, whtRateBps: null }
    if (body.whtOverrideCents === undefined && body.whtOverrideReason === undefined) return {}
    const reason = (body.whtOverrideReason ?? '').trim()
    if (body.whtOverrideCents === undefined || reason.length < 5) {
      throw new AppError('WHT_OVERRIDE_REASON_REQUIRED', 'Give the withholding amount and the reason for overriding it (at least 5 characters)', 422)
    }
    return { whtCents: body.whtOverrideCents, whtOverrideReason: reason }
  }

  // A bank account named on an instalment must be a live, linked bank of the
  // PROJECT's company — checked on every save, paid or not, so a scheduled
  // instalment can never carry another company's bank. Cash names none.
  async function assertInstalmentBank(projectTenantId: string | null, payFrom: 'bank' | 'cash' | undefined, bankAccountId: string | null | undefined): Promise<void> {
    if (!bankAccountId) return
    if (payFrom === 'cash') throw new AppError('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
    if (!projectTenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company', 422)
    await moneyAccountCode(prisma, projectTenantId, { method: 'bank', bankAccountId })
  }

  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/payments',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object({
        label:       z.enum(['deposit', 'midpoint', 'balance', 'extra']).default('deposit'),
        amountCents: zMoneyCents('An instalment'),
        dueDate:     z.string().nullable().optional(),
        ...capexPaymentBody,
      }).parse(req.body)
      const ownedLine = await prisma.capexLine.findFirst({
        where: { id: req.params.lineId, project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        include: { project: { select: { tenantId: true } } },
      })
      if (!ownedLine) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      const { payFrom, bankAccountId, whtOverrideCents: _o, whtOverrideReason: _r, ...data } = body
      await assertInstalmentBank(ownedLine.project.tenantId, payFrom, bankAccountId)
      const override = overrideData(body)
      const result = await prisma.$transaction(async (tx) => {
        const p = await tx.capexPayment.create({
          data: {
            ...data,
            ...override,
            lineId: req.params.lineId,
            bankAccountId: payFrom === 'cash' ? null : (bankAccountId ?? null),
            dueDate: toDate(data.dueDate),
            paidAt:  toDate(data.paidAt),
          },
        })
        const ledger = await syncCapexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id, payFrom, bankAccountId })
        await recalcLinePaid(req.params.lineId, tx)
        const fresh = await tx.capexPayment.findUniqueOrThrow({ where: { id: p.id } })
        return { ...fresh, ledger }
      })
      return reply.status(201).send(result)
    },
  )

  fastify.patch<{ Params: { paymentId: string } }>('/capex/payments/:paymentId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object(capexPaymentBody).parse(req.body)
      const ownedPayment = await prisma.capexPayment.findFirst({
        where: { id: req.params.paymentId, line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        include: { line: { select: { project: { select: { tenantId: true } } } } },
      })
      if (!ownedPayment) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      if (ownedPayment.source === 'cash') {
        throw new AppError('PAID_FROM_CASH', 'This instalment was paid from petty cash / a cash request — correct it there', 409)
      }
      const tenantId = ownedPayment.line.project.tenantId
      // A prepayment's months cannot move once releasing has started.
      const coverChange = (body.coversFrom !== undefined && body.coversFrom !== ownedPayment.coversFrom)
        || (body.coversMonths !== undefined && body.coversMonths !== ownedPayment.coversMonths)
      if (coverChange && tenantId && await prisma.prepaidRelease.count({ where: { tenantId, sourceType: 'capex_payment', sourceId: ownedPayment.id, reversedAt: null } }) > 0) {
        throw new AppError('PREPAID_RELEASING', 'Part of this prepayment has already been released to rent — its months can no longer change', 409)
      }
      const { payFrom, bankAccountId, whtOverrideCents: _o, whtOverrideReason: _r, ...data } = body
      await assertInstalmentBank(tenantId, payFrom, bankAccountId)
      const override = overrideData(body)
      const updated = await prisma.$transaction(async (tx) => {
        await tx.capexPayment.update({
          where: { id: ownedPayment.id },
          data: {
            ...data,
            ...override,
            // Paid in cash: no bank account. Otherwise only when named.
            ...(payFrom === 'cash' ? { bankAccountId: null } : bankAccountId !== undefined ? { bankAccountId } : {}),
            paidAt: data.paidAt !== undefined ? toDate(data.paidAt) : undefined,
          },
        })
        const ledger = await syncCapexPaymentPosting(ownedPayment.id, { tx, postedBy: req.staffUser!.id, payFrom, bankAccountId })
        await recalcLinePaid(ownedPayment.lineId, tx)
        const fresh = await tx.capexPayment.findUniqueOrThrow({ where: { id: ownedPayment.id } })
        return { ...fresh, ledger }
      })
      return updated
    },
  )

  fastify.delete<{ Params: { paymentId: string } }>('/capex/payments/:paymentId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const p = await prisma.capexPayment.findFirst({
        where: { id: req.params.paymentId, line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        include: { line: { select: { project: { select: { tenantId: true } } } } },
      })
      if (!p) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      const tenantId = p.line.project.tenantId
      await prisma.$transaction(async (tx) => {
        await assertPaymentRemovable(p.id, tx)
        // A posted instalment is reversed before its row goes.
        if (tenantId) {
          await syncSourcePosting({ tenantId, sourceType: CAPEX_SOURCE, id: p.id, desired: null, postedBy: req.staffUser!.id, reason: 'Capex payment deleted', tx })
        }
        await tx.capexPayment.delete({ where: { id: p.id } })
        await recalcLinePaid(p.lineId, tx)
      })
      return reply.status(204).send()
    },
  )

  // POST /finance/capex/:id/post-payments — put a project's paid instalments
  // that predate the posting rule on the books (admin, dry run by default).
  // Idempotent: an instalment already posted is left as it is; one dated in a
  // closed month is listed, never forced.
  fastify.post<{ Params: { id: string } }>('/capex/:id/post-payments',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
      const project = await prisma.capexProject.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        include: { lines: { include: { payments: { where: { paidAt: { not: null } }, select: { id: true } } } } },
      })
      if (!project) throw new NotFoundError('CapexProject', req.params.id)
      if (!project.tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company', 422)
      const state = await capexLedgerState([project.tenantId], project.lines)
      const rows: Array<{ paymentId: string; outcome: string }> = []
      for (const l of project.lines) {
        for (const p of l.payments) {
          if (state.get(l.id)?.payments[p.id]?.status === 'posted') { rows.push({ paymentId: p.id, outcome: 'already_posted' }); continue }
          if (body.dryRun) { rows.push({ paymentId: p.id, outcome: `would_post:${capexTreatmentOf(l, project.projectType)}` }); continue }
          try {
            const r = await prisma.$transaction((tx) => syncCapexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id }))
            rows.push({ paymentId: p.id, outcome: r.outcome })
          } catch (err) {
            rows.push({ paymentId: p.id, outcome: `error:${(err as Error).message}` })
          }
        }
      }
      return { dryRun: body.dryRun, rows }
    },
  )

  // ─── Capitalisation (→ the fixed-asset register, through the CEO) ─────────

  const capitaliseBody = z.object({
    classKey: z.string().min(1).max(40),
    inServiceAt: isoDay.optional(),
    usefulLifeMonths: z.number().int().min(1).max(600).optional(),
    salvageCents: zMoneyCents('The salvage value').optional(),
    name: z.string().min(1).max(120).optional(),
    // Where the asset physically is (omitted = the project's outlet).
    locationId: z.string().min(1).nullable().optional(),
    // An individual asset's brand (omitted = the project's brand; null = shared across brands —
    // which needs a location: 422 LOCATION_REQUIRED_FOR_SHARED, owner 2026-10-14).
    conceptId: z.string().min(1).nullable().optional(),
    pool: z.object({ typeKey: z.string().min(1).max(40), conceptId: z.string().min(1).nullable().optional() }).optional(),
    costCents: zMoneyCents('The asset\'s cost', { sign: 'positive' }).optional(),
    inputTaxCents: zMoneyCents('The input tax').optional(),
    leaseEndsAt: isoDay.optional(),
    reason: z.string().trim().max(1000).optional(),
  })

  // POST /finance/capex/lines/:lineId/capitalise — prepare a delivered item
  // for the register. Finance's preparation waits for the CEO (202, pending
  // in the approvals inbox); the CEO's own applies at once (201): Dr class
  // cost (+ input tax) / Cr 1340 advanced / Cr 2012 still owed.
  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/capitalise',
    { preHandler: requireAuth(...FA_WRITERS) },
    async (req, reply) => {
      const body = capitaliseBody.parse(req.body)
      const line = await prisma.capexLine.findFirst({
        where: { id: req.params.lineId, project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        select: { id: true, project: { select: { tenantId: true } } },
      })
      if (!line) throw new NotFoundError('CapexLine', req.params.lineId)
      // Ids attached to the asset must be the LINE's company's (422 otherwise).
      if (body.locationId) await assertLocationOfCompany(line.project.tenantId, body.locationId)
      if (body.conceptId) await assertConceptOfCompany(line.project.tenantId, body.conceptId)
      const result = await prepareCapitalisation({ ...body, lineId: line.id, tenantId: line.project.tenantId ?? undefined }, actorOf(req))
      await audit({
        category: 'accounting',
        action: result.applied ? 'fixed_asset.capitalise_capex' : 'fixed_asset.capitalise_request',
        entity: 'CapexLine', entityId: line.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: line.project.tenantId,
        after: result, metadata: { classKey: body.classKey, eventId: result.eventId },
      })
      return reply.status(result.applied ? 201 : 202).send({ ...result, status: result.applied ? 'posted' : 'pending' })
    },
  )

  // ─── Quick buy (bank only) ────────────────────────────────────────────────

  // POST /finance/capex/quick-buy — one form for buying equipment / smallwares
  // for an outlet: the outlet's standing "Equipment & smallwares" project
  // (projectType 'equipment_only', the ACTIVE company), a line delivered on
  // the day, its payment from a BANK account (posted: Dr 1340 / Cr bank net /
  // Cr 2040 WHT) and the capitalisation request — all in one transaction.
  // The CEO's own Quick buy is then applied at once. Cash never pays here
  // (owner: cash goes through a cash request / petty cash and its CapEx line).
  fastify.post('/capex/quick-buy', { preHandler: requireAuth(...CAPITAL_WRITERS) }, async (req, reply) => {
    const body = z.object({
      locationId:        z.string().min(1),
      conceptId:         z.string().min(1).nullable().optional(),
      item:              z.string().trim().min(1).max(200),
      classKey:          z.string().min(1).max(40),
      typeKey:           z.string().min(1).max(40).optional(),
      quantity:          z.number().int().min(1).max(100_000).default(1),
      unitCostCents:     zMoneyCents('The unit cost', { sign: 'positive' }),
      supplierId:        z.string().min(1).nullable().optional(),
      vendor:            z.string().trim().max(120).nullable().optional(),
      paidAt:            isoDay,
      payFrom:           z.enum(['bank', 'cash']).optional(),
      bankAccountId:     z.string().min(1).nullable().optional(),
      paymentRef:        z.string().max(120).nullable().optional(),
      inputTaxCents:     zMoneyCents('The sales tax').default(0),
      inputTaxAuthority: z.enum(TAX_AUTHORITY_KEYS).nullable().optional(),
      whtSection:        z.enum(WHT_SECTION_INPUT).nullable().optional(),
      whtOverrideCents:  zMoneyCents('The income tax withheld').optional(),
      whtOverrideReason: z.string().trim().max(500).nullable().optional(),
      usefulLifeMonths:  z.number().int().min(1).max(600).optional(),
      salvageCents:      zMoneyCents('The salvage value').optional(),
      warrantyMonths:    z.number().int().min(0).max(600).nullable().optional(),
      notes:             z.string().max(2000).nullable().optional(),
      reason:            z.string().trim().max(1000).optional(),
    }).parse(req.body)
    if (body.payFrom === 'cash') {
      throw new AppError('QUICK_BUY_BANK_ONLY', 'Quick buy pays from a bank account. Equipment bought with cash goes through a cash request (or a petty-cash spend) and its CapEx line', 422)
    }
    // Every client id resolves to the ACTIVE company (422 otherwise).
    const tenantId = requireActiveCompany(req)
    await assertLocationOfCompany(tenantId, body.locationId)
    if (body.conceptId) await assertConceptOfCompany(tenantId, body.conceptId)
    if (body.supplierId) await assertSupplierOfCompany(tenantId, body.supplierId)
    if (body.bankAccountId) await assertBankAccountOfCompany(tenantId, body.bankAccountId)
    const cls = await classOf(tenantId, body.classKey, prisma)
    if (!cls.isActive) throw new AppError('CLASS_INACTIVE', `${cls.label} is switched off for this company`, 422)
    if (cls.pooled && !body.typeKey) throw new AppError('POOL_TYPE_REQUIRED', 'Say which smallwares type this is (plates, knives, …)', 422)
    if (body.typeKey && !SMALLWARE_TYPES.includes(body.typeKey)) {
      throw new AppError('POOL_TYPE', `Unknown smallwares type "${body.typeKey}" — one of ${SMALLWARE_TYPES.join(', ')}`, 422)
    }
    const total = body.unitCostCents * body.quantity
    assertMoneyFits(total, 'This purchase (quantity × unit cost)')
    assertLineTax(body.inputTaxCents, body.inputTaxAuthority, total)
    const override = overrideData(body)
    const actor = actorOf(req)
    const canCapitalise = FA_WRITER_ROLES.includes(actor.role)
    const paidAt = new Date(`${body.paidAt.slice(0, 10)}T12:00:00+05:00`)
    if (Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 86_400_000) {
      throw new AppError('BAD_DATE', 'The payment date must be a real date, not in the future', 422)
    }
    const supplierName = body.supplierId ? (await prisma.supplier.findUnique({ where: { id: body.supplierId }, select: { name: true } }))?.name ?? null : null

    const out = await prisma.$transaction(async (tx) => {
      // The outlet's standing project (one live per company + outlet).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capex_standing:${tenantId}:${body.locationId}`}))`
      let project = await tx.capexProject.findFirst({ where: { tenantId, locationId: body.locationId, isStanding: true, deletedAt: null } })
      if (!project) {
        const location = await tx.location.findUniqueOrThrow({ where: { id: body.locationId }, select: { name: true } })
        project = await tx.capexProject.create({
          data: {
            tenantId, locationId: body.locationId, isStanding: true, projectType: 'equipment_only',
            name: `Equipment & smallwares — ${location.name}`.slice(0, 120), phase: 'live', status: 'in_progress',
          },
        })
      }
      const line = await tx.capexLine.create({
        data: {
          projectId: project.id, scope: 'Equipment', category: cls.label, item: body.item, quantity: body.quantity,
          unitCostCents: body.unitCostCents, negotiatedCents: total, status: 'delivered', actualDeliveryDate: paidAt,
          vendor: body.vendor ?? supplierName, supplierId: body.supplierId ?? null, treatment: 'capital',
          inputTaxCents: body.inputTaxCents, inputTaxAuthority: body.inputTaxAuthority ?? null, whtSection: body.whtSection ?? null,
          warrantyMonths: body.warrantyMonths ?? null, notes: body.notes ?? null,
        },
      })
      const payment = await tx.capexPayment.create({
        data: {
          lineId: line.id, label: 'balance', amountCents: total, paidAmountCents: total, paidAt,
          paymentRef: body.paymentRef ?? null, bankAccountId: body.bankAccountId ?? null,
          ...override,
        },
      })
      const ledger = await syncCapexPaymentPosting(payment.id, { tx, postedBy: actor.id, payFrom: 'bank', bankAccountId: body.bankAccountId ?? null })
      await recalcLinePaid(line.id, tx)
      let eventId: string | null = null
      if (canCapitalise) {
        const { payload } = await checkCapitalisable(tx, {
          lineId: line.id, tenantId, classKey: cls.key, inServiceAt: body.paidAt.slice(0, 10),
          usefulLifeMonths: body.usefulLifeMonths, salvageCents: body.salvageCents, locationId: body.locationId,
          ...(cls.pooled && body.typeKey ? { pool: { typeKey: body.typeKey, conceptId: body.conceptId ?? null } } : {}),
        })
        eventId = await insertCapitaliseRequestTx(tx, {
          tenantId, lineId: line.id, payload, requestedById: actor.id, effectiveDate: paidAt,
          reason: (body.reason ?? '').length >= 10 ? body.reason! : `Quick buy: ${body.item} for ${project.name}`,
        })
      }
      return { projectId: project.id, lineId: line.id, paymentId: payment.id, eventId, ledger }
    }, { timeout: 60_000, maxWait: 15_000 })

    // The CEO's own Quick buy is applied at once, through the one approval
    // engine; a refusal leaves the request pending (with its reason) in the
    // inbox — the purchase itself is already on the books.
    let applied = false
    let assetIds: string[] = []
    let capitaliseError: { code: string; message: string } | null = null
    if (out.eventId && actor.role === FA_APPROVER_ROLE) {
      try {
        const ev = await applyEvent(out.eventId, actor.id)
        applied = true
        const ids = (ev.payload as { assetIds?: unknown } | null)?.assetIds
        assetIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
      } catch (err) {
        capitaliseError = { code: err instanceof AppError ? err.code : 'CAPITALISE_FAILED', message: (err as Error).message }
      }
    }
    await audit({
      category: 'accounting', action: 'capex.quick_buy', entity: 'CapexLine', entityId: out.lineId,
      userId: actor.id, userEmail: req.staffUser!.email, tenantId,
      after: { ...out, applied, assetIds }, metadata: { classKey: cls.key, totalCents: total, locationId: body.locationId },
    })
    return reply.status(201).send({
      ...out,
      capitalisation: out.eventId ? { eventId: out.eventId, status: applied ? 'posted' : 'pending', applied, assetIds, error: capitaliseError } : null,
    })
  })

  // ─── Deposits (H25: refundable deposits on 1360) ──────────────────────────

  // How a landlord's deposit can come back (lib/bankAccounts.ts receipt methods, card aside).
  const DEPOSIT_RETURN_METHODS = ['cash', 'bank_transfer', 'bank_deposit', 'cheque'] as const

  // POST /finance/capex/payments/:paymentId/deposit-return — the landlord gave
  // the deposit back (Dr the money account) and/or kept part of it (Dr 6010
  // rent, reason required) / Cr 1360. Totals are re-stated on each call. Dated
  // the day the money came back: a closed month is 422 PERIOD_LOCKED.
  //
  // Money returned (owner, 2026-10-14): `method` — cash, bank_transfer,
  // bank_deposit or cheque (lib/bankAccounts.ts receipt methods; the old
  // `payFrom` bank | cash still works as bank_transfer | cash) — and its
  // payment reference # (`reference`, 422 PAYMENT_REFERENCE_REQUIRED when
  // returnedCents > 0, every method). The account is moneyAccountCode of the
  // PROJECT's company: a bank of another company is 422. A reference this
  // company used before answers `referenceUsedBefore` — a warning only.
  fastify.post<{ Params: { paymentId: string } }>('/capex/payments/:paymentId/deposit-return',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object({
        returnedCents:  zMoneyCents('The amount returned').default(0),
        forfeitedCents: zMoneyCents('The amount kept by the landlord').default(0),
        reason:         z.string().trim().max(500).nullable().optional(),
        receivedAt:     isoDay,
        method:         zReceiptMethod(DEPOSIT_RETURN_METHODS).optional(),
        payFrom:        z.enum(['bank', 'cash']).optional(),   // the old spelling of `method`
        reference:      zPaymentRef.nullable().optional(),
        bankAccountId:  z.string().min(1).nullable().optional(),
      }).parse(req.body)
      if (body.method && body.payFrom && (body.method === 'cash') !== (body.payFrom === 'cash')) {
        throw new AppError('PAYMENT_METHOD_CONFLICT', 'Say how the deposit came back once — method and payFrom disagree', 422)
      }
      const method = body.method ?? (body.payFrom === 'cash' ? 'cash' : 'bank_transfer')
      const p = await prisma.capexPayment.findFirst({
        where: { id: req.params.paymentId, line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        include: { line: { select: { project: { select: { tenantId: true } } } } },
      })
      if (!p) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      const tenantId = p.line.project.tenantId
      if (!tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company', 422)
      if (body.returnedCents > 0) assertPaymentReference(method, body.reference)
      // The bank must be the project's company's (moneyAccountCode; recordDepositReturn re-resolves it in the transaction).
      if (body.returnedCents > 0) await moneyAccountCode(prisma, tenantId, { method, bankAccountId: body.bankAccountId ?? null })
      const r = await prisma.$transaction((tx) => recordDepositReturn(tx, {
        paymentId: p.id, returnedCents: body.returnedCents, forfeitedCents: body.forfeitedCents, reason: body.reason,
        receivedAt: new Date(`${body.receivedAt.slice(0, 10)}T12:00:00+05:00`), method, reference: body.reference ?? null,
        bankAccountId: body.bankAccountId ?? null, postedBy: req.staffUser!.id,
      }))
      const referenceUsedBefore = await findPaymentReferenceUses(prisma, tenantId, r.reference, { exclude: { kind: 'capex_deposit_return', id: p.id } })
      await audit({
        category: 'accounting', action: 'capex.deposit_return', entity: 'CapexPayment', entityId: p.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
        after: { ...body, method }, metadata: { heldCents: r.heldCents, entryId: r.entryId, referenceUsedBefore: referenceUsedBefore.length },
      })
      return reply.status(201).send({
        paymentId: p.id, ...r, method: body.returnedCents > 0 ? method : null,
        returnedCents: body.returnedCents, forfeitedCents: body.forfeitedCents, referenceUsedBefore,
      })
    },
  )

  // POST /finance/capex/payments/:paymentId/reclass-deposit — a legacy security
  // deposit booked as a prepayment (Dr 1310) moves to 1360 (CEO; dry run first).
  fastify.post<{ Params: { paymentId: string } }>('/capex/payments/:paymentId/reclass-deposit',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
      const p = await prisma.capexPayment.findFirst({
        where: { id: req.params.paymentId, line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        include: { line: { select: { project: { select: { tenantId: true } } } } },
      })
      if (!p) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      const r = await prisma.$transaction((tx) => reclassLegacyDeposit(tx, p.id, { dryRun: body.dryRun, postedBy: req.staffUser!.id }))
      if (!body.dryRun) {
        await audit({
          category: 'accounting', action: 'capex.deposit_reclass', entity: 'CapexPayment', entityId: p.id,
          userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: p.line.project.tenantId, after: r,
        })
      }
      return reply.status(body.dryRun ? 200 : 201).send({ paymentId: p.id, from: '1310', to: '1360', ...r })
    },
  )

  // POST /finance/capex/orphans/:paymentId/reverse — a live CapEx entry whose
  // instalment row is gone (or whose project was deleted) is reversed (CEO).
  fastify.post<{ Params: { paymentId: string } }>('/capex/orphans/:paymentId/reverse',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const tenantIds = await writeScopeIds(req)
      const orphan = (await findOrphanAdvances(tenantIds)).find((o) => o.paymentId === req.params.paymentId)
      if (!orphan) {
        for (const t of tenantIds) {
          if ((await liveRevision(t, CAPEX_SOURCE, req.params.paymentId)).live) {
            throw new AppError('NOT_ORPHAN', 'This instalment still exists on a live project — reverse it from the project', 409)
          }
        }
        throw new NotFoundError('CapexPayment', req.params.paymentId)
      }
      const r = await syncSourcePosting({
        tenantId: orphan.tenantId, sourceType: CAPEX_SOURCE, id: orphan.paymentId, desired: null,
        postedBy: req.staffUser!.id, reason: `Orphan CapEx entry cleared (${orphan.reason.replace('_', ' ')})`,
      })
      await audit({
        category: 'accounting', action: 'capex.orphan_reverse', entity: 'CapexPayment', entityId: orphan.paymentId,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: orphan.tenantId, before: orphan,
      })
      return reply.status(201).send({ ...orphan, outcome: r.outcome })
    },
  )

  // ─── Prepaid releases (H25 — CapEx and OpEx, accounting/prepaidReleases.ts) ─

  // POST /finance/prepaid-releases — release every prepayment of a company
  // through the last completed month (the worker does this nightly; the
  // period-close checklist's fix calls it). Body tenantId: a company in the
  // caller's write scope (default the active one).
  fastify.post('/prepaid-releases', { preHandler: requireAuth(...FA_WRITERS) }, async (req, reply) => {
    const body = z.object({
      tenantId: z.string().min(1).optional(),
      throughPeriod: periodStr.optional(),
    }).parse(req.body ?? {})
    let tenantId: string
    if (body.tenantId) {
      if (!(await writeScopeIds(req)).includes(body.tenantId)) throw new NotFoundError('Tenant', body.tenantId)
      tenantId = body.tenantId
    } else {
      tenantId = requireActiveCompany(req)
    }
    const through = body.throughPeriod ?? lastCompletedPeriodPkt()
    const r = await releasePrepaidThrough(tenantId, through, { postedBy: req.staffUser!.id })
    await audit({
      category: 'accounting', action: 'prepaid.release_run', entity: 'Tenant', entityId: tenantId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { through, ...r },
    })
    return reply.status(200).send({ tenantId, throughPeriod: through, ...r })
  })

  // There are no /finance/projections routes. The ProForma scenarios were a
  // second projections module (it counted frozen seats and read no ramp);
  // /projections is the one module, and its labour line follows the one
  // budgeted-labour rule (projections/labour.ts). The pro_formas* tables are
  // kept as history.
}

