// The servd name (owner, 2026-10-26: "when they hop into servd first time
// after logging in, ask them to pick a nickname/username").
//
//   GET /storefront/account/nickname-available?q=   → { nickname, available, reason, message }
//   PUT /storefront/account/nickname { nickname }   → { nickname } | 409 NICKNAME_TAKEN | 422 NICKNAME_INVALID
//
// Customer routes: the signed-in customer only (the id comes from the session).
// Unique servd-wide, case-insensitive (lib/nickname.ts; index on lower()).
// Registered at prefix '/storefront'.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { assertNickname, checkNickname } from '../../lib/nickname.js'

async function holderOf(nickname: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM customers WHERE lower(nickname) = lower(${nickname}) LIMIT 1`
  return rows[0]?.id ?? null
}

export default async function identityRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { q?: string } }>(
    '/account/nickname-available',
    { preHandler: requireCustomerAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const c = checkNickname(String(req.query.q ?? '').slice(0, 64))
      if (c.problem) return { nickname: c.nickname, available: false, reason: c.problem, message: c.message }
      const holder = await holderOf(c.nickname)
      if (holder === req.customer!.id) return { nickname: c.nickname, available: true, reason: 'yours', message: null }
      if (holder) return { nickname: c.nickname, available: false, reason: 'taken', message: 'That name is taken.' }
      return { nickname: c.nickname, available: true, reason: null, message: null }
    },
  )

  fastify.put(
    '/account/nickname',
    { preHandler: requireCustomerAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req) => {
      const body = z.object({ nickname: z.string().max(64) }).parse(req.body)
      const nickname = assertNickname(body.nickname)
      const holder = await holderOf(nickname)
      if (holder && holder !== req.customer!.id) throw new AppError('NICKNAME_TAKEN', 'That name is taken.', 409)
      try {
        await prisma.customer.update({ where: { id: req.customer!.id }, data: { nickname } })
      } catch (err) {
        // The unique index on lower(nickname): someone took it a moment ago.
        // (Under RLS Postgres hides the key, so branch on the code alone.)
        if ((err as { code?: string }).code === 'P2002') throw new AppError('NICKNAME_TAKEN', 'That name is taken.', 409)
        throw err
      }
      return { nickname }
    },
  )
}
