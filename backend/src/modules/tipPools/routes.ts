// Tip pool — sums Order.tipCents a brand collected during the period,
// distributes it across that company's staff who worked in the period, and
// posts the journal:
//   On post: records member shareCents (no JE — the liability already exists
//            from order completion).
//   On pay:  Dr 2095 Tips Payable / Cr Bank or Cash for total disbursed.

import { tenantForConcept } from '../../lib/setup-config.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, APPROVERS, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'
import { conceptIdsInScope, assertConceptOwned } from '../../lib/tenantScope.js'
import { getOperationsConfig, tipPoolWeights } from '../../lib/setup-config.js'
import type { PunchEntry } from '../hr/attendance.js'

// The rules are the company's, set in /configuration/operations
// (OperationsConfig): whether pooling is on, how it is split, and the weight
// of each role (decision 36: servers 1.0, cashiers and baristas 0.75, kitchen
// 0.5 — setup-config.ts TIP_POOL_DEFAULT_WEIGHTS). A role with no weight is not
// in the pool. Split:
//   equal           one share each for everyone in the pool who worked
//   by_hours        hours worked
//   by_role_weight  hours worked × role weight

/** Pair in/out punches (sorted) into worked milliseconds. */
function workedMs(punches: Array<{ type: string; at: Date }>): number {
  let ms = 0
  let openIn: Date | null = null
  for (const p of punches) {
    if (p.type === 'in') openIn = p.at
    else if (p.type === 'out' && openIn) { ms += Math.max(0, p.at.getTime() - openIn.getTime()); openIn = null }
  }
  return ms
}

/**
 * Hours each login worked for THIS company in the window. Someone with an HR
 * record here is read from that company's attendance punches — a person on
 * two companies' payrolls is paid by each for its own hours. Someone without
 * one is read from the punch log, but only when this is their only company
 * (the punch log does not say which company a punch was for).
 */
async function hoursByUser(tenantId: string, from: Date, to: Date) {
  const users = await prisma.user.findMany({
    where: { deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true, name: true, role: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  const emps = await prisma.hrEmployee.findMany({
    where: { tenantId, userId: { in: users.map((u) => u.id) } },
    select: { id: true, userId: true, designationId: true },
  })
  const empByUser = new Map(emps.map((e) => [e.userId!, e]))
  const designations = await prisma.hrOrgUnit.findMany({ where: { tenantId, id: { in: emps.map((e) => e.designationId).filter(Boolean) as string[] } }, select: { id: true, name: true } })
  const designationName = new Map(designations.map((d) => [d.id, d.name]))

  const dayFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) - 86_400_000)
  const attendance = emps.length ? await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId: { in: emps.map((e) => e.id) }, startDate: { gte: dayFrom, lte: to }, status: { notIn: ['draft', 'rejected', 'cancelled'] } },
    select: { employeeId: true, data: true },
  }) : []
  const soloUserIds = users.filter((u) => !empByUser.has(u.id) && (u.tenantMemberships.every((m) => m.tenantId === tenantId)) && (!u.tenantId || u.tenantId === tenantId)).map((u) => u.id)
  const logs = soloUserIds.length ? await prisma.clockLog.findMany({
    where: { userId: { in: soloUserIds }, recordedAt: { gte: from, lte: to } },
    orderBy: { recordedAt: 'asc' }, select: { userId: true, type: true, recordedAt: true },
  }) : []

  return users.map((u) => {
    const emp = empByUser.get(u.id)
    let punches: Array<{ type: string; at: Date }>
    if (emp) {
      punches = attendance.filter((a) => a.employeeId === emp.id)
        .flatMap((a) => (((a.data as Record<string, unknown>)['_punches'] as PunchEntry[] | undefined) ?? []))
        .map((p) => ({ type: p.type, at: new Date(p.at) }))
        .filter((p) => p.at >= from && p.at <= to)
        .sort((a, b) => a.at.getTime() - b.at.getTime())
    } else {
      punches = logs.filter((l) => l.userId === u.id).map((l) => ({ type: l.type, at: l.recordedAt }))
    }
    const designation = emp?.designationId ? designationName.get(emp.designationId) ?? null : null
    return { userId: u.id, name: u.name, role: u.role, designation, hours: workedMs(punches) / 3_600_000 }
  })
}

export async function tipPoolRoutes(fastify: FastifyInstance) {
  // List
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const inScope = await conceptIdsInScope(req, 'read')
      const ids = req.query.conceptId ? inScope.filter((c) => c === req.query.conceptId) : inScope
      return prisma.tipPool.findMany({
        where: { conceptId: { in: ids } },
        orderBy: { periodStart: 'desc' },
        include: { _count: { select: { members: true } }, },
        take: 50,
      })
    },
  )

  // GET /tip-pools/:id — full pool with members
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const pool = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'read') } },
        include: { members: { orderBy: { userName: 'asc' } } },
      })
      if (!pool) throw new NotFoundError('TipPool', req.params.id)
      return pool
    },
  )

  // Compute a draft pool for one brand — tips from its completed orders, hours
  // from its company's punches — split by the company's rules. The operator
  // can adjust shares before posting.
  fastify.post<{ Body: { conceptId: string; name: string; periodStart: string; periodEnd: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        // A pool belongs to a brand, and so to one company: tips and hours from
        // every company can never be pooled together, and post/pay look the
        // pool up by its brand.
        conceptId: z.string().uuid(),
        name: z.string().min(1).max(80),
        periodStart: z.string().datetime(),
        periodEnd:   z.string().datetime(),
      }).parse(req.body)
      const concept = await assertConceptOwned(req, body.conceptId, 'create')
      if (!concept.tenantId) throw new NotFoundError('Concept', body.conceptId)
      const cfg = await getOperationsConfig(concept.tenantId)
      if (!cfg?.tipPoolEnabled) {
        throw new AppError('TIP_POOL_DISABLED', 'Tip pooling is switched off for this company — turn it on in Configuration → Operations', 422)
      }
      const weights = tipPoolWeights(cfg)
      const mode = (cfg.tipPoolDistribution ?? 'equal') as 'equal' | 'by_hours' | 'by_role_weight'

      const periodStart = new Date(body.periodStart)
      const periodEnd   = new Date(body.periodEnd)
      if (!(periodEnd > periodStart)) throw new AppError('BAD_PERIOD', 'The period must end after it starts', 400)

      const tipAgg = await prisma.order.aggregate({
        where: {
          status: { in: ['completed', 'refunded'] },  // tip stays even on refund — liability owed to staff
          completedAt: { gte: periodStart, lte: periodEnd },
          conceptId: concept.id,
          deletedAt: null,
        },
        _sum: { tipCents: true },
      })
      const totalTips = tipAgg._sum.tipCents ?? 0

      const worked = (await hoursByUser(concept.tenantId, periodStart, periodEnd)).map((w) => {
        // A barista is a designation, not a login role.
        const weight = w.designation && /barista/i.test(w.designation) && weights['barista'] != null ? weights['barista']! : weights[w.role] ?? 0
        const units = mode === 'equal' ? 1 : mode === 'by_hours' ? w.hours : w.hours * weight
        return { ...w, weight, units }
      }).filter((w) => w.hours > 0 && w.weight > 0)

      return prisma.$transaction(async (tx) => {
        const pool = await tx.tipPool.create({
          data: {
            conceptId:    concept.id,
            name:         body.name,
            periodStart, periodEnd,
            totalTipsCents: totalTips,
            createdById:  req.staffUser?.id ?? null,
          },
        })
        for (const w of worked) {
          await tx.tipPoolMember.create({
            data: {
              poolId:      pool.id,
              userId:      w.userId,
              userName:    w.name,
              hoursWorked: Number(w.hours.toFixed(2)),
              roleWeight:  w.weight,
              shareUnits:  Number(w.units.toFixed(3)),
              shareCents:  0,
              notes:       mode === 'equal' ? 'equal share' : null,
            },
          })
        }
        return tx.tipPool.findUnique({
          where: { id: pool.id },
          include: { members: { orderBy: { userName: 'asc' } } },
        })
      }).then((r) => reply.status(201).send({ ...r, distribution: mode }))
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
      // Through its pool: a member of another company's pool is not found, and
      // shares are frozen once the pool is posted.
      const member = await prisma.tipPoolMember.findFirst({
        where: { id: req.params.memberId, pool: { conceptId: { in: await conceptIdsInScope(req, 'write') } } },
        include: { pool: { select: { status: true } } },
      })
      if (!member) throw new NotFoundError('TipPoolMember', req.params.memberId)
      if (member.pool.status !== 'draft') throw new AppError('ALREADY_POSTED', `Pool is ${member.pool.status}`, 422)
      return prisma.tipPoolMember.update({ where: { id: member.id }, data: body })
    },
  )

  // Post — locks the pool, computes per-member shareCents, no JE (liability
  // is already on the books from each order's tip).
  fastify.post<{ Params: { id: string } }>(
    '/:id/post',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      // Tip pools belong to a brand, and therefore to one company. Looking one
      // up by bare id let a manager distribute another company's pool.
      const pool = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
        include: { members: true },
      })
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
      await audit({ category: 'accounting',
        action: 'tippool.post', entity: 'TipPool', entityId: pool.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
        after: { totalCents: pool.totalTipsCents, members: updated.members.length },
      })

      // Per-member audit row so each individual share is independently
      // verifiable. Without this, a manager could quietly give themselves a
      // bigger cut and the pool-level audit log wouldn't show it.
      for (const m of updated.members) {
        await audit({ category: 'accounting',
          action: 'tippool.distribute',
          entity: 'TipPoolMember',
          entityId: m.id,
          userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null,
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
          tenantId: (pool.conceptId ? await tenantForConcept(pool.conceptId) : null) ?? req.staffUser!.tenantId,
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
      const pool = await prisma.tipPool.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
      })
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
