import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import {
  importBankStatement,
  adjustStatementLine,
  reconcileFoodpandaSettlement,
} from './service.js'

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

const settlementSchema = z.object({
  settlementDate: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  actualAmountCents: z.number().int().min(0),
  reference: z.string().optional(),
  notes: z.string().optional(),
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
    { preHandler: requireAuth(...ADMIN_ONLY) },
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

  // ─── Foodpanda settlements ───────────────────────────────────────────────

  fastify.get('/foodpanda/settlements', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.foodpandaSettlement.findMany({
      orderBy: { settlementDate: 'desc' },
      take: 100,
    })
  })

  fastify.post('/foodpanda/settlements', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = settlementSchema.parse(req.body)
    const settlement = await reconcileFoodpandaSettlement({
      settlementDate: new Date(body.settlementDate),
      periodStart: new Date(body.periodStart),
      periodEnd: new Date(body.periodEnd),
      actualAmountCents: body.actualAmountCents,
      reference: body.reference,
      notes: body.notes,
      recordedById: req.staffUser!.id,
    })
    return reply.status(201).send(settlement)
  })
}
