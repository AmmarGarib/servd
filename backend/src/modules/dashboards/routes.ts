// Dashboard starter numbers (owner, 2026-10-26, C4): GET /dashboards/:id/numbers, id = ceo | operations | finance |
// marketing | hr. ONE route, read-only, no per-person storage (the owner picks changes later). Every number is read
// from an EXISTING function or table, inside the caller's company view (resolveTenantScope: the portfolio header
// expands it). The route needs the module that dashboard's page already needs (404-style 403 otherwise). Money
// figures go only to FINANCIALS_VIEWERS (as the reports hide money): others get the tile without its amount
// (`hidden: true`). A number whose source fails comes back `value: null` with a `reason` — never fails the call.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { salesTotals, salesByChannel, stationTimes, soldOrderWhere, type SalesQuery } from '../reports/service.js'
import { foodCostSummary } from '../reports/foodCost.js'
import { trialBalance } from '../accounting/reports.js'
import { reorderSuggestions } from '../procurement/service.js'
import { fmtPktDate, parsePktStartOfDay, parsePktEndOfDay } from '../accounting/dates.js'
import { ATTENDANCE_DAY_TAKEN } from '../hr/service.js'
import { pktToday } from '../hr/logic.js'

export const DASHBOARD_IDS = ['ceo', 'operations', 'finance', 'marketing', 'hr'] as const
type DashboardId = typeof DASHBOARD_IDS[number]

/** The module(s) each dashboard's own page needs (moduleCatalog: Home, Operations / Finance / Marketing / HR dashboard). */
const DASHBOARD_MODULES: Record<DashboardId, string[]> = {
  ceo: ['ceo_overview'],
  operations: ['dashboard', 'fnb_dashboard', 'ops'],
  finance: ['finance_pl'],
  marketing: ['brand_dashboard'],
  hr: ['staff_hr'],
}

type Unit = 'pkr' | 'count' | 'pct' | 'minutes'
export interface DashboardNumber {
  key: string
  label: string
  unit: Unit
  /** The page with the full report. */
  href: string
  value: number | null
  /** Month to date, where it makes sense. */
  monthToDate?: number | null
  breakdown?: Array<{ label: string; value: number | null }>
  /** Money the caller's role may not see: the tile shows without its amount. */
  hidden?: boolean
  reason?: string
}

const seesMoney = (req: FastifyRequest) => FINANCIALS_VIEWERS.includes(req.staffUser!.role)

export async function dashboardRoutes(fastify: FastifyInstance) {
  const apiBase = fastify.prefix.replace(/\/dashboards\/?$/, '').replace(/\/$/, '')

  fastify.get<{ Params: { id: string } }>(
    '/:id/numbers',
    {
      preHandler: [
        requireAuth(...ALL_STAFF),
        async (req, reply) => {
          const id = z.enum(DASHBOARD_IDS).safeParse((req.params as { id: string }).id)
          if (!id.success) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such dashboard' } })
          return requireModule(...DASHBOARD_MODULES[id.data])(req)
        },
      ],
    },
    async (req) => {
      const id = z.enum(DASHBOARD_IDS).parse(req.params.id)
      const money = seesMoney(req)
      const scope = await resolveTenantScope(req)
      const company = await scopeTenantWhere(req, 'read')
      const tenantIds = scope.tenantIds
      const now = new Date()
      const todayKey = fmtPktDate(now)
      const today = { from: parsePktStartOfDay(todayKey), to: parsePktEndOfDay(todayKey) }
      const month = { from: parsePktStartOfDay(`${todayKey.slice(0, 8)}01`), to: today.to }
      const sq = (r: { from: Date; to: Date }, extra: Partial<SalesQuery> = {}): SalesQuery => ({ company, settlement: 'all', ...r, ...extra })
      const orderOfCompany = { concept: { ...company, deletedAt: null } }

      /** Build one number; a failing source gives null + reason (and is logged), never a failed call. */
      async function num(
        base: Omit<DashboardNumber, 'value'>, isMoney: boolean,
        read: () => Promise<Pick<DashboardNumber, 'value' | 'monthToDate' | 'breakdown'>>,
      ): Promise<DashboardNumber> {
        if (isMoney && !money) return { ...base, value: null, hidden: true }
        try { return { ...base, ...(await read()) } } catch (err) {
          console.error(`[dashboards] ${id}/${base.key}:`, (err as Error).message)
          return { ...base, value: null, reason: 'This number could not be read right now.' }
        }
      }
      const notAvailable = (base: Omit<DashboardNumber, 'value'>, reason: string): DashboardNumber => ({ ...base, value: null, reason })

      // ── The number readers (each one an existing function / table) ──────────────────────────────────
      const salesN = (key: string, label: string, by: 'company' | 'brand' | 'none') => num(
        { key, label, unit: 'pkr', href: '/reports' }, true, async () => {
          const [t, m] = await Promise.all([salesTotals(sq(today)), salesTotals(sq(month))])
          let breakdown: DashboardNumber['breakdown']
          if (by !== 'none') {
            const concepts = await prisma.concept.findMany({ where: { ...company, deletedAt: null }, select: { id: true, name: true, tenant: { select: { name: true } } }, orderBy: { name: 'asc' } })
            const rows = await Promise.all(concepts.map(async (c) => ({
              label: by === 'company' ? `${c.tenant?.name ?? 'No company'} — ${c.name}` : c.name,
              value: (await salesTotals(sq(today, { conceptId: c.id }))).net,
            })))
            breakdown = rows
          }
          return { value: t.net, monthToDate: m.net, ...(breakdown && { breakdown }) }
        })
      const foodCostN = () => num({ key: 'food_cost_pct', label: 'Food cost %', unit: 'pct', href: '/reports/food-cost' }, false, async () => {
        const read = async (r: { from: Date; to: Date }) => {
          const blocks = await foodCostSummary(prisma, { tenantIds, ...r, revenueVisible: money })
          return blocks.map((b) => ({ label: b.companyName, value: typeof b.actualPct === 'number' ? Math.round(b.actualPct * 10) / 10 : null }))
        }
        const [t, m] = await Promise.all([read(today), read(month)])
        // One company: its figure. Several: never blended — each company's own figure is listed.
        return { value: t.length === 1 ? t[0]!.value : null, monthToDate: m.length === 1 ? m[0]!.value : null, ...(t.length !== 1 && { breakdown: t }) }
      })
      const cashN = () => num({ key: 'cash_bank', label: 'Cash and bank', unit: 'pkr', href: '/accounting/trial-balance' }, true, async () => {
        const banks = await prisma.bankAccount.findMany({ where: { ...company, deletedAt: null }, select: { accountCode: true } })
        const codes = new Set(['1010', '1011', '1015', '1020', ...banks.map((b) => b.accountCode).filter((c): c is string => !!c)])
        const tb = await trialBalance(tenantIds, now)
        const value = tb.rows.filter((r) => codes.has(r.code)).reduce((s, r) => s + Number(r.debitCents) - Number(r.creditCents), 0)
        return { value }
      })
      const approvalsN = () => num({ key: 'approvals_waiting', label: 'Approvals waiting', unit: 'count', href: '/ceo/approvals' }, false, async () => {
        const headers: Record<string, string> = {}
        for (const h of ['authorization', 'cookie', 'x-servd-portfolio', 'x-servd-active-tenant']) {
          const v = req.headers[h]; if (typeof v === 'string' && v) headers[h] = v
        }
        const res = await fastify.inject({ method: 'GET', url: `${apiBase}/approvals/counts`, headers })
        if (res.statusCode >= 400) throw new Error(`approvals answered ${res.statusCode}`)
        return { value: (res.json() as { total: number }).total }
      })
      const openTicketsN = () => num({ key: 'open_tickets', label: 'Open tickets', unit: 'count', href: '/orders' }, false, async () => ({
        value: await prisma.order.count({ where: { ...orderOfCompany, status: { in: ['received', 'confirmed', 'preparing', 'ready'] } } }),
      }))
      const ticketTimeN = () => num({ key: 'ticket_time', label: 'Ticket time', unit: 'minutes', href: '/ops' }, false, async () => ({
        value: (await stationTimes(sq(today))).avgTicketMinutes,
      }))
      const lowStockN = () => num({ key: 'low_stock', label: 'Low stock items', unit: 'count', href: '/inventory' }, false, async () => ({
        value: (await reorderSuggestions(tenantIds)).length,
      }))
      const coversN = () => num({ key: 'covers', label: 'Covers today', unit: 'count', href: '/reports' }, false, async () => {
        const sum = async (r: { from: Date; to: Date }) =>
          (await prisma.order.aggregate({ where: soldOrderWhere(sq(r)), _sum: { partySize: true } }))._sum.partySize ?? 0
        const [t, m] = await Promise.all([sum(today), sum(month)])
        return { value: t, monthToDate: m }
      })
      const billsDueN = () => num({ key: 'bills_due', label: 'Bills due in 7 days', unit: 'pkr', href: '/procurement' }, true, async () => {
        const bills = await prisma.supplierBill.findMany({
          where: { kind: 'bill', status: { in: ['open', 'partially_paid'] }, dueDate: { lte: new Date(now.getTime() + 7 * 86_400_000) }, supplier: { ...company } },
          select: { totalCents: true, whtCents: true, paidCents: true },
        })
        const owed = bills.reduce((s, b) => s + Math.max(0, Number(b.totalCents) - Number(b.whtCents ?? 0) - Number(b.paidCents)), 0)
        return { value: owed, breakdown: [{ label: 'Bills', value: bills.length }] }
      })
      const heldFiscalN = () => num({ key: 'held_fiscal', label: 'Held tax documents', unit: 'count', href: '/connectors/pos' }, false, async () => ({
        value: await prisma.fiscalDocument.count({ where: { ...company, status: 'held' } }),
      }))
      const channelsN = () => num({ key: 'orders_by_channel', label: 'Orders by channel (month)', unit: 'count', href: '/reports' }, false, async () => {
        const rows = await salesByChannel(sq(month))
        return { value: rows.reduce((s, r) => s + r.orders, 0), breakdown: rows.map((r) => ({ label: r.source, value: r.orders })) }
      })
      const newCustomersN = () => num({ key: 'new_customers', label: 'New customers', unit: 'count', href: '/crm' }, false, async () => {
        // A customer is servd-wide: "new" for the company = their first order is in the period and one of the company's brands served them.
        const count = (r: { from: Date; to: Date }) => prisma.customer.count({
          where: { deletedAt: null, firstOrderAt: { gte: r.from, lte: r.to }, orders: { some: orderOfCompany } },
        })
        const [t, m] = await Promise.all([count(today), count(month)])
        return { value: t, monthToDate: m }
      })
      const reviewsN = () => num({ key: 'reviews', label: 'Reviews', unit: 'count', href: '/reviews' }, false, async () => {
        const where = (r: { from: Date; to: Date }) => ({ ...orderOfCompany, createdAt: { gte: r.from, lte: r.to } })
        const [t, m] = await Promise.all([prisma.orderReview.count({ where: where(today) }), prisma.orderReview.count({ where: where(month) })])
        return { value: t, monthToDate: m }
      })
      const complaintsN = () => num({ key: 'complaints', label: 'Open complaints', unit: 'count', href: '/complaints' }, false, async () => ({
        value: await prisma.orderComplaint.count({ where: { ...orderOfCompany, kind: 'complaint', status: { in: ['open'] } } }),
      }))
      // HR (per company, every row has tenantId)
      const headcountN = () => num({ key: 'headcount', label: 'Headcount', unit: 'count', href: '/hr/employees' }, false, async () => ({
        value: await prisma.hrEmployee.count({ where: { ...company, status: 'active' } }),
      }))
      const attendanceN = () => num({ key: 'attendance_today', label: 'Present today', unit: 'count', href: '/hr/attendance' }, false, async () => ({
        value: await prisma.hrRecord.count({ where: { ...company, section: 'attendance', status: ATTENDANCE_DAY_TAKEN, category: { in: ['present', 'late'] }, startDate: pktToday(now) } }),
      }))
      const leaveN = () => num({ key: 'leave_pending', label: 'Leave waiting', unit: 'count', href: '/hr/approvals' }, false, async () => ({
        value: await prisma.hrRecord.count({ where: { ...company, section: 'leave', status: 'submitted' } }),
      }))
      const docsN = () => num({ key: 'documents_expiring', label: 'Documents expiring in 30 days', unit: 'count', href: '/hr/documents' }, false, async () => ({
        value: await prisma.hrDocument.count({ where: { ...company, expiryDate: { not: null, lte: new Date(now.getTime() + 30 * 86_400_000) } } }),
      }))
      const payrollN = () => Promise.resolve(notAvailable(
        { key: 'payroll_vs_budget', label: 'Payroll vs budget', unit: 'pkr', href: '/hr/payroll' },
        'No payroll budget exists in servd yet — add one before this number can show.',
      ))

      const sets: Record<DashboardId, Array<() => Promise<DashboardNumber>>> = {
        ceo: [() => salesN('sales_by_brand', 'Sales by company and brand (today)', 'company'), () => foodCostN(), () => cashN(), () => approvalsN()],
        operations: [() => salesN('sales_by_brand', 'Sales by brand (today)', 'brand'), () => openTicketsN(), () => ticketTimeN(), () => lowStockN(), () => coversN()],
        finance: [() => salesN('sales', 'Sales (today)', 'none'), () => foodCostN(), () => cashN(), () => billsDueN(), () => heldFiscalN()],
        hr: [() => headcountN(), () => attendanceN(), () => leaveN(), () => payrollN(), () => docsN()],
        marketing: [() => channelsN(), () => newCustomersN(), () => reviewsN(), () => complaintsN()],
      }
      return {
        id,
        asOf: now.toISOString(),
        day: todayKey,
        companies: tenantIds.length,
        moneyHidden: !money,
        numbers: await Promise.all(sets[id].map((f) => f())),
      }
    },
  )
}
