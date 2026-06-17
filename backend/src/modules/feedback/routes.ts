// Feedback API.
//
// Distinct from /reviews (per-order rating) and /complaints (formal
// grievance). FeedbackEntry is for one-tap NPS / CSAT / open-suggestion
// signals — the kind of micro-feedback that drives a marketing funnel.
//
// Public POST is rate-limited per-IP to discourage abuse but does not
// require auth — anonymous suggestions land too. Auth, if present, links the
// entry to a Customer for personalized follow-up.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { verifyCustomerToken } from '../auth/service.js'

const FEEDBACK_KINDS = ['nps', 'csat', 'open'] as const

export async function feedbackRoutes(fastify: FastifyInstance) {
  // POST /feedback — public. Captures one-tap NPS / CSAT / open suggestions.
  // If a customer auth token is in the Authorization header we link the
  // entry; otherwise it's anonymous.
  fastify.post(
    '/',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = z.object({
        kind:      z.enum(FEEDBACK_KINDS),
        score:     z.number().int().nullable().optional(),
        comment:   z.string().max(2000).nullable().optional(),
        conceptId: z.string().uuid().nullable().optional(),
        context:   z.record(z.string(), z.unknown()).nullable().optional(),
      }).parse(req.body)

      // Score validation per kind.
      if (body.kind === 'nps' && body.score != null && (body.score < 0 || body.score > 10)) {
        return reply.status(422).send({ error: { code: 'BAD_SCORE', message: 'NPS score must be 0..10' } })
      }
      if (body.kind === 'csat' && body.score != null && (body.score < 1 || body.score > 5)) {
        return reply.status(422).send({ error: { code: 'BAD_SCORE', message: 'CSAT score must be 1..5' } })
      }
      if (body.kind === 'open' && !body.comment?.trim()) {
        return reply.status(422).send({ error: { code: 'EMPTY_FEEDBACK', message: 'Tell us a bit more' } })
      }

      // Soft-link to a customer if they have a valid customer token.
      let customerId: string | null = null
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) {
        try {
          const payload = verifyCustomerToken(auth.slice(7))
          customerId = payload.sub
        } catch { /* anonymous is fine */ }
      }

      const entry = await prisma.feedbackEntry.create({
        data: {
          kind:       body.kind,
          score:      body.score ?? null,
          comment:    body.comment?.trim() || null,
          conceptId:  body.conceptId ?? null,
          customerId,
          context:    (body.context ?? undefined) as never,
          source:     'storefront',
        },
      })

      return reply.status(201).send({ id: entry.id })
    },
  )

  // GET /feedback — staff inbox. Rolling NPS + CSAT + suggestions feed.
  fastify.get<{ Querystring: { kind?: string; conceptId?: string; limit?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { kind, conceptId, limit } = req.query
      const where: Record<string, unknown> = {}
      if (kind && (FEEDBACK_KINDS as readonly string[]).includes(kind)) where.kind = kind
      if (conceptId) where.conceptId = conceptId

      const entries = await prisma.feedbackEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        // Cap pagination — an uncapped ?limit= is a free full-table dump + DoS.
        take: Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200),
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } },
          concept:  { select: { name: true, slug: true } },
        },
      })

      return entries
    },
  )

  // GET /feedback/summary — aggregates for the dashboard. NPS bucket counts
  // (promoters 9-10, passives 7-8, detractors 0-6), CSAT average, recent
  // open-suggestion count.
  //
  // Aggregates filter on `customerId: { not: null }`. Anonymous submissions
  // (no customer JWT) were being used to drag the public NPS/CSAT scores
  // arbitrarily — 30/hr per IP × a residential proxy pool was enough to
  // bury real signal. We still store the anonymous rows so staff can read
  // them in the inbox, but they no longer move the public scoreboard.
  fastify.get<{ Querystring: { conceptId?: string; days?: string } }>(
    '/summary',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const days = parseInt(req.query.days ?? '30', 10)
      const since = new Date(Date.now() - days * 86_400_000)
      const where = {
        createdAt: { gte: since },
        customerId: { not: null },
        ...(req.query.conceptId && { conceptId: req.query.conceptId }),
      } as const

      const [npsRows, csatAgg, openCount] = await Promise.all([
        prisma.feedbackEntry.findMany({
          where: { ...where, kind: 'nps', score: { not: null } },
          select: { score: true },
        }),
        prisma.feedbackEntry.aggregate({
          where: { ...where, kind: 'csat', score: { not: null } },
          _avg:   { score: true },
          _count: { _all: true },
        }),
        prisma.feedbackEntry.count({ where: { ...where, kind: 'open' } }),
      ])

      const promoters  = npsRows.filter((r) => (r.score ?? 0) >= 9).length
      const passives   = npsRows.filter((r) => (r.score ?? 0) >= 7 && (r.score ?? 0) <= 8).length
      const detractors = npsRows.filter((r) => (r.score ?? 0) <= 6).length
      const npsTotal   = npsRows.length
      const npsScore   = npsTotal > 0
        ? Math.round(((promoters - detractors) / npsTotal) * 100)
        : null

      return {
        period: { from: since.toISOString(), days },
        nps: {
          score: npsScore,
          total: npsTotal,
          promoters, passives, detractors,
        },
        csat: {
          average: csatAgg._avg.score != null ? Number(csatAgg._avg.score.toFixed(2)) : null,
          total:   csatAgg._count._all,
        },
        openSuggestions: openCount,
      }
    },
  )
}
