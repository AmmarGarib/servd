// Social pages per brand — routes (owner C18, 2026-10-26). Contract: service.ts header.
//
//   GET  /social-connections                       each brand in view: approved + pending page (hints only)
//   POST /social-connections/:conceptId/connect    → { url } Meta OAuth for THIS brand (Marketing)
//   GET  /social-connections/requests?status=pending   the CEO's queue (the approvals inbox reads it)
//   POST /social-connections/requests/:id/approve  {pageId}  CEO only — 409 CONNECTION_CHANGED if it moved
//   POST /social-connections/requests/:id/reject   {pageId, note}  CEO only
//   GET  /integrations/social/callback             public: Meta calls it (registered redirect URI, unchanged)
//
// Who: MARKETING_TEAM (+ IT reads) holding `calendar` or `brands` (social posts are made in the Calendar; the
// brand's identity is Marketing's — CLAUDE.md "Brand info is Marketing's"). Company scope: a brand of another
// company is 404 (lib/tenantScope.ts assertConceptOwned); a request of another company is 404.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { serviceClient } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { requireAuth, MARKETING_TEAM, ADMIN_ONLY } from '../auth/middleware.js'
import { CONNECTOR_ADMINS } from '../../lib/connectorRoles.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { getOAuthUrl, exchangeCodeForTokens } from '../../lib/meta-social.js'
import { connectionView, sealToken } from './service.js'

const READERS = [...MARKETING_TEAM, ...CONNECTOR_ADMINS] as typeof MARKETING_TEAM
const MODULES = ['calendar', 'brands']

const apiUrl = () => process.env['API_URL'] ?? 'http://localhost:3001'
const webUrl = () => process.env['WEB_URL'] ?? 'http://localhost:3000'
export const SOCIAL_CALLBACK_PATH = '/api/v1/integrations/social/callback'
const RETURN_PAGE = '/calendar/social'

const VIEW_SELECT = {
  id: true, tenantId: true, conceptId: true, status: true, pageId: true, pageName: true, igUserId: true,
  tokenHint: true, requestedById: true, requestedAt: true, decidedById: true, decidedAt: true, decisionNote: true,
} as const

interface OAuthState { userId: string; conceptId: string; tenantId: string }

/**
 * Store a connection the OAuth flow found. A CEO's own connect is the approval
 * (owner: "Approval goes thru me") — applied at once and audited; anyone
 * else's replaces the brand's pending one and waits for the CEO.
 */
export async function recordConnection(
  st: OAuthState & { role: string },
  found: { pageId: string; pageName: string; igUserId: string | null; pageToken: string },
): Promise<{ id: string; status: 'pending' | 'approved' }> {
  const sealed = sealToken(found.pageToken)
  const ceo = st.role === 'admin'
  const row = await serviceClient.$transaction(async (tx) => {
    await tx.socialConnection.updateMany({ where: { conceptId: st.conceptId, status: 'pending' }, data: { status: 'superseded' } })
    if (ceo) await tx.socialConnection.updateMany({ where: { conceptId: st.conceptId, status: 'approved' }, data: { status: 'superseded' } })
    return tx.socialConnection.create({
      data: {
        tenantId: st.tenantId, conceptId: st.conceptId, status: ceo ? 'approved' : 'pending',
        pageId: found.pageId, pageName: found.pageName, igUserId: found.igUserId,
        token: sealed.value, tokenHint: sealed.hint, requestedById: st.userId,
        ...(ceo ? { decidedById: st.userId, decidedAt: new Date() } : {}),
      },
      select: { id: true, requestedAt: true },
    })
  })
  await audit({
    category: 'identity', action: ceo ? 'social_connection.connect_approved' : 'social_connection.connect',
    entity: 'SocialConnection', entityId: row.id, userId: st.userId, userEmail: null, tenantId: st.tenantId,
    metadata: { conceptId: st.conceptId, pageId: found.pageId, pageName: found.pageName, instagram: !!found.igUserId, via: ceo ? 'ceo_connect' : 'marketing' },
  })
  if (!ceo) approvalWaiting('social_connection', row.id, { round: row.requestedAt.toISOString(), actorId: st.userId })
  return { id: row.id, status: ceo ? 'approved' : 'pending' }
}

export async function socialConnectionRoutes(fastify: FastifyInstance) {
  // GET /social-connections — every brand in view with its approved and pending page.
  fastify.get('/', { preHandler: [requireAuth(...READERS), requireModule(...MODULES, 'integrations')] }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const brands = await serviceClient.concept.findMany({
      where: { deletedAt: null, ...scope },
      select: { id: true, name: true, tenantId: true, isActive: true },
      orderBy: { name: 'asc' },
    })
    const ids = brands.map((b) => b.id)
    const rows = ids.length === 0 ? [] : await serviceClient.socialConnection.findMany({
      where: { conceptId: { in: ids }, status: { in: ['approved', 'pending', 'rejected'] } },
      select: VIEW_SELECT,
      orderBy: { requestedAt: 'desc' },
    })
    const legacy = req.staffUser!.role === 'admin'
      ? await serviceClient.socialConnection.findFirst({ where: { status: 'legacy' }, select: { id: true, pageName: true, tokenHint: true, requestedAt: true } })
      : null
    return {
      configured: Boolean(process.env['FACEBOOK_APP_ID'] && process.env['FACEBOOK_APP_SECRET']),
      redirectUri: `${apiUrl()}${SOCIAL_CALLBACK_PATH}`,
      legacy,
      brands: brands.map((b) => {
        const mine = rows.filter((r) => r.conceptId === b.id)
        const approved = mine.find((r) => r.status === 'approved') ?? null
        const pending = mine.find((r) => r.status === 'pending') ?? null
        const lastRejected = mine.find((r) => r.status === 'rejected') ?? null
        return {
          conceptId: b.id, name: b.name, tenantId: b.tenantId, isActive: b.isActive,
          approved, pending,
          rejected: lastRejected && (!pending || lastRejected.requestedAt > pending.requestedAt) ? lastRejected : null,
        }
      }),
    }
  })

  // POST /social-connections/:conceptId/connect — start Meta OAuth for this brand.
  fastify.post<{ Params: { conceptId: string } }>(
    '/:conceptId/connect',
    { preHandler: [requireAuth(...MARKETING_TEAM), requireModule(...MODULES)] },
    async (req) => {
      const concept = await assertConceptOwned(req, req.params.conceptId, 'write')
      if (!concept.tenantId) throw new NotFoundError('Concept', req.params.conceptId)
      const state = randomBytes(32).toString('hex')
      const st: OAuthState = { userId: req.staffUser!.id, conceptId: concept.id, tenantId: concept.tenantId }
      // One-time CSRF state, tied to the operator AND the brand, valid 10 minutes. The callback refuses anything else.
      await redis.setex(`social:oauth:${state}`, 600, JSON.stringify(st))
      const url = await getOAuthUrl(`${apiUrl()}${SOCIAL_CALLBACK_PATH}`, state)
      return { url }
    },
  )

  // GET /social-connections/requests?status=pending — connections waiting for the CEO (the inbox reads this).
  fastify.get<{ Querystring: { status?: string } }>(
    '/requests',
    { preHandler: [requireAuth(...READERS), requireModule(...MODULES)] },
    async (req) => {
      const scope = await scopeTenantWhere(req, 'read')
      const status = req.query.status === 'pending' ? 'pending' : undefined
      const rows = await serviceClient.socialConnection.findMany({
        where: { ...scope, ...(status ? { status } : { status: { not: 'legacy' } }) },
        select: VIEW_SELECT,
        orderBy: { requestedAt: 'asc' },
        take: 200,
      })
      const conceptIds = [...new Set(rows.map((r) => r.conceptId).filter((x): x is string => !!x))]
      const userIds = [...new Set(rows.flatMap((r) => [r.requestedById]).filter((x): x is string => !!x))]
      const [brands, users, approved] = await Promise.all([
        serviceClient.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }),
        serviceClient.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
        serviceClient.socialConnection.findMany({ where: { conceptId: { in: conceptIds }, status: 'approved' }, select: { conceptId: true, pageName: true, pageId: true } }),
      ])
      const brandName = new Map(brands.map((b) => [b.id, b.name]))
      const userName = new Map(users.map((u) => [u.id, u.name]))
      const current = new Map(approved.map((a) => [a.conceptId, a]))
      return {
        items: rows.map((r) => ({
          ...connectionView(r),
          brandName: r.conceptId ? brandName.get(r.conceptId) ?? null : null,
          requestedByName: r.requestedById ? userName.get(r.requestedById) ?? null : null,
          currentApproved: r.conceptId && current.get(r.conceptId) ? { pageId: current.get(r.conceptId)!.pageId, pageName: current.get(r.conceptId)!.pageName } : null,
        })),
      }
    },
  )

  const decision = z.object({
    // The page the CEO is looking at: refused (409 CONNECTION_CHANGED) when the brand was reconnected since.
    pageId: z.string().min(1).max(100),
    note: z.string().trim().max(500).optional(),
  })

  async function forDecision(req: FastifyRequest, id: string, pageId: string) {
    const row = await serviceClient.socialConnection.findFirst({
      where: { id, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true, tenantId: true, conceptId: true, status: true, pageId: true, pageName: true },
    })
    if (!row || !row.tenantId || !row.conceptId) throw new NotFoundError('SocialConnection', id)
    const s = await approvalSubject('social_connection', row.id)
    if (!s) throw new NotFoundError('SocialConnection', id)
    const grant = await assertCanApprove(req, approvalInputOf('social_connection', row.id, s))
    if (row.status !== 'pending') throw new AppError('CONNECTION_NOT_PENDING', 'This page connection is not waiting for approval', 409)
    if (row.pageId !== pageId) throw new AppError('CONNECTION_CHANGED', 'The page connection changed while you were looking — open it again', 409)
    return { row: row as typeof row & { tenantId: string; conceptId: string }, grant }
  }

  // POST /social-connections/requests/:id/approve — the CEO approves; it replaces the brand's approved page.
  fastify.post<{ Params: { id: string } }>('/requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = decision.parse(req.body ?? {})
    const { row, grant } = await forDecision(req, req.params.id, body.pageId)
    const ok = await serviceClient.$transaction(async (tx) => {
      const claimed = await tx.socialConnection.updateMany({
        where: { id: row.id, status: 'pending', pageId: body.pageId },
        data: { status: 'superseded' }, // parked for the swap below (the one-approved index)
      })
      if (claimed.count === 0) return false
      await tx.socialConnection.updateMany({ where: { conceptId: row.conceptId, status: 'approved' }, data: { status: 'superseded' } })
      await tx.socialConnection.update({
        where: { id: row.id },
        data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note ?? null },
      })
      return true
    })
    if (!ok) throw new AppError('CONNECTION_CHANGED', 'The page connection changed while you were looking — open it again', 409)
    await auditApproval(req, {
      type: 'social_connection', id: row.id, tenantId: row.tenantId, decision: 'approve', grant, entity: 'SocialConnection',
      metadata: { conceptId: row.conceptId, pageId: row.pageId, pageName: row.pageName, note: body.note ?? null },
    })
    return { id: row.id, approved: true }
  })

  // POST /social-connections/requests/:id/reject {note} — the brand's approved page (if any) stays in force.
  fastify.post<{ Params: { id: string } }>('/requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = decision.extend({ note: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    const { row, grant } = await forDecision(req, req.params.id, body.pageId)
    const n = await serviceClient.socialConnection.updateMany({
      where: { id: row.id, status: 'pending', pageId: body.pageId },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note },
    })
    if (n.count === 0) throw new AppError('CONNECTION_CHANGED', 'The page connection changed while you were looking — open it again', 409)
    await auditApproval(req, {
      type: 'social_connection', id: row.id, tenantId: row.tenantId, decision: 'reject', grant, entity: 'SocialConnection',
      metadata: { conceptId: row.conceptId, pageId: row.pageId, note: body.note },
    })
    return { id: row.id, rejected: true }
  })
}

/** The public OAuth callback (Meta calls it). Registered at /api/v1/integrations/social/callback. */
export async function socialCallbackRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { code?: string; error?: string; state?: string } }>('/callback', async (req, reply) => {
    const back = (q: string) => reply.redirect(`${webUrl()}${RETURN_PAGE}?${q}`)
    if (req.query.error) return back(`social_error=${encodeURIComponent(req.query.error)}`)
    if (!req.query.code) return back('social_error=no_code')
    const state = req.query.state
    if (!state) return back('social_error=missing_state')
    // Only finish a flow this server started; the state is consumed on first use.
    let st: OAuthState | null = null
    try {
      const raw = await redis.get(`social:oauth:${state}`)
      if (raw) {
        await redis.del(`social:oauth:${state}`)
        const v = JSON.parse(raw) as Partial<OAuthState>
        if (v && typeof v.userId === 'string' && typeof v.conceptId === 'string' && typeof v.tenantId === 'string') st = v as OAuthState
      }
    } catch { st = null }
    if (!st) return back('social_error=invalid_state')
    try {
      // The operator who started it must still be an active login, the brand still that company's.
      const [user, concept] = await Promise.all([
        serviceClient.user.findFirst({ where: { id: st.userId, isActive: true, accountStatus: 'active', deletedAt: null }, select: { role: true } }),
        serviceClient.concept.findFirst({ where: { id: st.conceptId, tenantId: st.tenantId, deletedAt: null }, select: { name: true } }),
      ])
      if (!user || !concept) return back('social_error=invalid_state')
      const found = await exchangeCodeForTokens(req.query.code, `${apiUrl()}${SOCIAL_CALLBACK_PATH}`, concept.name)
      const res = await recordConnection({ ...st, role: user.role }, found)
      return back(`social_connected=${encodeURIComponent(found.pageName)}&status=${res.status}`)
    } catch (err) {
      return back(`social_error=${encodeURIComponent((err as Error).message)}`)
    }
  })
}
