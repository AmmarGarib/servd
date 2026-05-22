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

const brandInputSchema = z.object({
  conceptId:           z.string(),
  launchMonth:         z.number().int().min(1).max(12).default(1),
  checkAverageCents:   z.number().int().min(0).default(0),
  tradingDaysPerMonth: z.number().int().min(1).max(31).default(26),
  foodCostPct:         z.number().min(0).max(100).default(32),
  packagingCostPct:    z.number().min(0).max(100).default(8),
  dailyCoversAtSS:     z.number().int().min(0).default(0),
})

const brandInputUpdateSchema = z.object({
  launchMonth:         z.number().int().min(1).max(12).optional(),
  checkAverageCents:   z.number().int().min(0).optional(),
  tradingDaysPerMonth: z.number().int().min(1).max(31).optional(),
  foodCostPct:         z.number().min(0).max(100).optional(),
  packagingCostPct:    z.number().min(0).max(100).optional(),
  dailyCoversAtSS:     z.number().int().min(0).optional(),
})

export async function projectionsRoutes(fastify: FastifyInstance) {
  // ── List all scenarios ────────────────────────────────────────────────
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.projection.findMany({
      include: {
        brands: {
          include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
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
            include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } },
          },
        },
      })
      if (!projection) return reply.status(404).send({ error: { code: 'NOT_FOUND' } })

      const conceptIds = projection.brands.map((b) => b.conceptId)

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
      const brands = projection.brands.map((b) => {
        const staffMonthlyCents = staffByBrand.get(b.conceptId) ?? 0
        const opexMonthlyCents  = opexByBrand.get(b.conceptId)  ?? 0
        const capexTotalCents   = capexByBrand.get(b.conceptId) ?? 0
        const months: Array<{
          month: number; live: boolean; rampFactor: number; orders: number
          revenueCents: number; variableCents: number; staffCents: number
          opexCents: number; totalCostCents: number; profitCents: number
          cumulativeCents: number
        }> = []
        let cumulative = 0
        for (let i = 0; i < 12; i++) {
          const monthNumber = i + 1
          const live = monthNumber >= b.launchMonth
          const rampIdx = live ? Math.min(monthNumber - b.launchMonth, rampLen - 1) : -1
          const rampFactor = live ? (rampCurve[rampIdx] ?? 0) : 0
          const orders = Math.round(b.tradingDaysPerMonth * b.dailyCoversAtSS * rampFactor)
          const revenueCents  = orders * b.checkAverageCents
          const variableCents = Math.round(revenueCents * (b.foodCostPct + b.packagingCostPct) / 100)
          const staffCents    = live ? staffMonthlyCents : 0
          const opexCents     = live ? opexMonthlyCents  : 0
          const totalCostCents = variableCents + staffCents + opexCents
          const profitCents = revenueCents - totalCostCents
          cumulative += profitCents
          months.push({
            month: monthNumber, live, rampFactor, orders,
            revenueCents, variableCents, staffCents, opexCents,
            totalCostCents, profitCents, cumulativeCents: cumulative,
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
          staffMonthlyCents,
          opexMonthlyCents,
          capexTotalCents,
          months,
          year1RevenueCents: months.reduce((s, m) => s + m.revenueCents, 0),
          year1ProfitCents:  months.reduce((s, m) => s + m.profitCents,  0),
          steadyStateMonthlyProfitCents: steadyState.profitCents,
          steadyStateMonthlyCostCents:   steadyState.totalCostCents,
        }
      })

      // Combined sum across brands
      const combined: Array<{
        month: number; revenueCents: number; variableCents: number
        staffCents: number; opexCents: number; totalCostCents: number
        profitCents: number; cumulativeCents: number
      }> = []
      let combinedCum = 0
      for (let i = 0; i < 12; i++) {
        let revenueCents = 0, variableCents = 0, staffCents = 0, opexCents = 0, profitCents = 0
        for (const b of brands) {
          const m = b.months[i]!
          revenueCents  += m.revenueCents
          variableCents += m.variableCents
          staffCents    += m.staffCents
          opexCents     += m.opexCents
          profitCents   += m.profitCents
        }
        const totalCostCents = variableCents + staffCents + opexCents
        combinedCum += profitCents
        combined.push({ month: i + 1, revenueCents, variableCents, staffCents, opexCents, totalCostCents, profitCents, cumulativeCents: combinedCum })
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
