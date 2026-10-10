// The rider guard — preHandler for every /rider/* route (docs/rider-app.md).
//
// Accepts ONLY a rider access token (type 'rider'): a staff access token, a
// staff refresh token, a customer token and a rider refresh token are all
// refused. Like the staff guard it re-checks the deny list and the account on
// every request — a rider a manager deactivated or deleted is out at once,
// whatever their token says.
//
// Refused requests are counted per IP (RIDER_BAD_TOKEN_IP_LIMIT): the per-route
// limiter keys on the rider and runs after this guard, so without this a
// revoked or deactivated rider's token could be replayed without limit.
//
// RLS scope: the rider's own company plus the client companies of its active
// fleet agreements (lib/fleet.ts), plus the companies of the orders it is
// carrying right now (dispatch/service riderOpenOrderWhere — the one
// definition of "still on the rider's hands") — so a delivery already under
// way can be finished even if its agreement is ended mid-route. What the rider
// can READ is narrower still: every rider query filters on riderId = the
// signed-in rider.

import type { FastifyRequest, FastifyReply } from 'fastify'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, UnauthorizedError } from '../../lib/errors.js'
import { setRlsContext } from '../../lib/rlsContext.js'
import { isRevoked } from '../../lib/tokenRevocation.js'
import { clientTenantIdsOf } from '../../lib/fleet.js'
import { check as checkRateLimit, recordFailure, RIDER_BAD_TOKEN_IP_LIMIT } from '../../lib/loginRateLimit.js'
import { riderOpenOrderWhere } from '../dispatch/service.js'
import { loadActiveRider, verifyRiderToken, type SignedInRider } from './service.js'

export interface RiderPrincipal extends SignedInRider {
  /** Companies this request may touch (RLS): own + clients + in-flight orders'. */
  tenantIds: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    rider?: RiderPrincipal
  }
}

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) throw new UnauthorizedError('Missing authentication')
  return h.slice(7)
}

/** Who is signing in with this token, or a 401. */
async function authenticate(req: FastifyRequest): Promise<SignedInRider> {
  const token = bearer(req)
  const payload = verifyRiderToken(token, 'rider')
  if (await isRevoked(token, payload.sub, payload.iat)) {
    throw new UnauthorizedError('Session has been revoked — please sign in again')
  }
  const rider = await loadActiveRider(payload.sub)
  if (!rider) throw new UnauthorizedError('This rider account is no longer active')
  return rider
}

export async function requireRider(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const ip = req.ip ?? 'unknown'
  await checkRateLimit(RIDER_BAD_TOKEN_IP_LIMIT, ip)
  let rider: SignedInRider
  try {
    rider = await authenticate(req)
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 401) await recordFailure(RIDER_BAD_TOKEN_IP_LIMIT, ip)
    throw err
  }

  const [clients, inFlight] = await Promise.all([
    clientTenantIdsOf(rider.tenantId),
    prisma.order.findMany({
      where: riderOpenOrderWhere(rider.id),
      select: { concept: { select: { tenantId: true } } },
      take: 50,
    }),
  ])
  const tenantIds = new Set<string>([rider.tenantId, ...clients])
  for (const o of inFlight) if (o.concept.tenantId) tenantIds.add(o.concept.tenantId)

  req.rider = { ...rider, tenantIds: Array.from(tenantIds) }
  setRlsContext({ tenantIds: Array.from(tenantIds), staffUserId: null, customerId: null })
}

/** Rate-limit key for rider routes: the rider, not the IP (carrier NAT). */
export function riderRateKey(req: FastifyRequest): string {
  return req.rider ? `rider:${req.rider.id}` : `ip:${req.ip}`
}
