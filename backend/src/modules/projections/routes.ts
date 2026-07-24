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

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'

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

export async function projectionsRoutes(fastify: FastifyInstance) {
  // ── List all scenarios ────────────────────────────────────────────────
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scenarios = await prisma.projection.findMany({
      include: {
        brands: {
          include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true, tenantId: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    // Trim each scenario's brand list to the caller's tenant scope so the
    // payload doesn't expose other companies' concept names/colors.
    const scope = await resolveTenantScope(req)
    return scenarios.map((s) => ({
      ...s,
      brands: s.brands.filter((b) => b.concept.tenantId != null && scope.tenantIds.includes(b.concept.tenantId)),
    }))
  })

  // ── Get one scenario with full computed 12-month matrix ───────────────
  fastify.get<{ Params: { id: string } }>(
    '/:id/computed',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const projection = await prisma.projection.findUnique({
        where: { id: req.params.id },
        include: {
          brands: {
            include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true, tenantId: true, deletedAt: true } } },
          },
        },
      })
      if (!projection) return reply.status(404).send({ error: { code: 'NOT_FOUND' } })

      // Scope the view to the active company (or the full portfolio in
      // "All companies" mode) — same mechanism as /concepts, so the brands
      // shown here always match the brands shown everywhere else. The
      // scenario itself stores every brand ever added; we just filter the
      // response. "Combined" then sums only the visible brands.
      const scope = await resolveTenantScope(req)
      const visibleBrandInputs = projection.brands.filter((b) =>
        !b.concept.deletedAt
        && b.concept.tenantId != null
        && scope.tenantIds.includes(b.concept.tenantId),
      )

      const conceptIds = visibleBrandInputs.map((b) => b.conceptId)

      // Aggregate staff cost per concept (active positions only)
      const positions = await prisma.position.findMany({
        where: {
          conceptId: { in: conceptIds },
          status: { in: ['open', 'filled'] },
        },
        select: { conceptId: true, tenantCostShareCents: true, headcount: true },
      })
      const staffByBrand = new Map<string, number>()
      for (const p of positions) {
        if (!p.conceptId) continue
        const total = p.tenantCostShareCents * p.headcount
        staffByBrand.set(p.conceptId, (staffByBrand.get(p.conceptId) ?? 0) + total)
      }

      // Aggregate monthly-equivalent opex per concept
      const opexLines = await prisma.opexLine.findMany({
        where: { conceptId: { in: conceptIds }, isActive: true },
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
        where: { conceptId: { in: conceptIds } },
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

      // Combined sum across brands
      const combined: Array<{
        month: number; revenueCents: number; variableCents: number
        staffCents: number; opexCents: number; totalCostCents: number
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
        const totalCostCents = variableCents + staffCents + opexCents
        combinedCum += profitAfterTaxCents
        combined.push({ month: i + 1, revenueCents, variableCents, staffCents, opexCents, totalCostCents, profitCents, profitAfterTaxCents, cumulativeCents: combinedCum })
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
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:   z.string().min(1).max(120).default('Default scenario'),
      brands: z.array(brandInputSchema).default([]),
    }).parse(req.body)

    return prisma.projection.create({
      data: {
        name: body.name,
        brands: { create: body.brands },
      },
      include: { brands: true },
    })
  })

  // ── Update scenario meta (name, ramp curve) ───────────────────────────
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:      z.string().min(1).max(120).optional(),
      rampCurve: z.array(z.number().min(0).max(5)).length(12).optional(),
    }).parse(req.body)
    return prisma.projection.update({ where: { id: req.params.id }, data: body })
  })

  // ── Upsert one brand's inputs ─────────────────────────────────────────
  fastify.put<{ Params: { id: string; conceptId: string } }>(
    '/:id/brands/:conceptId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = brandInputUpdateSchema.parse(req.body)
      return prisma.projectionBrandInput.upsert({
        where: { projectionId_conceptId: { projectionId: req.params.id, conceptId: req.params.conceptId } },
        create: { projectionId: req.params.id, conceptId: req.params.conceptId, ...body },
        update: body,
      })
    },
  )

  // ── Remove one brand from the scenario ────────────────────────────────
  fastify.delete<{ Params: { id: string; conceptId: string } }>(
    '/:id/brands/:conceptId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await prisma.projectionBrandInput.delete({
        where: { projectionId_conceptId: { projectionId: req.params.id, conceptId: req.params.conceptId } },
      })
      return { ok: true }
    },
  )

  // ── Delete a scenario ─────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    await prisma.projection.delete({ where: { id: req.params.id } })
    return { ok: true }
  })
}
