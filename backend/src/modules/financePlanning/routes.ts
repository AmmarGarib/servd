// Finance planning module: capital ledger, capex projects, pro-forma scenarios.
// All three are CRUD-heavy with light computed totals; UI does the heavy
// lifting on rendering monthly P&L curves.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { flagException } from '../../lib/exceptions.js'

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
    where: { kind: 'high_value_void', status: 'open', entityType: 'CapexProject', entityId: projectId },
    select: { id: true },
  })
  if (existing) return
  await flagException({
    kind: 'high_value_void',
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

  fastify.get<{ Querystring: { conceptId?: string; projectId?: string; days?: string } }>(
    '/capital-ledger',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, projectId } = req.query
      const days = req.query.days ? parseInt(req.query.days, 10) : 365 * 5
      const since = new Date(Date.now() - days * 86_400_000)
      const entries = await prisma.capitalLedgerEntry.findMany({
        where: {
          deletedAt: null, tenantId: req.staffUser!.tenantFilter,
          date: { gte: since },
          ...(conceptId && { conceptId }),
          ...(projectId && { projectId }),
        },
        orderBy: { date: 'desc' },
      })
      const totalCents = entries.reduce((s, e) => s + e.amountCents, 0)
      return { entries, totalCents, count: entries.length }
    },
  )

  fastify.post(
    '/capital-ledger',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        date:        z.string(),
        amountCents: z.number().int().positive(),
        description: z.string().min(1).max(200),
        paidTo:      z.string().max(200).optional(),
        invoiceUrl:  z.string().url().optional(),
        category:    z.string().max(40).optional(),
        conceptId:   z.string().uuid().optional(),
        projectId:   z.string().optional(),
      }).parse(req.body)
      // If a concept is referenced, verify it belongs to active tenant.
      if (body.conceptId) {
        const concept = await prisma.concept.findFirst({
          where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        })
        if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
      }
      const entry = await prisma.capitalLedgerEntry.create({
        data: { ...body, date: new Date(body.date), tenantId: req.staffUser!.tenantId!, createdById: req.staffUser!.id },
      })
      return reply.status(201).send(entry)
    },
  )

  fastify.patch<{ Params: { id: string } }>(
    '/capital-ledger/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        date:        z.string().optional(),
        amountCents: z.number().int().positive().optional(),
        description: z.string().min(1).max(200).optional(),
        paidTo:      z.string().max(200).nullable().optional(),
        category:    z.string().max(40).nullable().optional(),
        invoiceUrl:  z.string().url().nullable().optional(),
      }).parse(req.body)
      const owned = await prisma.capitalLedgerEntry.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Entry not found in your active company' } })
      return prisma.capitalLedgerEntry.update({
        where: { id: req.params.id },
        data: { ...body, ...(body.date && { date: new Date(body.date) }) },
      })
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/capital-ledger/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.capitalLedgerEntry.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Entry not found in your active company' } })
      await prisma.capitalLedgerEntry.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
      return reply.status(204).send()
    },
  )

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CapEx projects
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  fastify.get('/capex', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const projects = await prisma.capexProject.findMany({
      where: { deletedAt: null, tenantId: req.staffUser!.tenantFilter },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { quotes: true, payments: true } }, _count: { select: { lines: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return projects.map((p) => withRollups(p))
  })

  fastify.get<{ Params: { id: string } }>(
    '/capex/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const p = await prisma.capexProject.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter },
        include: {
          lines: {
            orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }],
            include: { quotes: true, payments: { orderBy: { dueDate: 'asc' } } },
          },
        },
      })
      if (!p) throw new NotFoundError('CapexProject', req.params.id)
      return withRollups(p)
    },
  )

  fastify.post('/capex', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
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
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    const project = await prisma.capexProject.create({
      data: {
        ...body, tenantId: req.staffUser!.tenantId!,
        targetOpeningDate: body.targetOpeningDate ? new Date(body.targetOpeningDate) : null,
        jvPartners: body.jvPartners ?? undefined,
      },
    })
    return reply.status(201).send(project)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/capex/:id',
    { preHandler: requireAuth(...MANAGERS) },
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
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.capexProject.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = lineSchema.parse(req.body)
      const project = await prisma.capexProject.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!project) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx project not found in your active company' } })
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = lineSchema.partial().parse(req.body)
      const owned = await prisma.capexLine.findFirst({
        where: {
          id: req.params.lineId,
          project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.capexLine.findFirst({
        where: {
          id: req.params.lineId,
          project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      await prisma.capexLine.delete({ where: { id: req.params.lineId } })
      return reply.status(204).send()
    },
  )

  // â”€â”€â”€ Quotes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/quotes',
    { preHandler: requireAuth(...MANAGERS) },
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
          project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const q = await prisma.capexQuote.findFirst({
        where: {
          id: req.params.quoteId,
          line: { project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.capexQuote.findFirst({
        where: {
          id: req.params.quoteId,
          line: { project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Quote not found in your active company' } })
      await prisma.capexQuote.delete({ where: { id: req.params.quoteId } })
      return reply.status(204).send()
    },
  )

  // â”€â”€â”€ Payments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post<{ Params: { lineId: string } }>('/capex/lines/:lineId/payments',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        label:       z.enum(['deposit', 'midpoint', 'balance', 'extra']).default('deposit'),
        amountCents: z.number().int().nonnegative(),
        dueDate:     z.string().nullable().optional(),
        paidAt:      z.string().nullable().optional(),
        paidAmountCents: z.number().int().nonnegative().nullable().optional(),
        paymentRef:  z.string().max(120).nullable().optional(),
        notes:       z.string().nullable().optional(),
      }).parse(req.body)
      const ownedLine = await prisma.capexLine.findFirst({
        where: {
          id: req.params.lineId,
          project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!ownedLine) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'CapEx line not found in your active company' } })
      const p = await prisma.capexPayment.create({
        data: {
          ...body,
          lineId: req.params.lineId,
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          paidAt:  body.paidAt  ? new Date(body.paidAt)  : null,
        },
      })
      // Bump line.paidCents from sum of paid payments
      await recalcLinePaid(req.params.lineId)
      return reply.status(201).send(p)
    },
  )

  fastify.patch<{ Params: { paymentId: string } }>('/capex/payments/:paymentId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        paidAt:      z.string().nullable().optional(),
        paidAmountCents: z.number().int().nonnegative().nullable().optional(),
        paymentRef:  z.string().max(120).nullable().optional(),
        notes:       z.string().nullable().optional(),
      }).parse(req.body)
      const ownedPayment = await prisma.capexPayment.findFirst({
        where: {
          id: req.params.paymentId,
          line: { project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
        },
      })
      if (!ownedPayment) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      const updated = await prisma.capexPayment.update({
        where: { id: req.params.paymentId },
        data: {
          ...body,
          paidAt: body.paidAt !== undefined ? (body.paidAt ? new Date(body.paidAt) : null) : undefined,
        },
      })
      await recalcLinePaid(updated.lineId)
      return updated
    },
  )

  fastify.delete<{ Params: { paymentId: string } }>('/capex/payments/:paymentId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const p = await prisma.capexPayment.findFirst({
        where: {
          id: req.params.paymentId,
          line: { project: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
        },
      })
      if (!p) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
      await prisma.capexPayment.delete({ where: { id: req.params.paymentId } })
      await recalcLinePaid(p.lineId)
      return reply.status(204).send()
    },
  )

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Pro-forma projections
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  fastify.get('/projections', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.proForma.findMany({
      where: { deletedAt: null, tenantId: req.staffUser!.tenantFilter },
      orderBy: { updatedAt: 'desc' },
    })
  })

  fastify.get<{ Params: { id: string } }>(
    '/projections/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const p = await prisma.proForma.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter },
        include: {
          channels:   { orderBy: { sortOrder: 'asc' } },
          fixedCosts: { orderBy: { sortOrder: 'asc' } },
          months:     { orderBy: { monthIndex: 'asc' } },
        },
      })
      if (!p) throw new NotFoundError('ProForma', req.params.id)

      // Compute steady-state monthly revenue from channels
      const ssMonthly = p.channels.reduce((s, c) => {
        const weeklyOrders =
          (c.ordersMon + c.ordersTue + c.ordersWed + c.ordersThu + c.ordersFri + c.ordersSat + c.ordersSun)
        const monthlyOrders = (weeklyOrders / 7) * p.tradingDaysPerMonth
        return s + Math.round(monthlyOrders * c.checkAvgCents)
      }, 0)

      // Live labour line from workforce/positions. Pulls tenantCostShareCents
      // for any active position attached to this concept (if the ProForma is
      // concept-scoped) or all tenant-wide positions otherwise. Surfaced as
      // a synthetic fixed-cost row in the response so the UI can render it
      // distinctly ("Auto · from workforce") and operators see budget edits
      // here update projections on next load.
      // Narrow tenantFilter (Position.tenantId is non-nullable).
      const laborTenantFilter = req.staffUser!.tenantFilter ?? { in: [] as string[] }
      const laborPositions = await prisma.position.findMany({
        where: {
          tenantId: laborTenantFilter,
          status: { in: ['open', 'filled', 'frozen'] },
          ...(p.conceptId ? { conceptId: p.conceptId } : {}),
        },
        select: { tenantCostShareCents: true, headcount: true },
      })
      const autoLaborGross = laborPositions.reduce(
        (s, q) => s + q.tenantCostShareCents * q.headcount, 0,
      )

      // Apply inter-tenant contributions to tenant-wide ProForma scenarios.
      // Concept-scoped scenarios get only their concept's labour, so
      // contributions (which are tenant-level) don't apply there. For
      // tenant-wide projections (no conceptId), incoming contributions
      // reduce labour cost; outgoing add to it.
      let contributionAdjustment = 0
      if (!p.conceptId) {
        const tenantsArr = typeof laborTenantFilter === 'string'
          ? [laborTenantFilter]
          : laborTenantFilter.in
        const contributions = await prisma.tenantContribution.findMany({
          where: {
            isActive: true,
            OR: [
              { destinationTenantId: { in: tenantsArr } },
              { sourceTenantId:      { in: tenantsArr } },
            ],
          },
        })
        for (const c of contributions) {
          if (tenantsArr.includes(c.destinationTenantId)) contributionAdjustment -= c.monthlyCents
          if (tenantsArr.includes(c.sourceTenantId))      contributionAdjustment += c.monthlyCents
        }
      }
      const autoLaborMonthly = autoLaborGross + contributionAdjustment

      // Per-month rendered P&L. totalFixed = manual fixed-cost lines (or
      // legacy aggregate) PLUS the auto labor line, so labor flows in
      // without operators having to mirror salaries twice.
      const totalManualFixed = p.fixedCosts.length > 0
        ? p.fixedCosts.reduce((s, f) => s + f.monthlyCents, 0)
        : p.monthlyFixedCostsCents
      const totalFixed = totalManualFixed + autoLaborMonthly

      const monthsRendered = p.months.map((m) => {
        const revenue   = Math.round(ssMonthly * m.rampPct)
        const variable  = Math.round(revenue * p.variableCostPct)
        const opex      = totalFixed + variable
        const profit    = revenue - opex
        return {
          monthIndex: m.monthIndex,
          rampPct:    m.rampPct,
          revenueCents: revenue,
          variableCents: variable,
          fixedCents: totalFixed,
          opexCents: opex,
          profitCents: profit,
        }
      })

      // Cumulative cash flow starting from -workingCapital
      let cumulative = -p.workingCapitalCents
      const monthsWithCum = monthsRendered.map((m) => {
        cumulative += m.profitCents
        return { ...m, cumulativeCashCents: cumulative }
      })

      // Payback: first month index where cumulative >= 0
      const paybackMonth = monthsWithCum.find((m) => m.cumulativeCashCents >= 0)?.monthIndex ?? null

      return {
        ...p,
        steadyStateMonthlyCents: ssMonthly,
        totalFixedMonthlyCents:  totalFixed,
        // Surface the auto labor split so the UI can render it as its own
        // (non-editable, synthetic) fixed-cost row pointing back at workforce.
        autoLaborMonthlyCents:   autoLaborMonthly,
        autoLaborGrossCents:     autoLaborGross,
        contributionAdjustmentCents: contributionAdjustment,
        manualFixedMonthlyCents: totalManualFixed,
        autoLaborPositionCount:  laborPositions.reduce((s, q) => s + q.headcount, 0),
        months: monthsWithCum,
        paybackMonth,
      }
    },
  )

  fastify.post('/projections', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:      z.string().min(1).max(120),
      conceptId: z.string().uuid().optional(),
      scenario:  z.enum(['base', 'aggressive', 'conservative']).default('base'),
      totalAskCents:           z.number().int().nonnegative().default(0),
      capexCents:              z.number().int().nonnegative().default(0),
      workingCapitalCents:     z.number().int().nonnegative().default(0),
      brokerFeeCents:          z.number().int().nonnegative().default(0),
      rentAdvanceSecurityCents:z.number().int().nonnegative().default(0),
      monthlyFixedCostsCents:  z.number().int().nonnegative().default(0),
      variableCostPct:         z.number().min(0).max(1).default(0.40),
      tradingDaysPerMonth:     z.number().int().min(1).max(31).default(26),
      notes:     z.string().optional(),
    }).parse(req.body)
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    const created = await prisma.proForma.create({
      data: {
        ...body, tenantId: req.staffUser!.tenantId!,
        createdById: req.staffUser!.id,
        // Default 12 months at 100% steady state â€” operator tunes after creation
        months: { create: Array.from({ length: 12 }, (_, i) => ({ monthIndex: i + 1, rampPct: 1.0 })) },
      },
      include: { months: true },
    })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/projections/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        name:                    z.string().min(1).max(120).optional(),
        scenario:                z.enum(['base', 'aggressive', 'conservative']).optional(),
        totalAskCents:           z.number().int().nonnegative().optional(),
        capexCents:              z.number().int().nonnegative().optional(),
        workingCapitalCents:     z.number().int().nonnegative().optional(),
        brokerFeeCents:          z.number().int().nonnegative().optional(),
        rentAdvanceSecurityCents:z.number().int().nonnegative().optional(),
        monthlyFixedCostsCents:  z.number().int().nonnegative().optional(),
        variableCostPct:         z.number().min(0).max(1).optional(),
        tradingDaysPerMonth:     z.number().int().min(1).max(31).optional(),
        notes:                   z.string().nullable().optional(),
      }).parse(req.body)
      const owned = await prisma.proForma.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Projection not found in your active company' } })
      return prisma.proForma.update({ where: { id: req.params.id }, data: body })
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/projections/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const owned = await prisma.proForma.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Projection not found in your active company' } })
      await prisma.proForma.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
      return reply.status(204).send()
    },
  )

  // Channels
  fastify.post<{ Params: { id: string } }>(
    '/projections/:id/channels',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        name:           z.string().min(1).max(40),
        checkAvgCents:  z.number().int().nonnegative(),
        ordersMon:      z.number().int().nonnegative().default(0),
        ordersTue:      z.number().int().nonnegative().default(0),
        ordersWed:      z.number().int().nonnegative().default(0),
        ordersThu:      z.number().int().nonnegative().default(0),
        ordersFri:      z.number().int().nonnegative().default(0),
        ordersSat:      z.number().int().nonnegative().default(0),
        ordersSun:      z.number().int().nonnegative().default(0),
      }).parse(req.body)
      const owned = await prisma.proForma.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Projection not found in your active company' } })
      const created = await prisma.proFormaChannel.create({ data: { ...body, proFormaId: req.params.id } })
      return reply.status(201).send(created)
    },
  )

  fastify.patch<{ Params: { channelId: string } }>(
    '/projections/channels/:channelId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        name:           z.string().min(1).max(40).optional(),
        checkAvgCents:  z.number().int().nonnegative().optional(),
        ordersMon:      z.number().int().nonnegative().optional(),
        ordersTue:      z.number().int().nonnegative().optional(),
        ordersWed:      z.number().int().nonnegative().optional(),
        ordersThu:      z.number().int().nonnegative().optional(),
        ordersFri:      z.number().int().nonnegative().optional(),
        ordersSat:      z.number().int().nonnegative().optional(),
        ordersSun:      z.number().int().nonnegative().optional(),
      }).parse(req.body)
      const owned = await prisma.proFormaChannel.findFirst({
        where: {
          id: req.params.channelId,
          proForma: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Channel not found in your active company' } })
      return prisma.proFormaChannel.update({ where: { id: req.params.channelId }, data: body })
    },
  )

  fastify.delete<{ Params: { channelId: string } }>(
    '/projections/channels/:channelId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.proFormaChannel.findFirst({
        where: {
          id: req.params.channelId,
          proForma: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Channel not found in your active company' } })
      await prisma.proFormaChannel.delete({ where: { id: req.params.channelId } })
      return reply.status(204).send()
    },
  )

  // Fixed costs
  fastify.post<{ Params: { id: string } }>(
    '/projections/:id/fixed-costs',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        category:     z.string().min(1).max(60),
        monthlyCents: z.number().int().nonnegative(),
        notes:        z.string().optional(),
      }).parse(req.body)
      const owned = await prisma.proForma.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Projection not found in your active company' } })
      const created = await prisma.proFormaFixedCost.create({ data: { ...body, proFormaId: req.params.id } })
      return reply.status(201).send(created)
    },
  )

  fastify.patch<{ Params: { costId: string } }>(
    '/projections/fixed-costs/:costId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        category:     z.string().min(1).max(60).optional(),
        monthlyCents: z.number().int().nonnegative().optional(),
        notes:        z.string().nullable().optional(),
      }).parse(req.body)
      const owned = await prisma.proFormaFixedCost.findFirst({
        where: {
          id: req.params.costId,
          proForma: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Cost not found in your active company' } })
      return prisma.proFormaFixedCost.update({ where: { id: req.params.costId }, data: body })
    },
  )

  fastify.delete<{ Params: { costId: string } }>(
    '/projections/fixed-costs/:costId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.proFormaFixedCost.findFirst({
        where: {
          id: req.params.costId,
          proForma: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Cost not found in your active company' } })
      await prisma.proFormaFixedCost.delete({ where: { id: req.params.costId } })
      return reply.status(204).send()
    },
  )

  // Month ramp tweak
  fastify.patch<{ Params: { id: string; monthIndex: string } }>(
    '/projections/:id/months/:monthIndex',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({ rampPct: z.number().min(0).max(2) }).parse(req.body)
      const monthIndex = parseInt(req.params.monthIndex, 10)
      const owned = await prisma.proForma.findFirst({
        where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Projection not found in your active company' } })
      return prisma.proFormaMonth.update({
        where: { proFormaId_monthIndex: { proFormaId: req.params.id, monthIndex } },
        data: body,
      })
    },
  )
}
