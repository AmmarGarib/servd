import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM, APPROVERS, ADMIN_ONLY } from '../auth/middleware.js'
import {
  importBankStatement,
  adjustStatementLine,
  unmatchStatementLine,
  manualMatchStatementLine,
  manualMatchCandidates,
} from './service.js'
import { requireModule } from '../notifications/requireModule.js'
import { raastReconciliationRoutes, raastPaidCents } from './raastRoutes.js'
import cardPayoutRoutes from './cardPayoutRoutes.js'
import { cardSettlementChips } from './cardPayouts.js'
import codRoutes from './codRoutes.js'
import pettyCashBackfillRoutes from './pettyCashBackfillRoutes.js'
import { drawerExpectationOf, drawerVariance, cashVarianceLimitCents, isDrawerBalanced } from '../../lib/drawer.js'
import { scopeTenantWhere, shiftWhere, shiftTenantId, SHIFT_COMPANY_INCLUDE, resolveTenantScope } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { reportDateRange } from '../reports/service.js'
import { zMoneyCents } from '../../lib/money.js'

// Who works the reconciliation module (BOOKS-02): every manager tier plus the
// finance role, which holds the `reconciliation` module by default
// (lib/moduleAccess.ts) — the auth middleware's module gate on the
// /reconciliation prefix is what narrows it per role or per person. Booking an
// adjustment journal, matching by hand and undoing a match are BANK_BOOKERS
// (below); the backfill stays CEO-only.
const RECONCILERS = FINANCE_TEAM

// Who books, matches by hand and undoes a match (owner, 2026-10-16: finance does
// the full bank reconciliation — "match by hand, bank fees, undo, un-ignore"):
// the CEO, the co-owners (APPROVERS, as before) and finance holding the
// `accounting` module — the same people who post manual journals
// (accounting/routes.ts JOURNAL_POSTERS). Every action is audited. Closed
// months stay the CEO's: the posting engine refuses a dated-in-closed-books
// adjustment for anyone else (closedBooks.ts).
const BANK_BOOKER_ROLES = [...APPROVERS, 'finance'] as UserRole[]
const financeHoldsAccounting = async (req: FastifyRequest) => {
  if (req.staffUser?.role === 'finance') await requireModule('accounting')(req)
}
const BANK_BOOKERS = [requireAuth(...BANK_BOOKER_ROLES), financeHoldsAccounting]

// Statement balances are BIGINT columns (BOOKS-06) and come back as JS
// numbers through lib/money.ts. One balance ≤ MAX_MONEY_CENTS (PKR 900bn),
// else 422 AMOUNT_TOO_LARGE; either sign (an overdrawn account is negative).
const balanceCents = zMoneyCents('A statement balance', { sign: 'any' })

const importBankSchema = z.object({
  // The bank the statement is for (Configuration → Bank accounts): the ledger
  // code and the source label derive from it. A non-bank ledger (a Keenu
  // settlement against 1030 card receivable) passes accountCode + source.
  bankAccountId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  accountCode: z.string().min(1).optional(),
  statementDate: z.string().refine((v) => !isNaN(new Date(v).getTime()), 'statementDate must be a date (YYYY-MM-DD)'),
  openingBalanceCents: balanceCents,
  closingBalanceCents: balanceCents,
  filename: z.string().min(1, 'Statement file name is required — upload the bank statement before reconciling'),
  fileUrl:  z.string().url('Statement file URL required — uploaded statement must be reachable for audit'),
  csv: z.string().min(1, 'Bank statement contents required — paste or upload the CSV'),
})

// The other side of an unmatched statement line: one contra account for the
// whole amount, or a balanced split (BOOKS-11 — a card settlement net of its
// MDR clears 1030 in full and books the fee to 6080).
const adjustLineSchema = z.object({
  memo: z.string().trim().min(1),
  contraAccountCode: z.string().trim().min(1).optional(),
  lines: z.array(z.object({
    accountCode: z.string().trim().min(1),
    type: z.enum(['debit', 'credit']),
    // One journal line each (BIGINT): above PKR 900bn it is a plain 422
    // AMOUNT_TOO_LARGE here rather than a refusal deep in the posting.
    amountCents: zMoneyCents('A split line', { sign: 'positive' }),
    memo: z.string().trim().max(500).optional(),
  })).min(1).max(20).optional(),
  // H12 card payouts (cardPayouts.ts): the card days a split crediting 1030 on
  // the payout bank settles, and the unit ('brand:<id>' / 'terminal:<id>')
  // when the company is paid per brand / machine.
  cardDays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(5).optional(),
  cardUnit: z.string().trim().min(1).max(120).optional(),
  // Posting to a fixed-asset register account needs a reason (audited + flagged).
  registerOverride: z.object({ reason: z.string().trim().min(10).max(500) }).optional(),
}).refine((b) => !!b.contraAccountCode !== !!b.lines, {
  message: 'Give either contraAccountCode or lines (a split), not both',
})

export async function reconciliationRoutes(fastify: FastifyInstance) {
  // ─── Bank statements ─────────────────────────────────────────────────────

  // Every statement import belongs to one company (its ledger). Reads are
  // view-aware; acting on a line (adjust / ignore) needs write scope, and an
  // adjustment posts to the IMPORT's company, never the operator's active one.

  fastify.get('/bank/imports', { preHandler: requireAuth(...RECONCILERS) }, async (req) => {
    const rows = await prisma.bankStatementImport.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { statementDate: 'desc' },
      take: 100,
      include: { _count: { select: { lines: true } } },
    })
    // The balances are BIGINT; lib/money.ts already hands them over as numbers.
    return rows
  })

  fastify.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/bank/imports/:id/lines',
    { preHandler: requireAuth(...RECONCILERS) },
    async (req) => {
      const imp = await prisma.bankStatementImport.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
        select: { id: true },
      })
      if (!imp) throw new NotFoundError('BankStatementImport', req.params.id)
      // A line matched to a Raast payment carries it (the Raast tab's chip).
      const rows = await prisma.bankStatementLine.findMany({
        where: {
          importId: imp.id,
          ...(req.query.status && { matchStatus: req.query.status }),
        },
        orderBy: { postedDate: 'asc' },
        include: { raastReceipt: { select: { id: true, bankRef: true, orderId: true, amountCents: true } } },
      })
      // A line that settles card days (H12) carries its chip (Card payouts tab).
      const chips = await cardSettlementChips(prisma, rows.map((l) => l.id))
      return rows.map((l) => ({ ...l, cardSettlement: chips.get(l.id) ?? null }))
    },
  )

  fastify.post('/bank/imports', { preHandler: requireAuth(...RECONCILERS) }, async (req, reply) => {
    const body = importBankSchema.parse(req.body)
    // The ledger is per company: the statement reconciles against the
    // company the operator is working in.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — the ledger is per company', 422)

    let accountCode = body.accountCode
    let source = body.source
    let bankAccountId: string | null = null
    if (body.bankAccountId) {
      const bank = await prisma.bankAccount.findFirst({
        where: { id: body.bankAccountId, tenantId, deletedAt: null },
        select: { id: true, name: true, bankName: true, accountCode: true },
      })
      if (!bank) throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'That bank account is not one of your active company\'s', 422)
      if (!bank.accountCode) throw new AppError('BANK_ACCOUNT_NOT_LINKED', 'Link this bank account to a chart code first (Configuration → Bank accounts)', 422)
      bankAccountId = bank.id
      accountCode = bank.accountCode
      source = `bank:${(bank.bankName ?? bank.name).toLowerCase()}`
    }
    if (!accountCode || !source) {
      throw new AppError('BANK_ACCOUNT_REQUIRED', 'Pick the bank account this statement is for', 400)
    }

    const result = await importBankStatement({
      tenantId,
      bankAccountId,
      source,
      accountCode,
      statementDate: new Date(body.statementDate),
      openingBalanceCents: body.openingBalanceCents,
      closingBalanceCents: body.closingBalanceCents,
      filename: body.filename,
      importedById: req.staffUser!.id,
      csv: body.csv,
    })
    // Night audit (sales days): an audited day whose bank side is now matched closes.
    import('../nightAudit/service.js').then((m) => m.nudgeNightAudit(tenantId)).catch(() => undefined)
    return reply.status(201).send(result)
  })

  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/adjust',
    { preHandler: BANK_BOOKERS },
    async (req) => {
      const body = adjustLineSchema.parse(req.body)
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true, amountCents: true, import: { select: { tenantId: true } } },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      // Register-account overrides stay the CEO's (as on manual journals).
      if (body.registerOverride && req.staffUser!.role !== 'admin') {
        throw new AppError('REGISTER_OVERRIDE_CEO_ONLY', 'Only the CEO can post to the fixed-asset register accounts by hand.', 403)
      }
      const result = await adjustStatementLine({
        lineId: line.id,
        contraAccountCode: body.contraAccountCode,
        lines: body.lines,
        memo: body.memo,
        postedById: req.staffUser!.id,
        cardDays: body.cardDays,
        cardUnit: body.cardUnit,
        registerOverride: body.registerOverride,
        actorEmail: req.staffUser!.email ?? null,
        actorTenantId: req.staffUser!.tenantId ?? null,
      })
      await audit({
        category: 'accounting', action: 'reconciliation.line.adjust', entity: 'BankStatementLine', entityId: line.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: line.import.tenantId ?? null,
        before: { matchStatus: 'unmatched' },
        after: { matchStatus: 'adjusted', memo: body.memo, contraAccountCode: body.contraAccountCode ?? null, lines: body.lines ?? null },
        metadata: { actorRole: req.staffUser!.role, amountCents: Number(line.amountCents), cardSettlementId: result.cardSettlementId ?? null },
      })
      return result
    },
  )

  // GET /bank/lines/:id/candidates?days=45 — the live, free journal lines on
  // the statement's account equal to the line's signed amount (± days, ≤ 400),
  // for the manual match picker. Another company's line → 404.
  fastify.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/bank/lines/:id/candidates',
    { preHandler: BANK_BOOKERS },
    async (req) => {
      const days = z.coerce.number().int().min(1).max(400).default(45).parse(req.query.days ?? undefined)
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      return manualMatchCandidates(line.id, days)
    },
  )

  // POST /bank/lines/:id/match {journalLineId} — pair an unmatched statement
  // line with its existing journal line BY HAND (service.ts
  // manualMatchStatementLine: same company, the statement's account, live,
  // free, equal signed amount; conditional claim). Audited. Posts nothing.
  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/match',
    { preHandler: BANK_BOOKERS },
    async (req) => {
      const body = z.object({
        journalLineId: z.string().min(1).max(64),
        note: z.string().trim().max(500).optional(),
      }).parse(req.body ?? {})
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      const res = await manualMatchStatementLine(line.id, body.journalLineId)
      await audit({
        category: 'accounting', action: 'reconciliation.line.match', entity: 'BankStatementLine', entityId: line.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: res.tenantId,
        before: { matchStatus: 'unmatched', matchedJournalLineId: null },
        after: { matchStatus: 'matched', matchedJournalLineId: body.journalLineId },
        metadata: { actorRole: req.staffUser!.role, amountCents: res.amountCents, journalEntryId: res.journalEntryId, reference: res.reference, note: body.note ?? null },
      })
      import('../nightAudit/service.js').then((m) => m.nudgeNightAudit(res.tenantId)).catch(() => undefined)
      return prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/ignore',
    { preHandler: requireAuth(...RECONCILERS) },
    async (req) => {
      // A reason is required (owner, 2026-10-16) and the ignore is audited; it
      // is kept on the line's notes and can be undone with /unignore.
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true, matchStatus: true, notes: true, amountCents: true, raastReceipt: { select: { id: true } }, import: { select: { tenantId: true } } },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      // RV-FIN-3: only an UNMATCHED line can be ignored. A line matched to a
      // Raast receipt is undone on the Raast tab (Unmatch) — ignoring it would
      // strand the receipt; a generic match is undone with /unmatch first.
      if (line.raastReceipt) {
        throw new AppError('RAAST_MATCHED_LINE', 'This line is matched to a Raast payment — unmatch it on the Raast tab first', 409, { receiptId: line.raastReceipt.id })
      }
      if (line.matchStatus === 'ignored') return prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })
      if (line.matchStatus !== 'unmatched') throw new AppError('LINE_NOT_UNMATCHED', `Line is already ${line.matchStatus}`, 409)
      const body = z.object({ reason: z.string().trim().min(10, 'Say why this line is ignored (at least 10 characters)').max(500) }).parse(req.body ?? {})
      const claimed = await prisma.bankStatementLine.updateMany({
        where: { id: line.id, matchStatus: 'unmatched' },
        data: { matchStatus: 'ignored', notes: `Ignored: ${body.reason}`.slice(0, 520) },
      })
      if (claimed.count === 0) throw new AppError('LINE_NOT_UNMATCHED', `Line is already ${line.matchStatus}`, 409)
      await audit({
        category: 'accounting', action: 'reconciliation.line.ignore', entity: 'BankStatementLine', entityId: line.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: line.import.tenantId ?? null,
        before: { matchStatus: 'unmatched', notes: line.notes },
        after: { matchStatus: 'ignored' },
        metadata: { actorRole: req.staffUser!.role, reason: body.reason, amountCents: Number(line.amountCents) },
      })
      return prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })
    },
  )

  // POST /bank/lines/:id/unignore — bring an ignored line back to unmatched
  // (conditional on it still being 'ignored'), audited. Whoever may ignore may
  // undo it (RECONCILERS — finance included).
  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/unignore',
    { preHandler: requireAuth(...RECONCILERS) },
    async (req) => {
      const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {})
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true, matchStatus: true, notes: true, import: { select: { tenantId: true } } },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      const claimed = await prisma.bankStatementLine.updateMany({
        where: { id: line.id, matchStatus: 'ignored' },
        data: { matchStatus: 'unmatched', notes: null },
      })
      if (claimed.count === 0) throw new AppError('LINE_NOT_IGNORED', `Line is ${line.matchStatus}, not ignored`, 409)
      await audit({
        category: 'accounting', action: 'reconciliation.line.unignore', entity: 'BankStatementLine', entityId: line.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: line.import.tenantId ?? null,
        before: { matchStatus: 'ignored', notes: line.notes },
        after: { matchStatus: 'unmatched' },
        metadata: { actorRole: req.staffUser!.role, reason: body.reason ?? null },
      })
      return prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })
    },
  )

  // POST /bank/lines/:id/unmatch — undo a GENERIC match (S3; BANK_BOOKERS —
  // the CEO, co-owners and finance with accounting; audited): the line goes
  // back to unmatched and its journal line is free.
  // A line matched to a Raast payment is undone on the Raast tab (409).
  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/unmatch',
    { preHandler: BANK_BOOKERS },
    async (req) => {
      const body = z.object({ reason: z.string().trim().min(3).max(500).optional() }).parse(req.body ?? {})
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true, import: { select: { tenantId: true } } },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      const { before } = await unmatchStatementLine(line.id)
      await audit({
        category: 'accounting',
        action: 'reconciliation.line.unmatch',
        entity: 'BankStatementLine',
        entityId: line.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        tenantId: line.import.tenantId ?? req.staffUser!.tenantId ?? null,
        before,
        after: { matchStatus: 'unmatched', matchedJournalLineId: null },
        metadata: { lineTenantId: line.import.tenantId, reason: body.reason ?? null, actorRole: req.staffUser!.role },
      })
      return { ok: true }
    },
  )

  // ─── Raast QR (spec §7.2) — /reconciliation/raast/* ─────────────────────
  await fastify.register(raastReconciliationRoutes, { prefix: '/raast' })

  // ─── Finance wave B child plugins (one file each, one owner each) ───────
  // Card payouts at payout (H12), COD owed by riders (H5), and the petty-cash
  // history backfill (H2). All under the /reconciliation module gate.
  await fastify.register(cardPayoutRoutes, { prefix: '/card-payouts' })
  await fastify.register(codRoutes, { prefix: '/cod' })
  await fastify.register(pettyCashBackfillRoutes, { prefix: '/backfill-petty-cash' })

  // ─── POS shift cash reconciliation ──────────────────────────────────────
  //
  // There is ONE shift close: POST /pos/shifts/:id/close (closeShift). It is
  // the only close that posts the shift to the ledger (postShiftClose), reads
  // the company's own variance limit and checks who owns the drawer. The old
  // GET /reconciliation/shift/:id and POST /reconciliation/shift/:id/complete
  // closed drawers WITHOUT posting them — every shift closed from here was
  // missing from the trial balance, P&L, cash flow and sales-tax return while
  // its Z-report still showed the money. Both are gone; the admin page reads
  // GET /pos/shifts/:id/zreport and closes through the POS route.

  // GET /reconciliation/summary
  // Last 30 days (or a custom range) of POS shifts, one row per shift, with
  // expected cash from the ONE drawer formula (lib/drawer.ts) and the verdict
  // against each drawer company's own tolerance. Feeds the /reconciliation
  // shift list and the CEO dashboard's "Cash balanced" card. Dates are PKT
  // business days (YYYY-MM-DD), the shifts OPENED on them — as /accounting and
  // /reports read them (BOOKS-12: a date-only range used to be parsed as one
  // UTC instant and returned nothing).
  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string } }>(
    '/summary',
    { preHandler: requireAuth(...RECONCILERS) },
    async (req) => {
      const { from: dateFrom, to: dateTo } = reportDateRange(req.query.dateFrom, req.query.dateTo, 30)

      const shifts = await prisma.shift.findMany({
        where: {
          openedAt: { gte: dateFrom, lte: dateTo },
          // Whose drawer: Shift.tenantId (view-aware), not the cashier's
          // primary company — a cashier who works in two companies used to
          // show A's drawer under B.
          ...(await shiftWhere(req, 'read')),
        },
        include: {
          cashMovements: { select: { type: true, amountCents: true } },
          payments: { select: { method: true, status: true, amountCents: true } },
          user: { select: { name: true, tenantId: true } },
          location: SHIFT_COMPANY_INCLUDE.location,
        },
        orderBy: { openedAt: 'desc' },
        take: 200,
      })

      const limits = new Map<string | null, number>()
      const limitFor = async (tenantId: string | null) => {
        if (!limits.has(tenantId)) limits.set(tenantId, await cashVarianceLimitCents(tenantId))
        return limits.get(tenantId)!
      }

      const summary = []
      for (const shift of shifts) {
        const drawer = drawerExpectationOf(shift)
        const varianceCents = drawerVariance(shift.closingFloatCents, drawer)
        const varianceLimitCents = await limitFor(shiftTenantId(shift))
        // Same sales total as the Z-report: paid cash + Card – Keenu (with
        // the retired Keenu QR's old rows) + Raast QR. Comps are not sales
        // (they are 7030 on the P&L).
        const totalSalesCents = shift.payments
          .filter((p) => p.status === 'paid' && ['cash', 'card', 'keenu_qr', 'raast'].includes(p.method))
          .reduce((s, p) => s + p.amountCents, 0)
        const raastSalesCents = raastPaidCents(shift.payments)
        summary.push({
          shiftId: shift.id,
          cashier: shift.user.name,
          openedAt: shift.openedAt,
          closedAt: shift.closedAt,
          status: shift.status,
          totalSalesCents,
          raastSalesCents,
          cashSalesCents: drawer.cashSalesCents,
          expectedCashCents: drawer.expectedCents,
          closingFloatCents: shift.closingFloatCents,
          varianceCents,
          varianceLimitCents,
          isBalanced: isDrawerBalanced(varianceCents, varianceLimitCents),
          notes: shift.notes,
        })
      }

      return {
        dateFrom,
        dateTo,
        totalShifts: summary.length,
        balancedShifts: summary.filter((s) => s.isBalanced).length,
        shifts: summary,
      }
    },
  )

  const BACKFILL_RUNNERS = ['admin', 'finance'] as UserRole[]

  // POST /reconciliation/backfill-unposted — owner decision 6. Closed shifts
  // that never reached the books (closed through the old /reconciliation
  // close, or refused as unbalanced) post into their own month while it is
  // open, otherwise into the CURRENT open month with a memo naming the
  // shift's original close date. A locked month is never reopened. The CEO
  // and finance (owner, 2026-10-16: finance re-posts refused postings in
  // OPEN months; the reconciliation module gates /reconciliation); dry run
  // unless { dryRun: false }. Closed months are never posted into (the run
  // moves those to the current month). While the CEO has a month REOPENED
  // in a company in view, a real run is the CEO's (409
  // REOPENED_BOOKS_CEO_ONLY): its own-day postings would land in that
  // month. The companies in view (the portfolio header expands).
  // Idempotent — a shift posts once.
  fastify.post('/backfill-unposted', { preHandler: [requireAuth(...BACKFILL_RUNNERS), requireModule('reconciliation', 'accounting')] }, async (req) => {
    const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    if (!body.dryRun && req.staffUser!.role !== 'admin') {
      const { reopenedThrough } = await import('../accounting/closedBooks.js')
      for (const tid of scope.tenantIds) {
        const re = await reopenedThrough(prisma, tid)
        if (re) {
          throw new AppError('REOPENED_BOOKS_CEO_ONLY',
            'The CEO has reopened closed books in this company, so re-posting could land in them — only the CEO can run it until those months are closed again.', 409)
        }
      }
    }
    const { backfillUnpostedShifts } = await import('../accounting/shiftPosting.js')
    const { backfillUnpostedOrders, withBackfillSlot, BackfillRunningError } = await import('./backfillOrders.js')
    const runAll = async () => {
      const result = await backfillUnpostedShifts({ tenantIds: scope.tenantIds, dryRun: body.dryRun, postedBy: req.staffUser!.id })
      // BOOKS-R2-01: order completions, loyalty earns / redemptions and refund
      // restores the ledger refused are re-posted too (backfillOrders.ts) —
      // into their own day only; a locked one is listed, never moved. Its
      // step 4 re-posts refused deposits, waste, counts, void waste, cancel
      // unwinds and failed till cards — into the current month with a note
      // when their own month is closed (decision 6), like the shifts above.
      const orders = await backfillUnpostedOrders({ tenantIds: scope.tenantIds, dryRun: body.dryRun, postedBy: req.staffUser!.id })
      return { result, orders }
    }
    // A real run is single-flight per company (RB-1); a dry run writes
    // nothing and never waits.
    let ran: Awaited<ReturnType<typeof runAll>>
    try {
      ran = body.dryRun ? await runAll() : await withBackfillSlot(scope.tenantIds, runAll)
    } catch (err) {
      if (err instanceof BackfillRunningError) throw new AppError('BACKFILL_RUNNING', err.message, 409)
      throw err
    }
    const { result, orders } = ran
    if (!body.dryRun) {
      await audit({
        category: 'accounting',
        action: 'shift.backfill_unposted',
        entity: 'Shift',
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        tenantId: req.staffUser!.tenantId ?? null,
        after: { shifts: result.summary, orders: orders.summary },
        metadata: {
          shiftIds: result.rows.filter((r) => r.outcome.startsWith('posted')).map((r) => r.shiftId),
          posted: orders.rows.filter((r) => r.outcome === 'posted' || r.outcome === 'posted_into_current_month').map((r) => `${r.kind}:${r.id}`),
          flagged: orders.rows.filter((r) => r.outcome === 'flagged').map((r) => `${r.kind}:${r.id}`),
          actorRole: req.staffUser!.role,
          tenantIds: scope.tenantIds,
        },
      })
    }
    // `rows` / `summary` stay the shifts' (the admin page reads them);
    // `orders` carries the order / loyalty / refund rows.
    return { dryRun: body.dryRun, ...result, orders }
  })
}
