import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, APPROVERS } from '../auth/middleware.js'
import {
  importBankStatement,
  adjustStatementLine,
} from './service.js'
import { flagException } from '../../lib/exceptions.js'

const importBankSchema = z.object({
  source: z.string().min(1),
  accountCode: z.string().min(1),
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

  fastify.get('/bank/imports', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.bankStatementImport.findMany({
      orderBy: { statementDate: 'desc' },
      take: 100,
      include: { _count: { select: { lines: true } } },
    })
  })

  fastify.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/bank/imports/:id/lines',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.bankStatementLine.findMany({
        where: {
          importId: req.params.id,
          ...(req.query.status && { matchStatus: req.query.status }),
        },
        orderBy: { postedDate: 'asc' },
      })
    },
  )

  fastify.post('/bank/imports', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = importBankSchema.parse(req.body)
    const result = await importBankStatement({
      source: body.source,
      accountCode: body.accountCode,
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
      return adjustStatementLine({
        lineId: req.params.id,
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
      return prisma.bankStatementLine.update({
        where: { id: req.params.id },
        data: { matchStatus: 'ignored' },
      })
    },
  )

  // ─── POS shift cash reconciliation ──────────────────────────────────────

  // GET /reconciliation/shift/:shiftId
  // Compute the full cash reconciliation summary for a POS shift.
  // Expected cash = openingFloat + cashSales + cashIn - cashOut
  // Variance      = closingFloat (if set) - expectedCash
  fastify.get<{ Params: { shiftId: string } }>(
    '/shift/:shiftId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const shift = await prisma.shift.findFirst({
        where: { id: req.params.shiftId, user: { tenantId: req.staffUser!.tenantId } },
        include: {
          cashMovements: true,
          payments: { where: { status: 'paid' } },
          user: { select: { name: true } },
        },
      })
      if (!shift) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found' } })

      // ── Payment breakdown by method ──────────────────────────────────────
      // Payments are directly linked to the shift via Payment.shiftId, which
      // is set when a POS payment is processed.
      const cashSalesCents = shift.payments
        .filter((p) => p.method === 'cash')
        .reduce((s, p) => s + p.amountCents, 0)

      const cardSalesCents = shift.payments
        .filter((p) => p.method === 'card')
        .reduce((s, p) => s + p.amountCents, 0)

      const walletSalesCents = shift.payments
        .filter((p) => p.method === 'keenu_qr')                            // F-PAY02: wallets retired
        .reduce((s, p) => s + p.amountCents, 0)

      const compSalesCents = shift.payments
        .filter((p) => p.method === 'comp')
        .reduce((s, p) => s + p.amountCents, 0)

      const totalSalesCents = shift.payments.reduce((s, p) => s + p.amountCents, 0)

      // ── Cash movement breakdown ───────────────────────────────────────────
      // 'add' and 'payin' increase the expected drawer balance.
      // 'drop' and 'payout' decrease it.
      const cashInCents = shift.cashMovements
        .filter((m) => m.type === 'add' || m.type === 'payin')
        .reduce((s, m) => s + m.amountCents, 0)

      const cashOutCents = shift.cashMovements
        .filter((m) => m.type === 'drop' || m.type === 'payout')
        .reduce((s, m) => s + m.amountCents, 0)

      const expectedCashCents =
        shift.openingFloatCents + cashSalesCents + cashInCents - cashOutCents

      const closingFloat = shift.closingFloatCents ?? null
      const varianceCents = closingFloat !== null ? closingFloat - expectedCashCents : null
      const isBalanced = varianceCents !== null && Math.abs(varianceCents) <= 50000 // ≤ PKR 500

      return {
        shiftId: shift.id,
        openedAt: shift.openedAt,
        closedAt: shift.closedAt,
        status: shift.status,
        cashier: shift.user.name,
        expectedCashCents,
        closingFloatCents: closingFloat,
        varianceCents,
        isBalanced,
        breakdown: {
          openingFloatCents: shift.openingFloatCents,
          cashSalesCents,
          cardSalesCents,
          walletSalesCents,
          compSalesCents,
          totalSalesCents,
          cashInCents,
          cashOutCents,
          movementCount: shift.cashMovements.length,
          paymentCount: shift.payments.length,
        },
      }
    },
  )

  // POST /reconciliation/shift/:shiftId/complete
  // Finalize shift reconciliation: record closing float, compute variance,
  // flag an exception if variance > PKR 500 (50,000 cents).
  fastify.post<{ Params: { shiftId: string } }>(
    '/shift/:shiftId/complete',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        closingFloat: z.number().int().min(0),   // in cents
        notes: z.string().max(1000).optional(),
      }).parse(req.body)

      const shift = await prisma.shift.findFirst({
        where: { id: req.params.shiftId, user: { tenantId: req.staffUser!.tenantId } },
        include: {
          cashMovements: true,
          payments: { where: { status: 'paid' } },
          user: { select: { name: true, id: true } },
        },
      })
      if (!shift) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found' } })
      if (shift.status !== 'open') {
        return reply.status(400).send({ error: { code: 'SHIFT_ALREADY_CLOSED', message: 'Shift is already closed' } })
      }

      // Recompute expected cash exactly the same way as the GET endpoint
      const cashSalesCents = shift.payments
        .filter((p) => p.method === 'cash')
        .reduce((s, p) => s + p.amountCents, 0)
      const cashInCents = shift.cashMovements
        .filter((m) => m.type === 'add' || m.type === 'payin')
        .reduce((s, m) => s + m.amountCents, 0)
      const cashOutCents = shift.cashMovements
        .filter((m) => m.type === 'drop' || m.type === 'payout')
        .reduce((s, m) => s + m.amountCents, 0)

      const expectedCashCents =
        shift.openingFloatCents + cashSalesCents + cashInCents - cashOutCents
      const varianceCents = body.closingFloat - expectedCashCents
      const isBalanced = Math.abs(varianceCents) <= 50000

      // Persist the closing float and notes (shift close is handled by pos/service;
      // here we only update the reconciliation fields — the shift must already be
      // in 'closed' state or we close it now).
      await prisma.shift.update({
        where: { id: req.params.shiftId },
        data: {
          closingFloatCents: body.closingFloat,
          notes: body.notes ?? shift.notes,
          status: 'closed',
          closedAt: shift.closedAt ?? new Date(),
        },
      })

      // Flag a cash_variance exception when the discrepancy exceeds PKR 500
      if (!isBalanced) {
        await flagException({
          kind: 'cash_variance',
          severity: Math.abs(varianceCents) >= 500000 ? 'high' : 'medium', // PKR 5,000 = high
          title: `Cash variance on shift ${shift.id.slice(-6).toUpperCase()}`,
          description:
            `Cashier: ${shift.user.name}. ` +
            `Expected: PKR ${(expectedCashCents / 100).toFixed(2)}, ` +
            `Counted: PKR ${(body.closingFloat / 100).toFixed(2)}, ` +
            `Variance: PKR ${(varianceCents / 100).toFixed(2)}.`,
          entityType: 'Shift',
          entityId: req.params.shiftId,
          actorId: req.staffUser!.id,
          amountCents: Math.abs(varianceCents),
          metadata: {
            expectedCashCents,
            closingFloatCents: body.closingFloat,
            varianceCents,
            cashSalesCents,
            cashInCents,
            cashOutCents,
          },
        })
      }

      const cardSalesCents = shift.payments
        .filter((p) => p.method === 'card')
        .reduce((s, p) => s + p.amountCents, 0)
      const walletSalesCents = shift.payments
        .filter((p) => p.method === 'keenu_qr')                            // F-PAY02: wallets retired
        .reduce((s, p) => s + p.amountCents, 0)
      const totalSalesCents = shift.payments.reduce((s, p) => s + p.amountCents, 0)

      return reply.status(200).send({
        shiftId: shift.id,
        status: 'closed',
        expectedCashCents,
        closingFloatCents: body.closingFloat,
        varianceCents,
        isBalanced,
        exceptionFlagged: !isBalanced,
        breakdown: {
          openingFloatCents: shift.openingFloatCents,
          cashSalesCents,
          cardSalesCents,
          walletSalesCents,
          totalSalesCents,
          cashInCents,
          cashOutCents,
        },
      })
    },
  )

  // GET /reconciliation/summary
  // Last 30 days (or custom range) of POS shifts with their reconciliation
  // summary — one row per shift, shows variance and balanced status.
  // ?locationId= optionally scopes to a single physical location.
  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string; locationId?: string } }>(
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
          user: { tenantId: req.staffUser!.tenantId },
          ...(req.query.locationId ? { locationId: req.query.locationId } : {}),
        },
        include: {
          cashMovements: true,
          payments: { where: { status: 'paid' } },
          user: { select: { name: true } },
        },
        orderBy: { openedAt: 'desc' },
        take: 200,
      })

      const summary = shifts.map((shift) => {
        const cashSalesCents = shift.payments
          .filter((p) => p.method === 'cash')
          .reduce((s, p) => s + p.amountCents, 0)
        const cashInCents = shift.cashMovements
          .filter((m) => m.type === 'add' || m.type === 'payin')
          .reduce((s, m) => s + m.amountCents, 0)
        const cashOutCents = shift.cashMovements
          .filter((m) => m.type === 'drop' || m.type === 'payout')
          .reduce((s, m) => s + m.amountCents, 0)
        const totalSalesCents = shift.payments.reduce((s, p) => s + p.amountCents, 0)
        const expectedCashCents =
          shift.openingFloatCents + cashSalesCents + cashInCents - cashOutCents
        const closingFloat = shift.closingFloatCents ?? null
        const varianceCents = closingFloat !== null ? closingFloat - expectedCashCents : null
        const isBalanced = varianceCents !== null && Math.abs(varianceCents) <= 50000

        return {
          shiftId: shift.id,
          cashier: shift.user.name,
          openedAt: shift.openedAt,
          closedAt: shift.closedAt,
          status: shift.status,
          totalSalesCents,
          cashSalesCents,
          expectedCashCents,
          closingFloatCents: closingFloat,
          varianceCents,
          isBalanced,
          notes: shift.notes,
        }
      })

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
