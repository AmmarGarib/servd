// Best-effort JWT revocation backed by Redis.
//
// JWTs are stateless, so "log out" / "kill a fired employee's sessions" needs a
// server-side deny list. Two mechanisms:
//   1. Per-token blacklist (single logout): revoked:<sha256(token)> set with a
//      TTL equal to the token's remaining life.
//   2. Per-subject cutoff (logout-everywhere / password change / deactivation):
//      tva:<sub> = epoch seconds; any token issued (`iat`) before that instant
//      is rejected.
//
// FAILS OPEN on Redis errors — a cache outage must never lock the whole company
// out. The per-request isActive/accountStatus DB check in middleware is the
// hard backstop for deactivation.

import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { redis } from './redis.js'

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

// Covers the longest token life (customer 14d / refresh 7d) with margin.
const CUTOFF_TTL_SEC = 31 * 24 * 60 * 60

export async function revokeToken(token: string, ttlSec: number): Promise<void> {
  if (ttlSec <= 0) return
  try {
    await redis.set(`revoked:${hash(token)}`, '1', 'EX', Math.ceil(ttlSec))
  } catch { /* best-effort */ }
}

// Revoke a bearer token from an Authorization header, deriving its TTL from exp.
export async function revokeBearer(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) return
  const token = authHeader.slice(7)
  const decoded = jwt.decode(token) as { exp?: number } | null
  const ttl = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 0
  await revokeToken(token, ttl)
}

// Invalidate EVERY outstanding session for a subject (user or customer id).
export async function revokeAllForSubject(sub: string): Promise<void> {
  try {
    await redis.set(`tva:${sub}`, String(Math.floor(Date.now() / 1000)), 'EX', CUTOFF_TTL_SEC)
  } catch { /* best-effort */ }
}

// True if the token (or its subject's cutoff) has been revoked. Fail-open.
export async function isRevoked(token: string, sub: string, iatSec: number | undefined): Promise<boolean> {
  try {
    const [tok, tva] = await redis.mget(`revoked:${hash(token)}`, `tva:${sub}`)
    if (tok) return true
    if (tva && iatSec !== undefined && iatSec < parseInt(tva, 10)) return true
    return false
  } catch {
    return false
  }
}
