import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, APPROVERS } from '../auth/middleware.js'
import {
  importBankStatement,
  adjustStatementLine,
} from './service.js'
import { drawerExpectationOf, drawerVariance, cashVarianceLimitCents, isDrawerBalanced } from '../../lib/drawer.js'
import { scopeTenantWhere, shiftWhere, shiftTenantId, SHIFT_COMPANY_INCLUDE } from '../../lib/tenantScope.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

const importBankSchema = z.object({
  // The bank the statement is for (Configuration → Bank accounts): the ledger
  // code and the source label derive from it. A non-bank ledger (a Keenu
  // settlement against 1030 card receivable) passes accountCode + source.
  bankAccountId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  accountCode: z.string().min(1).optional(),
  statementDate: z.string(),
  openingBalanceCents: z.number().int(),
  closingBalanceCents: z.number().int(),
  filename: z.string().min(1, 'Statement file name is required — upload the bank statement before reconciling'),
  fileUrl:  z.string().url('Statement file URL required — uploaded statement must be reachable for audit'),
  csv: z.string().min(1, 'Bank statement contents required — paste or upload the CSV'),
})

const adjustLineSchema = z.object({
  contraAccountCode: z.string().min(1),
  memo: z.string().min(1),
})

export async function reconciliationRoutes(fastify: FastifyInstance) {
  // ─── Bank statements ─────────────────────────────────────────────────────

  // Every statement import belongs to one company (its ledger). Reads are
  // view-aware; acting on a line (adjust / ignore) needs write scope, and an
  // adjustment posts to the IMPORT's company, never the operator's active one.

  fastify.get('/bank/imports', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.bankStatementImport.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { statementDate: 'desc' },
      take: 100,
      include: { _count: { select: { lines: true } } },
    })
  })

  fastify.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/bank/imports/:id/lines',
    { preHandler: requireAuth(...MANAGERS) },
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

  fastify.post('/bank/imports', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
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
        memo: body.memo,
        postedById: req.staffUser!.id,
      })
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/bank/lines/:id/ignore',
    { preHandler: requireAuth(...MANAGERS) },
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
  // shift list and the CEO dashboard's "Cash balanced" card.
  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string } }>(
    '/summary',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const dateFrom = req.query.dateFrom
        ? new Date(req.query.dateFrom)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : new Date()

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

}
