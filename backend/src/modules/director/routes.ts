// Director → Brand performance (owner, 2026-10-18) — THE read-only API of a
// director login. Contract:
//
//   GET /director/brands                                  the brands this login may see
//   GET /director/sales?conceptId&dateFrom&dateTo         net sales, orders, average bill, by day / channel / tender, top items
//   GET /director/pnl?…                                   the brand's own P&L row (labour % included)
//   GET /director/food-cost?…                             the brand's food-cost block and its items
//   GET /director/menu?…                                  menu engineering (stars / plowhorses / puzzles / dogs)
//   GET /director/reviews?…                               reviews, no customer contact
//   GET /director/complaints?…                            complaints, no customer contact
//   GET /director/export.csv?view=<view>&…                any table above as CSV, from the same functions
//
// requireAuth('director', 'admin'): a director, and the CEO previewing a brand.
// GET only — a director never writes (the auth middleware refuses every other
// route for the role: DIRECTOR_ROUTES). The brand list comes from the LOGIN
// (access.ts), never from the client: a conceptId outside it is 404. With no
// brand (a director with none) every answer is empty — never "everything".
// Dates are PKT days; default this month so far (service.ts directorPeriod).
// Module gate: '/director' needs 'director_view' (lib/moduleAccess.ts).

import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAuth } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { csvCell } from '../accounting/csv.js'
import { exportFormatOf, fromMatrix, sendReport, type ExportFormat } from '../../lib/reportExport.js'
import { directorBrands, pickDirectorBrand, type DirectorBrand } from './access.js'
import {
  directorPeriod, directorSales, directorPnl, directorFoodCost, directorMenu, directorReviews, directorComplaints,
  type DirectorPeriod,
} from './service.js'

interface Q { conceptId?: string; dateFrom?: string; dateTo?: string }

const DIRECTOR_VIEWERS = requireAuth('director', 'admin')

/** The brand (or null) and period of a request. Period first: a bad date is 400 before anything is read. */
async function context(req: Parameters<typeof pickDirectorBrand>[0], q: Q): Promise<{ brand: DirectorBrand | null; period: DirectorPeriod }> {
  const period = directorPeriod(q)
  const brand = await pickDirectorBrand(req, q.conceptId || undefined)
  return { brand, period }
}

function head(brand: DirectorBrand | null, p: DirectorPeriod) {
  return { brand: brand ? { id: brand.id, name: brand.name } : null, period: { dateFrom: p.dateFrom, dateTo: p.dateTo } }
}

const rs = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2))

type Table = { columns: string[]; rows: unknown[][] }

/** Every CSV view, each built from the same function its JSON endpoint uses. */
const VIEWS: Record<string, (b: DirectorBrand, p: DirectorPeriod) => Promise<Table>> = {
  'sales-daily': async (b, p) => {
    const s = await directorSales(b, p)
    return { columns: ['Date', 'Orders', 'Gross (PKR)', 'Net sales (PKR)'], rows: s.daily.map((d) => [d.date, d.orders, rs(d.gross), rs(d.net)]) }
  },
  'sales-channels': async (b, p) => {
    const s = await directorSales(b, p)
    return {
      columns: ['Channel', 'Orders', 'Gross (PKR)', 'Discounts (PKR)', 'Refunds (PKR)', 'Net sales (PKR)'],
      rows: s.byChannel.map((c) => [c.source, c.orders, rs(c.gross), rs(c.discount), rs(c.refunds), rs(c.net)]),
    }
  },
  'sales-tenders': async (b, p) => {
    const s = await directorSales(b, p)
    return {
      columns: ['Tender', 'Orders', 'Payments', 'Amount (PKR)', 'Share %'],
      rows: s.byTender.tenders.map((t) => [t.label, t.orders, t.payments, rs(t.amountCents), t.sharePct]),
    }
  },
  'top-items': async (b, p) => {
    const s = await directorSales(b, p)
    return { columns: ['Rank', 'Item', 'Quantity', 'Revenue (PKR)'], rows: s.topItems.map((i) => [i.rank, i.name, i.quantity, rs(i.revenueCents)]) }
  },
  pnl: async (b, p) => {
    const r = await directorPnl(b, p)
    const lines: Array<[string, number | null, number | null]> = [
      ['Revenue', r.revenueCents, null],
      ['Discounts and loyalty', r.contraCents, null],
      ['Net revenue', r.netRevenueCents, null],
      ['Cost of sales', r.cogsCents, r.costOfSalesPct],
      ['  Food', r.foodCents, r.foodPct],
      ['  Drinks', r.drinksCents, r.drinksPct],
      ['  Packaging', r.packagingCents, r.packagingPct],
      ['Gross profit', r.grossProfitCents, r.grossMarginPct],
      ['Operating expenses (incl. labour)', r.opexCents, null],
      ['  Labour', r.labourCents, r.labourPct],
      ['Other income', r.otherIncomeCents, null],
      ['Net profit', r.netProfitCents, r.netMarginPct],
    ]
    return { columns: ['Line', 'Amount (PKR)', '%'], rows: lines.map(([l, c, pct]) => [l, rs(c), pct ?? '']) }
  },
  'food-cost': async (b, p) => {
    const f = await directorFoodCost(b, p)
    return {
      columns: ['Item', 'Sold', 'Has recipe', 'Cost (PKR)', 'Revenue (PKR)', 'Cost %', 'Target %'],
      rows: f.items.map((i) => [i.name, i.qtySold, i.hasRecipe ? 'yes' : 'no', rs(i.costCents), rs(i.revenueCents), i.costPct ?? '', i.targetPct ?? '']),
    }
  },
  menu: async (b, p) => {
    const m = await directorMenu(b, p)
    return {
      columns: ['Item', 'Price (PKR)', 'Sold', 'Plate cost (PKR)', 'Gross margin %', 'Class'],
      rows: m.map((i) => [i.name, rs(i.priceCents), i.qtySold, rs(i.foodCostCents), i.grossMarginPct, i.quadrant]),
    }
  },
  reviews: async (b, p) => {
    const r = await directorReviews(b, p)
    return {
      columns: ['Date', 'Rating', 'Comment', 'Tags', 'Source'],
      rows: r.reviews.map((x) => [x.createdAt.toISOString().slice(0, 10), x.rating, x.comment ?? '', x.tags, x.source]),
    }
  },
  complaints: async (b, p) => {
    const c = await directorComplaints(b, p)
    return {
      columns: ['Date', 'Title', 'Category', 'Priority', 'Status', 'Resolved', 'Description', 'Resolution'],
      rows: c.complaints.map((x) => [
        x.createdAt.toISOString().slice(0, 10), x.title, x.category, x.priority, x.status,
        x.resolvedAt ? x.resolvedAt.toISOString().slice(0, 10) : '', x.description, x.resolution ?? '',
      ]),
    }
  },
}

export const DIRECTOR_CSV_VIEWS = Object.keys(VIEWS)

const VIEW_TITLE: Record<string, string> = {
  'sales-daily': 'Sales by day', 'sales-channels': 'Sales by channel', 'sales-tenders': 'Sales by tender', 'top-items': 'Top items',
  pnl: 'Profit and loss', 'food-cost': 'Food cost', menu: 'Menu engineering', reviews: 'Reviews', complaints: 'Complaints',
}

/** CSV exactly as before; Excel / PDF through lib/reportExport.ts, headed with the BRAND only (never a company). */
function sendTable(reply: FastifyReply, format: ExportFormat, name: string, view: string, brandName: string | null, period: string | null, t: Table) {
  const body = '﻿' + [t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  return sendReport(reply, format, name, {
    title: `${brandName ? `${brandName} — ` : ''}${VIEW_TITLE[view] ?? view}`,
    companies: brandName ? [brandName] : [],
    ...(period ? { period } : {}),
    ...fromMatrix(t.columns, t.rows),
    csv: body,
  })
}

export async function directorRoutes(fastify: FastifyInstance) {
  fastify.get('/brands', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const brands = await directorBrands(req)
    return { brands: brands.map((b) => ({ id: b.id, name: b.name, slug: b.slug })) }
  })

  fastify.get<{ Querystring: Q }>('/sales', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const { brand, period } = await context(req, req.query)
    return { ...head(brand, period), ...(brand ? await directorSales(brand, period) : { totals: null, daily: [], byChannel: [], byTender: null, topItems: [] }) }
  })

  fastify.get<{ Querystring: Q }>('/pnl', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const { brand, period } = await context(req, req.query)
    return { ...head(brand, period), pnl: brand ? await directorPnl(brand, period) : null }
  })

  fastify.get<{ Querystring: Q }>('/food-cost', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const { brand, period } = await context(req, req.query)
    return { ...head(brand, period), ...(brand ? await directorFoodCost(brand, period) : { summary: null, items: [] }) }
  })

  fastify.get<{ Querystring: Q }>('/menu', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const { brand, period } = await context(req, req.query)
    return { ...head(brand, period), items: brand ? await directorMenu(brand, period) : [] }
  })

  fastify.get<{ Querystring: Q }>('/reviews', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const { brand, period } = await context(req, req.query)
    return { ...head(brand, period), ...(brand ? await directorReviews(brand, period) : { reviews: [], total: 0, average: null }) }
  })

  fastify.get<{ Querystring: Q }>('/complaints', { preHandler: DIRECTOR_VIEWERS }, async (req) => {
    const { brand, period } = await context(req, req.query)
    return {
      ...head(brand, period),
      ...(brand ? await directorComplaints(brand, period) : { complaints: [], stats: { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0 } }),
    }
  })

  fastify.get<{ Querystring: Q & { view?: string } }>('/export.csv', { preHandler: DIRECTOR_VIEWERS }, async (req, reply) => {
    const view = req.query.view ?? ''
    const build = Object.prototype.hasOwnProperty.call(VIEWS, view) ? VIEWS[view] : undefined
    if (!build) throw new AppError('BAD_VIEW', `view is one of: ${DIRECTOR_CSV_VIEWS.join(', ')}`, 400)
    const { brand, period } = await context(req, req.query)
    // No brand on the login: an empty file, never another brand's rows.
    const format = exportFormatOf((req.query as { format?: string }).format, 'csv')!
    if (!brand) return sendTable(reply, format, `director-${view}`, view, null, null, { columns: [], rows: [] })
    const slug = brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brand'
    return sendTable(reply, format, `${slug}-${view}-${period.dateFrom}-to-${period.dateTo}`, view, brand.name, `${period.dateFrom} to ${period.dateTo}`, await build(brand, period))
  })
}
