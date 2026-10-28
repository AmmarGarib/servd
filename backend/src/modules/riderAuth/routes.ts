// /api/v1/rider-auth — rider-app sign-in (docs/rider-app.md). Public, rate-limited.
// Riders sign in like staff (owner, 2026-10-28: "Riders same as staff — Gsfoods email + password").
//
//   POST /login       { email, password }  → 200 { accessToken, refreshToken, rider } | 401 INVALID_CREDENTIALS
//   POST /refresh     { refreshToken }     → 200 { accessToken, refreshToken } (rotated; old one revoked)
//   POST /logout      { refreshToken? } [+ Bearer rider token] → 204 (whatever was sent is revoked)
//   POST /otp/request, /otp/verify         → 410 RIDER_CODE_LOGIN_RETIRED (the WhatsApp code sign-in is gone)
//
// A manager adds the rider in admin → Riders with an @gsfoods.pk email and issues the password there
// (POST /riders/:id/new-password, shown once). A wrong password, no password yet, an unknown or non-gsfoods
// email all get the same 401 in the same time. Limits are CLAIMED before the work (loginRateLimit `claim`).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { AppError } from '../../lib/errors.js'
import { revokeToken, claimRevocation, isCutOff, revokeAllForSubject } from '../../lib/tokenRevocation.js'
import {
  claim as claimRateLimit,
  release as releaseRateLimit,
  clearFailures,
  RIDER_PASSWORD_EMAIL_LIMIT,
  RIDER_PASSWORD_IP_LIMIT,
} from '../../lib/loginRateLimit.js'
import { findLoginRiderByEmail, issueRiderSession, loadActiveRider, riderPasswordHash, riderPublic, verifyRiderToken } from './service.js'

// Compared when the email has no rider or no password yet, so the answer takes as long either way.
const DUMMY_HASH = bcrypt.hashSync('servd-rider-no-password', 12)

function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Wrong email or password. Forgot it? Ask your manager for a new password.', 401)
}

function signedOut(): AppError {
  return new AppError('UNAUTHORIZED', 'Session has been signed out', 401)
}

const ipOf = (req: FastifyRequest) => req.ip ?? 'unknown'

/** Seconds until a JWT expires (0 when unreadable). */
function ttlOf(token: string): number {
  const decoded = jwt.decode(token) as { exp?: number } | null
  return decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 0
}

/** Value stored on a refresh token revoked by rotation (vs. '1' for a sign-out). */
const ROTATED = 'rotated'

export async function riderAuthRoutes(fastify: FastifyInstance) {
  // POST /rider-auth/login — @gsfoods.pk email + password.
  fastify.post('/login', async (req, reply) => {
    const body = z.object({ email: z.string().trim().max(200), password: z.string().min(1).max(128) }).parse(req.body)
    const email = body.email.toLowerCase()
    const emailKey = `email:${email}`
    const ip = ipOf(req)
    await claimRateLimit(RIDER_PASSWORD_IP_LIMIT, ip)
    await claimRateLimit(RIDER_PASSWORD_EMAIL_LIMIT, emailKey)

    const rider = await findLoginRiderByEmail(email)
    const hash = rider ? await riderPasswordHash(rider.id) : null
    const ok = await bcrypt.compare(body.password, hash ?? DUMMY_HASH)
    if (!rider || !hash || !ok) throw invalidCredentials()

    await clearFailures(RIDER_PASSWORD_EMAIL_LIMIT, emailKey)
    await releaseRateLimit(RIDER_PASSWORD_IP_LIMIT, ip)
    const session = issueRiderSession(rider)
    return reply.status(200).send({ ...session, rider: riderPublic(rider) })
  })

  // The WhatsApp code sign-in is retired: riders sign in like staff. 410 so an old app build says why.
  for (const path of ['/otp/request', '/otp/verify']) {
    fastify.post(path, async () => {
      throw new AppError('RIDER_CODE_LOGIN_RETIRED', 'Sign in with your @gsfoods.pk email and password. Your manager gives you your password.', 410)
    })
  }

  // POST /rider-auth/refresh — rotate: the presented refresh token is revoked
  // and a new pair issued, once. The revocation is the claim (SET NX), so two
  // simultaneous refreshes with one token cannot both mint a session. A token
  // that was already rotated being presented again means a copy is in someone
  // else's hands: every session the rider has is ended (refresh-token reuse
  // detection). A rider deactivated since sign-in gets 401.
  fastify.post('/refresh', async (req, reply) => {
    const body = z.object({ refreshToken: z.string().min(1) }).parse(req.body ?? {})
    const payload = verifyRiderToken(body.refreshToken, 'rider_refresh')
    // Signed out everywhere (deactivated, number changed, reuse detected).
    if (await isCutOff(payload.sub, payload.iat)) throw signedOut()

    const claim = await claimRevocation(body.refreshToken, ttlOf(body.refreshToken), ROTATED)
    if (!claim.claimed) {
      if (claim.previous === ROTATED) {
        req.log.warn({ riderId: payload.sub }, 'rotated rider refresh token presented again — ending every session')
        await revokeAllForSubject(payload.sub)
      }
      throw signedOut()
    }
    const rider = await loadActiveRider(payload.sub)
    if (!rider) throw new AppError('UNAUTHORIZED', 'This rider account is no longer active', 401)
    return reply.status(200).send(issueRiderSession(rider))
  })

  // POST /rider-auth/logout — revoke whatever was sent: the refresh token in
  // the body (its own proof — whoever holds it could use it anyway) and the
  // Bearer access token when it is a valid rider token. The access token is
  // NOT required: it lasts 15 minutes, and a rider signing out of a page left
  // idle must still be able to kill the 30-day refresh token.
  fastify.post(
    '/logout',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z.object({ refreshToken: z.string().max(4096).optional() }).parse(req.body ?? {})
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) {
        const access = auth.slice(7)
        try {
          verifyRiderToken(access, 'rider')
          await revokeToken(access, ttlOf(access))
        } catch { /* expired or not a rider token — nothing to revoke */ }
      }
      if (body.refreshToken) {
        try {
          verifyRiderToken(body.refreshToken, 'rider_refresh')
          await revokeToken(body.refreshToken, ttlOf(body.refreshToken))
        } catch { /* expired or not a rider refresh token — nothing to revoke */ }
      }
      return reply.status(204).send()
    },
  )
}
