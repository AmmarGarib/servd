// Marketing activity surface — read-only views over the existing audit log,
// plus aggregate performance metrics. Lets owners track what their outside
// agency is producing in the platform.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MARKETING_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
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

// Module Access really closes these staff routes (W3A-RV-03): the role array
// lets the Marketing team in, and the CEO's Module Access (decision 34)
// narrows it to logins holding marketing_workspace (Activity log). Same source of truth as the
// central gate (lib/moduleAccess.ts effectiveModulesForUser).
const marketingGuard = [requireAuth(...MARKETING_TEAM), requireModule('marketing_workspace')]

export async function marketingActivityRoutes(fastify: FastifyInstance) {
  // GET /marketing/activity — recent marketing actions
  // Query: ?userId — filter by user; ?days — lookback window (default 14)
  fastify.get<{ Querystring: { userId?: string; days?: string; limit?: string } }>(
    '/activity',
    // The Marketing workspace's own Activity log (module marketing_workspace):
    // MARKETING_TEAM — managers / admin track the agency, the team sees its own
    // company's work. Company-scoped below whatever the role.
    { preHandler: marketingGuard },
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

  // GET /marketing/team — the Marketing workspace's people (marketing and
  // brand_manager logins) + their last activity. Names and emails only.
  fastify.get('/team', { preHandler: marketingGuard }, async (req) => {
    const t = await scopeTenantWhere(req, 'read')
    const users = await prisma.user.findMany({
      // Company-scoped: only the active company's (or portfolio's) marketing staff.
      where: { role: { in: ['marketing', 'brand_manager'] }, isActive: true, ...t },
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
    { preHandler: marketingGuard },
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
