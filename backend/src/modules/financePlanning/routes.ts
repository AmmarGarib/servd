// Finance planning module: the CapEx project tracker (quotes, status,
// budget) and the read-only history of the old capital ledger.
//
// ONE path for capital spend (owner decision 24, financePlanning/
// capexPosting.ts): a capex instalment marked paid posts as an advance to the
// supplier (or a prepayment / a fee, by what the line is), and a delivered
// item is capitalised through the fixed-asset register. The old capital-ledger
// writer (POST/PATCH/DELETE /finance/capital-ledger) is gone — it posted
// nothing and no page wrote to it. The ProForma scenarios (/finance/
// projections) are gone too: /projections is the one projections module.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, FINANCE_TEAM } from '../auth/middleware.js'

// Capital (the CapEx tracker and the old capital ledger) is the Finance
// workspace's: finance reads it as well as the manager tiers. Every /finance
// route is narrowed by the 'capital' module (lib/moduleAccess.ts), so a
// FOH/BOH manager without it is refused.
const CAPITAL_READERS = FINANCE_TEAM
// Working the tracker — projects, lines, quotes, instalments — is finance's
// normal job too (wave 3, UI-07: finance owns the Finance workspace and holds
// 'capital'). An instalment marked paid posts as an advance / prepayment / fee
// in the same transaction (capexPosting.ts): recording a supplier payment in
// the books is the finance role's work. What stays the CEO's: putting old
// instalments on the books (post-payments) and capitalising onto the
// fixed-asset register (capitalise) — ADMIN_ONLY below.
const CAPITAL_WRITERS = FINANCE_TEAM
import { NotFoundError, AppError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope, assertConceptOwned } from '../../lib/tenantScope.js'
import { syncSourcePosting } from '../accounting/sourcePosting.js'
import { ASSET_CATEGORIES, type AssetCategory } from '../fixedAssets/service.js'
import { audit } from '../../lib/audit.js'
import {
  syncCapexPaymentPosting, capitaliseCapexLine, capexLedgerState, capexTreatmentOf, CAPEX_SOURCE,
} from './capexPosting.js'
import { flagException, kindsMatching } from '../../lib/exceptions.js'
import {
  requireActiveCompany, assertConceptAttachable, assertLocationOfCompany,
  assertMemberOfCompany, assertCapexProjectOfCompany,
} from './companyRefs.js'

const STATUS_ENUM = ['not_quoted', 'quoted', 'ordered', 'partial_paid', 'delivered', 'installed', 'commissioned', 'snag', 'done'] as const

// Scope is a free-form string per project â€” operators define their own
// section headings via CapexProject.scopeConfig. We just enforce a sane
// upper bound on length.
const lineSchema = z.object({
  scope:           z.string().min(1).max(40),
  category:        z.string().max(80).nullable().optional(),
  item:            z.string().min(1).max(200),
  quantity:        z.number().int().positive().default(1),
  unitCostCents:   z.number().int().nonnegative(),
  vendor:          z.string().max(120).nullable().optional(),
  vendorContact:   z.string().max(120).nullable().optional(),
  quotedCents:     z.number().int().nonnegative().nullable().optional(),
  negotiatedCents: z.number().int().nonnegative().nullable().optional(),
  paidCents:       z.number().int().nonnegative().optional(),
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
})

// Compute roll-ups for a project: budgeted (line item totals), quoted (sum of
// won quotes), committed (negotiatedCents sum), paid (paidCents sum),
// remaining (envelope - committed), variance vs envelope.
function withRollups<T extends { lines: Array<{ unitCostCents: number; quantity: number; quotedCents: number | null; negotiatedCents: number | null; paidCents: number; status: string }>; consultantFeesCents: number; taxCents: number; budgetEnvelopeCents: number; contingencyPct: number }>(p: T) {
  const budgeted   = p.lines.reduce((s, l) => s + l.unitCostCents * l.quantity, 0)
  const quoted     = p.lines.reduce((s, l) => s + (l.quotedCents ?? 0), 0)
  const committed  = p.lines.reduce((s, l) => s + (l.negotiatedCents ?? l.unitCostCents * l.quantity), 0)
  const paid       = p.lines.reduce((s, l) => s + l.paidCents, 0)
  const totalAsk   = budgeted + p.consultantFeesCents + p.taxCents
  const contingency = Math.round(budgeted * p.contingencyPct)
  const remaining  = p.budgetEnvelopeCents - committed
  const varianceVsEnvelope = committed - p.budgetEnvelopeCents
  return {
    ...p,
    rollups: {
      budgetedCents: budgeted,
      quotedCents: quoted,
      committedCents: committed,
      paidCents: paid,
      remainingCents: remaining,
      contingencyCents: contingency,
      totalAskCents: totalAsk,
      varianceVsEnvelopeCents: varianceVsEnvelope,
    },
  }
}

// The books' view of each project (owner decision 24): per line what its
// posted instalments put on the books (advances, prepayments, fees) and the
// asset it was capitalised as; per project what is on the books as assets vs
// still sitting in advances, not yet capitalised.
async function withLedger<P extends { lines: Array<{ id: string; payments: Array<{ id: string }> }> }>(tenantIds: string[], projects: P[]) {
  const state = await capexLedgerState(tenantIds, projects.flatMap((p) => p.lines))
  return projects.map((p) => {
    const lines = p.lines.map((l) => ({ ...l, ledger: state.get(l.id) ?? null }))
    const sum = (f: (x: NonNullable<ReturnType<typeof state.get>>) => number) =>
      lines.reduce((t, l) => t + (l.ledger ? f(l.ledger) : 0), 0)
    const capitalisedCents = lines.reduce((t, l) => t + (l.ledger?.asset?.costCents ?? 0), 0)
    const advancedCents = sum((x) => x.advancedCents)
    const advancedOnCapitalised = lines.reduce((t, l) => t + (l.ledger?.asset ? l.ledger.advancedCents : 0), 0)
    return {
      ...p,
      lines,
      books: {
        capitalisedCents,
        advancedCents,
        notYetCapitalisedCents: advancedCents - advancedOnCapitalised,
        prepaidCents: sum((x) => x.prepaidCents),
        expensedCents: sum((x) => x.expensedCents),
      },
    }
  })
}

// Recompute line.paidCents from its CapexPayment children (paid only).
async function recalcLinePaid(lineId: string): Promise<void> {
  const sum = await prisma.capexPayment.aggregate({
    where: { lineId, paidAt: { not: null } },
    _sum: { paidAmountCents: true },
  })
  const paid = sum._sum.paidAmountCents ?? 0
  // Also nudge status forward when fully paid
  const line = await prisma.capexLine.findUnique({ where: { id: lineId }, select: { negotiatedCents: true, status: true } })
  let status = line?.status ?? 'quoted'
  if (line?.negotiatedCents && paid >= line.negotiatedCents && status !== 'delivered' && status !== 'installed' && status !== 'commissioned' && status !== 'done') {
    status = 'partial_paid'  // fully paid in money terms but not yet delivered â†’ "ordered/paid"
  }
  await prisma.capexLine.update({ where: { id: lineId }, data: { paidCents: paid, status } })
}

// Fire flag when a line takes a project over the budget envelope.
async function maybeFireOverBudgetFlag(projectId: string, lineId: string): Promise<void> {
  const project = await prisma.capexProject.findUnique({
    where: { id: projectId },
    include: { lines: { select: { negotiatedCents: true, unitCostCents: true, quantity: true, item: true } } },
  })
  if (!project || project.budgetEnvelopeCents === 0) return
  const committed = project.lines.reduce((s, l) => s + (l.negotiatedCents ?? l.unitCostCents * l.quantity), 0)
  if (committed <= project.budgetEnvelopeCents) return
  const overBy = committed - project.budgetEnvelopeCents
  // Don't double-flag â€” only if no open over-budget flag exists for this project
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
    severity: overBy > project.budgetEnvelopeCents * 0.1 ? 'high' : 'medium',
    title: `CapEx project over budget: ${project.name}`,
    description: `Committed PKR ${(committed / 100).toLocaleString()} on a PKR ${(project.budgetEnvelopeCents / 100).toLocaleString()} envelope. Over by PKR ${(overBy / 100).toLocaleString()}.`,
    entityType: 'CapexProject',
    entityId: projectId,
    amountCents: overBy,
    metadata: { committed, envelope: project.budgetEnvelopeCents, lineId },
  })
}

export async function financePlanningRoutes(fastify: FastifyInstance) {

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Capital Ledger
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CapEx projects
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  fastify.get('/capex', { preHandler: requireAuth(...CAPITAL_READERS) }, async (req) => {
    const projects = await prisma.capexProject.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { quotes: true, payments: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return withLedger((await resolveTenantScope(req)).tenantIds, projects.map((p) => withRollups(p)))
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
      budgetEnvelopeCents: z.number().int().nonnegative().default(0),
      contingencyPct:      z.number().min(0).max(0.5).default(0.10),
      consultantFeesCents: z.number().int().nonnegative().default(0),
      taxCents:            z.number().int().nonnegative().default(0),
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
        budgetEnvelopeCents: z.number().int().nonnegative().optional(),
        contingencyPct:      z.number().min(0).max(0.5).optional(),
        consultantFeesCents: z.number().int().nonnegative().optional(),
        taxCents:            z.number().int().nonnegative().optional(),
        targetOpeningDate:   z.string().nullable().optional(),
        actualOpeningDate:   z.string().nullable().optional(),
        address:             z.string().max(500).nullable().optional(),
        floorAreaSqft:       z.number().int().positive().nullable().optional(),
        ownerId:             z.string().uuid().nullable().optional(),
        status:              z.enum(['planning', 'in_progress', 'completed', 'on_hold']).optional(),
        notes:               z.string().nullable().optional(),
        // Custom scope sections â€” array of { key, label, emoji?, hint? }.
        // Validated shape but not the keys themselves so operators can name
        // sections however they want.
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
      const { scopeConfig, jvPartners, ...rest } = body
      return prisma.capexProject.update({
        where: { id: req.params.id },
        data: {
          ...rest,
          targetOpeningDate: body.targetOpeningDate !== undefined ? (body.targetOpeningDate ? new Date(body.targetOpeningDate) : null) : undefined,
          actualOpeningDate: body.actualOpeningDate !== undefined ? (body.actualOpeningDate ? new Date(body.actualOpeningDate) : null) : undefined,
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

  // Soft-delete a CapEx project. Lines + quotes + payments cascade through
  // the relation, but the project row stays for audit; deletedAt filters it
  // out of the list. Recoverable by clearing deletedAt on the row directly.
  fastify.delete<{ Params: { id: string } }>(
    '/capex/:id',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const owned = await prisma.capexProject.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
      await prisma.capexProject.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      })
      return reply.status(204).send()
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/capex/:id/lines',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = lineSchema.parse(req.body)
      const project = await prisma.capexProject.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      })
      if (!project) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
      if (body.assignedToId) await assertMemberOfCompany(project.tenantId, body.assignedToId)
      const line = await prisma.capexLine.create({
        data: {
          ...body,
          projectId: req.params.id,
          expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
          actualDeliveryDate:   body.actualDeliveryDate   ? new Date(body.actualDeliveryDate)   : null,
          installedDate:        body.installedDate        ? new Date(body.installedDate)        : null,
          documentUrls: body.documentUrls as never,
          photoUrls:    body.photoUrls    as never,
        },
      })

      // Over-budget flag â€” when the line's negotiatedCents exceeds the project
      // remaining envelope, fire so the operator sees it before they sign.
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
        where: {
          id: req.params.lineId,
          project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        include: { project: { select: { tenantId: true } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      if (body.assignedToId) await assertMemberOfCompany(owned.project.tenantId, body.assignedToId)
      const updated = await prisma.capexLine.update({
        where: { id: req.params.lineId },
        data: {
          ...body,
          expectedDeliveryDate: body.expectedDeliveryDate !== undefined ? (body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null) : undefined,
          actualDeliveryDate:   body.actualDeliveryDate   !== undefined ? (body.actualDeliveryDate   ? new Date(body.actualDeliveryDate)   : null) : undefined,
          installedDate:        body.installedDate        !== undefined ? (body.installedDate        ? new Date(body.installedDate)        : null) : undefined,
          documentUrls: body.documentUrls as never,
          photoUrls:    body.photoUrls    as never,
        },
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
        where: {
          id: req.params.lineId,
          project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      await prisma.capexLine.delete({ where: { id: req.params.lineId } })
      return reply.status(204).send()
    },
  )

  // â”€â”€â”€ Quotes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/quotes',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object({
        vendor:       z.string().min(1).max(120),
        contactName:  z.string().max(120).nullable().optional(),
        contactPhone: z.string().max(40).nullable().optional(),
        totalCents:   z.number().int().nonnegative(),
        leadTimeDays: z.number().int().min(0).nullable().optional(),
        validUntil:   z.string().nullable().optional(),
        fileUrl:      z.string().url().nullable().optional(),
        notes:        z.string().nullable().optional(),
      }).parse(req.body)
      const ownedLine = await prisma.capexLine.findFirst({
        where: {
          id: req.params.lineId,
          project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!ownedLine) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      const q = await prisma.capexQuote.create({
        data: {
          ...body,
          lineId: req.params.lineId,
          validUntil: body.validUntil ? new Date(body.validUntil) : null,
        },
      })
      return reply.status(201).send(q)
    },
  )

  fastify.patch<{ Params: { quoteId: string } }>('/capex/quotes/:quoteId/winner',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req) => {
      const q = await prisma.capexQuote.findFirst({
        where: {
          id: req.params.quoteId,
          line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
      })
      if (!q) throw new NotFoundError('CapexQuote', req.params.quoteId)
      // Mark this as winner, others as not. Also stamp vendor + negotiatedCents on the line.
      await prisma.$transaction([
        prisma.capexQuote.updateMany({ where: { lineId: q.lineId }, data: { isWinner: false } }),
        prisma.capexQuote.update({ where: { id: q.id }, data: { isWinner: true } }),
        prisma.capexLine.update({
          where: { id: q.lineId },
          data: {
            vendor: q.vendor,
            negotiatedCents: q.totalCents,
            leadTimeDays: q.leadTimeDays,
            status: 'quoted',
          },
        }),
      ])
      return prisma.capexLine.findUnique({ where: { id: q.lineId }, include: { quotes: true } })
    },
  )

  fastify.delete<{ Params: { quoteId: string } }>('/capex/quotes/:quoteId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const owned = await prisma.capexQuote.findFirst({
        where: {
          id: req.params.quoteId,
          line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Quote not found in your active company' } })
      await prisma.capexQuote.delete({ where: { id: req.params.quoteId } })
      return reply.status(204).send()
    },
  )

  // â”€â”€â”€ Payments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Marking an instalment paid posts it to the books in the SAME transaction
  // (owner decision 24, capexPosting.ts): a capital item as an advance to
  // the supplier (1340), a rent advance as a prepayment (1310), a broker /
  // consultant fee as an expense (6110) — from the bank (or cash). A payment
  // the ledger refuses (closed month, project with no company) is not saved.
  const capexPaymentBody = {
    paidAt:      z.string().nullable().optional(),
    paidAmountCents: z.number().int().nonnegative().nullable().optional(),
    paymentRef:  z.string().max(120).nullable().optional(),
    notes:       z.string().nullable().optional(),
    // How it is booked — defaults from what the line is (capexTreatmentOf).
    treatment:   z.enum(['capital', 'prepaid', 'expense']).optional(),
    payFrom:     z.enum(['bank', 'cash']).optional(),
  }

  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/payments',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object({
        label:       z.enum(['deposit', 'midpoint', 'balance', 'extra']).default('deposit'),
        amountCents: z.number().int().nonnegative(),
        dueDate:     z.string().nullable().optional(),
        ...capexPaymentBody,
      }).parse(req.body)
      const ownedLine = await prisma.capexLine.findFirst({
        where: {
          id: req.params.lineId,
          project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!ownedLine) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      const { treatment, payFrom, ...data } = body
      const result = await prisma.$transaction(async (tx) => {
        const p = await tx.capexPayment.create({
          data: {
            ...data,
            lineId: req.params.lineId,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            paidAt:  data.paidAt  ? new Date(data.paidAt)  : null,
          },
        })
        const ledger = await syncCapexPaymentPosting(p.id, { tx, postedBy: req.staffUser!.id, treatment, payFrom })
        return { ...p, ledger }
      })
      // Bump line.paidCents from sum of paid payments
      await recalcLinePaid(req.params.lineId)
      return reply.status(201).send(result)
    },
  )

  fastify.patch<{ Params: { paymentId: string } }>('/capex/payments/:paymentId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const body = z.object(capexPaymentBody).parse(req.body)
      const ownedPayment = await prisma.capexPayment.findFirst({
        where: {
          id: req.params.paymentId,
          line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
      })
      if (!ownedPayment) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      const { treatment, payFrom, ...data } = body
      const updated = await prisma.$transaction(async (tx) => {
        const updated = await tx.capexPayment.update({
          where: { id: ownedPayment.id },
          data: {
            ...data,
            paidAt: data.paidAt !== undefined ? (data.paidAt ? new Date(data.paidAt) : null) : undefined,
          },
        })
        const ledger = await syncCapexPaymentPosting(updated.id, { tx, postedBy: req.staffUser!.id, treatment, payFrom })
        return { ...updated, ledger }
      })
      await recalcLinePaid(updated.lineId)
      return updated
    },
  )

  fastify.delete<{ Params: { paymentId: string } }>('/capex/payments/:paymentId',
    { preHandler: requireAuth(...CAPITAL_WRITERS) },
    async (req, reply) => {
      const p = await prisma.capexPayment.findFirst({
        where: {
          id: req.params.paymentId,
          line: { project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
        include: { line: { select: { project: { select: { tenantId: true } } } } },
      })
      if (!p) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      const tenantId = p.line.project.tenantId
      await prisma.$transaction(async (tx) => {
        // A posted instalment is reversed before its row goes.
        if (tenantId) {
          await syncSourcePosting({ tenantId, sourceType: CAPEX_SOURCE, id: p.id, desired: null, postedBy: req.staffUser!.id, reason: 'Capex payment deleted', tx })
        }
        await tx.capexPayment.delete({ where: { id: p.id } })
      })
      await recalcLinePaid(p.lineId)
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
          if (body.dryRun) { rows.push({ paymentId: p.id, outcome: `would_post:${capexTreatmentOf(l)}` }); continue }
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

  // POST /finance/capex/lines/:lineId/capitalise — a delivered item goes on
  // the fixed-asset register: Dr 15x0 / Cr 1340 for what was advanced, Cr
  // 2010 for what is still owed. Depreciation then runs from the register.
  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/capitalise',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({
        category: z.enum(Object.keys(ASSET_CATEGORIES) as [AssetCategory, ...AssetCategory[]]),
        usefulLifeMonths: z.number().int().min(1).max(600),
        salvageCents: z.number().int().min(0).default(0),
        name: z.string().min(1).max(120).optional(),
        acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
        costCents: z.number().int().positive().optional(),
      }).parse(req.body)
      const line = await prisma.capexLine.findFirst({
        where: { id: req.params.lineId, project: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        select: { id: true, project: { select: { tenantId: true } } },
      })
      if (!line) throw new NotFoundError('CapexLine', req.params.lineId)
      const result = await capitaliseCapexLine({
        lineId: line.id,
        category: body.category,
        usefulLifeMonths: body.usefulLifeMonths,
        salvageCents: body.salvageCents,
        name: body.name,
        acquiredAt: body.acquiredAt ? new Date(body.acquiredAt) : undefined,
        costCents: body.costCents,
        postedBy: req.staffUser!.id,
      })
      await audit({
        category: 'accounting', action: 'fixed_asset.capitalise_capex', entity: 'FixedAsset', entityId: result.asset.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: line.project.tenantId,
        after: result.asset, metadata: { capexLineId: line.id, advancedCents: result.advancedCents, owedCents: result.owedCents },
      })
      return reply.status(201).send(result)
    },
  )

  // There are no /finance/projections routes. The ProForma scenarios were a
  // second projections module (it counted frozen seats and read no ramp);
  // /projections is the one module, and its labour line follows the one
  // budgeted-labour rule (projections/labour.ts). The pro_formas* tables are
  // kept as history.
}
