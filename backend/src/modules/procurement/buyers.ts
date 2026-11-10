// The buyers list, per company (owner, 2026-11-10: "Give option to add buyers and then select buyer when PO is being
// raised"; answer: a buyers list per company — any existing login of that company, e.g. a chef who also shops; "Not
// only CEO, anyone who's raising PO could select buyer").
//
//   GET   /procurement/buyers?active=1        the companies in view (PROCUREMENT_TEAM): {id, tenantId, userId, name, role, active}
//   GET   /procurement/buyers/candidates?q=   active logins of the ACTIVE company not on its list yet (managers)
//   POST  /procurement/buyers {userId}        add (managers, the ACTIVE company; an active login of it — 422
//                                             BUYER_NOT_IN_COMPANY; already listed and off → switched back on)
//   PATCH /procurement/buyers/:id {active}    switch off / on (managers; another company's row 404). Never deleted.
//
// Whoever raises a PO picks its buyer from the list of the PO's company (`buyerUserId` on POST / PATCH
// /procurement/purchase-orders — assertListedBuyer, 422 BUYER_NOT_LISTED); the CEO may still change it when approving
// (service.ts approvePo → resolvePoBuyer) or later (PUT /purchase-orders/:id/buyer). With none picked the approval
// falls back to the company's only listed buyer, else its only 'procurement' login, else the requester.
// Table po_buyers (tenantId, RLS, merge repoint — a login listed in both companies keeps the target's row).

import type { FastifyInstance } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { activeTenantOr422 } from './scope.js'

type Db = Prisma.TransactionClient | typeof prisma

const BUYER_EDITORS = MANAGERS as UserRole[]

const activeLoginWhere = (tenantId: string): Prisma.UserWhereInput => ({
  deletedAt: null, isActive: true, accountStatus: 'active',
  OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
})

/** The PO's buyer must be on the company's active buyers list (422 BUYER_NOT_LISTED). */
export async function assertListedBuyer(db: Db, tenantId: string, userId: string): Promise<void> {
  const row = await db.poBuyer.findFirst({ where: { tenantId, userId, active: true, user: activeLoginWhere(tenantId) }, select: { id: true } })
  if (!row) throw new AppError('BUYER_NOT_LISTED', 'Pick a buyer from this company\'s buyers list (Procurement → Buyers)', 422)
}

/** The company's only active listed buyer, if exactly one (the approval's fallback when no buyer was picked). */
export async function onlyListedBuyer(tenantId: string): Promise<string | null> {
  const rows = await prisma.poBuyer.findMany({ where: { tenantId, active: true, user: activeLoginWhere(tenantId) }, select: { userId: true }, take: 2 })
  return rows.length === 1 ? rows[0]!.userId : null
}

export async function registerBuyerRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { active?: string } }>('/buyers', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req) => {
    const { tenantIds } = await resolveTenantScope(req)
    const rows = await prisma.poBuyer.findMany({
      where: { tenantId: { in: tenantIds }, ...(req.query.active === '1' && { active: true }) },
      include: { user: { select: { name: true, email: true, role: true, isActive: true, deletedAt: true } } },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    })
    return rows
      .filter((r) => req.query.active !== '1' || (r.user.isActive && !r.user.deletedAt))
      .map((r) => ({
        id: r.id, tenantId: r.tenantId, userId: r.userId, active: r.active,
        name: r.user.name ?? r.user.email ?? 'Login', email: r.user.email, role: r.user.role,
        loginActive: r.user.isActive && !r.user.deletedAt,
      }))
  })

  fastify.get<{ Querystring: { q?: string } }>('/buyers/candidates', { preHandler: requireAuth(...BUYER_EDITORS) }, async (req) => {
    const tenantId = activeTenantOr422(req, null)
    const q = (req.query.q ?? '').trim().slice(0, 80)
    const listed = new Set((await prisma.poBuyer.findMany({ where: { tenantId, active: true }, select: { userId: true } })).map((r) => r.userId))
    const users = await prisma.user.findMany({
      where: {
        ...activeLoginWhere(tenantId), role: { notIn: ['director'] as UserRole[] },
        ...(q && { AND: [{ OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }] }),
      },
      select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' }, take: 200,
    })
    return users.filter((u) => !listed.has(u.id))
  })

  fastify.post('/buyers', { preHandler: requireAuth(...BUYER_EDITORS) }, async (req, reply) => {
    const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.body ?? {})
    const tenantId = activeTenantOr422(req, null)
    const user = await prisma.user.findFirst({ where: { id: userId, ...activeLoginWhere(tenantId), role: { notIn: ['director'] as UserRole[] } }, select: { id: true, name: true } })
    if (!user) throw new AppError('BUYER_NOT_IN_COMPANY', 'A buyer must be an active login of this company', 422)
    const existing = await prisma.poBuyer.findUnique({ where: { tenantId_userId: { tenantId, userId } } })
    if (existing?.active) return reply.status(200).send(existing)
    const row = existing
      ? await prisma.poBuyer.update({ where: { id: existing.id }, data: { active: true, addedById: req.staffUser!.id } })
      : await prisma.poBuyer.create({ data: { tenantId, userId, addedById: req.staffUser!.id } })
    await audit({
      category: 'accounting', action: 'procurement.buyer_add', entity: 'PoBuyer', entityId: row.id, tenantId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, after: { userId, name: user.name, active: true },
    })
    return reply.status(201).send(row)
  })

  fastify.patch<{ Params: { id: string } }>('/buyers/:id', { preHandler: requireAuth(...BUYER_EDITORS) }, async (req) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body ?? {})
    const row = await prisma.poBuyer.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!row) throw new NotFoundError('PoBuyer', req.params.id)
    if (row.active === active) return row
    const updated = await prisma.poBuyer.update({ where: { id: row.id }, data: { active } })
    await audit({
      category: 'accounting', action: active ? 'procurement.buyer_on' : 'procurement.buyer_off', entity: 'PoBuyer', entityId: row.id,
      tenantId: row.tenantId, userId: req.staffUser!.id, userEmail: req.staffUser!.email,
      before: { active: row.active }, after: { active }, metadata: { buyerUserId: row.userId },
    })
    return updated
  })
}
