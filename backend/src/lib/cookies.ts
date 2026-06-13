// httpOnly session cookies for the manager web app.
//
// Why: the admin used to keep its access token in localStorage, where any XSS
// could read it. These cookies are HttpOnly (JS can't read them) and become the
// admin's durable credential. The token is ALSO still returned in the JSON body
// so the tablet / mobile apps keep authenticating with a Bearer header — the
// API accepts either (see middleware tokenFromRequest).
//
// Scope: the cookie is set by, and sent to, the API host only (the admin never
// reads it). So it's host-only — no Domain attribute, no cross-subdomain setup.
// admin.garibsons.app → api.garibsons.app is SAME-SITE (same registrable
// domain), so SameSite=Lax cookies are sent on those requests while still
// blocking cross-site (CSRF) POSTs from other origins.

import type { FastifyReply, FastifyRequest } from 'fastify'

const isProd = process.env['NODE_ENV'] === 'production'
const ACCESS = 'servd_at'
const REFRESH = 'servd_rt'
// Roughly mirror the JWT lifetimes (access 15m, refresh 7d). The JWT's own exp
// is the real authority; Max-Age just stops the browser sending a dead cookie.
const ACCESS_MAX_SEC = 15 * 60
const REFRESH_MAX_SEC = 7 * 24 * 60 * 60

function serialize(name: string, value: string, maxAgeSec: number): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`]
  if (isProd) parts.push('Secure')
  return parts.join('; ')
}

export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken?: string): void {
  const cookies = [serialize(ACCESS, accessToken, ACCESS_MAX_SEC)]
  if (refreshToken) cookies.push(serialize(REFRESH, refreshToken, REFRESH_MAX_SEC))
  reply.header('Set-Cookie', cookies)
}

export function setAccessCookie(reply: FastifyReply, accessToken: string): void {
  reply.header('Set-Cookie', serialize(ACCESS, accessToken, ACCESS_MAX_SEC))
}

export function clearAuthCookies(reply: FastifyReply): void {
  const expire = (n: string) => `${n}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? '; Secure' : ''}`
  reply.header('Set-Cookie', [expire(ACCESS), expire(REFRESH)])
}

export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}

export function readCookie(req: FastifyRequest, name: string): string | null {
  return parseCookieHeader(req.headers.cookie, name)
}

export const ACCESS_COOKIE = ACCESS
export const REFRESH_COOKIE = REFRESH
