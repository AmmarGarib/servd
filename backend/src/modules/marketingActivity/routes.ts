// Marketing activity surface — read-only views over the existing audit log,
// plus aggregate performance metrics. Lets owners track what their outside
// agency is producing in the platform.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MARKETING_TEAM, MANAGERS } from '../auth/middleware.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'

const MARKETING_ACTIONS = [
  'campaign.create', 'campaign.send', 'campaign.update',
  'promo.create', 'promo.update', 'promo.deactivate',
  'discount.create', 'discount.update',
  'concept.update',                    // brand edits
  'storefront.layout.update',
  'media.upload',
  'content_event.create', 'content_event.publish',
] as const

export async function marketingActivityRoutes(fastify: FastifyInstance) {
  // GET /marketing/activity — recent marketing actions
  // Query: ?userId — filter by user; ?days — lookback window (default 14)
  fastify.get<{ Querystring: { userId?: string; days?: string; limit?: string } }>(
    '/activity',
    { preHandler: requireAuth(...MANAGERS) },     // managers / admin track agency
    async (req) => {
      const days = Math.min(parseInt(req.query.days ?? '14', 10), 365)
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const since = new Date(Date.now() - days * 86_400_000)

      // Company-scoped: AuditLog.tenantId is the company the actor was working
      // in. Legacy rows with no company are not shown here.
      const rows = await prisma.auditLog.findMany({
        where: {
          ...(await scopeTenantWhere(req, 'read')),
          createdAt: { gte: since },
          action: { in: [...MARKETING_ACTIONS] },
          ...(req.query.userId && { userId: req.query.userId }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })

      return rows.map((r) => ({
        id:        r.id,
        action:    r.action,
        entity:    r.entity,
        entityId:  r.entityId,
        userId:    r.userId,
        userEmail: r.userEmail,
        before:    r.before,
        after:     r.after,
        metadata:  r.metadata,
        createdAt: r.createdAt,
      }))
    },
  )

  // GET /marketing/team — list of marketing-role users + their last activity
  fastify.get('/team', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const t = await scopeTenantWhere(req, 'read')
    const users = await prisma.user.findMany({
      // Company-scoped: only the active company's (or portfolio's) marketing staff.
      where: { role: 'marketing', isActive: true, ...t },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { name: 'asc' },
    })

    // Get each user's last marketing-action timestamp
    const lastSeen = await Promise.all(
      users.map(async (u) => {
        const last = await prisma.auditLog.findFirst({
          where: { userId: u.id, action: { in: [...MARKETING_ACTIONS] }, ...t },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, action: true },
        })
        return { userId: u.id, lastActionAt: last?.createdAt ?? null, lastAction: last?.action ?? null }
      }),
    )
    const map = new Map(lastSeen.map((s) => [s.userId, s]))
    return users.map((u) => ({ ...u, ...(map.get(u.id) ?? { lastActionAt: null, lastAction: null }) }))
  })

  // GET /marketing/performance — high-level aggregate (last N days)
  fastify.get<{ Querystring: { days?: string } }>(
    '/performance',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const days = Math.min(parseInt(req.query.days ?? '30', 10), 365)
      const since = new Date(Date.now() - days * 86_400_000)

      // Company-scoped throughout. Campaigns, promos, content events, media and
      // the audit log carry tenantId; a legacy promo / content event with no
      // company falls back to its brand's company (only when tenantId is null).
      // Rows with neither are nobody's and are not counted.
      const t = await scopeTenantWhere(req, 'read')
      const conceptScoped = { OR: [t, { AND: [{ tenantId: null }, { concept: t }] }] }
      const [campaigns, clickers, openers, promosCreated, promoUsages, contentEvents, mediaUploads, marketingActions] = await Promise.all([
        // Campaign sends — sentAt is when it actually went out
        prisma.campaignSend.count({ where: { sentAt: { gte: since }, campaign: t } }).catch(() => 0),
        // Unique clickers / openers (for CTR + open rate)
        prisma.campaignSend.count({ where: { sentAt: { gte: since }, firstClickedAt: { not: null }, campaign: t } }).catch(() => 0),
        prisma.campaignSend.count({ where: { sentAt: { gte: since }, firstOpenedAt: { not: null }, campaign: t } }).catch(() => 0),
        // Promos
        prisma.promoCode.count({ where: { createdAt: { gte: since }, ...conceptScoped } }).catch(() => 0),
        // Promo redemptions (impact)
        prisma.promoCodeUsage.count({ where: { usedAt: { gte: since }, promoCode: conceptScoped } }).catch(() => 0),
        // Calendar / content posts
        prisma.contentEvent.count({ where: { createdAt: { gte: since }, ...conceptScoped } }).catch(() => 0),
        // Marketing-category media
        prisma.mediaAsset.count({ where: { createdAt: { gte: since }, category: { in: ['marketing', 'shoot'] }, ...t } }).catch(() => 0),
        // Total marketing actions in audit log
        prisma.auditLog.count({ where: { createdAt: { gte: since }, action: { in: [...MARKETING_ACTIONS] }, ...t } }),
      ])

      return {
        windowDays: days,
        since:      since.toISOString(),
        campaigns,
        campaignClicks: clickers,
        campaignOpens:  openers,
        ctr:      campaigns > 0 ? Number(((clickers / campaigns) * 100).toFixed(1)) : null,
        openRate: campaigns > 0 ? Number(((openers / campaigns) * 100).toFixed(1)) : null,
        promosCreated,
        promoUsages,
        contentEvents,
        mediaUploads,
        totalActions: marketingActions,
      }
    },
  )
}
