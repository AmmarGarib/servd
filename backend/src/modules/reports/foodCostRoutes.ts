// Reports → Food cost variance — the API of THE food-cost engine
// (reports/foodCost.ts). Registered at '/reports/food-cost' BEFORE
// reportRoutes (wave Z). Module gate (lib/moduleAccess.ts GATED_PREFIXES):
// '/reports/food-cost' needs 'food_cost'; GET also answers 'accounting'
// holders (the Accounting hub's gauge).
//
//   GET  /summary?from&to&conceptId&locationId     one block per company in view — never blended
//   GET  /ingredients?from&to&tenantId&conceptId&locationId&costClass&sort
//   GET  /ingredients/:inventoryItemId/movements?from&to
//   GET  /valuation?tenantId&asOf                   lots vs 1210/1220/1230, reconciling items, 2015
//   GET  /flags?tenantId                            read-only stock flags (acknowledge in /exceptions)
//   GET  /export.csv?view=summary|ingredients|valuation&…
//   POST /align-inventory { tenantId, dryRun = true }   the CEO only (postFifoAlign)
//
// Every route: requireAuth(FINANCE_TEAM) (align: ADMIN_ONLY); dates are
// YYYY-MM-DD read as PKT days (400 BAD_DATE); the companies come from
// resolveTenantScope (an empty scope is 403 — never unscoped); a conceptId,
// locationId, tenantId or inventoryItemId of another company is 404. Revenue
// and every % only for FINANCIALS_VIEWERS — everyone else gets
// `revenueHidden: true` with quantities and PKR at cost.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { requireAuth, FINANCE_TEAM, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { resolveTenantScope, assertConceptOwned } from '../../lib/tenantScope.js'
import { COST_CLASSES, type CostClass } from '../../lib/inventoryClass.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { postFifoAlign } from '../accounting/inventoryPosting.js'
import {
  foodCostSummary, ingredientVariance, itemMovements, inventoryValuation, foodCostFlags,
  WASTE_REASONS, WASTE_REASON_LABEL, type IngredientSort,
} from './foodCost.js'

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD as a PKT day, or 400 BAD_DATE (2026-02-30 is refused, not rolled over). */
function pktDay(name: string, v: string, end: boolean): Date {
  const s = v.slice(0, 10)
  const start = DATE.test(s) ? parsePktStartOfDay(s) : null
  if (!start || Number.isNaN(start.getTime()) || fmtPktDate(start) !== s || (v.length > 10 && !/^\d{4}-\d{2}-\d{2}T/.test(v))) {
    throw new AppError('BAD_DATE', `${name} must be a date (YYYY-MM-DD)`, 400)
  }
  return end ? parsePktEndOfDay(s) : start
}

/** The period: whole PKT days; the last 30 days (to today) by default. */
function periodOf(q: { from?: string; to?: string; dateFrom?: string; dateTo?: string }): { from: Date; to: Date } {
  const fromS = q.from ?? q.dateFrom
  const toS = q.to ?? q.dateTo
  const to = toS ? pktDay('to', toS, true) : parsePktEndOfDay(fmtPktDate(new Date()))
  const from = fromS ? pktDay('from', fromS, false) : parsePktStartOfDay(fmtPktDate(new Date(to.getTime() - 29 * DAY_MS)))
  if (from.getTime() > to.getTime()) throw new AppError('BAD_DATE', 'from is after to', 400)
  return { from, to }
}

const seesRevenue = (req: FastifyRequest) => FINANCIALS_VIEWERS.includes(req.staffUser!.role)

/** The companies in view; an empty scope is refused, never read unscoped. */
async function scopeIds(req: FastifyRequest): Promise<string[]> {
  const { tenantIds } = await resolveTenantScope(req)
  if (tenantIds.length === 0) throw new AppError('NO_COMPANY_SCOPE', 'Pick a company first — the food-cost report is per company.', 403)
  return tenantIds
}

/** `tenantId` from the client, in view (else 404); absent → the active company (else the only one in view). */
async function companyOf(req: FastifyRequest, tenantId: string | undefined): Promise<string> {
  const ids = await scopeIds(req)
  if (tenantId) {
    if (!ids.includes(tenantId)) throw new NotFoundError('Company', tenantId)
    return tenantId
  }
  const active = req.staffUser?.tenantId
  if (active && ids.includes(active)) return active
  if (ids.length === 1) return ids[0]!
  throw new AppError('TENANT_REQUIRED', 'Pick one company (tenantId) — this view is per company.', 400)
}

/** A location in view, or 404; returns its company. */
async function locationCompany(req: FastifyRequest, locationId: string): Promise<string> {
  const ids = await scopeIds(req)
  const loc = await prisma.location.findFirst({ where: { id: locationId, tenantId: { in: ids } }, select: { tenantId: true } })
  if (!loc?.tenantId) throw new NotFoundError('Location', locationId)
  return loc.tenantId
}

function costClassParam(v: string | undefined): CostClass | undefined {
  if (!v) return undefined
  const c = v === 'drinks' ? 'beverage' : v
  if (!(COST_CLASSES as readonly string[]).includes(c)) throw new AppError('BAD_COST_CLASS', 'costClass is food, drinks (beverage) or packaging', 400)
  return c as CostClass
}

const SORTS: readonly IngredientSort[] = ['unexplained', 'theoretical', 'waste', 'name']

interface SummaryQ { from?: string; to?: string; dateFrom?: string; dateTo?: string; conceptId?: string; locationId?: string }
interface IngredientsQ extends SummaryQ { tenantId?: string; costClass?: string; sort?: string }

/** Resolve the summary's companies: the view, narrowed to a brand's or an outlet's company. */
async function summaryScope(req: FastifyRequest, q: SummaryQ): Promise<{ tenantIds: string[]; conceptId?: string; locationId?: string }> {
  let tenantIds = await scopeIds(req)
  let conceptId: string | undefined
  let locationId: string | undefined
  if (q.conceptId) {
    const c = await assertConceptOwned(req, q.conceptId, 'read')
    if (!c.tenantId || !tenantIds.includes(c.tenantId)) throw new NotFoundError('Concept', q.conceptId)
    tenantIds = [c.tenantId]
    conceptId = c.id
  }
  if (q.locationId) {
    const t = await locationCompany(req, q.locationId)
    if (!tenantIds.includes(t)) throw new NotFoundError('Location', q.locationId)
    tenantIds = [t]
    locationId = q.locationId
  }
  return { tenantIds, ...(conceptId ? { conceptId } : {}), ...(locationId ? { locationId } : {}) }
}

/** A brand / outlet for a one-company view must be that company's (404 otherwise). */
async function narrowFor(req: FastifyRequest, tenantId: string, q: { conceptId?: string; locationId?: string }) {
  if (q.conceptId) {
    const c = await assertConceptOwned(req, q.conceptId, 'read')
    if (c.tenantId !== tenantId) throw new NotFoundError('Concept', q.conceptId)
  }
  if (q.locationId && (await locationCompany(req, q.locationId)) !== tenantId) throw new NotFoundError('Location', q.locationId)
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
const rs = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2))

export default async function foodCostRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.get<{ Querystring: SummaryQ }>('/summary', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const { from, to } = periodOf(req.query)
    const s = await summaryScope(req, req.query)
    const revenueVisible = seesRevenue(req)
    const companies = await foodCostSummary(prisma, { ...s, from, to, revenueVisible })
    return {
      period: { from: from.toISOString(), to: to.toISOString(), fromDate: fmtPktDate(from), toDate: fmtPktDate(to) },
      revenueHidden: !revenueVisible,
      wasteReasons: WASTE_REASONS.map((r) => ({ key: r, label: WASTE_REASON_LABEL[r] })),
      companies,
    }
  })

  fastify.get<{ Querystring: IngredientsQ }>('/ingredients', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const { from, to } = periodOf(req.query)
    const tenantId = await companyOf(req, req.query.tenantId)
    await narrowFor(req, tenantId, req.query)
    const sort = SORTS.includes(req.query.sort as IngredientSort) ? req.query.sort as IngredientSort : 'unexplained'
    const costClass = costClassParam(req.query.costClass)
    const rows = await ingredientVariance(prisma, {
      tenantId, from, to, sort,
      ...(req.query.conceptId ? { conceptId: req.query.conceptId } : {}),
      ...(req.query.locationId ? { locationId: req.query.locationId } : {}),
      ...(costClass ? { costClass } : {}),
    })
    return { tenantId, period: { from: from.toISOString(), to: to.toISOString() }, revenueHidden: !seesRevenue(req), rows }
  })

  fastify.get<{ Params: { inventoryItemId: string }; Querystring: SummaryQ }>(
    '/ingredients/:inventoryItemId/movements', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
      const { from, to } = periodOf(req.query)
      const ids = await scopeIds(req)
      const item = await prisma.inventoryItem.findFirst({ where: { id: req.params.inventoryItemId, tenantId: { in: ids } }, select: { tenantId: true } })
      if (!item?.tenantId) throw new NotFoundError('Inventory item', req.params.inventoryItemId)
      return itemMovements(prisma, { tenantId: item.tenantId, inventoryItemId: req.params.inventoryItemId, from, to })
    },
  )

  fastify.get<{ Querystring: { tenantId?: string; asOf?: string } }>('/valuation', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const tenantId = await companyOf(req, req.query.tenantId)
    const asOf = req.query.asOf ? pktDay('asOf', req.query.asOf, true) : undefined
    return inventoryValuation(prisma, { tenantId, ...(asOf ? { asOf } : {}) })
  })

  fastify.get<{ Querystring: { tenantId?: string } }>('/flags', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const tenantId = await companyOf(req, req.query.tenantId)
    return { tenantId, flags: await foodCostFlags(prisma, { tenantId }) }
  })

  fastify.get<{ Querystring: IngredientsQ & { view?: string; asOf?: string } }>('/export.csv', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req, reply) => {
    const view = req.query.view ?? 'summary'
    const revenueVisible = seesRevenue(req)
    let body: string
    let name: string
    if (view === 'summary') {
      const { from, to } = periodOf(req.query)
      const s = await summaryScope(req, req.query)
      const companies = await foodCostSummary(prisma, { ...s, from, to, revenueVisible })
      const head = ['Company', 'Brand', ...(revenueVisible ? ['Brand sales', 'Target %', 'Theoretical %', 'Actual %', 'AvT points'] : []),
        'Theoretical', 'Comps', 'Staff meals', 'Waste', 'Prep draws', 'Issued on receipt', 'Late receipts settled', 'Price adjustments',
        'Count variance', 'Cooked before on the books', 'Other entries', 'FIFO cut-over', 'Timing', 'Actual', 'Explained', 'Unexplained', 'Status']
      const rows: unknown[][] = [head]
      for (const c of companies) {
        for (const b of [{ ...c, name: 'All brands' }, ...c.brands]) {
          const k = b.buckets
          rows.push([c.companyName, b.name,
            ...(revenueVisible ? [rs(b.revenueCents), b.targetPct, b.theoreticalPct, b.actualPct, b.avtPoints] : []),
            rs(b.theoretical.totalCents), rs(k.comps.totalCents), rs(k.staffMeals.totalCents), rs(k.waste.total.totalCents), rs(k.prepDraws.totalCents),
            rs(k.issueOnReceipt.totalCents), rs(k.shortfallSettles.totalCents), rs(k.priceAdjustments), rs(k.countVariance.totalCents), rs(k.notOnBooks),
            rs(k.otherEntries), rs(b.alignmentCents), rs(b.timing?.totalCents ?? null), rs(b.actual?.totalCents ?? null), rs(b.explainedCents),
            rs(b.unexplainedCents), b.statusLabel])
        }
      }
      body = csv(rows)
      name = `food-cost-summary-${fmtPktDate(from)}-${fmtPktDate(to)}.csv`
    } else if (view === 'ingredients') {
      const { from, to } = periodOf(req.query)
      const tenantId = await companyOf(req, req.query.tenantId)
      await narrowFor(req, tenantId, req.query)
      const costClass = costClassParam(req.query.costClass)
      const rows = await ingredientVariance(prisma, {
        tenantId, from, to, sort: 'unexplained',
        ...(req.query.conceptId ? { conceptId: req.query.conceptId } : {}),
        ...(req.query.locationId ? { locationId: req.query.locationId } : {}),
        ...(costClass ? { costClass } : {}),
      })
      const out: unknown[][] = [['Ingredient', 'Class', 'Unit', 'Opening qty', 'Opening PKR', 'Received qty', 'Received PKR', 'Theoretical qty', 'Theoretical PKR',
        'Comps PKR', 'Staff meals PKR', 'Waste qty', 'Waste PKR', 'Prep PKR', 'Count qty', 'Count PKR', 'Shortfall qty', 'Shortfall PKR',
        'Closing qty', 'Closing PKR', 'Unexplained qty', 'Unexplained PKR']]
      for (const r of rows) {
        out.push([r.name, r.classLabel, r.unit, r.opening.qty, rs(r.opening.cents), r.received.qty, rs(r.received.cents), r.theoretical.qty, rs(r.theoretical.cents),
          rs(r.comps.cents), rs(r.staffMeals.cents), r.waste.qty, rs(r.waste.cents), rs(r.prep.cents), r.count.qty, rs(r.count.cents), r.shortfall.qty,
          rs(r.shortfall.cents), r.closing.qty, rs(r.closing.cents), r.unexplained.qty, rs(r.unexplained.cents)])
      }
      body = csv(out)
      name = `food-cost-ingredients-${fmtPktDate(from)}-${fmtPktDate(to)}.csv`
    } else if (view === 'valuation') {
      const tenantId = await companyOf(req, req.query.tenantId)
      const asOf = req.query.asOf ? pktDay('asOf', req.query.asOf, true) : undefined
      const v = await inventoryValuation(prisma, { tenantId, ...(asOf ? { asOf } : {}) })
      const out: unknown[][] = [['Class', 'Account', 'Lots', 'Ledger', 'Issued, not booked', 'Pre-FIFO difference', 'Unreconciled']]
      for (const c of v.classes) out.push([c.label, c.glCode, rs(c.lotsCents), rs(c.glCents), rs(c.issuedNotBookedCents), rs(c.preFifoDiffCents), rs(c.unreconciledCents)])
      out.push(['Goods received not invoiced', v.grni.glCode, rs(v.grni.expectedCents), rs(v.grni.glCreditCents), '', '', rs(v.grni.differenceCents)])
      body = csv(out)
      name = `food-cost-valuation-${v.asOf.slice(0, 10)}.csv`
    } else {
      throw new AppError('BAD_VIEW', 'view is summary, ingredients or valuation', 400)
    }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(body)
  })

  // The CEO aligns 1210 / 1220 / 1230 with the lots once, after the cut-over
  // (a prior-period difference to 3020 — never cost of sales). Dry run first.
  const alignBody = z.object({ tenantId: z.string().min(1), dryRun: z.boolean().default(true) })
  fastify.post('/align-inventory', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = alignBody.parse(req.body ?? {})
    // A company the CEO belongs to (write scope), else 404 — never another's books.
    if (!req.staffUser!.memberTenantIds.includes(body.tenantId)) throw new NotFoundError('Company', body.tenantId)
    const t = await prisma.tenant.findUnique({ where: { id: body.tenantId }, select: { id: true } })
    if (!t) throw new NotFoundError('Company', body.tenantId)
    const r = await postFifoAlign(body.tenantId, { dryRun: body.dryRun, actor: { id: req.staffUser!.id } })
    if (r.posted) {
      await audit({
        category: 'accounting', action: 'inventory.fifo_align', entity: 'Tenant', entityId: body.tenantId,
        userId: req.staffUser!.id, tenantId: body.tenantId, metadata: { byClass: r.byClass },
      })
    }
    return { tenantId: body.tenantId, dryRun: body.dryRun, ...r }
  })
}
