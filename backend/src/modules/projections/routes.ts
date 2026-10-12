// Per-brand 12-month P&L projections.
//
// Inputs (launch month, check avg, days, food%, pkg%, daily covers, ramp curve)
// live in the Projection / ProjectionBrandInput tables. Staff cost, opex, and
// capex come from their live tables at read time so projections always reflect
// the current state of the org.
//
// Allocation: each Position has a tenantCostShareCents + headcount + conceptId;
// each OpexLine has conceptId. Sum by conceptId → that brand's monthly cost.
// Head-office / commissary / shared-kitchen costs are modelled via the
// tenantCostShareCents field on each Position, not via brand-share rules
// hardcoded in projections.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM } from '../auth/middleware.js'

// Projections live in the Finance workspace (lib/workspaces.ts), so finance
// works them as well as the manager tiers. Who actually gets in is narrowed by
// the 'projections' module (lib/moduleAccess.ts gates /projections): by
// default the CEO, owners, management and finance — not the FOH/BOH managers.
const PROJECTION_TEAM = FINANCE_TEAM
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { requireActiveCompany, assertConceptAttachable, assertConceptOfCompany } from '../financePlanning/companyRefs.js'
import { monthlyLabourCents } from './labour.js'

const brandInputSchema = z.object({
  conceptId:           z.string(),
  launchMonth:         z.number().int().min(1).max(12).default(1),
  checkAverageCents:   z.number().int().min(0).default(0),
  tradingDaysPerMonth: z.number().int().min(1).max(31).default(26),
  foodCostPct:         z.number().min(0).max(100).default(32),
  packagingCostPct:    z.number().min(0).max(100).default(8),
  dailyCoversAtSS:     z.number().int().min(0).default(0),
  seats:               z.number().int().min(0).default(0),
  tableTurnHours:      z.number().min(0).max(24).default(1.5),
  seatUtilizationPct:  z.number().min(0).max(100).default(70),
  breakfastHours:      z.number().min(0).max(24).default(4),
  lunchHours:          z.number().min(0).max(24).default(4),
  dinnerHours:         z.number().min(0).max(24).default(10),
  taxRatePct:          z.number().min(0).max(100).default(0),
})

const brandInputUpdateSchema = z.object({
  launchMonth:         z.number().int().min(1).max(12).optional(),
  checkAverageCents:   z.number().int().min(0).optional(),
  tradingDaysPerMonth: z.number().int().min(1).max(31).optional(),
  foodCostPct:         z.number().min(0).max(100).optional(),
  packagingCostPct:    z.number().min(0).max(100).optional(),
  dailyCoversAtSS:     z.number().int().min(0).optional(),
  seats:               z.number().int().min(0).optional(),
  tableTurnHours:      z.number().min(0).max(24).optional(),
  seatUtilizationPct:  z.number().min(0).max(100).optional(),
  breakfastHours:      z.number().min(0).max(24).optional(),
  lunchHours:          z.number().min(0).max(24).optional(),
  dinnerHours:         z.number().min(0).max(24).optional(),
  taxRatePct:          z.number().min(0).max(100).optional(),
})

// Daily covers from the timing & capacity block:
//   covers = seats × utilization% × (total operating hours ÷ table turn hours)
// Returns null when the block isn't filled in (seats or turn time missing) —
// callers then fall back to the manually entered dailyCoversAtSS.
function calcDailyCovers(b: { seats: number; tableTurnHours: number; seatUtilizationPct: number; breakfastHours: number; lunchHours: number; dinnerHours: number }): number | null {
  const totalHours = b.breakfastHours + b.lunchHours + b.dinnerHours
  if (b.seats <= 0 || b.tableTurnHours <= 0 || totalHours <= 0) return null
  return Math.round(b.seats * (b.seatUtilizationPct / 100) * (totalHours / b.tableTurnHours))
}

// One company per scenario (owner decision 25). Projection.tenantId is
// stamped with the ACTIVE company at create; every later read or write by id
// resolves the scenario inside the operator's companies first (foreign = 404),
// and brands, staff, opex and capex are all read from the scenario's own
// company only.
async function findProjectionInScope(req: FastifyRequest, id: string, mode: 'read' | 'write') {
  const projection = await prisma.projection.findFirst({
    where: { id, ...(await scopeTenantWhere(req, mode)) },
    select: { id: true, tenantId: true },
  })
  if (!projection) throw new NotFoundError('Projection', id)
  return projection
}

export async function projectionsRoutes(fastify: FastifyInstance) {
  // ── List all scenarios ────────────────────────────────────────────────
  fastify.get('/', { preHandler: requireAuth(...PROJECTION_TEAM) }, async (req) => {
    const scenarios = await prisma.projection.findMany({
      where: await scopeTenantWhere(req, 'read'),
      include: {
        brands: {
          include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true, tenantId: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    // A scenario only ever shows its own company's brands.
    return scenarios.map((s) => ({
      ...s,
      brands: s.brands.filter((b) => b.concept.tenantId != null && b.concept.tenantId === s.tenantId),
    }))
  })

  // ── Get one scenario with full computed 12-month matrix ───────────────
  fastify.get<{ Params: { id: string } }>(
    '/:id/computed',
    { preHandler: requireAuth(...PROJECTION_TEAM) },
    async (req, reply) => {
      const projection = await prisma.projection.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
        include: {
          brands: {
            include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true, tenantId: true, deletedAt: true } } },
          },
        },
      })
      if (!projection) throw new NotFoundError('Projection', req.params.id)
      if (!projection.tenantId) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Projection not found' } })
      const tenantId = projection.tenantId

      // One company per scenario: only the scenario's own company's live
      // brands, and every actual below is read from that company alone.
      // "Combined" then sums only those brands.
      const visibleBrandInputs = projection.brands.filter((b) =>
        !b.concept.deletedAt && b.concept.tenantId === tenantId,
      )

      const conceptIds = visibleBrandInputs.map((b) => b.conceptId)

      // Labour: THE budgeted-labour rule (projections/labour.ts, owner
      // decision 25) — open and filled seats only (frozen seats are out), at
      // this company's cost share, with JV / head-office contributions netted
      // on the company line below. The same figure the OpEx payroll budget
      // shows.
      const labour = await monthlyLabourCents(tenantId)
      const staffByBrand = labour.byConcept
      // Company-level labour that no brand carries: head-office seats, plus
      // what this company pays towards another's shared staff, minus what it
      // receives (the JV contribution). Charged every month of the scenario.
      const headOfficeLabourMonthlyCents = labour.headOfficeCents + labour.outgoingContributionCents - labour.incomingContributionCents

      // Aggregate monthly-equivalent opex per concept
      const opexLines = await prisma.opexLine.findMany({
        where: { conceptId: { in: conceptIds }, isActive: true, category: { tenantId, deletedAt: null } },
        select: { conceptId: true, amountCents: true, cadence: true },
      })
      const opexByBrand = new Map<string, number>()
      for (const l of opexLines) {
        if (!l.conceptId) continue
        const monthly =
          l.cadence === 'monthly'   ? l.amountCents :
          l.cadence === 'quarterly' ? Math.round(l.amountCents / 3) :
          l.cadence === 'annual'    ? Math.round(l.amountCents / 12) :
          l.amountCents
        opexByBrand.set(l.conceptId, (opexByBrand.get(l.conceptId) ?? 0) + monthly)
      }

      // Capex total per concept (working-capital buffer reference)
      const capexProjects = await prisma.capexProject.findMany({
        where: { tenantId, conceptId: { in: conceptIds }, deletedAt: null },
        select: { conceptId: true, totalAskCents: true },
      })
      const capexByBrand = new Map<string, number>()
      for (const c of capexProjects) {
        if (!c.conceptId) continue
        capexByBrand.set(c.conceptId, (capexByBrand.get(c.conceptId) ?? 0) + c.totalAskCents)
      }

      const rampCurve = projection.rampCurve
      const rampLen = rampCurve.length

      // Per-brand 12-month rows
      const brands = visibleBrandInputs.map((b) => {
        const staffMonthlyCents = staffByBrand.get(b.conceptId) ?? 0
        const opexMonthlyCents  = opexByBrand.get(b.conceptId)  ?? 0
        const capexTotalCents   = capexByBrand.get(b.conceptId) ?? 0
        // Daily covers: calculated from the timing block when it's filled in,
        // otherwise the manually entered steady-state figure.
        const dailyCoversCalculated = calcDailyCovers(b)
        const effectiveDailyCovers  = dailyCoversCalculated ?? b.dailyCoversAtSS

        const months: Array<{
          month: number; live: boolean; rampFactor: number; orders: number
          revenueCents: number; variableCents: number; staffCents: number
          opexCents: number; totalCostCents: number; profitCents: number
          profitAfterTaxCents: number; cumulativeCents: number
        }> = []
        let cumulative = 0
        for (let i = 0; i < 12; i++) {
          const monthNumber = i + 1
          const live = monthNumber >= b.launchMonth
          const rampIdx = live ? Math.min(monthNumber - b.launchMonth, rampLen - 1) : -1
          const rampFactor = live ? (rampCurve[rampIdx] ?? 0) : 0
          const orders = Math.round(b.tradingDaysPerMonth * effectiveDailyCovers * rampFactor)
          const revenueCents  = orders * b.checkAverageCents
          const variableCents = Math.round(revenueCents * (b.foodCostPct + b.packagingCostPct) / 100)
          const staffCents    = live ? staffMonthlyCents : 0
          const opexCents     = live ? opexMonthlyCents  : 0
          const totalCostCents = variableCents + staffCents + opexCents
          const profitCents = revenueCents - totalCostCents
          // Tax applies to profitable months only; losses pass through untaxed.
          const profitAfterTaxCents = profitCents > 0
            ? Math.round(profitCents * (1 - b.taxRatePct / 100))
            : profitCents
          // Cumulative cashflow runs on AFTER-tax profit (the sheet's bottom line).
          cumulative += profitAfterTaxCents
          months.push({
            month: monthNumber, live, rampFactor, orders,
            revenueCents, variableCents, staffCents, opexCents,
            totalCostCents, profitCents, profitAfterTaxCents, cumulativeCents: cumulative,
          })
        }
        const steadyState = months[11]!
        return {
          inputId: b.id,
          conceptId: b.conceptId,
          concept: b.concept,
          launchMonth: b.launchMonth,
          checkAverageCents: b.checkAverageCents,
          tradingDaysPerMonth: b.tradingDaysPerMonth,
          foodCostPct: b.foodCostPct,
          packagingCostPct: b.packagingCostPct,
          dailyCoversAtSS: b.dailyCoversAtSS,
          seats: b.seats,
          tableTurnHours: b.tableTurnHours,
          seatUtilizationPct: b.seatUtilizationPct,
          breakfastHours: b.breakfastHours,
          lunchHours: b.lunchHours,
          dinnerHours: b.dinnerHours,
          taxRatePct: b.taxRatePct,
          totalOperatingHours: b.breakfastHours + b.lunchHours + b.dinnerHours,
          dailyCoversCalculated,
          effectiveDailyCovers,
          staffMonthlyCents,
          opexMonthlyCents,
          capexTotalCents,
          months,
          year1RevenueCents: months.reduce((s, m) => s + m.revenueCents, 0),
          year1ProfitCents:  months.reduce((s, m) => s + m.profitCents,  0),
          year1ProfitAfterTaxCents: months.reduce((s, m) => s + m.profitAfterTaxCents, 0),
          steadyStateMonthlyProfitCents: steadyState.profitCents,
          steadyStateMonthlyCostCents:   steadyState.totalCostCents,
        }
      })

      // Combined sum across brands, plus the company-level labour line (head
      // office net of the JV contribution) — a scenario is one company's.
      const combined: Array<{
        month: number; revenueCents: number; variableCents: number
        staffCents: number; headOfficeLabourCents: number; opexCents: number; totalCostCents: number
        profitCents: number; profitAfterTaxCents: number; cumulativeCents: number
      }> = []
      let combinedCum = 0
      for (let i = 0; i < 12; i++) {
        let revenueCents = 0, variableCents = 0, staffCents = 0, opexCents = 0, profitCents = 0, profitAfterTaxCents = 0
        for (const b of brands) {
          const m = b.months[i]!
          revenueCents  += m.revenueCents
          variableCents += m.variableCents
          staffCents    += m.staffCents
          opexCents     += m.opexCents
          profitCents   += m.profitCents
          profitAfterTaxCents += m.profitAfterTaxCents
        }
        const headOfficeLabourCents = headOfficeLabourMonthlyCents
        profitCents -= headOfficeLabourCents
        profitAfterTaxCents -= headOfficeLabourCents
        const totalCostCents = variableCents + staffCents + headOfficeLabourCents + opexCents
        combinedCum += profitAfterTaxCents
        combined.push({ month: i + 1, revenueCents, variableCents, staffCents, headOfficeLabourCents, opexCents, totalCostCents, profitCents, profitAfterTaxCents, cumulativeCents: combinedCum })
      }

      // Capital ask summary (PDF: totalCapex + 3 × steady-state monthly cost)
      const totalCapexCents       = brands.reduce((s, b) => s + b.capexTotalCents, 0)
      const combinedSteady        = combined[11]!
      const workingCapitalCents   = combinedSteady.totalCostCents * 3
      const capitalAskCents       = totalCapexCents + workingCapitalCents
      const paybackMonths         = combinedSteady.profitCents > 0
        ? Math.round(capitalAskCents / combinedSteady.profitCents)
        : null

      return {
        projection: { id: projection.id, name: projection.name, rampCurve: projection.rampCurve, updatedAt: projection.updatedAt },
        brands,
        combined,
        labour: {
          rule: 'open + filled seats at the company cost share; frozen seats excluded; JV contribution netted',
          brandSeatsMonthlyCents: labour.seatsCents - labour.headOfficeCents,
          headOfficeSeatsMonthlyCents: labour.headOfficeCents,
          incomingContributionMonthlyCents: labour.incomingContributionCents,
          outgoingContributionMonthlyCents: labour.outgoingContributionCents,
          netMonthlyCents: labour.netCents,
        },
        summary: {
          totalCapexCents,
          workingCapitalCents,
          capitalAskCents,
          steadyStateMonthlyCostCents:   combinedSteady.totalCostCents,
          steadyStateMonthlyProfitCents: combinedSteady.profitCents,
          year1TotalRevenueCents:        combined.reduce((s, m) => s + m.revenueCents, 0),
          year1CombinedProfitCents:      combined.reduce((s, m) => s + m.profitCents,  0),
          paybackMonths,
        },
      }
    },
  )

  // ── Create a new scenario, optionally seeding all brand inputs ────────
  fastify.post('/', { preHandler: requireAuth(...PROJECTION_TEAM) }, async (req) => {
    const body = z.object({
      name:   z.string().min(1).max(120).default('Default scenario'),
      brands: z.array(brandInputSchema).default([]),
    }).parse(req.body)
    const tenantId = requireActiveCompany(req)
    const seen = new Set<string>()
    for (const b of body.brands) {
      if (seen.has(b.conceptId)) throw new AppError('DUPLICATE_BRAND', 'Each brand may appear once per scenario', 422)
      seen.add(b.conceptId)
      await assertConceptAttachable(req, b.conceptId)
    }

    return prisma.projection.create({
      data: {
        tenantId,
        name: body.name,
        brands: { create: body.brands },
      },
      include: { brands: true },
    })
  })

  // ── Update scenario meta (name, ramp curve) ───────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...PROJECTION_TEAM) }, async (req) => {
    const body = z.object({
      name:      z.string().min(1).max(120).optional(),
      rampCurve: z.array(z.number().min(0).max(5)).length(12).optional(),
    }).parse(req.body)
    const projection = await findProjectionInScope(req, req.params.id, 'write')
    return prisma.projection.update({ where: { id: projection.id }, data: body })
  })

  // ── Upsert one brand's inputs ─────────────────────────────────────────
  fastify.put<{ Params: { id: string; conceptId: string } }>(
    '/:id/brands/:conceptId',
    { preHandler: requireAuth(...PROJECTION_TEAM) },
    async (req) => {
      const body = brandInputUpdateSchema.parse(req.body)
      const projection = await findProjectionInScope(req, req.params.id, 'write')
      // The brand must be the SCENARIO's company's — never another company's,
      // even one the operator also belongs to.
      await assertConceptOfCompany(projection.tenantId, req.params.conceptId)
      return prisma.projectionBrandInput.upsert({
        where: { projectionId_conceptId: { projectionId: projection.id, conceptId: req.params.conceptId } },
        create: { projectionId: projection.id, conceptId: req.params.conceptId, ...body },
        update: body,
      })
    },
  )

  // ── Remove one brand from the scenario ────────────────────────────────
  fastify.delete<{ Params: { id: string; conceptId: string } }>(
    '/:id/brands/:conceptId',
    { preHandler: requireAuth(...PROJECTION_TEAM) },
    async (req) => {
      const projection = await findProjectionInScope(req, req.params.id, 'write')
      const { count } = await prisma.projectionBrandInput.deleteMany({
        where: { projectionId: projection.id, conceptId: req.params.conceptId },
      })
      if (count === 0) throw new NotFoundError('ProjectionBrandInput', req.params.conceptId)
      return { ok: true }
    },
  )

  // ── Delete a scenario ─────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...PROJECTION_TEAM) }, async (req) => {
    const projection = await findProjectionInScope(req, req.params.id, 'write')
    await prisma.projection.delete({ where: { id: projection.id } })
    return { ok: true }
  })
}
