// The till's Reports routes (owner, 2026-10-22) — contract: ./TILL_REPORTS.md.
//
//   GET /reports/till/catalog            the groups, reports, filters and options
//   GET /reports/till/lookups            the pickers (outlets = the caller's brands; the rest for ?conceptIds)
//   GET /reports/till/run/:reportId      one report (JSON, or ?format=csv|xlsx|pdf)
//
// Same readers and gate as /reports/till-sales: requireAuth(...REPORT_READERS)
// and the '/reports' module rule in lib/moduleAccess.ts. Every conceptId is
// resolved with assertConceptOwned(req, id, 'read') — another company's brand
// is 404 — and every list below is scoped to those brands / their companies.
// Read only.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned } from '../../lib/tenantScope.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'
import { reportDateRange } from './service.js'
import { REPORT_READERS } from './routes.js'
import {
  tillCatalog, runTillReport, tillReportTable, terminalLabel, STATIC_LOOKUPS,
  TILL_REPORTS, TILL_REPORT_IDS, OPTION_KEYS, GROUP_BY_KEYS, ORDER_TYPES, SOURCES, PAYMENT_METHODS, PAYMENT_TYPES,
  type TillReportId, type TillFilters, type OptionKey, type GroupByKey, type OrderTypeKey,
} from './tillReports.js'

const MAX_DAYS = 92
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Q = Record<string, string | undefined>

function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}
function bad(code: string, message: string): never {
  throw new AppError(code, message, 400)
}
function ids(q: Q, key: string): string[] | undefined {
  const v = list(q[key])
  if (v.length === 0) return undefined
  if (v.length > 200) bad('INVALID_FILTER', `${key}: at most 200 values`)
  for (const id of v) if (!UUID.test(id)) bad('INVALID_FILTER', `${key}: '${id}' is not an id`)
  return v
}
function oneOf<T extends string>(q: Q, key: string, allowed: readonly T[]): T[] | undefined {
  const v = list(q[key])
  if (v.length === 0) return undefined
  for (const x of v) if (!allowed.includes(x as T)) bad('INVALID_FILTER', `${key}: '${x}' must be one of ${allowed.join(', ')}`)
  return v as T[]
}

/** The brands asked for, each owned (404 otherwise), with their companies and names. */
async function ownedBrands(req: FastifyRequest, raw: string | undefined, required: boolean) {
  const conceptIds = [...new Set(list(raw))]
  if (required && conceptIds.length === 0) bad('CONCEPTS_REQUIRED', 'Pick at least one outlet (conceptIds)')
  if (conceptIds.length > 50) bad('INVALID_FILTER', 'conceptIds: at most 50 brands')
  for (const id of conceptIds) if (!UUID.test(id)) throw new NotFoundError('Concept', id)
  const tenantIds = new Set<string>()
  for (const id of conceptIds) {
    const c = await assertConceptOwned(req, id, 'read')
    if (c.tenantId) tenantIds.add(c.tenantId)
  }
  const names = conceptIds.length
    ? (await prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { name: true }, orderBy: { name: 'asc' } })).map((c) => c.name)
    : []
  return { conceptIds, tenantIds: [...tenantIds], names }
}

function period(q: Q) {
  const { from, to } = reportDateRange(q['dateFrom'], q['dateTo'], 0)
  if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) bad('RANGE_TOO_LONG', `A till report covers at most ${MAX_DAYS} days`)
  return { from, to }
}

export async function tillReportRoutes(fastify: FastifyInstance) {
  fastify.get('/catalog', { preHandler: requireAuth(...REPORT_READERS) }, async () => tillCatalog())

  fastify.get('/lookups', { preHandler: requireAuth(...REPORT_READERS) }, async (req) => {
    const q = req.query as Q
    const company = await scopeTenantWhere(req, 'read')
    const outlets = await prisma.concept.findMany({ where: { deletedAt: null, ...company }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    const { conceptIds, tenantIds } = await ownedBrands(req, q['conceptIds'], false)
    const empty = { users: [], waiters: [], categories: [], subCategories: [], sessions: [], menuItems: [], terminals: [], items: [] }
    if (conceptIds.length === 0) return { outlets, ...empty, ...STATIC_LOOKUPS }
    // Users / waiters / drawers are read from the brands' orders in the window (default: the last 31 days).
    const { from, to } = reportDateRange(q['dateFrom'], q['dateTo'], 31)
    const window = { placedAt: { gte: from, lte: to } }
    const orderWhere = { conceptId: { in: conceptIds }, deletedAt: null, ...window }
    const [staff, waiters, allCategories, menuItems, shifts, items, sessions] = await Promise.all([
      prisma.order.findMany({ where: { ...orderWhere, posStaffId: { not: null } }, distinct: ['posStaffId'], select: { posStaff: { select: { id: true, name: true } } } }),
      prisma.order.findMany({ where: { ...orderWhere, waiterEmployeeId: { not: null } }, distinct: ['waiterEmployeeId'], select: { waiter: { select: { id: true, fullName: true, tenantId: true } } } }),
      prisma.category.findMany({ where: { conceptId: { in: conceptIds }, deletedAt: null }, select: { id: true, name: true, conceptId: true, parentId: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.menuItem.findMany({ where: { conceptId: { in: conceptIds }, deletedAt: null }, select: { id: true, name: true, categoryId: true }, orderBy: { name: 'asc' } }),
      prisma.shift.findMany({
        where: {
          tenantId: { in: tenantIds }, openedAt: { lte: to }, OR: [{ closedAt: null }, { closedAt: { gte: from } }],
          AND: [{ OR: [{ payments: { some: { order: { conceptId: { in: conceptIds } } } } }, { location: { concepts: { some: { conceptId: { in: conceptIds } } } } }] }],
        },
        select: { id: true, openedAt: true, userId: true, user: { select: { id: true, name: true } } },
        orderBy: { openedAt: 'desc' }, take: 500,
      }),
      prisma.inventoryItem.findMany({ where: { tenantId: { in: tenantIds }, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      // Sales sessions (2026-10-22): the brands' active ones.
      prisma.menuSession.findMany({ where: { conceptId: { in: conceptIds }, isActive: true }, select: { id: true, name: true, conceptId: true, startTime: true, endTime: true }, orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }] }),
    ])
    // Categories = main categories; sub-categories carry their main category (parentId).
    const categories = allCategories.filter((c) => !c.parentId).map(({ parentId: _p, ...c }) => c)
    const subCategories = allCategories.filter((c) => c.parentId)
    const users = new Map<string, string>()
    for (const s of staff) if (s.posStaff) users.set(s.posStaff.id, s.posStaff.name)
    for (const s of shifts) users.set(s.user.id, s.user.name)
    return {
      outlets,
      users: [...users].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      // A waiter is an HR employee of the order's company — never another company's.
      waiters: waiters.map((w) => w.waiter).filter((w): w is NonNullable<typeof w> => !!w && tenantIds.includes(w.tenantId))
        .map((w) => ({ id: w.id, name: w.fullName })).sort((a, b) => a.name.localeCompare(b.name)),
      categories, subCategories, sessions, menuItems,
      terminals: shifts.map((s) => ({ id: s.id, label: terminalLabel(s) })),
      items,
      ...STATIC_LOOKUPS,
    }
  })

  fastify.get<{ Params: { reportId: string } }>('/run/:reportId', { preHandler: requireAuth(...REPORT_READERS) }, async (req, reply) => {
    const id = req.params.reportId as TillReportId
    if (!TILL_REPORT_IDS.includes(id)) throw new NotFoundError('Report', req.params.reportId)
    const def = TILL_REPORTS[id]
    const q = req.query as Q
    const { from, to } = period(q)
    const brands = await ownedBrands(req, q['conceptIds'], true)

    const filters: TillFilters = {
      users: ids(q, 'users'), waiters: ids(q, 'waiters'), categories: ids(q, 'categories'), subCategories: ids(q, 'subCategories'), sessions: ids(q, 'sessions'), menuItems: ids(q, 'menuItems'),
      terminals: ids(q, 'terminals'), orderBy: ids(q, 'orderBy'), settleBy: ids(q, 'settleBy'), items: ids(q, 'items'),
      orderTypes: oneOf<OrderTypeKey>(q, 'orderTypes', ORDER_TYPES), sources: oneOf(q, 'sources', SOURCES),
      paymentMethods: oneOf(q, 'paymentMethods', PAYMENT_METHODS), paymentType: oneOf(q, 'paymentType', PAYMENT_TYPES),
    }
    const search = q['q']?.trim()
    if (search && search.length > 80) bad('INVALID_FILTER', 'q: at most 80 characters')
    if (search) filters.q = search
    const opts = new Set(oneOf<OptionKey>(q, 'opts', OPTION_KEYS) ?? [])
    let groupBy: GroupByKey = 'payment_method'
    if (q['groupBy']) {
      if (!def.groupBy || !(GROUP_BY_KEYS as readonly string[]).includes(q['groupBy'])) bad('INVALID_FILTER', `groupBy must be one of ${(def.groupBy ?? []).join(', ') || '(none for this report)'}`)
      groupBy = q['groupBy'] as GroupByKey
    }

    const money = FINANCIALS_VIEWERS.includes(req.staffUser!.role)
    const report = await runTillReport(id, {
      sq: { company: await scopeTenantWhere(req, 'read'), conceptIds: brands.conceptIds, from, to },
      conceptIds: brands.conceptIds, tenantIds: brands.tenantIds, outlets: brands.names,
      filters, groupBy, opts, money,
    })
    const format = exportFormatOf(q['format'])
    if (format) return sendReportFor(req, reply, format, { base: `till-${id.replace(/_/g, '-')}`, suffix: report.period.replace(/ to /, '-to-') }, tillReportTable(report))
    return report
  })
}
