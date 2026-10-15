// Feedback API.
//
// Distinct from /reviews (per-order rating) and /complaints (formal
// grievance). FeedbackEntry is for one-tap NPS / CSAT / open-suggestion
// signals — the kind of micro-feedback that drives a marketing funnel.
//
// Public POST is rate-limited per-IP to discourage abuse but does not
// require auth — anonymous suggestions land too. Auth, if present, links the
// entry to a Customer for personalized follow-up.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { conceptWhere, scopeTenantWhere } from '../../lib/tenantScope.js'
import { verifyCustomerToken } from '../auth/service.js'
import { publicBrandWhere } from '../../lib/publicBrands.js'
import { primaryTenantId } from '../../lib/setup-config.js'
import { contactAddressOver, contactIdentityOver } from './contactLimit.js'

const FEEDBACK_KINDS = ['nps', 'csat', 'open', 'contact'] as const
/** Topics the public contact form offers (SEO round 1, WP4). */
export const CONTACT_TOPICS = ['catering', 'complaint', 'press', 'jobs', 'other'] as const

// Reply phone: digits with the usual separators, 7-20 digits (+92 21 ..., 0300-...).
const PHONE_RE = /^\+?[0-9][0-9 ()\-]{5,24}[0-9]$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const clean = (v: string | null | undefined, max: number) => {
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
  return t || null
}

type ContactBody = {
  comment?: string | null; conceptId?: string | null; brandSlug?: string | null
  name?: string | null; replyPhone?: string | null; replyEmail?: string | null
  topic?: (typeof CONTACT_TOPICS)[number] | null; website?: string | null
}

const bad = (reply: FastifyReply, code: string, message: string, status = 422) =>
  reply.status(status).send({ error: { code, message } })

// POST /feedback with kind 'contact' — the public contact form. Stored in the
// same inbox as other feedback; the company is the chosen brand's (resolved
// here from a live, public brand), else the primary company. Nothing is sent
// to the reply address on submit.
async function submitContact(req: FastifyRequest, reply: FastifyReply, body: ContactBody) {
  // Honeypot: bots fill every field. Answer as if it worked, store nothing.
  if (body.website && body.website.trim()) return reply.status(201).send({ id: null })

  const name = clean(body.name, 120)
  const message = clean(body.comment, 2000)
  const phone = clean(body.replyPhone, 40)
  const email = clean(body.replyEmail, 200)?.toLowerCase() ?? null
  if (!name) return bad(reply, 'NAME_REQUIRED', 'Please tell us your name')
  if (!message || message.length < 10) return bad(reply, 'MESSAGE_TOO_SHORT', 'Please write at least a sentence')
  if (!phone && !email) return bad(reply, 'REPLY_CONTACT_REQUIRED', 'Give a phone number or an email so we can reply')
  if (phone && !PHONE_RE.test(phone)) return bad(reply, 'BAD_PHONE', 'That phone number does not look right')
  if (email && !EMAIL_RE.test(email)) return bad(reply, 'BAD_EMAIL', 'That email address does not look right')
  if (!body.topic) return bad(reply, 'TOPIC_REQUIRED', 'Pick a topic')
  const replyPhone = phone ? phone.replace(/[^0-9+]/g, '') : null

  // Caps BEFORE anything is stored.
  if ((await contactAddressOver(req.ip)) || (await contactIdentityOver(replyPhone, email))) {
    return bad(reply, 'RATE_LIMITED', 'Too many messages — please try again in an hour', 429)
  }

  // The brand (optional) decides the company. A client tenant is never read.
  let conceptId: string | null = null
  let tenantId: string | null = null
  if (body.conceptId || body.brandSlug) {
    const concept = await prisma.concept.findFirst({
      where: {
        isActive: true, deletedAt: null, storefrontVisible: true, tenantId: { not: null },
        ...publicBrandWhere(),
        ...(body.conceptId ? { id: body.conceptId } : { slug: body.brandSlug! }),
      },
      select: { id: true, tenantId: true },
    })
    if (!concept) return bad(reply, 'BRAND_NOT_FOUND', 'That brand is not taking messages')
    conceptId = concept.id
    tenantId = concept.tenantId
  } else {
    tenantId = await primaryTenantId()
  }
  if (!tenantId) return bad(reply, 'NO_COMPANY', 'Messages are not being accepted right now', 503)

  let customerId: string | null = null
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    try { customerId = verifyCustomerToken(auth.slice(7)).sub } catch { /* anonymous is fine */ }
  }

  const entry = await prisma.feedbackEntry.create({
    data: {
      tenantId, conceptId, customerId,
      kind: 'contact', comment: message, source: 'contact_page',
      contactName: name, replyPhone, replyEmail: email, topic: body.topic,
    },
  })
  return reply.status(201).send({ id: entry.id })
}

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
        // Contact form only. The brand can be named by slug too (brand pages
        // know their slug, not their id).
        brandSlug: z.string().max(80).nullable().optional(),
        name:      z.string().max(120).nullable().optional(),
        replyPhone: z.string().max(40).nullable().optional(),
        replyEmail: z.string().max(200).nullable().optional(),
        topic:     z.enum(CONTACT_TOPICS).nullable().optional(),
        // Spam honeypot: a hidden field real visitors never fill.
        website:   z.string().max(500).nullable().optional(),
        context:   z.record(z.string(), z.unknown()).nullable().optional(),
      }).parse(req.body)

      if (body.kind === 'contact') return submitContact(req, reply, body)

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

      // Company is the brand's, resolved on the server — never from the client.
      let tenantId: string | null = null
      if (body.conceptId) {
        const c = await prisma.concept.findFirst({ where: { id: body.conceptId, deletedAt: null }, select: { tenantId: true } })
        tenantId = c?.tenantId ?? null
      }

      const entry = await prisma.feedbackEntry.create({
        data: {
          tenantId,
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
  fastify.get<{ Querystring: { kind?: string; conceptId?: string; limit?: string; topic?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { kind, conceptId, limit, topic } = req.query
      // Company scope. There was none: `where` started empty and a client
      // conceptId was used on trust, so any staff member of any company could
      // read every company's feedback — and the include below carries the
      // submitter's name, email and phone. Rows carry their own company
      // (`tenantId`, set from the brand on the server), so a message with no
      // brand (a contact message to the company) is scoped too. A client
      // conceptId must be a brand of the operator's companies (else 404).
      const tenant = await scopeTenantWhere(req, 'read')
      const cw = await conceptWhere(req, conceptId, 'read')
      const where: Record<string, unknown> = conceptId
        ? { ...tenant, ...cw }
        : { ...tenant, OR: [cw, { conceptId: null }] }
      if (kind && (FEEDBACK_KINDS as readonly string[]).includes(kind)) where.kind = kind
      if (topic && (CONTACT_TOPICS as readonly string[]).includes(topic)) where.topic = topic

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
      // Scoped for the same reason as the list above — without it the NPS and
      // CSAT headline numbers were computed across every company's feedback,
      // so one operator's scoreboard moved when another operator's guests
      // rated them.
      const where = {
        createdAt: { gte: since },
        customerId: { not: null },
        ...(await scopeTenantWhere(req, 'read')),
        ...(await conceptWhere(req, req.query.conceptId, 'read')),
      }

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
