// Tip pool — sums Order.tipCents collected during the period, distributes
// across staff present in the period weighted by hours × role weight, and
// posts the journal:
//   On post: records member shareCents (no JE — the liability already exists
//            from order completion).
//   On pay:  Dr 2095 Tips Payable / Cr Bank or Cash for total disbursed.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, APPROVERS, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'

const ROLE_WEIGHT_DEFAULT: Record<string, number> = {
  admin:     0,    // typically out of pool
  manager:   1.0,
  cashier:   1.0,
  expediter: 1.0,
  kitchen:   0.5,  // BOH gets half-share by convention
}

export async function tipPoolRoutes(fastify: FastifyInstance) {
  // List
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => prisma.tipPool.findMany({
      where: { ...(req.query.conceptId && { conceptId: req.query.conceptId }) },
      orderBy: { periodStart: 'desc' },
      include: { _count: { select: { members: true } } },
      take: 50,
    }),
  )

  // GET /tip-pools/:id — full pool with members
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const pool = await prisma.tipPool.findUnique({
        where: { id: req.params.id },
        include: { members: { orderBy: { userName: 'asc' } } },
      })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      return pool
    },
  )

  // Compute draft pool — pulls tips from completed orders + hours from clock
  // logs in the period. Operator can adjust before posting.
  fastify.post<{ Body: { conceptId?: string; name: string; periodStart: string; periodEnd: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        conceptId: z.string().uuid().nullable().optional(),
        name: z.string().min(1).max(80),
        periodStart: z.string().datetime(),
        periodEnd:   z.string().datetime(),
      }).parse(req.body)

      const periodStart = new Date(body.periodStart)
      const periodEnd   = new Date(body.periodEnd)

      // Sum tips from orders completed in window
      const tipAgg = await prisma.order.aggregate({
        where: {
          status: { in: ['completed', 'refunded'] },  // tip stays even on refund — liability owed to staff
          completedAt: { gte: periodStart, lte: periodEnd },
          ...(body.conceptId && { conceptId: body.conceptId }),
          deletedAt: null,
        },
        _sum: { tipCents: true },
      })
      const totalTips = tipAgg._sum.tipCents ?? 0

      // Pull users with clock logs in the window
      const events = await prisma.clockLog.findMany({
        where: { recordedAt: { gte: periodStart, lte: periodEnd } },
        orderBy: [{ userId: 'asc' }, { recordedAt: 'asc' }],
        select: { userId: true, type: true, recordedAt: true },
      })
      // Pair in/out into hours per user
      const byUser = new Map<string, { ms: number; openIn: Date | null }>()
      for (const e of events) {
        const slot = byUser.get(e.userId) ?? { ms: 0, openIn: null }
        if (e.type === 'in') slot.openIn = e.recordedAt
        else if (e.type === 'out' && slot.openIn) {
          slot.ms += Math.max(0, e.recordedAt.getTime() - slot.openIn.getTime())
          slot.openIn = null
        }
        byUser.set(e.userId, slot)
      }

      const userIds = Array.from(byUser.keys())
      const users = userIds.length > 0
        ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, role: true } })
        : []

      return prisma.$transaction(async (tx) => {
        const pool = await tx.tipPool.create({
          data: {
            conceptId:    body.conceptId ?? null,
            name:         body.name,
            periodStart, periodEnd,
            totalTipsCents: totalTips,
            createdById:  req.staffUser?.id ?? null,
          },
        })
        for (const u of users) {
          const slot = byUser.get(u.id)!
          const hours = slot.ms / 3_600_000
          const weight = ROLE_WEIGHT_DEFAULT[u.role] ?? 0
          if (hours <= 0 || weight <= 0) continue
          await tx.tipPoolMember.create({
            data: {
              poolId:      pool.id,
              userId:      u.id,
              userName:    u.name,
              hoursWorked: Number(hours.toFixed(2)),
              roleWeight:  weight,
              shareUnits:  Number((hours * weight).toFixed(3)),
              shareCents:  0,
            },
          })
        }
        return tx.tipPool.findUnique({
          where: { id: pool.id },
          include: { members: { orderBy: { userName: 'asc' } } },
        })
      }).then((r) => reply.status(201).send(r))
    },
  )

  // Adjust a member share manually
  fastify.patch<{ Params: { memberId: string }; Body: { shareUnits?: number; notes?: string } }>(
    '/members/:memberId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        shareUnits: z.number().min(0).max(1000).optional(),
        notes: z.string().max(300).optional(),
      }).parse(req.body)
      return prisma.tipPoolMember.update({ where: { id: req.params.memberId }, data: body })
    },
  )

  // Post — locks the pool, computes per-member shareCents, no JE (liability
  // is already on the books from each order's tip).
  fastify.post<{ Params: { id: string } }>(
    '/:id/post',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const pool = await prisma.tipPool.findUnique({ where: { id: req.params.id }, include: { members: true } })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      if (pool.status !== 'draft') throw new AppError('ALREADY_POSTED', `Pool is ${pool.status}`, 422)

      const totalUnits = pool.members.reduce((s, m) => s + m.shareUnits, 0)
      if (totalUnits <= 0) throw new AppError('NO_UNITS', 'Pool has no shareable hours', 422)

      // Distribute totalTipsCents proportionally; residue to last member
      let allocated = 0
      const updates = pool.members.map((m, i) => {
        const isLast = i === pool.members.length - 1
        const share = isLast
          ? pool.totalTipsCents - allocated
          : Math.floor((pool.totalTipsCents * m.shareUnits) / totalUnits)
        allocated += share
        return prisma.tipPoolMember.update({ where: { id: m.id }, data: { shareCents: share } })
      })
      await prisma.$transaction(updates)
      const updated = await prisma.tipPool.update({
        where: { id: pool.id },
        data: { status: 'posted', postedAt: new Date() },
        include: { members: { orderBy: { userName: 'asc' } } },
      })
      await audit({
        action: 'tippool.post', entity: 'TipPool', entityId: pool.id,
        userId: req.staffUser?.id ?? null, userEmail: req.staffUser?.email ?? null,
        after: { totalCents: pool.totalTipsCents, members: updated.members.length },
      })

      // Per-member audit row so each individual share is independently
      // verifiable. Without this, a manager could quietly give themselves a
      // bigger cut and the pool-level audit log wouldn't show it.
      for (const m of updated.members) {
        await audit({
          action: 'tippool.distribute',
          entity: 'TipPoolMember',
          entityId: m.id,
          userId: req.staffUser?.id ?? null,
          userEmail: req.staffUser?.email ?? null,
          after: { recipient: m.userName, recipientId: m.userId, units: m.shareUnits, cents: m.shareCents },
          metadata: { tipPoolId: pool.id, totalPool: pool.totalTipsCents },
        })
      }

      // Outlier flag: if any member is taking > 40% of the pool, flag.
      // Indicates either a real high-units worker (legit, reviewer can
      // resolve) or a manipulated split.
      const big = updated.members.find((m) => m.shareCents > pool.totalTipsCents * 0.4)
      if (big && updated.members.length >= 3) {
        const { flagException } = await import('../../lib/exceptions.js')
        await flagException({
          kind: 'high_value_void',
          severity: 'medium',
          title: `Tip pool: ${big.userName} taking ${((big.shareCents / pool.totalTipsCents) * 100).toFixed(0)}%`,
          description: `${big.userName} took ${((big.shareCents / pool.totalTipsCents) * 100).toFixed(0)}% of a PKR ${(pool.totalTipsCents / 100).toFixed(0)} pool across ${updated.members.length} members. Confirm units (${big.shareUnits}) reflect actual hours/role.`,
          entityType: 'TipPool',
          entityId: pool.id,
          actorId: req.staffUser?.id ?? null,
          amountCents: big.shareCents,
          metadata: { recipient: big.userName, totalCents: pool.totalTipsCents, units: big.shareUnits, memberCount: updated.members.length },
        })
      }

      return updated
    },
  )

  // Pay — disburses funds. Posts: Dr 2095 / Cr Bank.
  fastify.post<{ Params: { id: string }; Body: { paidFromAccountCode?: string } }>(
    '/:id/pay',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const body = z.object({ paidFromAccountCode: z.string().optional() }).parse(req.body)
      const pool = await prisma.tipPool.findUnique({ where: { id: req.params.id } })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      if (pool.status !== 'posted') throw new AppError('NOT_POSTABLE', `Pool is ${pool.status}`, 422)

      const cashAccount = body.paidFromAccountCode ?? ACCT.BANK
      const payoutTenantId = pool.conceptId
        ? (await prisma.concept.findUnique({ where: { id: pool.conceptId }, select: { tenantId: true } }))?.tenantId ?? req.staffUser!.tenantId
        : req.staffUser!.tenantId
      if (!payoutTenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before paying out a tip pool', 422)
      await postJournalEntry({
        tenantId: payoutTenantId,
        sourceType: 'tippool.payout',
        sourceId: pool.id,
        description: `Tip pool payout · ${pool.name}`,
        entryDate: new Date(),
        postedBy: req.staffUser?.id ?? 'system',
        lines: [
          { accountCode: ACCT.TIPS_PAYABLE, type: 'debit',  amountCents: pool.totalTipsCents, memo: 'Tips disbursed' },
          { accountCode: cashAccount,        type: 'credit', amountCents: pool.totalTipsCents, memo: 'Tips paid out' },
        ],
      })
      return prisma.tipPool.update({
        where: { id: pool.id },
        data: { status: 'paid', paidAt: new Date() },
      })
    },
  )
}
