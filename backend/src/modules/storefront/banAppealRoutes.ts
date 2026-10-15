// Customer side of ban appeals (owner, 2026-10-13; servd-wide since 2026-10-15).
//
//   GET  /storefront/account/blocks       — the signed-in customer's blocks in force
//   POST /storefront/account/ban-appeals  — ask the help desk to review one
//
// Registered by the orchestrator at prefix '/storefront'. Both answer 404 while
// the CEO's appeals switch is off (complaints/appeals.ts banAppealsEnabled).
// A block is about the customer's servd ACCOUNT and applies at every brand, so
// nothing here names a single company. Contact details come from the session's
// account only — never from the request body.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { banAppealState } from '../../lib/strikes.js'
import { activeBansForCustomer, banAppealsEnabled, createBanAppeal } from '../complaints/appeals.js'

/** 3 appeal submissions per hour per customer (attempts, refused ones included). */
const APPEAL_MAX_PER_HOUR = 3
const attempts = new Map<string, number[]>()
function takeAttempt(customerId: string): boolean {
  const now = Date.now()
  const recent = (attempts.get(customerId) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= APPEAL_MAX_PER_HOUR) {
    attempts.set(customerId, recent)
    return false
  }
  recent.push(now)
  attempts.set(customerId, recent)
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) if (v.every((t) => now - t >= 3_600_000)) attempts.delete(k)
  }
  return true
}

/** Test hook: forget the per-customer attempt counters. */
export function resetBanAppealRateLimit(): void {
  attempts.clear()
}

async function assertAppealsOn(): Promise<void> {
  if (!(await banAppealsEnabled())) throw new NotFoundError('Route', 'ban appeals')
}

async function sessionCustomer(id: string) {
  const c = await prisma.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true, email: true, phone: true } })
  if (!c) throw new NotFoundError('Customer', id)
  return c
}

const appealSchema = z.object({
  banId: z.string().uuid(),
  reason: z.enum(['new_number', 'mistake', 'other']),
  message: z.string().trim().min(10).max(1000),
  conceptSlug: z.string().min(1).max(100).optional(),
})

export default async function banAppealRoutes(fastify: FastifyInstance) {
  fastify.get('/account/blocks', { preHandler: requireCustomerAuth }, async (req) => {
    await assertAppealsOn()
    const customer = await sessionCustomer(req.customer!.id)
    const bans = await activeBansForCustomer(customer)
    const blocks = await Promise.all(bans.map(async (b) => ({
      banId: b.id,
      since: b.bannedAt,
      // Servd-wide (owner, 2026-10-15): the block is on the servd account.
      everywhere: true,
      companyName: null,
      brands: [] as string[],
      message: 'Your servd account is blocked from ordering and booking.',
      appeal: await banAppealState(prisma, b.id),
    })))
    return { blocks }
  })

  fastify.post('/account/ban-appeals', {
    preHandler: requireCustomerAuth,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    await assertAppealsOn()
    const customerId = req.customer!.id
    if (!takeAttempt(customerId)) {
      throw new AppError('RATE_LIMITED', 'Too many requests. Please try again in an hour.', 429)
    }
    const body = appealSchema.parse(req.body)
    const customer = await sessionCustomer(customerId)
    // The ban must be one of THIS account's blocks (id, email or phone) — else 404.
    const mine = (await activeBansForCustomer(customer)).find((b) => b.id === body.banId)
    if (!mine) throw new NotFoundError('Block', body.banId)
    // A brand slug is only a hint for which brand the appeal sits on; the
    // server keeps it only when it is a brand of the ban's company.
    const concept = body.conceptSlug
      ? await prisma.concept.findFirst({ where: { slug: body.conceptSlug, deletedAt: null }, select: { id: true } })
      : null
    const { appealId } = await createBanAppeal({
      banId: mine.id,
      customerId: customer.id,
      contactPhone: customer.phone ?? undefined,
      conceptId: concept?.id,
      reason: body.reason,
      message: body.message,
      via: 'storefront',
    })
    return reply.status(201).send({ appealId })
  })
}

export { banAppealRoutes }
