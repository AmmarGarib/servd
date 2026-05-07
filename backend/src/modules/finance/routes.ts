import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'

export async function financeRoutes(fastify: FastifyInstance) {
  // GET /finance/ledger — daily financial entries
  fastify.get<{
    Querystring: { conceptId?: string; channel?: string; dateFrom?: string; dateTo?: string; limit?: string; cursor?: string }
  }>('/ledger', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { conceptId, channel, dateFrom, dateTo, limit: limitStr, cursor } = req.query
    const limit = Math.min(parseInt(limitStr ?? '50', 10), 200)

    const entries = await prisma.financialEntry.findMany({
      where: {
        // Tenant scope: only entries in concepts under the active tenant.
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        ...(conceptId && { conceptId }),
        ...(channel && { channel }),
        ...(dateFrom || dateTo
          ? { entryDate: { ...(dateFrom && { gte: new Date(dateFrom) }), ...(dateTo && { lte: new Date(dateTo) }) } }
          : {}),
        ...(cursor && { id: { lt: cursor } }),
      },
      include: {
        concept: { select: { name: true, slug: true } },
        order: { select: { source: true, status: true, placedAt: true } },
      },
      orderBy: { entryDate: 'desc' },
      take: limit + 1,
    })

    const hasMore = entries.length > limit
    if (hasMore) entries.pop()
    return { data: entries, cursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null, hasMore }
  })

  // POST /finance/sync — trigger accounting sync (stub for external sync, built-in for now)
  fastify.post('/sync', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    // Built-in accounting — no external sync needed (spec §7.3)
    return reply.status(200).send({ message: 'servd uses built-in double-entry accounting. No external sync required.' })
  })
}
