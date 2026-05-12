import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { resolveDateRange, parsePktEndOfDay, fmtPktDate } from './dates.js'
import { trialBalance, balanceSheet, profitAndLoss, cashFlow } from './reports.js'
import { salesTaxReturn } from './salesTaxReturn.js'
import { toCsv, fmtPkr } from './csv.js'
import { audit } from '../../lib/audit.js'

const journalEntrySchema = z.object({
  reference: z.string().optional(),
  description: z.string().min(1),
  entryDate: z.string().datetime().optional(),
  lines: z.array(
    z.object({
      accountId: z.string().uuid(),
      type: z.enum(['debit', 'credit']),
      amountCents: z.number().int().min(1),
      memo: z.string().optional(),
    }),
  ).min(2),
})

function sendCsv(reply: FastifyReply, filename: string, body: string) {
  reply.header('Content-Type', 'text/csv; charset=utf-8')
  reply.header('Content-Disposition', `attachment; filename="${filename}"`)
  return reply.send(body)
}

export async function accountingRoutes(fastify: FastifyInstance) {
  // ─── Legacy P&L (FinancialEntry-based, retained for current dashboards) ──

  fastify.get<{
    Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; period?: string }
  }>('/pl', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { conceptId, dateFrom, dateTo } = req.query

    const defaultFrom = new Date(Date.now() - 90 * 86_400_000)
    const from = dateFrom ? new Date(dateFrom) : defaultFrom
    const to = dateTo ? new Date(dateTo) : undefined

    const entries = await prisma.financialEntry.findMany({
      where: {
        ...(conceptId && { conceptId }),
        // Scope to active tenant via concept relation
        concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        entryDate: { gte: from, ...(to && { lte: to }) },
      },
      include: { concept: { select: { name: true, slug: true } } },
    })

    const byConceptMap = new Map<string, {
      conceptName: string
      gross: number; commission: number; discount: number; tax: number; net: number; orders: number
    }>()
    for (const entry of entries) {
      const key = entry.conceptId
      const existing = byConceptMap.get(key)
      if (existing) {
        existing.gross += entry.grossCents
        existing.commission += entry.commissionCents
        existing.discount += entry.discountCents
        existing.tax += entry.taxCents
        existing.net += entry.netCents
        existing.orders += 1
      } else {
        byConceptMap.set(key, {
          conceptName: entry.concept.name,
          gross: entry.grossCents, commission: entry.commissionCents,
          discount: entry.discountCents, tax: entry.taxCents,
          net: entry.netCents, orders: 1,
        })
      }
    }

    const byConcept = Object.fromEntries(byConceptMap)
    const totals = {
      gross: entries.reduce((s, e) => s + e.grossCents, 0),
      commission: entries.reduce((s, e) => s + e.commissionCents, 0),
      discount: entries.reduce((s, e) => s + e.discountCents, 0),
      tax: entries.reduce((s, e) => s + e.taxCents, 0),
      net: entries.reduce((s, e) => s + e.netCents, 0),
      orders: entries.length,
    }
    return { byConcept, totals, dateFrom, dateTo }
  })

  // ─── Ledger / journal entry feed ─────────────────────────────────────────

  fastify.get<{ Querystring: { accountId?: string; dateFrom?: string; dateTo?: string; limit?: string; cursor?: string; format?: string } }>(
    '/ledger',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { accountId, dateFrom, dateTo, limit: limitStr, cursor, format } = req.query
      const limit = Math.min(parseInt(limitStr ?? '50', 10), 1000)
      const { from, to } = resolveDateRange(dateFrom, dateTo)

      const entries = await prisma.journalEntry.findMany({
        where: {
          ...(accountId && { lines: { some: { accountId } } }),
          entryDate: { gte: from, lte: to },
          ...(cursor && { id: { lt: cursor } }),
        },
        include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } } },
        orderBy: { entryDate: 'desc' },
        take: limit + 1,
      })

      const hasMore = entries.length > limit
      if (hasMore) entries.pop()

      if (format === 'csv') {
        const flat: Array<Record<string, string | number>> = []
        for (const e of entries) {
          for (const l of e.lines) {
            flat.push({
              date: fmtPktDate(e.entryDate),
              entry: e.description,
              reference: e.reference ?? '',
              accountCode: l.account.code,
              accountName: l.account.name,
              debit:  l.type === 'debit'  ? fmtPkr(l.amountCents) : '',
              credit: l.type === 'credit' ? fmtPkr(l.amountCents) : '',
              memo: l.memo ?? '',
            })
          }
        }
        return sendCsv(reply, `ledger-${fmtPktDate(from)}-${fmtPktDate(to)}.csv`, toCsv(flat))
      }

      return { data: entries, cursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null, hasMore }
    },
  )

  // ─── Manual journal entry (admin) ────────────────────────────────────────

  fastify.post('/journal', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = journalEntrySchema.parse(req.body)

    const debits = body.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const credits = body.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    if (debits !== credits) {
      return reply.status(422).send({
        error: { code: 'UNBALANCED_ENTRY', message: `Debits (${debits}) must equal credits (${credits})` },
      })
    }

    // Period-lock check
    const entryDate = body.entryDate ? new Date(body.entryDate) : new Date()
    const lock = await prisma.periodLock.findFirst({ orderBy: { lockedThrough: 'desc' } })
    if (lock && entryDate <= lock.lockedThrough) {
      throw new AppError(
        'PERIOD_LOCKED',
        `Books are closed through ${fmtPktDate(lock.lockedThrough)}. Adjust in the open period.`,
        422,
      )
    }

    const entry = await prisma.journalEntry.create({
      data: {
        reference: body.reference,
        description: body.description,
        entryDate,
        postedBy: req.staffUser!.id,
        lines: { create: body.lines },
      },
      include: { lines: { include: { account: true } } },
    })
    await audit({
      action: 'journal.manual',
      entity: 'JournalEntry',
      entityId: entry.id,
      userId: req.staffUser!.id,
      userEmail: req.staffUser!.email,
      after: entry,
      metadata: { ip: req.ip, debits, credits },
    })

    // Every manual JE is a high-trust action. The system fires a flag for
    // owner review — not because it's wrong, but because every single one
    // should have eyes on it. The resolution note is the owner's audit trail.
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      kind: 'manual_journal',
      severity: debits >= 100000 ? 'high' : 'medium',           // PKR 1,000+ = high
      title: `Manual journal entry posted: ${body.description}`,
      description: `${req.staffUser!.email} posted a manual JE for PKR ${(debits / 100).toFixed(0)}. Reference: ${body.reference}.`,
      entityType: 'JournalEntry',
      entityId: entry.id,
      actorId: req.staffUser!.id,
      amountCents: debits,
      metadata: { reference: body.reference, debits, credits, lineCount: body.lines.length, ip: req.ip },
    })

    return reply.status(201).send(entry)
  })

  // ─── Chart of accounts ───────────────────────────────────────────────────

  fastify.get('/accounts', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.account.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } })
  })

  // ─── Trial balance ───────────────────────────────────────────────────────

  fastify.get<{ Querystring: { asOf?: string; format?: string } }>(
    '/trial-balance',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const asOf = req.query.asOf ? parsePktEndOfDay(req.query.asOf) : new Date()
      const report = await trialBalance(asOf)

      if (req.query.format === 'csv') {
        const rows = report.rows.map((r) => ({
          code: r.code, account: r.name, type: r.type,
          debit: fmtPkr(r.debitCents), credit: fmtPkr(r.creditCents),
        }))
        rows.push({
          code: '', account: 'TOTAL', type: 'asset',
          debit: fmtPkr(report.totals.debitCents), credit: fmtPkr(report.totals.creditCents),
        })
        return sendCsv(reply, `trial-balance-${report.asOf}.csv`, toCsv(rows))
      }
      return report
    },
  )

  // ─── Balance sheet ───────────────────────────────────────────────────────

  fastify.get<{ Querystring: { asOf?: string; format?: string } }>(
    '/balance-sheet',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const asOf = req.query.asOf ? parsePktEndOfDay(req.query.asOf) : new Date()
      const report = await balanceSheet(asOf)

      if (req.query.format === 'csv') {
        const flat: Array<Record<string, string | number>> = []
        for (const a of report.assets)      flat.push({ section: 'Assets',      code: a.code, name: a.name, balance: fmtPkr(a.balanceCents) })
        flat.push({ section: 'Assets',      code: '', name: 'TOTAL ASSETS', balance: fmtPkr(report.totals.assetsCents) })
        for (const l of report.liabilities) flat.push({ section: 'Liabilities', code: l.code, name: l.name, balance: fmtPkr(l.balanceCents) })
        flat.push({ section: 'Liabilities', code: '', name: 'TOTAL LIABILITIES', balance: fmtPkr(report.totals.liabilitiesCents) })
        for (const e of report.equity)      flat.push({ section: 'Equity',      code: e.code, name: e.name, balance: fmtPkr(e.balanceCents) })
        flat.push({ section: 'Equity',      code: '', name: 'Current Period Earnings', balance: fmtPkr(report.totals.currentEarningsCents) })
        flat.push({ section: 'Equity',      code: '', name: 'TOTAL EQUITY', balance: fmtPkr(report.totals.equityCents + report.totals.currentEarningsCents) })
        return sendCsv(reply, `balance-sheet-${report.asOf}.csv`, toCsv(flat))
      }
      return report
    },
  )

  // ─── Profit & loss (ledger-based) ────────────────────────────────────────

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string; format?: string } }>(
    '/pl-ledger',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      const report = await profitAndLoss(from, to)

      if (req.query.format === 'csv') {
        const flat: Array<Record<string, string | number>> = []
        for (const r of report.revenue)       flat.push({ section: 'Revenue', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
        flat.push({ section: 'Revenue', code: '', name: 'TOTAL REVENUE', amount: fmtPkr(report.totals.revenueCents) })
        for (const r of report.contraRevenue) flat.push({ section: 'Discounts/Refunds', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
        for (const r of report.cogs)          flat.push({ section: 'COGS', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
        flat.push({ section: 'COGS', code: '', name: 'TOTAL COGS', amount: fmtPkr(report.totals.cogsCents) })
        flat.push({ section: 'Margin', code: '', name: 'GROSS PROFIT', amount: fmtPkr(report.totals.grossProfitCents) })
        flat.push({ section: 'Margin', code: '', name: 'GROSS MARGIN %', amount: report.totals.grossMarginPct })
        for (const r of report.opex)          flat.push({ section: 'OpEx', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
        flat.push({ section: 'OpEx', code: '', name: 'TOTAL OPEX', amount: fmtPkr(report.totals.opexCents) })
        flat.push({ section: 'Result', code: '', name: 'NET PROFIT', amount: fmtPkr(report.totals.netProfitCents) })
        return sendCsv(reply, `pl-${report.dateFrom}-${report.dateTo}.csv`, toCsv(flat))
      }
      return report
    },
  )

  // ─── Cash flow ───────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string; format?: string } }>(
    '/cash-flow',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      const report = await cashFlow(from, to)

      if (req.query.format === 'csv') {
        const flat: Array<Record<string, string | number>> = []
        for (const a of report.byCashAccount) flat.push({ section: 'By account', code: a.code, name: a.name, inflow: fmtPkr(a.inflowCents), outflow: fmtPkr(a.outflowCents), net: fmtPkr(a.netCents) })
        for (const c of report.byCategory)    flat.push({ section: 'By category', code: '', name: c.category, inflow: fmtPkr(c.inflowCents), outflow: fmtPkr(c.outflowCents), net: fmtPkr(c.netCents) })
        flat.push({ section: 'Total', code: '', name: 'NET CHANGE IN CASH', inflow: fmtPkr(report.totals.inflowCents), outflow: fmtPkr(report.totals.outflowCents), net: fmtPkr(report.totals.netCents) })
        return sendCsv(reply, `cash-flow-${report.dateFrom}-${report.dateTo}.csv`, toCsv(flat))
      }
      return report
    },
  )

  // ─── Activity feed (mixed timeline) ──────────────────────────────────────
  // Consolidates recent journal entries, audit-log mutations, and orders into
  // one chronological feed for the dashboard widget.

  fastify.get<{ Querystring: { limit?: string } }>(
    '/activity-feed',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '30', 10), 100)
      const [entries, audits, orders] = await Promise.all([
        prisma.journalEntry.findMany({
          orderBy: { createdAt: 'desc' }, take: limit,
          select: { id: true, reference: true, description: true, createdAt: true, postedBy: true },
        }),
        prisma.auditLog.findMany({
          orderBy: { createdAt: 'desc' }, take: limit,
          select: { id: true, action: true, entity: true, entityId: true, userEmail: true, createdAt: true },
        }),
        prisma.order.findMany({
          where: {
            deletedAt: null,
            status: { in: ['completed', 'refunded', 'cancelled'] },
            concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
          },
          orderBy: { completedAt: 'desc' }, take: limit,
          select: {
            id: true, status: true, totalCents: true, completedAt: true, placedAt: true,
            concept: { select: { name: true, slug: true } },
          },
        }),
      ])

      type FeedItem = { kind: 'journal' | 'audit' | 'order'; ts: string; payload: unknown }
      const merged: FeedItem[] = [
        ...entries.map((e) => ({ kind: 'journal' as const, ts: e.createdAt.toISOString(), payload: e })),
        ...audits.map((a)  => ({ kind: 'audit'   as const, ts: a.createdAt.toISOString(), payload: a })),
        ...orders.map((o)  => ({ kind: 'order'   as const, ts: (o.completedAt ?? o.placedAt).toISOString(), payload: o })),
      ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, limit)

      return { feed: merged }
    },
  )

  // ─── Audit log viewer ────────────────────────────────────────────────────

  fastify.get<{ Querystring: { action?: string; entity?: string; userId?: string; limit?: string; cursor?: string } }>(
    '/audit-log',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const rows = await prisma.auditLog.findMany({
        where: {
          ...(req.query.action && { action: { startsWith: req.query.action } }),
          ...(req.query.entity && { entity: req.query.entity }),
          ...(req.query.userId && { userId: req.query.userId }),
          ...(req.query.cursor && { id: { lt: req.query.cursor } }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      })
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return { data: rows, cursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null, hasMore }
    },
  )

  // ─── Sales tax return ────────────────────────────────────────────────────

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string; format?: string } }>(
    '/sales-tax-return',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      const report = await salesTaxReturn(from, to)

      if (req.query.format === 'csv') {
        const flat: Array<Record<string, string | number>> = []
        flat.push({ section: 'Period',     code: '',                       name: 'From',    value: report.period.from })
        flat.push({ section: 'Period',     code: '',                       name: 'To',      value: report.period.to })
        flat.push({ section: 'Output Tax', code: report.outputTax.fbr.code,  name: report.outputTax.fbr.name,  value: fmtPkr(report.outputTax.fbr.totalCents) })
        flat.push({ section: 'Output Tax', code: report.outputTax.pra.code,  name: report.outputTax.pra.name,  value: fmtPkr(report.outputTax.pra.totalCents) })
        flat.push({ section: 'Output Tax', code: report.outputTax.srb.code,  name: report.outputTax.srb.name,  value: fmtPkr(report.outputTax.srb.totalCents) })
        flat.push({ section: 'Output Tax', code: report.outputTax.kpra.code, name: report.outputTax.kpra.name, value: fmtPkr(report.outputTax.kpra.totalCents) })
        flat.push({ section: 'Output Tax', code: report.outputTax.bra.code,  name: report.outputTax.bra.name,  value: fmtPkr(report.outputTax.bra.totalCents) })
        flat.push({ section: 'Output Tax', code: '',                          name: 'TOTAL OUTPUT TAX', value: fmtPkr(report.outputTax.totalCents) })
        flat.push({ section: 'Input Tax',  code: report.inputTax.fbr.code,   name: report.inputTax.fbr.name,   value: fmtPkr(report.inputTax.fbr.totalCents) })
        flat.push({ section: 'Input Tax',  code: report.inputTax.pra.code,   name: report.inputTax.pra.name,   value: fmtPkr(report.inputTax.pra.totalCents) })
        flat.push({ section: 'Input Tax',  code: report.inputTax.srb.code,   name: report.inputTax.srb.name,   value: fmtPkr(report.inputTax.srb.totalCents) })
        flat.push({ section: 'Input Tax',  code: report.inputTax.kpra.code,  name: report.inputTax.kpra.name,  value: fmtPkr(report.inputTax.kpra.totalCents) })
        flat.push({ section: 'Input Tax',  code: report.inputTax.bra.code,   name: report.inputTax.bra.name,   value: fmtPkr(report.inputTax.bra.totalCents) })
        flat.push({ section: 'Input Tax',  code: '',                          name: 'TOTAL INPUT TAX',  value: fmtPkr(report.inputTax.totalCents) })
        flat.push({ section: 'Sales',      code: '',                          name: 'Total taxable sales', value: fmtPkr(report.taxableSalesCents) })
        for (const c of report.taxableValueByConceptCents) {
          flat.push({ section: 'Sales',    code: c.conceptSlug,                name: c.conceptName,         value: fmtPkr(c.revenueCents) })
        }
        flat.push({ section: 'Result',     code: '',                          name: 'NET PAYABLE / (REFUND)', value: fmtPkr(report.netPayableCents) })
        return sendCsv(reply, `sales-tax-return-${report.period.from}-${report.period.to}.csv`, toCsv(flat))
      }
      return report
    },
  )

  // ─── Period close ────────────────────────────────────────────────────────

  fastify.get('/period-close', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const lock = await prisma.periodLock.findFirst({
      orderBy: { lockedThrough: 'desc' },
      select: { lockedThrough: true, lockedAt: true, lockedBy: true, note: true },
    })
    return { lockedThrough: lock?.lockedThrough ?? null, lockedAt: lock?.lockedAt ?? null, lockedBy: lock?.lockedBy ?? null, note: lock?.note ?? null }
  })

  fastify.post('/period-close', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      lockedThrough: z.string(),
      note: z.string().optional(),
    }).parse(req.body)

    const newLock = parsePktEndOfDay(body.lockedThrough)
    const existing = await prisma.periodLock.findFirst({ orderBy: { lockedThrough: 'desc' } })
    if (existing && newLock <= existing.lockedThrough) {
      throw new AppError(
        'LOCK_CANNOT_REGRESS',
        `Period is already locked through ${fmtPktDate(existing.lockedThrough)}. Lock dates can only move forward.`,
        422,
      )
    }

    const created = await prisma.periodLock.create({
      data: {
        lockedThrough: newLock,
        lockedBy: req.staffUser!.id,
        note: body.note ?? null,
      },
    })
    await audit({
      action: 'period.close',
      entity: 'PeriodLock',
      entityId: created.id,
      userId: req.staffUser!.id,
      userEmail: req.staffUser!.email,
      before: existing,
      after: created,
      metadata: { ip: req.ip },
    })
    return reply.status(201).send(created)
  })
}
