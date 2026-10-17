// Who a request is from, for the global rate limit only (index.ts).
//
// The limit runs before requireAuth, so it cannot read req.staffUser. This
// reads the caller's token itself — Bearer header, else the web session
// cookie, else the refresh cookie — and VERIFIES its signature (access tokens
// and customer tokens with JWT_SECRET, refresh tokens with
// JWT_REFRESH_SECRET), so a forged token can never land in someone else's
// bucket. Expiry is ignored: an expired access token still names its own
// person on the way to /auth/refresh. Nothing here authenticates anything.
import jwt from 'jsonwebtoken'
import type { FastifyRequest } from 'fastify'
import { readCookie, ACCESS_COOKIE, REFRESH_COOKIE } from './cookies.js'

function subOf(token: string | null | undefined, secret: string | undefined): string | null {
  if (!token || !secret) return null
  try {
    const p = jwt.verify(token, secret, { ignoreExpiration: true }) as { sub?: unknown }
    return typeof p.sub === 'string' && p.sub ? p.sub : null
  } catch {
    return null
  }
}

export function rateLimitSubject(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null
  const access = process.env['JWT_SECRET']
  return subOf(bearer, access)
    ?? subOf(readCookie(req, ACCESS_COOKIE), access)
    ?? subOf(readCookie(req, REFRESH_COOKIE), process.env['JWT_REFRESH_SECRET'])
}
