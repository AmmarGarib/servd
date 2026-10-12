import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM, APPROVERS, ADMIN_ONLY } from '../auth/middleware.js'
import {
  importBankStatement,
  adjustStatementLine,
} from './service.js'
import { drawerExpectationOf, drawerVariance, cashVarianceLimitCents, isDrawerBalanced } from '../../lib/drawer.js'
import { scopeTenantWhere, shiftWhere, shiftTenantId, SHIFT_COMPANY_INCLUDE, resolveTenantScope } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { reportDateRange } from '../reports/service.js'
import { MAX_LINE_CENTS, amountTooLarge } from '../accounting/journal.js'

// Who works the reconciliation module (BOOKS-02): every manager tier plus the
// finance role, which holds the `reconciliation` module by default
// (lib/moduleAccess.ts) — the auth middleware's module gate on the
// /reconciliation prefix is what narrows it per role or per person. Booking an
// adjustment journal stays with the APPROVERS (CEO and co-owners); the
// backfill stays CEO-only.
const RECONCILERS = FINANCE_TEAM

// Statement balances are BigInt columns (BOOKS-06); JSON carries them as
// numbers. Paisa stay far inside 2^53, and the schema refuses anything bigger.
const balanceCents = z.number().int().refine(Number.isSafeInteger, 'Balance is out of range')

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
    // One journal line each (INT4): above PKR 21,474,836.47 it is a plain
    // 422 AMOUNT_TOO_LARGE here rather than a refusal deep in the posting.
    amountCents: z.number().int().positive().refine(Number.isSafeInteger).transform((v) => {
      if (v > MAX_LINE_CENTS) throw amountTooLarge('A split line')
      return v
    }),
    memo: z.string().trim().max(500).optional(),
  })).min(1).max(20).optional(),
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
    return rows.map((r) => ({
      ...r,
      openingBalanceCents: Number(r.openingBalanceCents),
      closingBalanceCents: Number(r.closingBalanceCents),
    }))
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
      return prisma.bankStatementLine.findMany({
        where: {
          importId: imp.id,
          ...(req.query.status && { matchStatus: req.query.status }),
        },
        orderBy: { postedDate: 'asc' },
      })
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
    return reply.status(201).send(result)
  })

  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/adjust',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const body = adjustLineSchema.parse(req.body)
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      return adjustStatementLine({
        lineId: line.id,
        contraAccountCode: body.contraAccountCode,
        lines: body.lines,
        memo: body.memo,
        postedById: req.staffUser!.id,
      })
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/ignore',
    { preHandler: requireAuth(...RECONCILERS) },
    async (req) => {
      const line = await prisma.bankStatementLine.findFirst({
        where: { id: req.params.id, import: await scopeTenantWhere(req, 'write') },
        select: { id: true },
      })
      if (!line) throw new NotFoundError('BankStatementLine', req.params.id)
      return prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { matchStatus: 'ignored' },
      })
    },
  )

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
        // Same sales total as the Z-report: paid cash + card + Keenu QR.
        // Comps are not sales (they are 7030 on the P&L).
        const totalSalesCents = shift.payments
          .filter((p) => p.status === 'paid' && ['cash', 'card', 'keenu_qr'].includes(p.method))
          .reduce((s, p) => s + p.amountCents, 0)
        summary.push({
          shiftId: shift.id,
          cashier: shift.user.name,
          openedAt: shift.openedAt,
          closedAt: shift.closedAt,
          status: shift.status,
          totalSalesCents,
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

  // POST /reconciliation/backfill-unposted — owner decision 6. Closed shifts
  // that never reached the books (closed through the old /reconciliation
  // close, or refused as unbalanced) post into their own month while it is
  // open, otherwise into the CURRENT open month with a memo naming the
  // shift's original close date. A locked month is never reopened. Admin
  // only; dry run unless { dryRun: false }. The companies in view (the
  // portfolio header expands). Idempotent — a shift posts once.
  fastify.post('/backfill-unposted', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    const { backfillUnpostedShifts } = await import('../accounting/shiftPosting.js')
    const { backfillUnpostedOrders, withBackfillSlot, BackfillRunningError } = await import('./backfillOrders.js')
    const runAll = async () => {
      const result = await backfillUnpostedShifts({ tenantIds: scope.tenantIds, dryRun: body.dryRun, postedBy: req.staffUser!.id })
      // BOOKS-R2-01: order completions, loyalty earns / redemptions and refund
      // restores the ledger refused are re-posted too (backfillOrders.ts) —
      // into their own day only; a locked one is listed, never moved.
      const orders = await backfillUnpostedOrders({ tenantIds: scope.tenantIds, dryRun: body.dryRun })
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
          posted: orders.rows.filter((r) => r.outcome === 'posted').map((r) => `${r.kind}:${r.id}`),
        },
      })
    }
    // `rows` / `summary` stay the shifts' (the admin page reads them);
    // `orders` carries the order / loyalty / refund rows.
    return { dryRun: body.dryRun, ...result, orders }
  })

  // POST /reconciliation/apply-missed-bill-variances — NEEDS 21 (BK2-RV-2).
  // Supplier bills booked before their goods carried their price difference
  // in 1210 until the goods arrived; receipts made before receiving applied it
  // itself never did. This applies those missed slices once
  // (supplierPosting.applyMissedCarriedBillVariances): the share still on
  // hand re-averages the item, the rest goes to 5060 dated today. CEO only
  // (role admin); dry run unless { dryRun: false }. The companies in view, or
  // the one picked (`tenantId`, which must be one of them — else 404).
  // Idempotent — a second run finds nothing. A company whose books are closed
  // through today is listed as 'locked' and nothing of it is applied.
  fastify.post('/apply-missed-bill-variances', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      dryRun:   z.boolean().default(true),
      tenantId: z.string().min(1).optional(),
    }).parse(req.body ?? {})
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    if (body.tenantId && !scope.tenantIds.includes(body.tenantId)) throw new NotFoundError('Company', body.tenantId)
    const tenantIds = body.tenantId ? [body.tenantId] : scope.tenantIds
    const { applyMissedCarriedBillVariances } = await import('../accounting/supplierPosting.js')
    const { withBackfillSlot, BackfillRunningError } = await import('./backfillOrders.js')
    const runAll = () => applyMissedCarriedBillVariances({ tenantIds, dryRun: body.dryRun })
    let ran: Awaited<ReturnType<typeof runAll>>
    try {
      // A real run is single-flight per company (it shares the backfill's
      // slot); a dry run writes nothing and never waits.
      ran = body.dryRun ? await runAll() : await withBackfillSlot(tenantIds, runAll)
    } catch (err) {
      if (err instanceof BackfillRunningError) throw new AppError('BACKFILL_RUNNING', err.message, 409)
      throw err
    }
    if (!body.dryRun && ran.rows.length > 0) {
      // One audit row per company the run touched, filed under THAT company
      // with only its own lines — never under the operator's home company
      // (which may not be one of them, and must not see another's lines).
      const byCompany = new Map<string, typeof ran.rows>()
      for (const r of ran.rows) byCompany.set(r.tenantId, [...(byCompany.get(r.tenantId) ?? []), r])
      for (const [companyId, rows] of byCompany) {
        const summary: Record<string, number> = { lines: rows.length, quantity: rows.reduce((s, r) => s + r.quantity, 0) }
        for (const r of rows) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1
        await audit({
          category: 'accounting',
          action: 'supplier.bill.variance_catch_up',
          entity: 'SupplierBill',
          userId: req.staffUser!.id,
          userEmail: req.staffUser!.email,
          tenantId: companyId,
          after: summary,
          metadata: {
            tenantId: companyId,
            applied: rows.filter((r) => r.outcome === 'applied').map((r) => ({ poLineId: r.poLineId, quantity: r.quantity, movedCents: r.movedCents })),
            notApplied: rows.filter((r) => r.outcome !== 'applied').map((r) => ({ poLineId: r.poLineId, outcome: r.outcome, detail: r.detail })),
          },
        })
      }
    }
    return { dryRun: body.dryRun, tenantIds, ...ran }
  })
}
