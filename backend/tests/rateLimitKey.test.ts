// The global rate limit keys on the caller's own VERIFIED token (owner,
// 2026-10-17: a whole office behind one connection shared 200/min, /auth/refresh
// got 429 and the admin signed staff out). lib/rateLimitKey.ts.
import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import type { FastifyRequest } from 'fastify'
import { rateLimitSubject } from '../src/lib/rateLimitKey.js'

const A = process.env['JWT_SECRET']!
const R = process.env['JWT_REFRESH_SECRET']!
const req = (headers: Record<string, string>) => ({ headers } as unknown as FastifyRequest)

describe('rate limit key', () => {
  it('two people on one connection get their own buckets (Bearer)', () => {
    const t1 = jwt.sign({ sub: 'u1', type: 'access' }, A, { expiresIn: '15m' })
    const t2 = jwt.sign({ sub: 'u2', type: 'access' }, A, { expiresIn: '15m' })
    expect(rateLimitSubject(req({ authorization: `Bearer ${t1}` }))).toBe('u1')
    expect(rateLimitSubject(req({ authorization: `Bearer ${t2}` }))).toBe('u2')
  })
  it('the web session cookie, and an expired one, still name the person', () => {
    const exp = jwt.sign({ sub: 'u3', type: 'access', exp: Math.floor(Date.now() / 1000) - 60 }, A)
    expect(rateLimitSubject(req({ cookie: `servd_at=${exp}` }))).toBe('u3')
  })
  it('the refresh cookie (verified with the refresh secret) names the person on /auth/refresh', () => {
    const rt = jwt.sign({ sub: 'u4', type: 'refresh' }, R, { expiresIn: '7d' })
    expect(rateLimitSubject(req({ cookie: `servd_rt=${rt}` }))).toBe('u4')
  })
  it('a forged or garbage token never picks a bucket (falls back to the IP)', () => {
    const forged = jwt.sign({ sub: 'victim', type: 'access' }, 'not-the-secret')
    expect(rateLimitSubject(req({ authorization: `Bearer ${forged}` }))).toBeNull()
    expect(rateLimitSubject(req({ cookie: 'servd_at=garbage' }))).toBeNull()
    expect(rateLimitSubject(req({}))).toBeNull()
  })
  it('a refresh token presented as an access token is not accepted', () => {
    const rt = jwt.sign({ sub: 'u5', type: 'refresh' }, R)
    expect(rateLimitSubject(req({ authorization: `Bearer ${rt}` }))).toBeNull()
  })
})
