import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { postJournalEntry } from './journal.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { resolveDateRange, parsePktEndOfDay, fmtPktDate } from './dates.js'
import { trialBalance, balanceSheet, profitAndLoss, pnlByConcept, cashFlow } from './reports.js'
import { salesTaxReturn } from './salesTaxReturn.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { toCsv, fmtPkr } from './csv.js'
import { audit } from '../../lib/audit.js'
import { ACCOUNTING_AUDIT_ROLES } from '../../lib/moduleAccess.js'

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
      // Optional brand attribution, so a manual adjustment can land on one
      // brand's P&L instead of the shared bucket.
      conceptId: z.string().uuid().nullable().optional(),
    }),
  ).min(2),
})

function sendCsv(reply: FastifyReply, filename: string, body: string) {
  reply.header('Content-Type', 'text/csv; charset=utf-8')
  reply.header('Content-Disposition', `attachment; filename="${filename}"`)
  return reply.send(body)
}

export async function accountingRoutes(fastify: FastifyInstance) {
  // ─── Ledger / journal entry feed ─────────────────────────────────────────

  // THE transaction feed: /accounting/ledger in admin, the Accounting hub's
  // activity links (?id=) and the CSV export. (/finance/ledger listed the
  // sales register to every manager tier and had no caller; the /finance
  // Transactions tab called a GET /accounting/entries that never existed.)
  fastify.get<{ Querystring: { id?: string; accountId?: string; dateFrom?: string; dateTo?: string; limit?: string; cursor?: string; format?: string } }>(
    '/ledger',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const { id, accountId, dateFrom, dateTo, limit: limitStr, cursor, format } = req.query
      const limit = Math.min(parseInt(limitStr ?? '50', 10), 1000)
      const { from, to } = resolveDateRange(dateFrom, dateTo)

      // The ledger is per company: single-company view shows that company's
      // books, "All companies" shows every company the operator belongs to.
      const scope = await resolveTenantScope(req)
      const entries = await prisma.journalEntry.findMany({
        where: {
          tenantId: { in: scope.tenantIds },
          // One entry (the activity feed's links) ignores the date window.
          ...(id
            ? { id }
            : {
                ...(accountId && { lines: { some: { accountId } } }),
                entryDate: { gte: from, lte: to },
              }),
        },
        include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } } },
        // Page by position in (entryDate, id) order. `id < cursor` paged on a
        // random uuid while sorting by date, so pages skipped and repeated.
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        ...(cursor && !id && { cursor: { id: cursor }, skip: 1 }),
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
  //
  // Posts through postJournalEntry like every other writer, so a manual entry
  // gets the same balance rule, the same period-lock check and message, the
  // same per-company chart resolution and an idempotency key of its own
  // (`manual:<uuid>`). It used to create the JournalEntry directly with a
  // copy of the lock check, and could not carry a brand, so every manual
  // adjustment landed in the shared bucket of the brand P&L.

  fastify.post('/journal', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = journalEntrySchema.parse(req.body)

    const debits = body.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const credits = body.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    if (debits !== credits) {
      return reply.status(422).send({
        error: { code: 'UNBALANCED_ENTRY', message: `Debits (${debits}) must equal credits (${credits})` },
      })
    }

    // A manual entry is posted into the company the operator is working in,
    // against that company's chart and its own period close.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — the ledger is per company', 422)

    // The client names accounts by id; the posting engine takes codes, which
    // it resolves again inside this company's chart.
    const accountIds = Array.from(new Set(body.lines.map((l) => l.accountId)))
    const accounts = await prisma.account.findMany({
      where: { id: { in: accountIds }, tenantId },
      select: { id: true, code: true, isActive: true },
    })
    if (accounts.length !== accountIds.length) {
      throw new AppError('ACCOUNT_NOT_IN_COMPANY', 'One or more accounts belong to another company', 422)
    }
    const inactive = accounts.filter((a) => !a.isActive).map((a) => a.code)
    if (inactive.length > 0) {
      throw new AppError('ACCOUNT_INACTIVE', `Account(s) ${inactive.join(', ')} are deactivated — reactivate them in Configuration → Chart of accounts first`, 422)
    }
    const codeOf = new Map(accounts.map((a) => [a.id, a.code]))

    // Brand attribution per line, optional. A brand must belong to the company
    // whose books this is (a create: the active company only).
    const conceptIds = Array.from(new Set(body.lines.map((l) => l.conceptId).filter((c): c is string => !!c)))
    if (conceptIds.length > 0) {
      const ownBrands = await prisma.concept.count({ where: { id: { in: conceptIds }, tenantId, deletedAt: null } })
      if (ownBrands !== conceptIds.length) {
        throw new AppError('BRAND_NOT_IN_COMPANY', 'A line names a brand that is not one of this company\'s brands', 422)
      }
    }

    const reference = body.reference?.trim() || null
    const posted = await postJournalEntry({
      tenantId,
      sourceType: 'manual',
      sourceId: randomUUID(),
      // JournalEntry.reference holds the idempotency key, so the operator's
      // own reference travels in the description (and the audit metadata).
      description: reference ? `${body.description} · ref ${reference}` : body.description,
      entryDate: body.entryDate ? new Date(body.entryDate) : new Date(),
      postedBy: req.staffUser!.id,
      lines: body.lines.map((l) => ({
        accountCode: codeOf.get(l.accountId)!,
        type: l.type,
        amountCents: l.amountCents,
        memo: l.memo,
        conceptId: l.conceptId ?? null,
      })),
    })

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: posted.entryId },
      include: { lines: { include: { account: true } } },
    })
    await audit({ category: 'accounting',
      action: 'journal.manual',
      entity: 'JournalEntry',
      entityId: entry.id,
      userId: req.staffUser!.id, tenantId: req.staffUser?.tenantId ?? null,
      userEmail: req.staffUser!.email,
      after: entry,
      metadata: { ip: req.ip, debits, credits, reference },
    })

    // Every manual JE is a high-trust action. The system fires a flag for
    // owner review — not because it's wrong, but because every single one
    // should have eyes on it. The resolution note is the owner's audit trail.
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      tenantId,
      kind: 'manual_journal',
      severity: debits >= 100000 ? 'high' : 'medium',           // PKR 1,000+ = high
      title: `Manual journal entry posted: ${body.description}`,
      description: `${req.staffUser!.email} posted a manual JE for PKR ${(debits / 100).toFixed(0)}. Reference: ${reference ?? 'none'}.`,
      entityType: 'JournalEntry',
      entityId: entry.id,
      actorId: req.staffUser!.id,
      amountCents: debits,
      metadata: { reference, debits, credits, lineCount: body.lines.length, ip: req.ip },
    })

    return reply.status(201).send(entry)
  })

  // The chart of accounts is read and edited through /setup/chart-of-accounts
  // (Configuration → Chart of accounts) — the one chart API.

  // ─── Trial balance ───────────────────────────────────────────────────────

  fastify.get<{ Querystring: { asOf?: string; format?: string } }>(
    '/trial-balance',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const asOf = req.query.asOf ? parsePktEndOfDay(req.query.asOf) : new Date()
      const report = await trialBalance((await resolveTenantScope(req)).tenantIds, asOf)

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
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const asOf = req.query.asOf ? parsePktEndOfDay(req.query.asOf) : new Date()
      const report = await balanceSheet((await resolveTenantScope(req)).tenantIds, asOf)

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
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      const report = await profitAndLoss((await resolveTenantScope(req)).tenantIds, from, to)

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

  // ─── P&L by brand (ledger-based) ─────────────────────────────────────────
  // The "By brand" tab of /accounting/pl-ledger (it replaces the /finance
  // "By Concept" tab, which summed the sales register). Straight from the
  // journal: each brand's MEASURED revenue, discounts/refunds, COGS and opex
  // from brand-tagged lines, plus the shared bucket (untagged lines —
  // overhead, manual entries, older postings) shown as its own row, never
  // spread across brands here.

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string; format?: string } }>(
    '/pl-ledger/brands',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      const tenantIds = (await resolveTenantScope(req)).tenantIds
      const [buckets, concepts] = await Promise.all([
        pnlByConcept(tenantIds, from, to),
        prisma.concept.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true, name: true, slug: true } }),
      ])
      const byId = new Map(concepts.map((c) => [c.id, c]))
      const row = (b: (typeof buckets)[number]) => {
        const netRevenueCents  = b.revenueCents - b.contraRevenueCents
        const grossProfitCents = netRevenueCents - b.cogsCents
        const netProfitCents   = grossProfitCents - b.opexCents
        return {
          conceptId: b.conceptId,
          name: b.conceptId ? (byId.get(b.conceptId)?.name ?? 'Unknown brand') : 'Shared / unallocated',
          slug: b.conceptId ? (byId.get(b.conceptId)?.slug ?? null) : null,
          revenueCents: b.revenueCents,
          contraRevenueCents: b.contraRevenueCents,
          netRevenueCents,
          cogsCents: b.cogsCents,
          grossProfitCents,
          opexCents: b.opexCents,
          netProfitCents,
          grossMarginPct: b.revenueCents > 0 ? Number(((grossProfitCents / b.revenueCents) * 100).toFixed(2)) : 0,
        }
      }
      const brands = buckets.filter((b) => b.conceptId).map(row).sort((a, b) => b.revenueCents - a.revenueCents)
      const sharedBucket = buckets.find((b) => !b.conceptId)
      const shared = sharedBucket ? row(sharedBucket) : null
      const all = [...brands, ...(shared ? [shared] : [])]
      const totals = all.reduce(
        (t, r) => ({
          revenueCents: t.revenueCents + r.revenueCents,
          contraRevenueCents: t.contraRevenueCents + r.contraRevenueCents,
          netRevenueCents: t.netRevenueCents + r.netRevenueCents,
          cogsCents: t.cogsCents + r.cogsCents,
          grossProfitCents: t.grossProfitCents + r.grossProfitCents,
          opexCents: t.opexCents + r.opexCents,
          netProfitCents: t.netProfitCents + r.netProfitCents,
        }),
        { revenueCents: 0, contraRevenueCents: 0, netRevenueCents: 0, cogsCents: 0, grossProfitCents: 0, opexCents: 0, netProfitCents: 0 },
      )
      const report = { dateFrom: fmtPktDate(from), dateTo: fmtPktDate(to), brands, shared, totals }

      if (req.query.format === 'csv') {
        const flat = [...all, { ...totals, name: 'TOTAL', grossMarginPct: '' }].map((r) => ({
          brand: r.name,
          revenue: fmtPkr(r.revenueCents),
          discountsRefunds: fmtPkr(r.contraRevenueCents),
          netRevenue: fmtPkr(r.netRevenueCents),
          cogs: fmtPkr(r.cogsCents),
          grossProfit: fmtPkr(r.grossProfitCents),
          opex: fmtPkr(r.opexCents),
          netProfit: fmtPkr(r.netProfitCents),
        }))
        return sendCsv(reply, `pl-by-brand-${report.dateFrom}-${report.dateTo}.csv`, toCsv(flat))
      }
      return report
    },
  )

  // ─── Cash flow ───────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string; format?: string } }>(
    '/cash-flow',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      const report = await cashFlow((await resolveTenantScope(req)).tenantIds, from, to)

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
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '30', 10), 100)
      const scope = await resolveTenantScope(req)
      // Audit rows: the BOOKS' trail only (category 'accounting'), of the
      // companies in view, and only for the roles allowed to read that trail
      // (ACCOUNTING_AUDIT_ROLES — the same gate as /accounting/audit-log,
      // where these rows link). This used to merge every company's identity
      // and accounting trail into the feed for every financials viewer.
      const canReadTrail = (ACCOUNTING_AUDIT_ROLES as string[]).includes(req.staffUser!.role)
      const [entries, audits, orders] = await Promise.all([
        prisma.journalEntry.findMany({
          where: { tenantId: { in: scope.tenantIds } },
          orderBy: { createdAt: 'desc' }, take: limit,
          select: { id: true, reference: true, description: true, createdAt: true, postedBy: true },
        }),
        canReadTrail
          ? prisma.auditLog.findMany({
              where: { category: 'accounting', tenantId: { in: scope.tenantIds } },
              orderBy: { createdAt: 'desc' }, take: limit,
              select: { id: true, action: true, entity: true, entityId: true, userEmail: true, createdAt: true },
            })
          : Promise.resolve([]),
        prisma.order.findMany({
          where: {
            deletedAt: null,
            status: { in: ['completed', 'refunded', 'cancelled'] },
            concept: { tenantId: { in: scope.tenantIds }, deletedAt: null },
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

  // The BOOKS' audit trail: period closes, manual journals, wage rates,
  // tip-pool postings, cost allocations. Its own module and its own role gate —
  // the CEO and the exec, and nobody else. Co-owners and finance can see the
  // numbers; this is the record of who MOVED them, which is what you read when
  // the person you doubt is one of those.
  //
  // It is also tenant-scoped. It used to return every company's rows to every
  // finance-tier role in either company — across a 60/40 JV with an outside
  // partner — while the sales-tax return twenty lines below was careful to file
  // for exactly one company.
  fastify.get<{ Querystring: { action?: string; entity?: string; userId?: string; limit?: string; cursor?: string } }>(
    '/audit-log',
    { preHandler: requireAuth(...ACCOUNTING_AUDIT_ROLES) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const scope = await resolveTenantScope(req)
      const rows = await prisma.auditLog.findMany({
        where: {
          category: 'accounting',
          // Rows written before the tenant column existed cannot be attributed
          // — the actor's current company is not necessarily the one they were
          // acting in. Only the CEO sees those, and only as history.
          ...(req.staffUser!.role === 'admin'
            ? { OR: [{ tenantId: { in: scope.tenantIds } }, { tenantId: null }] }
            : { tenantId: { in: scope.tenantIds } }),
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
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      // A sales-tax return is filed by ONE company — never a blend of two.
      const filingTenantId = req.staffUser!.tenantId
      if (!filingTenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company to file the return for', 422)
      const report = await salesTaxReturn(filingTenantId, from, to)

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
  //
  // THE one write path for period locks (the /setup/period-locks copy is
  // gone). A lock is a PKT end-of-day, only ever moves forward, and every
  // close and reopen is on the books' audit trail (category 'accounting').
  // Reopening (owner decision 21) is admin only, removes only the LATEST
  // lock, needs a reason, is audited and raises a high-severity exception.

  fastify.get('/period-close/history', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) return { locks: [] }
    const locks = await prisma.periodLock.findMany({
      where: { tenantId },
      orderBy: { lockedThrough: 'desc' },
      take: 60,
      select: { id: true, lockedThrough: true, lockedAt: true, lockedBy: true, note: true },
    })
    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(new Set(locks.map((l) => l.lockedBy))) } },
      select: { id: true, name: true, email: true },
    })
    const byId = new Map(users.map((u) => [u.id, u]))
    return {
      locks: locks.map((l) => ({
        ...l,
        lockedThroughLabel: fmtPktDate(l.lockedThrough),
        lockedByName: byId.get(l.lockedBy)?.name ?? byId.get(l.lockedBy)?.email ?? null,
      })),
    }
  })

  fastify.post('/period-close/reopen', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company — books are closed per company', 422)
    const latest = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' } })
    if (!latest) throw new AppError('NOTHING_TO_REOPEN', 'This company has no closed period', 422)
    await prisma.periodLock.delete({ where: { id: latest.id } })
    const now = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })

    await audit({ category: 'accounting',
      action: 'period.reopen',
      entity: 'PeriodLock',
      entityId: latest.id,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      before: latest,
      after: { lockedThrough: now?.lockedThrough ?? null },
      metadata: { reason: body.reason, ip: req.ip },
    })
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      tenantId,
      kind: 'period_reopened',
      severity: 'high',
      title: `Period reopened — books were closed through ${fmtPktDate(latest.lockedThrough)}`,
      description: `${req.staffUser!.email} reopened the books. Postings dated after ${now ? fmtPktDate(now.lockedThrough) : 'the start of the ledger'} are allowed again. Reason: ${body.reason}. Review any new entries before re-closing.`,
      entityType: 'PeriodLock',
      entityId: latest.id,
      actorId: req.staffUser!.id,
      metadata: { lockedThrough: latest.lockedThrough, originalLockedBy: latest.lockedBy, note: latest.note, reason: body.reason },
    })
    return { reopened: { lockedThrough: latest.lockedThrough }, lockedThrough: now?.lockedThrough ?? null }
  })

  fastify.get('/period-close', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    // Each company closes its own books, so this reports the ACTIVE company's
    // close — a lock elsewhere never shows here.
    const lock = await prisma.periodLock.findFirst({
      where: { tenantId: req.staffUser!.tenantId },
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

    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company — books are closed per company', 422)

    const newLock = parsePktEndOfDay(body.lockedThrough)
    const existing = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' } })
    if (existing && newLock <= existing.lockedThrough) {
      throw new AppError(
        'LOCK_CANNOT_REGRESS',
        `Period is already locked through ${fmtPktDate(existing.lockedThrough)}. Lock dates can only move forward.`,
        422,
      )
    }

    const created = await prisma.periodLock.create({
      data: {
        tenantId,
        lockedThrough: newLock,
        lockedBy: req.staffUser!.id,
        note: body.note ?? null,
      },
    })
    await audit({ category: 'accounting',
      action: 'period.close',
      entity: 'PeriodLock',
      entityId: created.id,
      userId: req.staffUser!.id, tenantId: req.staffUser?.tenantId ?? null,
      userEmail: req.staffUser!.email,
      before: existing,
      after: created,
      metadata: { ip: req.ip },
    })
    return reply.status(201).send(created)
  })
}
