// /api/v1/rider-auth — rider-app sign-in (docs/rider-app.md). Public,
// rate-limited.
//
//   POST /otp/request { phone }        → 202 { sent: true }, always
//   POST /otp/verify  { phone, code }  → 200 { accessToken, refreshToken, rider } | 401 INVALID_CODE
//   POST /refresh     { refreshToken } → 200 { accessToken, refreshToken } (rotated; old one revoked)
//   POST /logout      { refreshToken? } [+ Bearer rider token] → 204 (whatever was sent is revoked)
//
// A manager must first add the rider in admin → Riders. The request answers
// the same for a known and an unknown number — same status, same body, same
// rate limit (the phone bucket counts every request, matched or not), and the
// same timing (the WhatsApp send is not awaited) — so it cannot be used to
// learn which numbers are riders, or to make GS Foods' WhatsApp message a
// number of the caller's choosing: a code only ever goes to a number that is
// already an active rider's.
//
// Every limit here is CLAIMED before the work it guards (loginRateLimit
// `claim`), never read first and counted after: parallel requests used to all
// pass the read, so 25 simultaneous guesses got 25 tries against a limit of 6,
// and 20 simultaneous code requests sent 15 WhatsApp messages.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { normalisePhone, requestOtp, verifyOtp } from '../auth/otp.js'
import { AppError } from '../../lib/errors.js'
import { refuseCodeRequestInPractice } from '../../lib/sandbox.js'
import { revokeToken, claimRevocation, isCutOff, revokeAllForSubject } from '../../lib/tokenRevocation.js'
import {
  claim as claimRateLimit,
  release as releaseRateLimit,
  clearFailures,
  RIDER_OTP_PHONE_LIMIT,
  RIDER_OTP_IP_LIMIT,
} from '../../lib/loginRateLimit.js'
import { findLoginRider, issueRiderSession, loadActiveRider, riderPublic, verifyRiderToken } from './service.js'

const phoneSchema = z.string().trim().min(7).max(20)

function invalidCode(): AppError {
  return new AppError('INVALID_CODE', 'That code is not valid. Request a new one and try again.', 401)
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
  // POST /rider-auth/otp/request
  fastify.post('/otp/request', async (req, reply) => {
    refuseCodeRequestInPractice('rider') // practice copy: nothing is sent (lib/sandbox.ts)
    const body = z.object({ phone: phoneSchema }).parse(req.body)
    const phone = normalisePhone(body.phone)

    // Every request takes a slot, matched or not — the limit must not differ
    // between a rider's number and anyone else's. The IP bucket counts them
    // too, so one source cannot walk the whole fleet's numbers.
    await claimRateLimit(RIDER_OTP_IP_LIMIT, ipOf(req))
    await claimRateLimit(RIDER_OTP_PHONE_LIMIT, `phone:${phone}`)

    const rider = await findLoginRider(phone)
    if (rider) {
      // Not awaited. The cooldown and cap checks, the insert and the WhatsApp
      // send take real time (the send hundreds of milliseconds), and an
      // unknown number does none of it — waiting would make the reply's
      // timing say which numbers are riders. A send that fails, or a request
      // inside the cooldown (whose code is still valid), changes nothing the
      // caller sees.
      void requestOtp({ phone, purpose: 'rider_login' }).catch((err: Error) => {
        req.log.warn({ err: err.message, riderId: rider.id }, 'rider sign-in code not sent')
      })
    }
    return reply.status(202).send({ sent: true })
  })

  // POST /rider-auth/otp/verify
  fastify.post('/otp/verify', async (req, reply) => {
    const body = z.object({ phone: phoneSchema, code: z.string().trim().min(4).max(8) }).parse(req.body)
    const phone = normalisePhone(body.phone)
    const phoneKey = `phone:${phone}`
    const ip = ipOf(req)

    // The slot is taken before the code is looked at (and verifyOtp takes one
    // on the code itself), so parallel guesses cannot outrun either limit.
    await claimRateLimit(RIDER_OTP_IP_LIMIT, ip)
    await claimRateLimit(RIDER_OTP_PHONE_LIMIT, phoneKey)

    // Both lookups run whatever the number, so an unknown number makes the
    // same database round trips as a rider's. The rider is re-resolved at
    // verify time: a code alone is not enough if the rider was deactivated,
    // deleted or moved off this number since it was sent.
    const rider = await findLoginRider(phone)
    let codeOk = false
    try {
      await verifyOtp({ phone, code: body.code, purpose: 'rider_login' })
      codeOk = true
    } catch (err) {
      // Wrong, expired, used up, locked or never sent — one answer for all of
      // them. Anything else (the database is down) is not a wrong code.
      if (!(err instanceof AppError)) throw err
    }
    if (!rider || !codeOk) throw invalidCode()

    await clearFailures(RIDER_OTP_PHONE_LIMIT, phoneKey)
    // A sign-in that worked is not a strike against a shared carrier IP.
    await releaseRateLimit(RIDER_OTP_IP_LIMIT, ip)

    const session = issueRiderSession(rider)
    return reply.status(200).send({ ...session, rider: riderPublic(rider) })
  })

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
