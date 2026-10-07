// servd new-brand waitlist (owner, 2026-10-07) — the shared bits: the one
// list key, the canonical consent wording, the campaign-audience filter, and
// the signed unsubscribe token.
//
// Deliberately NOT company-scoped: this is a servd-level list (one general
// "tell me when servd opens a new brand" list), documented in schema.prisma
// on WaitlistSignup / WaitlistVisit. Members are ordinary Customer rows.

import crypto from 'crypto'
import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'

export const WAITLIST_LIST = 'servd_new_brand'

/** Campaign audience id (crm/routes.ts) for "New-brand waitlist". */
export const WAITLIST_AUDIENCE = 'waitlist'
export const WAITLIST_AUDIENCE_NAME = 'New-brand waitlist'

/** The exact wording shown next to the consent box. Stored on every sign-up. */
export const WAITLIST_CONSENT_TEXT =
  'Message me on WhatsApp or email when servd opens a new brand. I can opt out any time.'

/**
 * Customers on the list who have not left it. Combine with the reachability
 * rules in lib/marketingAudience.ts (marketing opt-out, bans) — leaving the
 * waitlist and unsubscribing from marketing are separate switches, and a
 * campaign must respect both.
 */
export function waitlistMemberWhere(): Prisma.CustomerWhereInput {
  return { waitlistSignups: { some: { list: WAITLIST_LIST, unsubscribedAt: null } } }
}

/** `?src=` tag: lower-case [a-z0-9_-], at most 40 chars, else none. */
export function sanitiseSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)
  return s.length > 0 ? s : null
}

export function deviceFromUserAgent(ua: string | undefined): 'mobile' | 'tablet' | 'desktop' {
  const s = ua ?? ''
  if (/ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i.test(s)) return 'tablet'
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(s)) return 'mobile'
  return 'desktop'
}

// ── Unsubscribe token ────────────────────────────────────────────────────────
// `<signupId>.<hmac>` — no expiry (an unsubscribe link must keep working), and
// the key is domain-separated from every other use of JWT_SECRET.

function unsubscribeSig(signupId: string): string {
  const key = `${process.env['JWT_SECRET'] ?? ''}:waitlist-unsubscribe`
  return crypto.createHmac('sha256', key).update(signupId).digest('base64url')
}

export function waitlistUnsubscribeToken(signupId: string): string {
  return `${signupId}.${unsubscribeSig(signupId)}`
}

/** The signup id the token names, or null if it was not signed by us. */
export function readUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const id = token.slice(0, dot)
  const a = Buffer.from(token.slice(dot + 1))
  const b = Buffer.from(unsubscribeSig(id))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return id
}

/** The signed-in staff member's effective modules (CEO: all). */
export async function staffModules(req: FastifyRequest): Promise<Set<string>> {
  const su = req.staffUser!
  const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
  return effectiveModulesForUser({ role: su.role, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
}
