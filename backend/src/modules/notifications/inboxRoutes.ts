// The notification bell's inbox (owner, 2026-10-16) — /api/v1/notifications/*.
//
// Every login has a bell: requireAuth(ALL_STAFF), no module gate (the prefix
// /notifications is not in GATED_PREFIXES; the broadcast routes in routes.ts
// gate themselves with requireModule('notifications')).
//
// Scope: the bell is PERSONAL across the user's companies, so it reads
// through serviceClient (RLS is narrowed to the ACTIVE company by the auth
// middleware). The wall is explicit and on every query:
//   userId = the caller  AND  ( tenantId ∈ member ∪ reach  OR  (admin AND tenantId IS NULL) )
// A company the user has left drops out at once; another login's id is a 404,
// never confirmed. Rows are only ever marked read — there is no create or
// delete route (lib/staffNotify.ts is the one writer; the worker retires old
// rows).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { reachTenantIds } from '../../lib/headOffice.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { NotFoundError } from '../../lib/errors.js'

const inboxQuery = z.object({
  cursor:  z.string().uuid().optional(),
  limit:   z.coerce.number().int().min(1).max(100).default(30),
  unread:  z.enum(['0', '1', 'true', 'false']).optional(),
  company: z.enum(['all', 'active']).default('all'),
})
const idParams = z.object({ id: z.string().uuid() })
const readAllBody = z.object({ before: z.string().datetime({ offset: true }).optional() }).nullish()

/** Pages that span the user's companies by themselves — a click never switches company for them. */
const SPANNING_PREFIXES = ['/ceo/approvals', '/exceptions', '/me', '/head-office']

/** The caller's wall (see the header). */
export function inboxScope(req: FastifyRequest): Prisma.StaffNotificationWhereInput {
  const su = req.staffUser!
  const companies = [...new Set([...(su.memberTenantIds ?? []), ...reachTenantIds(req)])]
  return {
    userId: su.id,
    OR: [
      { tenantId: { in: companies } },
      ...(su.role === 'admin' ? [{ tenantId: null }] : []),
    ],
  }
}

/** Should the client switch to the row's company before opening the link? */
export function needsCompanySwitch(link: string | null, tenantId: string | null): boolean {
  if (!link || !tenantId) return false
  return !SPANNING_PREFIXES.some((p) => link === p || link.startsWith(`${p}/`) || link.startsWith(`${p}?`))
}

async function unreadCount(req: FastifyRequest): Promise<number> {
  return serviceClient.staffNotification.count({ where: { AND: [inboxScope(req), { readAt: null }] } })
}

export async function notificationInboxRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAuth(...ALL_STAFF) }

  // GET /notifications/inbox — newest first, cursor = the last id of the previous page.
  fastify.get('/inbox', guard, async (req) => {
    const q = inboxQuery.parse(req.query ?? {})
    const and: Prisma.StaffNotificationWhereInput[] = [inboxScope(req)]
    if (q.unread === '1' || q.unread === 'true') and.push({ readAt: null })
    if (q.company === 'active') {
      const scope = await resolveTenantScope(req)
      and.push({ tenantId: { in: scope.tenantIds } })   // empty scope → nothing (deny)
    }
    if (q.cursor) {
      const at = await serviceClient.staffNotification.findFirst({
        where: { AND: [inboxScope(req), { id: q.cursor }] },
        select: { id: true, createdAt: true },
      })
      if (!at) throw new NotFoundError('Notification')
      and.push({
        OR: [
          { createdAt: { lt: at.createdAt } },
          { createdAt: at.createdAt, id: { lt: at.id } },
        ],
      })
    }
    const rows = await serviceClient.staffNotification.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: {
        id: true, kind: true, severity: true, title: true, body: true, link: true,
        tenantId: true, createdAt: true, readAt: true,
      },
    })
    const page = rows.slice(0, q.limit)
    const tenantIds = [...new Set(page.map((r) => r.tenantId).filter((t): t is string => !!t))]
    const tenants = tenantIds.length > 0
      ? await serviceClient.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
      : []
    const names = new Map(tenants.map((t) => [t.id, t.name]))
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        title: r.title,
        body: r.body,
        link: r.link,
        switchCompany: needsCompanySwitch(r.link, r.tenantId),
        tenantId: r.tenantId,
        companyName: r.tenantId ? names.get(r.tenantId) ?? null : null,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt ? r.readAt.toISOString() : null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      unread: await unreadCount(req),
    }
  })

  // GET /notifications/unread-count — the badge (partial index staff_notifications_unread_idx).
  fastify.get('/unread-count', guard, async (req) => ({ unread: await unreadCount(req) }))

  // POST /notifications/:id/read — mark one read. Another login's id (or one
  // outside the caller's companies) is 404; already read is 200.
  fastify.post('/:id/read', guard, async (req) => {
    const { id } = idParams.parse(req.params)
    const scope = inboxScope(req)
    const res = await serviceClient.staffNotification.updateMany({
      where: { AND: [scope, { id, readAt: null }] },
      data: { readAt: new Date() },
    })
    if (res.count === 0) {
      const mine = await serviceClient.staffNotification.findFirst({ where: { AND: [scope, { id }] }, select: { id: true } })
      if (!mine) throw new NotFoundError('Notification')
    }
    return { ok: true }
  })

  // POST /notifications/read-all { before? } — only rows created at or before
  // `before` (default now), so one arriving mid-click stays unread.
  fastify.post('/read-all', guard, async (req) => {
    const body = readAllBody.parse(req.body ?? null)
    const before = body?.before ? new Date(body.before) : new Date()
    const res = await serviceClient.staffNotification.updateMany({
      where: { AND: [inboxScope(req), { readAt: null, createdAt: { lte: before } }] },
      data: { readAt: new Date() },
    })
    return { updated: res.count }
  })
}
