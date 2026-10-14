import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { postJournalEntry, reverseJournalEntry } from './journal.js'
import { requireAuth, FINANCIALS_VIEWERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { resolveDateRange, parsePktEndOfDay, fmtPktDate, pktToday } from './dates.js'
import { trialBalance, balanceSheet, profitAndLoss, pnlByConcept, cashFlow } from './reports.js'
import { closeChecklist, isOverridableKey } from './closeChecks.js'
import type { CloseProblem } from './closeCheckTypes.js'
import { fiscalYearsFor, fiscalYearOf, fiscalYearEndMonthOf, closedAcrossYearEnd } from './fiscalYear.js'
import { chargeForClose } from '../fixedAssets/closeCheck.js'
import { salesTaxReturn, taxPaymentsFor } from './salesTaxReturn.js'
import {
  TAX_PAYMENT_AUTHORITIES, TAX_PAYMENT_METHODS, TAX_PAYER_ROLES, monthPeriod,
  recordTaxPayment, linkTaxPayment, linkCandidates, voidTaxPayment, postTaxReclass,
} from './taxPayments.js'
import type { Prisma, UserRole } from '@prisma/client'
import { resolveTenantScope, scopeTenantWhere, activeTenantId } from '../../lib/tenantScope.js'
import { toCsv, fmtPkr } from './csv.js'
import { audit } from '../../lib/audit.js'
import { ACCOUNTING_AUDIT_ROLES } from '../../lib/moduleAccess.js'
import { toCents, zMoneyCents } from '../../lib/money.js'

const journalEntrySchema = z.object({
  reference: z.string().optional(),
  description: z.string().min(1),
  entryDate: z.string().datetime().optional(),
  lines: z.array(
    z.object({
      accountId: z.string().uuid(),
      type: z.enum(['debit', 'credit']),
      // One line ≤ MAX_MONEY_CENTS (PKR 900bn), else 422 AMOUNT_TOO_LARGE.
      amountCents: zMoneyCents('A journal line', { sign: 'positive' }),
      memo: z.string().optional(),
      // Optional brand attribution, so a manual adjustment can land on one
      // brand's P&L instead of the shared bucket.
      conceptId: z.string().uuid().nullable().optional(),
    }),
  ).min(2),
  // A line on a fixed-asset register account (1500–1599, 2012) needs the
  // CEO's reason; the entry is then audited and flagged
  // fixed_asset_gl_mismatch so the register tie-out explains it. The reason's
  // length is checked by the posting engine (422 REGISTER_CONTROLLED_ACCOUNT).
  registerOverride: z.object({ reason: z.string().trim().max(500) }).optional(),
})

// Manual journal entries carry `manual:<uuid>`; their reversal (posted by
// reverseJournalEntry) carries `manual.reversal:<uuid>`.
const MANUAL_PREFIX = 'manual:'
const MANUAL_REVERSAL_PREFIX = 'manual.reversal:'

// Who records tax paid to the authorities, links entries and posts the
// 2030 reclass: finance and the CEO (finance gap 6) — taxPayments.ts holds
// the one list. Inside the /accounting module gate like every route here.
const TAX_PAYERS = [...TAX_PAYER_ROLES] as UserRole[]

const reverseSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  // Date of the reversing entry; defaults to now. The original may sit in a
  // closed month — the reversal is dated in the open period.
  entryDate: z.string().datetime().optional(),
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
  fastify.get<{ Querystring: { id?: string; accountId?: string; source?: string; dateFrom?: string; dateTo?: string; limit?: string; cursor?: string; format?: string } }>(
    '/ledger',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const { id, accountId, source, dateFrom, dateTo, limit: limitStr, cursor, format } = req.query
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
                // source=manual: the manual journal entries and their
                // reversals (the Journal entry page's list).
                ...(source === 'manual' && {
                  OR: [{ reference: { startsWith: MANUAL_PREFIX } }, { reference: { startsWith: MANUAL_REVERSAL_PREFIX } }],
                }),
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
              debit:  l.type === 'debit'  ? fmtPkr(toCents(l.amountCents)) : '',
              credit: l.type === 'credit' ? fmtPkr(toCents(l.amountCents)) : '',
              memo: l.memo ?? '',
            })
          }
        }
        return sendCsv(reply, `ledger-${fmtPktDate(from)}-${fmtPktDate(to)}.csv`, toCsv(flat))
      }

      // A manual entry says whether it has been reversed (and by which entry),
      // wherever the reversal is dated — so the page offers "Reverse" only
      // where it can still work.
      const manualIds = entries
        .filter((e) => e.tenantId && e.reference?.startsWith(MANUAL_PREFIX))
        .map((e) => ({ tenantId: e.tenantId!, ref: `${MANUAL_REVERSAL_PREFIX}${e.reference!.slice(MANUAL_PREFIX.length)}` }))
      const reversals = manualIds.length === 0 ? [] : await prisma.journalEntry.findMany({
        where: { OR: manualIds.map((m) => ({ tenantId: m.tenantId, reference: m.ref })) },
        select: { id: true, tenantId: true, reference: true, entryDate: true },
      })
      const reversalOf = new Map(reversals.map((r) => [`${r.tenantId}|${r.reference}`, { id: r.id, entryDate: r.entryDate }]))
      const data = entries.map((e) => ({
        ...e,
        reversedBy: e.tenantId && e.reference?.startsWith(MANUAL_PREFIX)
          ? (reversalOf.get(`${e.tenantId}|${MANUAL_REVERSAL_PREFIX}${e.reference.slice(MANUAL_PREFIX.length)}`) ?? null)
          : null,
      }))

      return { data, cursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null, hasMore }
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

    const debits =body.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
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
    const registerReason = body.registerOverride?.reason?.trim() || null
    const posted = await postJournalEntry({
      ...(registerReason ? { controlledOverride: { reason: registerReason } } : {}),
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
    // A register account posted to by hand (the engine let it through only
    // with the reason): on the trail and in the inbox, so the register's
    // tie-out explains the difference.
    const registerLines = entry.lines.filter((l) => l.account.controlledBy === 'fixed_asset')
    if (registerReason && registerLines.length > 0) {
      const codes = Array.from(new Set(registerLines.map((l) => l.account.code))).sort()
      const registerCents = registerLines.reduce((s, l) => s + toCents(l.amountCents), 0)
      await audit({ category: 'accounting',
        action: 'journal.register_override',
        entity: 'JournalEntry',
        entityId: entry.id,
        userId: req.staffUser!.id, tenantId,
        userEmail: req.staffUser!.email,
        after: { codes, amountCents: registerCents },
        metadata: { ip: req.ip, reason: registerReason, reference },
      })
      const { flagException } = await import('../../lib/exceptions.js')
      await flagException({
        tenantId,
        kind: 'fixed_asset_gl_mismatch',
        severity: 'high',
        title: `Fixed-asset account${codes.length === 1 ? '' : 's'} ${codes.join(', ')} posted to by hand`,
        description: `${req.staffUser!.email} posted a manual journal to the fixed-asset register's account${codes.length === 1 ? '' : 's'} (${codes.join(', ')}) for PKR ${(registerCents / 100).toFixed(0)}. `
          + `Reason: ${registerReason}. The register no longer ties to the ledger by this amount until it is matched by a register event or reversed.`,
        entityType: 'JournalEntry',
        entityId: entry.id,
        actorId: req.staffUser!.id,
        amountCents: registerCents,
        metadata: { codes, reason: registerReason, reference },
      })
    }

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

  // ─── Reverse a manual journal entry (admin) ─────────────────────────────
  //
  // The ledger is append-only: a wrong manual entry is undone by a REVERSING
  // entry (every line flipped), never by a delete, through reverseJournalEntry
  // — the same balance rule, period-lock check and per-company chart as every
  // other posting. Same role as posting a manual entry.
  //
  //   • Company: the entry's own. An entry of a company the operator is not a
  //     member of is 404 — it does not confirm the id exists.
  //   • Manual entries only. An order, shift, bill or payroll posting belongs
  //     to its source document and is corrected there (refund, void the bill,
  //     …); reversing it by hand would leave the document and the books
  //     disagreeing, and the document's own reversal would then double it.
  //   • Once. A second reversal is refused (409), and concurrent requests are
  //     serialised on the entry so two clicks cannot post two reversals.
  //   • Reason required; on the accounting trail and in the Exceptions inbox,
  //     like the manual entry itself.
  fastify.post<{ Params: { id: string } }>('/journal/:id/reverse', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = reverseSchema.parse(req.body ?? {})

    const original = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      include: { lines: { include: { account: { select: { code: true, name: true, isActive: true } } } } },
    })
    if (!original || !original.tenantId) throw new NotFoundError('JournalEntry', req.params.id)
    const tenantId = original.tenantId
    if (!original.reference?.startsWith(MANUAL_PREFIX)) {
      throw new AppError(
        'NOT_A_MANUAL_ENTRY',
        original.reference?.startsWith(MANUAL_REVERSAL_PREFIX)
          ? 'This entry is itself a reversal — post a new manual entry instead of reversing it.'
          : 'Only manual journal entries can be reversed here. This entry was posted by its source document — correct it there (refund the order, void the bill, …).',
        422,
      )
    }
    const inactive = Array.from(new Set(original.lines.filter((l) => !l.account.isActive).map((l) => l.account.code)))
    if (inactive.length > 0) {
      throw new AppError('ACCOUNT_INACTIVE', `Account(s) ${inactive.join(', ')} are deactivated — reactivate them in Configuration → Chart of accounts first`, 422)
    }
    // A manual entry linked to the sales-tax return as a tax payment is that
    // payment: reversing it underneath the link would leave the return
    // counting a payment that no longer exists (and its reversal as output).
    const linkedPayment = await prisma.salesTaxPayment.findFirst({
      where: { tenantId, journalEntryId: original.id, linked: true },
      select: { id: true },
    })
    if (linkedPayment) {
      throw new AppError('TAX_PAYMENT_LINKED', 'This entry is linked to the sales-tax return as a tax payment — unlink it there first, then reverse it.', 409)
    }
    const sourceId = original.reference.slice(MANUAL_PREFIX.length)
    const reversalRef = `${MANUAL_REVERSAL_PREFIX}${sourceId}`

    const result = await prisma.$transaction(async (tx) => {
      // One reversal per entry, even under a double click.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal.reverse:${tenantId}:${original.reference}`}))`
      const already = await tx.journalEntry.findFirst({ where: { tenantId, reference: reversalRef }, select: { id: true, entryDate: true } })
      if (already) {
        throw new AppError('ALREADY_REVERSED', `This entry was already reversed on ${fmtPktDate(already.entryDate)} (entry ${already.id.slice(0, 8)}).`, 409)
      }
      return reverseJournalEntry(tenantId, 'manual', sourceId, body.reason, {
        tx,
        postedBy: req.staffUser!.id,
        entryDate: body.entryDate ? new Date(body.entryDate) : new Date(),
      })
    })
    if (!result.posted) {
      throw new AppError('ALREADY_REVERSED', 'This entry was already reversed.', 409)
    }

    const reversal = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.entryId },
      include: { lines: { include: { account: true } } },
    })
    const amountCents = reversal.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + toCents(l.amountCents), 0)
    await audit({ category: 'accounting',
      action: 'journal.reverse',
      entity: 'JournalEntry',
      entityId: reversal.id,
      // The books this touched — the entry's company, which may not be the
      // operator's active one.
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      before: original,
      after: reversal,
      metadata: { ip: req.ip, reason: body.reason, reversedEntryId: original.id, amountCents },
    })
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      tenantId,
      kind: 'manual_journal',
      severity: amountCents >= 100000 ? 'high' : 'medium',
      title: `Manual journal entry reversed: ${original.description}`,
      description: `${req.staffUser!.email} reversed a manual JE of PKR ${(amountCents / 100).toFixed(0)}. Reason: ${body.reason}.`,
      entityType: 'JournalEntry',
      entityId: reversal.id,
      actorId: req.staffUser!.id,
      amountCents,
      metadata: { reversedEntryId: original.id, reason: body.reason, ip: req.ip, amountCents },
    })

    return reply.status(201).send({ ...reversal, reverses: { id: original.id, reference: original.reference } })
  })

  // The chart of accounts is read and edited through /setup/chart-of-accounts
  // (Configuration → Chart of accounts) — the one chart API.

  // ─── Trial balance ───────────────────────────────────────────────────────

  // ?basis=inception (default — every account since the first entry) or
  // ?basis=year (P&L accounts from each company's fiscal-year start plus one
  // computed 'Retained earnings b/f' row per company; still balances). The
  // admin page asks for 'year'.
  fastify.get<{ Querystring: { asOf?: string; format?: string; basis?: string } }>(
    '/trial-balance',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const asOf = req.query.asOf ? parsePktEndOfDay(req.query.asOf) : new Date()
      const basis = z.enum(['inception', 'year']).default('inception').parse(req.query.basis || undefined)
      const report = await trialBalance((await resolveTenantScope(req)).tenantIds, asOf, { basis })

      if (req.query.format === 'csv') {
        // "All companies": every row names its company, and each company's
        // own total follows the grand total.
        const multi = report.companies.length > 1
        const rows: Array<Record<string, string | number>> = report.rows.map((r) => ({
          ...(multi && { company: r.companyName ?? '' }),
          code: r.code, account: r.virtual ? `${r.name} (computed)` : r.name, type: r.type,
          debit: fmtPkr(r.debitCents), credit: fmtPkr(r.creditCents),
        }))
        rows.push({
          ...(multi && { company: '' }),
          code: '', account: 'TOTAL', type: '',
          debit: fmtPkr(report.totals.debitCents), credit: fmtPkr(report.totals.creditCents),
        })
        if (multi) {
          for (const c of report.companyTotals) {
            rows.push({ company: c.name, code: '', account: 'COMPANY TOTAL', type: '', debit: fmtPkr(c.debitCents), credit: fmtPkr(c.creditCents) })
          }
        }
        return sendCsv(reply, `trial-balance-${report.basis === 'year' ? 'year-' : ''}${report.asOf}.csv`, toCsv(rows))
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
        // "All companies": every account row names its company.
        const multi = report.companies.length > 1
        const co = (name: string | null): Record<string, string> => (multi ? { company: name ?? '' } : {})
        const flat: Array<Record<string, string | number>> = []
        for (const a of report.assets)      flat.push({ section: 'Assets',      ...co(a.companyName), code: a.code, name: a.name, balance: fmtPkr(a.balanceCents) })
        flat.push({ section: 'Assets',      ...co(''), code: '', name: 'TOTAL ASSETS', balance: fmtPkr(report.totals.assetsCents) })
        for (const l of report.liabilities) flat.push({ section: 'Liabilities', ...co(l.companyName), code: l.code, name: l.name, balance: fmtPkr(l.balanceCents) })
        flat.push({ section: 'Liabilities', ...co(''), code: '', name: 'TOTAL LIABILITIES', balance: fmtPkr(report.totals.liabilitiesCents) })
        for (const e of report.equity)      flat.push({ section: 'Equity',      ...co(e.companyName), code: e.code, name: e.name, balance: fmtPkr(e.balanceCents) })
        // Virtual roll-forward (H29): each company's own fiscal year.
        for (const e of report.earningsByCompany) {
          flat.push({ section: 'Equity', ...co(e.companyName), code: '', name: `Retained earnings b/f (before ${e.fiscalYear.start})`, balance: fmtPkr(e.retainedEarningsBroughtForwardCents) })
          flat.push({ section: 'Equity', ...co(e.companyName), code: '', name: `Profit for the year to date (${e.fiscalYear.label})`, balance: fmtPkr(e.currentYearEarningsCents) })
        }
        const unowned = report.totals.currentYearEarningsCents - report.earningsByCompany.reduce((s, e) => s + e.currentYearEarningsCents, 0)
        if (unowned !== 0) flat.push({ section: 'Equity', ...co(''), code: '', name: 'Profit on accounts with no company', balance: fmtPkr(unowned) })
        flat.push({ section: 'Equity',      ...co(''), code: '', name: 'TOTAL EQUITY', balance: fmtPkr(report.totals.equityCents + report.totals.currentEarningsCents) })
        for (const p of report.ppe) {
          flat.push({ section: 'Fixed assets by class', ...co(p.companyName), code: [p.costCode, p.accumCode].filter(Boolean).join(' / '), name: `${p.label}: cost ${fmtPkr(p.costCents)}, accumulated ${fmtPkr(p.accumulatedCents)}`, balance: fmtPkr(p.netCents) })
        }
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
        if (report.totals.depreciationCents !== 0) flat.push({ section: 'OpEx', code: '', name: 'of which depreciation', amount: fmtPkr(report.totals.depreciationCents) })
        if (report.totals.impairmentCents !== 0)   flat.push({ section: 'OpEx', code: '', name: 'of which impairment',   amount: fmtPkr(report.totals.impairmentCents) })
        flat.push({ section: 'Result', code: '', name: 'OPERATING PROFIT', amount: fmtPkr(report.totals.operatingProfitCents) })
        for (const r of report.otherIncome)   flat.push({ section: 'Other income', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
        flat.push({ section: 'Other income', code: '', name: 'TOTAL OTHER INCOME', amount: fmtPkr(report.totals.otherIncomeCents) })
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
        // 42xx other income is below the operating result — in net profit, never revenue.
        const netProfitCents   = grossProfitCents - b.opexCents + b.otherIncomeCents
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
          otherIncomeCents: b.otherIncomeCents,
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
          otherIncomeCents: t.otherIncomeCents + r.otherIncomeCents,
          netProfitCents: t.netProfitCents + r.netProfitCents,
        }),
        { revenueCents: 0, contraRevenueCents: 0, netRevenueCents: 0, cogsCents: 0, grossProfitCents: 0, opexCents: 0, otherIncomeCents: 0, netProfitCents: 0 },
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
          otherIncome: fmtPkr(r.otherIncomeCents),
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
        // Transfers between the company's own cash accounts (safe drops,
        // pay-ins, deposits) have their own columns and are not inflow/outflow.
        const multi = report.companies.length > 1
        const co = (name: string | null): Record<string, string> => (multi ? { company: name ?? '' } : {})
        const flat: Array<Record<string, string | number>> = []
        for (const a of report.byCashAccount) flat.push({ section: 'By account', ...co(a.companyName), code: a.code, name: a.name, inflow: fmtPkr(a.inflowCents), outflow: fmtPkr(a.outflowCents), transferIn: fmtPkr(a.transferInCents), transferOut: fmtPkr(a.transferOutCents), net: fmtPkr(a.netCents) })
        for (const c of report.byCategory)    flat.push({ section: 'By category', ...co(''), code: '', name: c.category, inflow: fmtPkr(c.inflowCents), outflow: fmtPkr(c.outflowCents), transferIn: '', transferOut: '', net: fmtPkr(c.netCents) })
        flat.push({ section: 'Total', ...co(''), code: '', name: 'NET CHANGE IN CASH', inflow: fmtPkr(report.totals.inflowCents), outflow: fmtPkr(report.totals.outflowCents), transferIn: fmtPkr(report.totals.transfersCents), transferOut: fmtPkr(report.totals.transfersCents), net: fmtPkr(report.totals.netCents) })
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
        // Per authority (F3 / BOOKS-10): each files its own return — its own
        // output less its own input, never one authority's input against
        // another's output.
        for (const a of report.byAuthority) {
          const sec = `By authority — ${a.authority}`
          flat.push({ section: sec, code: a.output.code, name: `Output tax (${a.output.name})`, value: fmtPkr(a.output.totalCents) })
          flat.push({ section: sec, code: a.input.code,  name: `Input tax (${a.input.name})`,   value: fmtPkr(a.input.totalCents) })
          flat.push({ section: sec, code: '', name: a.netPayableCents >= 0 ? 'Net payable' : 'Excess input carried forward', value: fmtPkr(Math.abs(a.netPayableCents)) })
          if (a.otherOutputCents !== 0) {
            flat.push({ section: sec, code: '', name: 'Output tax not from order sales (manual journals, B2B invoices, older entries)', value: fmtPkr(a.otherOutputCents) })
          }
          flat.push({ section: sec, code: '', name: 'Brands', value: a.brands.join(' ') })
        }
        // Per rate: the brand's cash (15%) and card (8%) rates, refunds netted.
        for (const r of report.byRate) {
          const rate = r.ratePct == null ? 'rate not stored' : `${r.ratePct}%`
          const label = `${r.authority} ${r.tender} ${rate}`
          flat.push({ section: 'By rate', code: r.authority, name: `${label} — orders`,                    value: r.orders })
          flat.push({ section: 'By rate', code: r.authority, name: `${label} — sales value / tax`,         value: `${fmtPkr(r.salesValueCents)} / ${fmtPkr(r.salesTaxCents)}` })
          flat.push({ section: 'By rate', code: r.authority, name: `${label} — refunds value / tax`,       value: `${fmtPkr(r.refundValueCents)} / ${fmtPkr(r.refundTaxCents)}` })
          flat.push({ section: 'By rate', code: r.authority, name: `${label} — taxable value to declare`,  value: fmtPkr(r.taxableValueCents) })
          flat.push({ section: 'By rate', code: r.authority, name: `${label} — output tax to declare`,     value: fmtPkr(r.taxCents) })
        }
        // Tax still in 2030 for provincially-taxed brands: the manual journal to post.
        for (const r of report.reclassification) {
          flat.push({
            section: 'Reclassify', code: r.conceptSlug,
            name: r.amountCents >= 0
              ? `${r.conceptName}: Dr ${r.fromAccount} / Cr ${r.toAccount}`
              : `${r.conceptName}: Dr ${r.toAccount} / Cr ${r.fromAccount} (refund)`,
            value: fmtPkr(Math.abs(r.amountCents)),
          })
        }
        for (const r of report.reclassesPosted) {
          flat.push({ section: 'Reclassified', code: r.reference, name: `${r.conceptName} ${r.month}: ${r.fromAccount} → ${r.toAccount} on ${r.entryDate}`, value: fmtPkr(r.amountCents) })
        }
        // Settlement: what was paid for the period and what the books still owe.
        for (const a of report.byAuthority) {
          const sec = `Paid — ${a.authority}`
          flat.push({ section: sec, code: a.output.code, name: 'Paid for this period', value: fmtPkr(a.paidForPeriodCents) })
          if (a.inputSetOffForPeriodCents !== 0) flat.push({ section: sec, code: a.input.code, name: 'Input set off in those payments', value: fmtPkr(a.inputSetOffForPeriodCents) })
          flat.push({ section: sec, code: a.output.code, name: 'Ledger balance at period end', value: fmtPkr(a.ledgerBalanceAtEndCents) })
        }
        for (const w of report.withholding) {
          const sec = `Withholding — ${w.authority}`
          flat.push({ section: sec, code: w.account.code, name: `Withheld in the period (${w.account.name})`, value: fmtPkr(w.account.totalCents) })
          flat.push({ section: sec, code: w.account.code, name: 'Paid for this period', value: fmtPkr(w.paidForPeriodCents) })
          flat.push({ section: sec, code: w.account.code, name: 'Ledger balance at period end', value: fmtPkr(w.ledgerBalanceAtEndCents) })
        }
        for (const p of report.payments) {
          flat.push({
            section: 'Payments', code: p.authority.toUpperCase(),
            name: `${p.periodFrom} – ${p.periodTo}, paid ${p.paidAt}${p.cprNumber ? `, CPR ${p.cprNumber}` : ''}${p.linked ? ' (linked entry)' : ''}${p.inputSetOffCents ? `, input set off ${fmtPkr(p.inputSetOffCents)}` : ''}`,
            value: fmtPkr(p.paidCents),
          })
        }
        flat.push({ section: 'Result',     code: '',                          name: 'NET PAYABLE (sum of each authority\'s own net)', value: fmtPkr(report.netPayableCents) })
        flat.push({ section: 'Result',     code: '',                          name: 'EXCESS INPUT CARRIED FORWARD (per authority)',   value: fmtPkr(report.carryForwardCents) })
        for (const n of report.notes) flat.push({ section: 'Notes', code: '', name: n, value: '' })
        return sendCsv(reply, `sales-tax-return-${report.period.from}-${report.period.to}.csv`, toCsv(flat))
      }
      return report
    },
  )

  // ─── Tax paid to the authorities (finance gap 6) ─────────────────────────
  //
  // The settlement side of the return (taxPayments.ts). A payment is recorded
  // in the ACTIVE company's books — the company whose return it is — from one
  // of THAT company's bank accounts; an existing manual / reconciliation
  // entry of that company can be linked instead of posting again. Foreign
  // rows are 404. Recording, linking, voiding and reclassing are finance's
  // and the CEO's (TAX_PAYERS); every money write is on the books' trail.

  const period = z.union([
    z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).transform((b) => monthPeriod(b.period)),
    z.object({ periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .transform((b) => ({ from: b.periodFrom, to: b.periodTo })),
  ])
  const authority = z.enum(TAX_PAYMENT_AUTHORITIES)
  const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => v || null)

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string } }>(
    '/sales-tax-return/payments',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const tenantId = activeTenantId(req, 'tax payments are per company')
      const { from, to } = req.query.dateFrom || req.query.dateTo
        ? resolveDateRange(req.query.dateFrom, req.query.dateTo)
        : { from: new Date(0), to: new Date(8.64e15) }
      return { payments: await taxPaymentsFor(tenantId, from, to) }
    },
  )

  fastify.get<{ Querystring: { authority?: string } }>(
    '/sales-tax-return/payments/candidates',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const tenantId = activeTenantId(req, 'tax payments are per company')
      return { entries: await linkCandidates(tenantId, authority.parse(req.query.authority)) }
    },
  )

  fastify.post('/sales-tax-return/payments', { preHandler: requireAuth(...TAX_PAYERS) }, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>
    const body = z.object({
      authority,
      paidCents: zMoneyCents('The amount paid'),
      inputSetOffCents: zMoneyCents('The input tax set off').default(0),
      // H13: sales tax customers withheld (1335) set off against this authority's payment.
      customerWithheldSetOffCents: zMoneyCents('The withheld tax set off').default(0),
      paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      method: z.enum(TAX_PAYMENT_METHODS).default('bank_transfer'),
      bankAccountId: z.string().trim().min(1).max(64).optional().nullable(),
      cprNumber: optText(80),
      notes: optText(500),
    }).parse(raw)
    const p = period.parse(raw)
    // A create: the ACTIVE company's books, never another membership.
    const tenantId = activeTenantId(req, 'a tax payment is in one company\'s books')
    const row = await recordTaxPayment({
      tenantId,
      authority: body.authority,
      periodFrom: p.from, periodTo: p.to,
      paidCents: body.paidCents,
      inputSetOffCents: body.inputSetOffCents,
      customerWithheldSetOffCents: body.customerWithheldSetOffCents,
      paidAt: body.paidAt,
      method: body.method,
      bankAccountId: body.bankAccountId ?? null,
      cprNumber: body.cprNumber,
      notes: body.notes,
      userId: req.staffUser!.id,
    })
    await audit({ category: 'accounting',
      action: 'salestax.payment',
      entity: 'SalesTaxPayment',
      entityId: row.id,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      after: row,
      metadata: { ip: req.ip, method: body.method },
    })
    return reply.status(201).send(row)
  })

  fastify.post('/sales-tax-return/payments/link', { preHandler: requireAuth(...TAX_PAYERS) }, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>
    const body = z.object({
      journalEntryId: z.string().uuid(),
      authority,
      cprNumber: optText(80),
      notes: optText(500),
    }).parse(raw)
    const p = period.parse(raw)
    // The entry must be in the ACTIVE company's books — another company's is 404.
    const tenantId = activeTenantId(req, 'a tax payment is in one company\'s books')
    const row = await linkTaxPayment({
      tenantId,
      journalEntryId: body.journalEntryId,
      authority: body.authority,
      periodFrom: p.from, periodTo: p.to,
      cprNumber: body.cprNumber,
      notes: body.notes,
      userId: req.staffUser!.id,
    })
    await audit({ category: 'accounting',
      action: 'salestax.payment_link',
      entity: 'SalesTaxPayment',
      entityId: row.id,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      after: row,
      metadata: { ip: req.ip, journalEntryId: body.journalEntryId },
    })
    return reply.status(201).send(row)
  })

  fastify.post<{ Params: { id: string } }>('/sales-tax-return/payments/:id/void', { preHandler: requireAuth(...TAX_PAYERS) }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body ?? {})
    // Editing an existing row: any company the operator belongs to; others 404.
    const row = await voidTaxPayment({
      scope: await scopeTenantWhere(req, 'write'),
      id: req.params.id,
      reason: body.reason,
      userId: req.staffUser!.id,
    })
    await audit({ category: 'accounting',
      action: row.linked ? 'salestax.payment_unlink' : 'salestax.payment_void',
      entity: 'SalesTaxPayment',
      entityId: row.id,
      userId: req.staffUser!.id, tenantId: row.tenantId,
      userEmail: req.staffUser!.email,
      before: row,
      metadata: { ip: req.ip, reason: body.reason },
    })
    return { ok: true, id: row.id, reversed: !row.linked }
  })

  // The one-off move of a provincial brand's output tax out of 2030 (the
  // return's "To reclassify" rows). Posts in the brand's company, dated in
  // the sales' month; a closed month is 422 PERIOD_LOCKED (reopen it under
  // decision 21 first). A repeat finds nothing left to move and is a no-op.
  fastify.post('/sales-tax-return/reclass', { preHandler: requireAuth(...TAX_PAYERS) }, async (req, reply) => {
    const body = z.object({
      conceptId: z.string().uuid(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body ?? {})
    // A brand of the operator's companies — deleted ones included: a brand
    // removed mid-month still has that month's tax to move (it is listed in
    // the return's "To reclassify"). Another company's brand is 404.
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true, tenantId: true, slug: true, name: true, province: true, srbPosId: true },
    })
    if (!concept) throw new NotFoundError('Concept', body.conceptId)
    if (!concept.tenantId) throw new AppError('BRAND_HAS_NO_COMPANY', 'This brand has no company — its books are not known', 422)
    const result = await postTaxReclass({ concept: { ...concept, tenantId: concept.tenantId }, from: body.from, to: body.to, userId: req.staffUser!.id })
    if (result.posted) {
      await audit({ category: 'accounting',
        action: 'salestax.reclass',
        entity: 'JournalEntry',
        entityId: result.entryId,
        userId: req.staffUser!.id, tenantId: concept.tenantId,
        userEmail: req.staffUser!.email,
        after: result,
        metadata: { ip: req.ip, conceptId: concept.id, month: result.month },
      })
    }
    return reply.status(result.posted ? 201 : 200).send(result)
  })

  // ─── Period close ────────────────────────────────────────────────────────
  //
  // THE one write path for period locks (the /setup/period-locks copy is
  // gone). A lock is a PKT end-of-day, only ever moves forward, and every
  // close and reopen is on the books' audit trail (category 'accounting').
  // Reopening (owner decision 21) is admin only, removes only the LATEST
  // lock, needs a reason, is audited and raises a high-severity exception.
  //
  // Closing runs ONE checklist (closeChecks.ts CLOSE_CHECKS) for the active
  // company only. A block stops the close (409 CLOSE_NOT_READY) unless the
  // CEO acknowledges it with a reason (acknowledge {keys, reason ≥ 10}) —
  // stored on the lock (overrides / overrideReason), audited
  // 'period.close_override' and flagged 'period_close_override' (high). The
  // trial balance can never be closed over. Raast alone keeps its old answer
  // (409 RAAST_UNMATCHED) and its old switch (closeWithUnmatchedRaast, no
  // reason, audited 'period.close_with_unmatched_raast'), which works ONLY
  // when Raast is the one block. A close whose range passes the company's
  // fiscal year end is a year-end close (audited 'period.year_end_close');
  // the roll-forward is virtual, so nothing is posted.

  fastify.get('/period-close/history', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) return { locks: [] }
    const locks = await prisma.periodLock.findMany({
      where: { tenantId },
      orderBy: { lockedThrough: 'desc' },
      take: 60,
      select: { id: true, lockedThrough: true, lockedAt: true, lockedBy: true, note: true, overrides: true, overrideReason: true },
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

  // The active company's close state and, for the date being closed
  // (?lockedThrough=YYYY-MM-DD, else yesterday — the latest a close can
  // take), the whole checklist. raastUnmatched is kept for older pages.
  fastify.get<{ Querystring: { lockedThrough?: string } }>('/period-close', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    // Each company closes its own books, so this reports the ACTIVE company's
    // close — a lock elsewhere never shows here.
    const tenantId = req.staffUser!.tenantId
    const lock = tenantId ? await prisma.periodLock.findFirst({
      where: { tenantId },
      orderBy: { lockedThrough: 'desc' },
      select: { lockedThrough: true, lockedAt: true, lockedBy: true, note: true, overrides: true, overrideReason: true },
    }) : null
    const base = {
      lockedThrough: lock?.lockedThrough ?? null, lockedAt: lock?.lockedAt ?? null, lockedBy: lock?.lockedBy ?? null,
      note: lock?.note ?? null, overrides: lock?.overrides ?? null, overrideReason: lock?.overrideReason ?? null,
    }
    if (!tenantId) {
      return { ...base, tenantId: null, closesFiscalYear: null, raastUnmatched: { count: 0, cents: 0, through: null }, through: null, checks: [], months: [], isYearEnd: false, fiscalYear: null, ready: false }
    }
    const asked = req.query.lockedThrough ? parsePktEndOfDay(req.query.lockedThrough) : null
    const through = asked && !Number.isNaN(asked.getTime()) ? asked : new Date(pktToday().from.getTime() - 1)
    // serviceClient: the checks read ONLY this company (every query names it),
    // but an inter-company check reads its pair's accounts, which RLS would
    // hide in single-company mode.
    const list = await closeChecklist(serviceClient, tenantId, through)
    const raast = list.problems.find((p) => p.key === 'raast')
    const endMonth = await fiscalYearEndMonthOf(prisma, tenantId)
    const fy = fiscalYearOf(endMonth, through)
    // The fiscal year this close completes (the latest one ending on or before the date).
    const ended = fy.end.getTime() <= through.getTime() ? fy : fiscalYearOf(endMonth, new Date(fy.start.getTime() - 1))
    return {
      ...base,
      tenantId,
      closesFiscalYear: list.isYearEnd ? ended.label : null,
      raastUnmatched: { count: raast?.count ?? 0, cents: raast?.cents ?? 0, through: fmtPktDate(through) },
      through: fmtPktDate(through),
      checks: list.problems,
      months: list.months,
      isYearEnd: list.isYearEnd,
      fiscalYear: { endMonth, label: fy.label, start: fmtPktDate(fy.start), end: fmtPktDate(fy.end) },
      // Nothing blocks: the close needs no acknowledgement.
      ready: list.blocks.length === 0,
    }
  })

  fastify.post('/period-close', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      lockedThrough: z.string(),
      note: z.string().max(500).optional(),
      // The CEO closes over these blocking checks, with a reason.
      acknowledge: z.object({
        keys: z.array(z.string().trim().min(1).max(120)).max(50),
        reason: z.string().trim().max(1000).optional(),
      }).optional(),
      // Old switch: close even though Raast payments up to the date are still
      // not matched to a bank statement (S6) — only when that is the ONE block.
      closeWithUnmatchedRaast: z.boolean().optional(),
    }).parse(req.body)

    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company — books are closed per company', 422)

    const newLock = parsePktEndOfDay(body.lockedThrough)
    if (Number.isNaN(newLock.getTime())) {
      throw new AppError('INVALID_DATE', 'Give the close date as YYYY-MM-DD', 422)
    }
    // A close is of days that have happened. Locking a future date (a typo for
    // last year) silently refused every till close, bill and payment dated
    // before it — the shift closed, its sales never reached the ledger, and
    // nobody was told (BOOKS-07). Today is still trading too: a lock through
    // today refused every online completion, refund and loyalty posting for
    // the rest of the day while their sales were filed with the fiscal POS
    // (BOOKS-R2-01). The latest a period can close is YESTERDAY, PKT.
    const today = pktToday()
    if (newLock.getTime() >= today.from.getTime()) {
      const yesterday = new Date(today.from.getTime() - 1)
      throw new AppError(
        'LOCK_IN_FUTURE',
        `Cannot close the books through ${fmtPktDate(newLock)} — today (${fmtPktDate(today.to)}, Pakistan time) is still trading. The latest date you can close is yesterday, ${fmtPktDate(yesterday)}.`,
        422,
      )
    }

    // The CEO's acknowledgement: every key closable-over, and a real reason.
    const ackKeys = Array.from(new Set(body.acknowledge?.keys ?? []))
    const reason = body.acknowledge?.reason?.trim() ?? ''
    if (ackKeys.length > 0) {
      const fixed = ackKeys.filter((k) => !isOverridableKey(k))
      if (fixed.length > 0) {
        throw new AppError('NOT_OVERRIDABLE', `${fixed.join(', ')} cannot be closed over — fix it first (the trial balance must balance).`, 422, { keys: fixed })
      }
      if (reason.length < 10) {
        throw new AppError('OVERRIDE_REASON_REQUIRED', 'Say why the books are closed over these checks (at least 10 characters) — it is kept on the close and the audit trail.', 422)
      }
    }
    const ack = new Set(ackKeys)

    const before = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
    if (before && newLock <= before.lockedThrough) {
      throw new AppError(
        'LOCK_CANNOT_REGRESS',
        `Period is already locked through ${fmtPktDate(before.lockedThrough)}. Lock dates can only move forward.`,
        422,
      )
    }

    // Depreciation for every completed month the close covers is charged
    // first (idempotent; a refusal is flagged and the 'depreciation' check
    // then reports it).
    try {
      await chargeForClose(tenantId, newLock, req.staffUser!.id)
    } catch (err) {
      console.error(`[period-close] depreciation before the close of ${tenantId} failed:`, (err as Error).message)
    }

    const result = await serviceClient.$transaction(async (tx) => {
      // Two closes of one company never run side by side.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`period-close:${tenantId}`}))`
      const existing = await tx.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' } })
      if (existing && newLock <= existing.lockedThrough) {
        throw new AppError(
          'LOCK_CANNOT_REGRESS',
          `Period is already locked through ${fmtPktDate(existing.lockedThrough)}. Lock dates can only move forward.`,
          422,
        )
      }
      const list = await closeChecklist(tx, tenantId, newLock)
      const blocks = list.blocks
      const fixedBlocks = blocks.filter((b) => !b.overridable)
      const raastOnly = blocks.length === 1 && blocks[0]!.key === 'raast'
      const aliasUsed = raastOnly && body.closeWithUnmatchedRaast === true && !ack.has('raast')
      const open = blocks.filter((b) => !b.overridable || !(ack.has(b.key) || (aliasUsed && b.key === 'raast')))
      if (open.length > 0) {
        if (raastOnly) {
          const r = blocks[0]!
          throw new AppError(
            'RAAST_UNMATCHED',
            `${r.count} Raast payment(s), PKR ${((r.cents ?? 0) / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}, up to ${fmtPktDate(newLock)} are not matched to a bank statement yet. Match them on Finance → Reconciliation → Raast (or mark them not received), or close anyway.`,
            409,
            { count: r.count, cents: r.cents ?? 0, problems: list.problems },
          )
        }
        const names = open.map((b) => b.title).join('; ')
        throw new AppError(
          'CLOSE_NOT_READY',
          fixedBlocks.length > 0
            ? `The books cannot be closed through ${fmtPktDate(newLock)}: ${names}. ${fixedBlocks.map((b) => b.title).join('; ')} cannot be closed over.`
            : `The books cannot be closed through ${fmtPktDate(newLock)} yet: ${names}. Fix them, or (CEO) close over them with a reason.`,
          409,
          { problems: list.problems, open: open.map((b) => b.key) },
        )
      }
      const overridden: CloseProblem[] = blocks
      const created = await tx.periodLock.create({
        data: {
          tenantId,
          lockedThrough: newLock,
          lockedBy: req.staffUser!.id,
          note: body.note ?? null,
          ...(overridden.length > 0 ? {
            overrides: overridden.map((b) => ({
              key: b.key, title: b.title, count: b.count,
              ...(b.cents !== undefined ? { cents: b.cents } : {}),
              ...(b.months ? { months: b.months } : {}),
              ...(aliasUsed && b.key === 'raast' ? { via: 'closeWithUnmatchedRaast' } : {}),
            })) as Prisma.InputJsonValue,
            overrideReason: aliasUsed ? null : reason,
          } : {}),
        },
      })
      return { created, existing, list, overridden, aliasUsed }
    }, { maxWait: 15_000, timeout: 180_000 })

    const { created, existing, list, overridden, aliasUsed } = result
    const endMonth = await fiscalYearEndMonthOf(prisma, tenantId)
    const fy = fiscalYearOf(endMonth, newLock)
    await audit({ category: 'accounting',
      action: 'period.close',
      entity: 'PeriodLock',
      entityId: created.id,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      before: existing,
      after: created,
      metadata: { ip: req.ip, months: list.months, isYearEnd: list.isYearEnd, warnings: list.warnings.map((w) => w.key) },
    })
    const reasoned = overridden.filter((b) => !(aliasUsed && b.key === 'raast'))
    if (reasoned.length > 0) {
      await audit({ category: 'accounting',
        action: 'period.close_override',
        entity: 'PeriodLock',
        entityId: created.id,
        userId: req.staffUser!.id, tenantId,
        userEmail: req.staffUser!.email,
        after: { lockedThrough: created.lockedThrough, overrides: created.overrides },
        metadata: { ip: req.ip, reason, keys: reasoned.map((b) => b.key) },
      })
      const { flagException } = await import('../../lib/exceptions.js')
      await flagException({
        tenantId,
        kind: 'period_close_override',
        severity: 'high',
        title: `Books closed through ${fmtPktDate(newLock)} over ${reasoned.length} blocking check${reasoned.length === 1 ? '' : 's'}`,
        description: `${req.staffUser!.email} closed the books over: ${reasoned.map((b) => `${b.title} (${b.count})`).join('; ')}. Reason: ${reason}. `
          + 'Whatever these checks found is still unresolved and now sits in a closed period — fix it in the open month (late postings carry a note naming the original date).',
        entityType: 'PeriodLock',
        entityId: created.id,
        actorId: req.staffUser!.id,
        amountCents: reasoned.reduce((s, b) => s + Math.abs(b.cents ?? 0), 0) || null,
        metadata: { lockedThrough: created.lockedThrough, keys: reasoned.map((b) => b.key), reason },
      })
    }
    const raastClosedOver = overridden.find((b) => b.key === 'raast')
    if (raastClosedOver) {
      await audit({ category: 'accounting',
        action: 'period.close_with_unmatched_raast',
        entity: 'PeriodLock',
        entityId: created.id,
        userId: req.staffUser!.id, tenantId,
        userEmail: req.staffUser!.email,
        after: { lockedThrough: created.lockedThrough, raastUnmatchedCount: raastClosedOver.count, raastUnmatchedCents: raastClosedOver.cents ?? 0 },
        metadata: { ip: req.ip, note: body.note ?? null, via: aliasUsed ? 'closeWithUnmatchedRaast' : 'acknowledge' },
      })
    }
    if (list.isYearEnd) {
      await audit({ category: 'accounting',
        action: 'period.year_end_close',
        entity: 'PeriodLock',
        entityId: created.id,
        userId: req.staffUser!.id, tenantId,
        userEmail: req.staffUser!.email,
        after: { lockedThrough: created.lockedThrough, fiscalYearEndMonth: endMonth },
        metadata: { ip: req.ip, prevLock: existing?.lockedThrough ?? null, currentFiscalYear: fy.label },
      })
    }
    return reply.status(201).send({ ...created, checks: list.problems, months: list.months, isYearEnd: list.isYearEnd })
  })

  // ─── Fiscal year (H29) ───────────────────────────────────────────────────
  // Each company in view: its year end month and the fiscal year it is in
  // today, and whether its books were already closed across a year end (then
  // changing the year end needs the CEO's reason — PATCH /tenants/:id).
  fastify.get('/fiscal-year', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    const [years, names] = await Promise.all([
      fiscalYearsFor(prisma, scope.tenantIds, new Date()),
      prisma.tenant.findMany({ where: { id: { in: scope.tenantIds } }, select: { id: true, name: true } }),
    ])
    const nameOf = new Map(names.map((n) => [n.id, n.name]))
    const companies = []
    for (const y of years) {
      companies.push({
        tenantId: y.tenantId,
        name: nameOf.get(y.tenantId) ?? '',
        endMonth: y.endMonth,
        label: y.label,
        currentStart: fmtPktDate(y.start),
        currentEnd: fmtPktDate(y.end),
        closedAcrossYearEnd: await closedAcrossYearEnd(prisma, y.tenantId, [y.endMonth]),
      })
    }
    return { companies: companies.sort((a, b) => a.name.localeCompare(b.name)) }
  })
}
