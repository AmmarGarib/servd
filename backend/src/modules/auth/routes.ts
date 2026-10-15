import type { FastifyInstance, FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'                  // password checks on the self-service routes
import { z } from 'zod'
import { staffLogin, refreshStaffToken, customerRegister, customerLogin, verifyMagicLink, requestMagicLink, hashPassword, issueStaffSession, findOtpLoginStaff, normaliseCustomerContact } from './service.js'
import {
  challengeSubject,
  verifyLoginChallenge,
  startEnrolment,
  completeEnrolment,
  disable as disableTwoFactor,
  maskPhone,
} from './twoFactor.js'
import { requestOtp, verifyOtp, normalisePhone, requestEmailOtp, verifyEmailOtp, requestSharedCode, verifySharedCode, issueStaffCodeInPerson } from './otp.js'
import { preparePin, setManagerPin, PIN_FORMAT, isWeakPin } from './managerPin.js'
import { accountStateOf, whereAccountState, suspendData, reactivateData, approveData, softDeleteData } from './accountStatus.js'
import {
  normaliseStaffPhone, normaliseStaffPhoneLenient, assertPhoneForRole, assertPhoneFree, withStaffPhoneLock, findManagedStaff,
  assertCompaniesInScope, staffInCompaniesWhere, auditCompanyOf, loginDecisionRight, practiceStaffEmail,
} from './staffAccounts.js'
import { maskPhoneForLog } from '../../lib/notify.js'
import { PRACTICE_NOTE, practiceCodeField, sandboxBlocks, refuseCodeRequestInPractice, isSandbox } from '../../lib/sandbox.js'
import { ASSIGNABLE_ROLES_WITH_ADMIN, isGeofenceExempt, isOverrideApprover } from '../../lib/roles.js'
import type { UserRole } from '@prisma/client'
import { sendText, whatsappSettingsView, saveWhatsappSettings } from '../../lib/whatsapp.js'
import { CONNECTOR_ADMINS } from '../../lib/connectorRoles.js'
import { requireModule } from '../notifications/requireModule.js'
import { sendEmail, mailConfig, invalidateMailConfig, emailConfigured as isEmailConfigured, SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY } from '../../lib/mailer.js'
import { runDeliveryWatch, DELIVERY_STATE_KEY } from '../../workers/deliveryWatch.js'
import { requestPasswordReset, consumeResetToken, checkResetToken, deliveryConfigured } from './passwordReset.js'
import { requireAuth, requireCustomerAuth, ADMIN_ONLY, MANAGERS, ALL_STAFF, usesOtpLogin, OTP_LOGIN_ROLES } from './middleware.js'
import { revokeBearer, revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { setAuthCookies, setAccessCookie, clearAuthCookies, readCookie, ACCESS_COOKIE, REFRESH_COOKIE } from '../../lib/cookies.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { resolveTenantScope, tenantWhere, scopeTenantWhere } from '../../lib/tenantScope.js'
import { childRolesFor } from '../../lib/workspaces.js'
import { approvalInputOf, approvalQueueTenantIds, auditApproval, canApprove } from '../../lib/approvalRights.js'
import { viaHeadOfficeForSubmit } from '../../lib/headOffice.js'
import { withoutCeoOnlyModules, effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { activeAtOnce, activationSideEffects, switchOffLogin, OFFBOARDERS } from './offboarding.js'
import { AppError, UnauthorizedError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { isStaffEmail, normaliseStaffEmail, STAFF_EMAIL_MESSAGE } from '../../lib/staffEmail.js'
import { generateStaffPassword } from '../../lib/generatePassword.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { TRASH_COMPANY, inTrashConflict } from '../trash/providers/masters/company.js'
import {
  check as checkRateLimit,
  claim as claimRateLimit,
  release as releaseRateLimit,
  recordFailure,
  clearFailures,
  STAFF_PASSWORD_LIMIT,
  STAFF_PASSWORD_USER_LIMIT,
  CUSTOMER_PASSWORD_LIMIT,
  MAGIC_LINK_VERIFY_LIMIT,
  PASSWORD_RESET_LIMIT,
  PASSWORD_RESET_USE_LIMIT,
  STAFF_OTP_PHONE_LIMIT
} from '../../lib/loginRateLimit.js'

const staffLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

// Floor-staff code sign-in. The phone is free-form because it is typed on a
// till by someone who may write it 0300…, +92300… or 92300… — normalisePhone
// resolves all three to one key.
const staffOtpRequestSchema = z.object({
  phone: z.string().min(7).max(20),
})
const staffOtpVerifySchema = z.object({
  phone: z.string().min(7).max(20),
  code: z.string().min(4).max(8),
})

const refreshSchema = z.object({
  refreshToken: z.string(),
})

// 32 characters for a link to an existing account; a signed link (longer) for
// a contact that had no account when it was requested (service.ts).
const magicLinkVerifySchema = z.object({
  token: z.string().min(32).max(1000),
})

// Rate-limit buckets this module owns (same shape as lib/loginRateLimit.ts).
//
// Sign-in links, PER CONTACT per day: the endpoint is unauthenticated and sends
// a message to a contact the caller chose, so the contact is what gets capped —
// an IP limit alone is the easy half to get around (owner rule, 2026-09-09).
// Counted for every request, account or not, so a 429 says nothing about
// whether the contact has one.
const MAGIC_LINK_CONTACT_LIMIT = { scope: 'magic-link-contact', max: 5, lockoutSec: 24 * 60 * 60 }
// Manager-issued sign-in codes, per manager per hour. A shift start is a
// handful; this stops a session being used to mint codes in bulk.
const STAFF_CODE_ISSUER_LIMIT = { scope: 'staff-code-issuer', max: 30, lockoutSec: 60 * 60 }
// Wrong current PIN / password on the signed-in PIN setter, per account. The
// session is already authenticated; this stops a borrowed session grinding the
// 10^4 PIN space or the password.
const PIN_CHANGE_USER_LIMIT = { scope: 'pin-change-user', max: 5, lockoutSec: 15 * 60 }
// EVERY PIN-setting attempt on the self-service setter, per account per hour —
// success, wrong credential or PIN_COLLISION alike (AUTH-R4). The collision
// answer is a yes/no on "is this a colleague's PIN?", so this is what keeps the
// 4-digit space from being enumerated.
const PIN_CHANGE_ATTEMPT_LIMIT = { scope: 'pin-change-attempt', max: 6, lockoutSec: 60 * 60 }

interface TenantLite { id: string; name: string; slug: string }

// Drop duplicate tenants (a user's primary is also in their memberships list).
// Order-preserving so the primary shows first in the UI's chip group.
function dedupeTenants(list: Array<TenantLite | null | undefined>): TenantLite[] {
  const seen = new Set<string>()
  const out: TenantLite[] = []
  for (const t of list) {
    if (!t) continue
    if (seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}
function dedupeStrings(list: string[]): string[] {
  return Array.from(new Set(list))
}

// Roles the CEO may assign on the staff editor — derived from the Prisma enum
// in lib/roles.ts (every role except legacy 'manager'; 'admin' included so the
// founder can name a successor). This used to be a hand-kept list that had
// drifted: Workforce offered fnb_manager, brand_manager and owner, and the API
// rejected all three with a 400.
const STAFF_ROLE_WITH_ADMIN = z.enum(ASSIGNABLE_ROLES_WITH_ADMIN as [UserRole, ...UserRole[]])

// Manager-override PIN rules (format, weak-PIN list, per-company collision
// check) live in ./managerPin.ts — the ONE setter and the ONE verifier.
export { isWeakPin } from './managerPin.js'
import { clockIn, clockOut } from '../timeclock/service.js'

/**
 * Sign-in trail (decision 47): auth.login, auth.login_failed, auth.otp_login,
 * auth.2fa_failed, auth.logout — category identity, stamped with the SIGNING-IN
 * user's company (null when the email matched nobody). Never carries a
 * password, code or token: only who, where from, and why it failed.
 */
async function signInAudit(
  req: FastifyRequest,
  action: 'auth.login' | 'auth.login_failed' | 'auth.otp_login' | 'auth.2fa_failed' | 'auth.logout',
  who: { userId: string | null; email: string | null },
  extra: Record<string, unknown> = {},
): Promise<void> {
  let tenantId: string | null = null
  if (who.userId) {
    const u = await prisma.user.findUnique({ where: { id: who.userId }, select: { tenantId: true } }).catch(() => null)
    tenantId = u?.tenantId ?? null
  }
  const ua = req.headers['user-agent']
  await audit({
    category: 'identity',
    action,
    entity: 'User',
    entityId: who.userId,
    userId: who.userId,
    userEmail: who.email,
    tenantId,
    metadata: { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null, ...extra },
  })
}

/** Why a sign-in failed, as a short code — never the message, never the input. */
function failReason(err: unknown): string {
  return err instanceof AppError ? err.code.toLowerCase() : 'error'
}

/**
 * The email of a new login is held by a login in the Trash → 409 IN_TRASH so
 * the screen offers "Restore it instead" (the CEO restores logins). Named only
 * to someone in one of its companies (a company-less login: the CEO); anything
 * else keeps EMAIL_TAKEN (null here).
 */
async function loginInTrash(req: FastifyRequest, holderId: string): Promise<AppError | null> {
  const h = await prisma.user.findUnique({
    where: { id: holderId },
    select: { id: true, deletedAt: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  if (!h?.deletedAt) return null
  const companies = [h.tenantId, ...h.tenantMemberships.map((m) => m.tenantId)].filter(Boolean) as string[]
  const mine = new Set(req.staffUser?.memberTenantIds ?? [])
  const visible = companies.length ? companies.some((t) => mine.has(t)) : req.staffUser?.role === 'admin'
  return inTrashConflict(TRASH_COMPANY.login, h.id, visible, 'A login with that email')
}

/** HR's onboarding / offboarding runs from the HR back office: an HR login
 *  needs the staff_hr module (the CEO's untick closes it). Other roles pass. */
async function assertHrBackOffice(req: FastifyRequest): Promise<void> {
  if (req.staffUser?.role !== 'hr') return
  const me = await prisma.user.findUnique({ where: { id: req.staffUser.id }, select: { moduleAllow: true, moduleDeny: true } })
  const mods = await effectiveModulesForUser({ role: 'hr', moduleAllow: me?.moduleAllow ?? [], moduleDeny: me?.moduleDeny ?? [] })
  if (!mods.has('staff_hr')) {
    throw new AppError('FORBIDDEN', 'Your account does not have access to this module (staff_hr). Ask the CEO to enable it in Module Access.', 403)
  }
}

export async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/login — staff email+password login (brute-force protected)
  fastify.post('/login', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(STAFF_PASSWORD_LIMIT, ip)

    const body = staffLoginSchema.parse(req.body)

    // Per-ACCOUNT limit as well as per-IP. PIN login has had both since it was
    // hardened; password login only ever had the IP one, and an IP limit is the
    // easy half to get around — a botnet or a rotating proxy gives an attacker
    // a fresh budget per request against a single, known address.
    //
    // That matters more now than it used to: blocking PIN login for owner,
    // management and finance made the password the ONLY way into those
    // accounts, which is exactly the set worth attacking.
    const accountKey = `email:${body.email.trim().toLowerCase()}`
    await checkRateLimit(STAFF_PASSWORD_USER_LIMIT, accountKey)

    let result: Awaited<ReturnType<typeof staffLogin>>
    try {
      result = await staffLogin(body.email, body.password)
      // Floor roles have no password — they sign in with a WhatsApp code. If a
      // stale one is still set on the row, it must not be a way in: the whole
      // point of the split is that a credential which can be shoulder-surfed,
      // written on a sticker or kept after leaving does not open a till.
      // Checked AFTER the password so this cannot be used to find out which
      // addresses are floor staff.
      // The practice copy sends no codes, so its floor logins (made from a
      // name and a role, below) sign in with the password they were given.
      if (!result.twoFactorRequired && usesOtpLogin(result.user?.role) && !isSandbox()) {
        throw new AppError(
          'USE_CODE_LOGIN',
          'This account signs in with a code sent to WhatsApp. Tap "Sign in with a code".',
          403,
        )
      }
      await clearFailures(STAFF_PASSWORD_LIMIT, ip)
      await clearFailures(STAFF_PASSWORD_USER_LIMIT, accountKey)
    } catch (err) {
      await recordFailure(STAFF_PASSWORD_USER_LIMIT, accountKey)
      await recordFailure(STAFF_PASSWORD_LIMIT, ip)
      // Attribute to the account when the typed address is one; the response
      // stays the same generic error either way.
      const typed = normaliseStaffEmail(body.email)
      const known = await prisma.user.findFirst({ where: { email: typed }, select: { id: true } }).catch(() => null)
      await signInAudit(req, 'auth.login_failed', { userId: known?.id ?? null, email: typed }, { reason: failReason(err), method: 'password' })
      throw err
    }
    // 2FA accounts get no session yet — just the challenge and a masked hint
    // of where the code went. No cookies are set here.
    if (result.twoFactorRequired) {
      return reply.status(200).send({
        twoFactorRequired: true,
        challengeToken: result.challengeToken,
        phoneHint: result.phoneHint,
        ...practiceCodeField(result.practiceCode), // practice copy only
      })
    }

    await signInAudit(req, 'auth.login', { userId: result.user.id, email: result.user.email }, { method: 'password' })
    // Manager web: also set httpOnly session cookies (the token stays out of
    // JS). Tablet/mobile ignore these and keep using the body tokens + Bearer.
    setAuthCookies(reply, result.accessToken, result.refreshToken)
    return reply.status(200).send(result)
  })

  // ── FLOOR-STAFF SIGN-IN: a code, not a password ───────────────────────────
  //
  // POST /auth/staff/otp/request — { phone } → a 6-digit code over WhatsApp.
  //
  // Unauthenticated, and it makes GS Foods send a message to a number the
  // CALLER chose, which is the shape of thing that has been abused here before.
  // Three things bound it: the number must already belong to an active
  // floor-role staff member (so it can never reach an arbitrary phone), the
  // per-phone limit is tighter than the per-IP one (an IP limit is the easy
  // half to get around), and the OTP service's own 30-second resend cooldown
  // sits underneath both.
  //
  // The response is identical whether or not a number matched. Anything else
  // turns this into a way to ask "is this number a cashier here?".
  fastify.post('/staff/otp/request', async (req, reply) => {
    refuseCodeRequestInPractice('staff') // practice copy: nothing is sent, say so (lib/sandbox.ts)
    const body = staffOtpRequestSchema.parse(req.body)
    const phone = normalisePhone(body.phone)

    await checkRateLimit(STAFF_PASSWORD_LIMIT, req.ip ?? 'unknown')
    await checkRateLimit(STAFF_OTP_PHONE_LIMIT, `phone:${phone}`)

    const staff = await findOtpLoginStaff(phone)
    if (staff) {
      try {
        // Same code to WhatsApp and the staff member's email; either works.
        await requestSharedCode({ phone, email: staff.email, purpose: 'staff_login' })
      } catch (err) {
        // A cooldown is the caller's own doing and worth saying out loud —
        // silence here reads as "my number is wrong" and they try another one.
        if (err instanceof AppError && (err.code === 'OTP_COOLDOWN' || err.code === 'OTP_DAILY_LIMIT')) throw err
        // Anything else (WhatsApp down or unconfigured) is ours. Say so plainly
        // rather than returning the generic success: a cashier standing at a
        // till needs to know to go and find a manager, not to keep retrying.
        req.log.error({ err, staffId: staff.id }, 'staff login OTP send failed')
        // The way round it is real now: a manager opens Workforce, finds this
        // person and taps "Sign-in code" (POST /auth/staff/:id/sign-in-code).
        throw new AppError(
          'OTP_UNAVAILABLE',
          'Sign-in codes cannot be sent right now. Ask a manager for a sign-in code — they get one from Workforce ("Sign-in code" next to your name) — and enter it here.',
          503,
        )
      }
      await recordFailure(STAFF_OTP_PHONE_LIMIT, `phone:${phone}`)
    }

    // Same body, same timing envelope, whether or not the number is staff.
    return reply.status(200).send({
      sent: true,
      message: 'If that number belongs to a staff account, a code is on its way.',
    })
  })

  // POST /auth/staff/otp/verify — { phone, code } → a session.
  //
  // Issues exactly the same session a password login would, through the same
  // issueStaffSession(), so the two paths cannot drift in what they grant.
  fastify.post('/staff/otp/verify', async (req, reply) => {
    const body = staffOtpVerifySchema.parse(req.body)
    const phone = normalisePhone(body.phone)
    const key = `phone:${phone}`

    await checkRateLimit(STAFF_PASSWORD_LIMIT, req.ip ?? 'unknown')
    await checkRateLimit(STAFF_OTP_PHONE_LIMIT, key)

    // Re-resolve the account at VERIFY time rather than trusting anything from
    // the request step. A code alone must not be enough if the account was
    // suspended, deleted or promoted out of a floor role in the five minutes
    // since it was sent.
    const staff = await findOtpLoginStaff(phone)
    if (!staff) {
      await recordFailure(STAFF_OTP_PHONE_LIMIT, key)
      throw new UnauthorizedError('That code is not valid')
    }

    try {
      await verifySharedCode({ phone, email: staff.email, code: body.code, purpose: 'staff_login' })
    } catch (err) {
      await recordFailure(STAFF_OTP_PHONE_LIMIT, key)
      await signInAudit(req, 'auth.login_failed', { userId: staff.id, email: staff.email }, { reason: failReason(err), method: 'otp' })
      throw err
    }
    await clearFailures(STAFF_OTP_PHONE_LIMIT, key)

    await signInAudit(req, 'auth.otp_login', { userId: staff.id, email: staff.email }, { method: 'otp' })
    const session = issueStaffSession(staff)
    setAuthCookies(reply, session.accessToken, session.refreshToken)
    return reply.status(200).send({ twoFactorRequired: false, ...session })
  })

  // POST /auth/2fa/verify — trade a login challenge + WhatsApp code for a session.
  //
  // Rate limited on the same bucket as password login: the challenge is only
  // handed out after a correct password, but a limit here still bounds anyone
  // grinding codes against a challenge they have obtained.
  fastify.post('/2fa/verify', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(STAFF_PASSWORD_LIMIT, ip)

    const body = z.object({
      challengeToken: z.string().min(1),
      code: z.string().min(4).max(10),
    }).parse(req.body)

    let user
    try {
      user = await verifyLoginChallenge(body.challengeToken, body.code)
      await clearFailures(STAFF_PASSWORD_LIMIT, ip)
    } catch (err) {
      await recordFailure(STAFF_PASSWORD_LIMIT, ip)
      const sub = challengeSubject(body.challengeToken)
      const who = sub ? await prisma.user.findUnique({ where: { id: sub }, select: { id: true, email: true } }).catch(() => null) : null
      await signInAudit(req, 'auth.2fa_failed', { userId: who?.id ?? null, email: who?.email ?? null }, { reason: failReason(err) })
      throw err
    }

    await signInAudit(req, 'auth.login', { userId: user.id, email: user.email }, { method: 'password+2fa' })
    const session = issueStaffSession(user)
    setAuthCookies(reply, session.accessToken, session.refreshToken)
    return reply.status(200).send(session)
  })

  // ─── 2FA enrolment (authenticated) ─────────────────────────────────────────
  //
  // Two steps on purpose: the number is stored only after a code sent to it has
  // been typed back, so nobody can switch 2FA on for a number they mistyped and
  // lock themselves out of their own account.

  // POST /auth/2fa/start — send a code to the number being enrolled.
  fastify.post('/2fa/start', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ phone: z.string().min(6) }).parse(req.body)
    return startEnrolment(req.staffUser!.id, body.phone)
  })

  // POST /auth/2fa/enable — code came back; store the number and switch 2FA on.
  fastify.post('/2fa/enable', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({
      phone: z.string().min(6),
      code: z.string().min(4).max(10),
    }).parse(req.body)
    const { phoneHint } = await completeEnrolment(req.staffUser!.id, body.phone, body.code)
    return { enabled: true, phoneHint }
  })

  // POST /auth/2fa/disable — requires the account password, not just a session,
  // so a walked-up-to laptop or a stolen token can't strip the second factor.
  fastify.post('/2fa/disable', { preHandler: requireAuth() }, async (req) => {
    const body = z.object({ password: z.string().min(1) }).parse(req.body)
    await disableTwoFactor(req.staffUser!.id, body.password)
    return { enabled: false }
  })

  // GET /auth/2fa/status — what the settings screen renders.
  fastify.get('/2fa/status', { preHandler: requireAuth() }, async (req) => {
    const u = await prisma.user.findFirst({
      where: { id: req.staffUser!.id, deletedAt: null },
      select: { twoFactorPhone: true, twoFactorEnabledAt: true },
    })
    return {
      enabled: Boolean(u?.twoFactorEnabledAt && u?.twoFactorPhone),
      phoneHint: u?.twoFactorPhone ? maskPhone(u.twoFactorPhone) : null,
      enabledAt: u?.twoFactorEnabledAt ?? null,
    }
  })

  // ─── Password self-service ────────────────────────────────────────────
  //
  // Reachable from the LOGIN PAGE, so it cannot require a session: someone
  // handed a generated password needs to replace it before they have anything
  // else. That makes it an unauthenticated endpoint that verifies a password,
  // i.e. a second front door — so it deliberately shares the SAME rate-limit
  // buckets and the SAME generic error as /auth/login. Given its own scope it
  // would be a clean bypass of the login lockout: grind currentPassword here
  // instead of there.
  const passwordChangeSchema = z.object({
    // Min 12 to match src/scripts/set-staff-password.ts. /auth/login accepts 8
    // for legacy reasons; new passwords do not get to be shorter than the
    // break-glass tool enforces.
    newPassword: z.string().min(12).max(200),
  })

  async function applyPasswordChange(userId: string, email: string, newPassword: string): Promise<void> {
    if (newPassword.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) {
      throw new AppError('WEAK_PASSWORD', 'Your password cannot contain your email name.', 400)
    }
    await prisma.user.update({
      where: { id: userId },
      data: { password: await hashPassword(newPassword), mustChangePassword: false },
    })
    // Every other session for this person dies with the old password —
    // otherwise "change my password" does not evict whoever knew the old one.
    await revokeAllForSubject(userId)
  }

  // POST /auth/password/change — no session required. Linked from /login.
  fastify.post('/password/change', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    const body = passwordChangeSchema.extend({
      email: z.string().email().max(200),
      currentPassword: z.string().min(1).max(200),
    }).parse(req.body)
    const emailKey = body.email.trim().toLowerCase()

    await checkRateLimit(STAFF_PASSWORD_LIMIT, ip)
    await checkRateLimit(STAFF_PASSWORD_USER_LIMIT, emailKey)

    const user = await prisma.user.findUnique({
      where: { email: emailKey },
      select: { id: true, email: true, password: true, isActive: true, accountStatus: true, deletedAt: true },
    })
    const ok = user
      && user.deletedAt === null
      && user.isActive
      && user.accountStatus === 'active'
      && await bcrypt.compare(body.currentPassword, user.password)

    if (!ok) {
      await recordFailure(STAFF_PASSWORD_LIMIT, ip)
      await recordFailure(STAFF_PASSWORD_USER_LIMIT, emailKey)
      // Same wording as a failed login — this must not become an oracle that
      // says "that account exists, wrong password".
      throw new AppError('UNAUTHORIZED', 'Invalid credentials', 401)
    }
    if (body.currentPassword === body.newPassword) {
      throw new AppError('WEAK_PASSWORD', 'Your new password must be different from the current one.', 400)
    }

    await clearFailures(STAFF_PASSWORD_LIMIT, ip)
    await clearFailures(STAFF_PASSWORD_USER_LIMIT, emailKey)
    await applyPasswordChange(user!.id, user!.email!, body.newPassword)
    return reply.status(204).send()
  })

  // POST /auth/password/forgot — the way back in when you don't know the
  // password. Sends a one-shot link to the account's email and, when there's a
  // phone on file, to WhatsApp as well.
  //
  // Always answers 202 with the same body. Whether the address belongs to an
  // account is not something this endpoint will tell you — the message itself
  // is the only signal, and it only reaches the real owner.
  fastify.post('/password/forgot', async (req, reply) => {
    const body = z.object({ email: z.string().email().max(200) }).parse(req.body)
    const emailKey = body.email.trim().toLowerCase()
    // Practice copy: no link is sent, and one is never echoed to an unauthenticated caller (lib/sandbox.ts).
    if (sandboxBlocks('password_reset')) throw new AppError('RESET_UNAVAILABLE', 'Practice copy: reset links are not sent here. Ask an admin to issue you a new password from Workforce.', 503)

    // Say so rather than promising a link that physically cannot be sent.
    // This is a fact about the server, not about the account, so it gives away
    // nothing — and the alternative is someone refreshing an inbox forever.
    if (!(await deliveryConfigured())) {
      req.log.error('password reset requested but no delivery channel is configured')
      throw new AppError(
        'RESET_UNAVAILABLE',
        'Password reset is not available right now — this server has no way to send you a link. Ask an admin to issue you a new password from Workforce.',
        503,
      )
    }

    // Keyed on the email, not the IP: the abuse this guards against is using
    // our gateway to spam ONE person's inbox and phone, which rotating source
    // addresses would sail straight past.
    await checkRateLimit(PASSWORD_RESET_LIMIT, emailKey)
    await recordFailure(PASSWORD_RESET_LIMIT, emailKey)

    const outcome = await requestPasswordReset(emailKey, req.ip ?? null)
    if (outcome.errors.length > 0) {
      // Log loudly. A reset that silently fails to send is indistinguishable
      // from one the user just hasn't opened yet, and that is exactly how
      // somebody ends up locked out with no idea why.
      req.log.error({ email: emailKey, outcome }, 'password reset delivery failed')
    } else if (outcome.email === 'sent' || outcome.whatsapp === 'sent') {
      req.log.info({ email: emailKey, email_: outcome.email, whatsapp: outcome.whatsapp }, 'password reset sent')
    }

    return reply.status(202).send({
      ok: true,
      message: 'If that account exists, a reset link is on its way to its email and WhatsApp.',
    })
  })

  // GET /auth/password/reset?token=… — is this link still good? Lets the reset
  // page say "this link has expired" before asking for a new password rather
  // than after.
  fastify.get<{ Querystring: { token?: string } }>('/password/reset', async (req) => {
    const token = (req.query.token ?? '').trim()
    if (!token) return { valid: false }
    return { valid: await checkResetToken(token) }
  })

  // POST /auth/password/reset — redeem the link.
  fastify.post('/password/reset', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    const body = passwordChangeSchema.extend({
      token: z.string().min(10).max(500),
    }).parse(req.body)

    await checkRateLimit(PASSWORD_RESET_USE_LIMIT, ip)

    const user = await consumeResetToken(body.token.trim())
    if (!user) {
      await recordFailure(PASSWORD_RESET_USE_LIMIT, ip)
      throw new AppError('RESET_LINK_INVALID', 'That reset link has expired or already been used. Request a new one.', 400)
    }

    await clearFailures(PASSWORD_RESET_USE_LIMIT, ip)
    // Clear the login lockouts too. Someone who just proved control of the
    // account's inbox should not then be told to wait 15 minutes because they
    // burned the login budget guessing before they gave up and reset.
    await clearFailures(STAFF_PASSWORD_LIMIT, ip)
    await clearFailures(STAFF_PASSWORD_USER_LIMIT, user.email)
    await clearFailures(PASSWORD_RESET_LIMIT, user.email)

    // applyPasswordChange revokes every existing session, which is what we
    // want: a reset is how you respond to a credential you no longer trust.
    await applyPasswordChange(user.id, user.email, body.newPassword)
    req.log.warn({ target: user.id }, 'password reset via emailed link')
    return reply.status(204).send()
  })

  // POST /auth/password/change-authed — same thing for a signed-in user. The
  // admin's /account/password page, where the "choose your own password"
  // prompt after a generated or reissued one lands.
  //
  // Shares the per-account login bucket: a session that can grind the current
  // password here unthrottled would be a way round the login lockout. A wrong
  // current password is 400, not 401 — a 401 makes the web client refresh and
  // retry, spending two attempts per click.
  //
  // Every OTHER session dies with the old password (applyPasswordChange); this
  // device gets a fresh session in the response, so the person who just proved
  // the password is not thrown out mid-task.
  fastify.post('/password/change-authed', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = passwordChangeSchema.extend({
      currentPassword: z.string().min(1).max(200),
    }).parse(req.body)
    const me = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { id: true, name: true, email: true, role: true, password: true },
    })
    if (!me) throw new UnauthorizedError('Account is no longer active')
    if (usesOtpLogin(me.role)) {
      throw new AppError('USE_CODE_LOGIN', 'You sign in with a code sent to your phone, so there is no password to change.', 400)
    }
    const accountKey = `email:${(me.email ?? me.id).toLowerCase()}`
    // claim() BEFORE the compare, not check-then-record: N parallel guesses
    // used to all pass the read before any failure was written (AUTH-R3), which
    // made this a way round the per-account login lockout. A correct password
    // clears the bucket, as a successful sign-in does.
    await claimRateLimit(STAFF_PASSWORD_USER_LIMIT, accountKey)
    if (!await bcrypt.compare(body.currentPassword, me.password)) {
      throw new AppError('WRONG_PASSWORD', 'Your current password is not right.', 400)
    }
    await clearFailures(STAFF_PASSWORD_USER_LIMIT, accountKey)
    if (body.currentPassword === body.newPassword) {
      throw new AppError('WEAK_PASSWORD', 'Your new password must be different from the current one.', 400)
    }
    await applyPasswordChange(me.id, me.email ?? '@', body.newPassword)
    await audit({
      category: 'identity',
      action: 'user.password_change',
      entity: 'User',
      entityId: me.id,
      userId: me.id,
      userEmail: me.email,
      tenantId: req.staffUser!.tenantId ?? null,
    })
    // mustChangePassword is false now (applyPasswordChange cleared it).
    const session = issueStaffSession({ id: me.id, name: me.name, email: me.email, role: me.role, mustChangePassword: false })
    setAuthCookies(reply, session.accessToken, session.refreshToken)
    return reply.status(200).send(session)
  })

  // POST /auth/users/:id/reissue-password — admin issues a fresh password.
  //
  // The gap this fills: a forgotten password had NO remedy. Self-service
  // change needs the current one, there is no email reset flow, and the only
  // other path was editing the database by hand on the production box. The
  // Workforce hand-over screen already tells the operator "if you lose it,
  // issue a new one" — until now that was not true.
  //
  // Returns the plaintext ONCE, same contract as account creation: we store a
  // bcrypt hash and nobody, admin included, can read it back afterwards.
  fastify.post<{ Params: { id: string } }>(
    '/users/:id/reissue-password',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      // Same scope rule as every other staff-admin route (staffAccounts.ts):
      // another company's login is 404; a login shared with a company the
      // operator is not in is 403. This used to read `tenantFilter`, which for
      // a single-company operator is their PRIMARY company and for an operator
      // with none is `null` — matching every company-less row.
      const target = await findManagedStaff(req, req.params.id, { id: true, name: true, email: true })
      if (!target.email) {
        return reply.status(400).send({ error: { code: 'EMAIL_REQUIRED', message: 'This account has no email, so it has no way to sign in. Add one first.' } })
      }

      const temporaryPassword = generateStaffPassword()
      await prisma.user.update({
        where: { id: target.id },
        data: { password: await hashPassword(temporaryPassword), mustChangePassword: true },
      })
      // Whoever knew the old password loses their sessions with it. A reissue
      // is most often triggered BECAUSE a credential is suspect.
      await revokeAllForSubject(target.id)
      req.log.warn({ actor: req.staffUser!.id, target: target.id }, 'password reissued by admin')
      // Someone other than the account holder now knows a working credential
      // for it. That belongs in the trail whatever the reason was.
      await audit({
        category: 'identity',
        action: 'user.password_reissue',
        entity: 'User',
        entityId: target.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        // Filed under the TARGET's company, so that company's CEO and IT see
        // that one of their people was changed. The actor's company rides along.
        tenantId: auditCompanyOf(target),
        after: { targetEmail: target.email },
        metadata: { actorTenantId: req.staffUser?.tenantId ?? null },
      })

      return reply.status(200).send({
        id: target.id,
        name: target.name,
        email: target.email,
        temporaryPassword,
      })
    },
  )

  // POST /auth/users/:id/2fa/reset — admin clears someone's 2FA enrolment.
  //
  // Without this, an account enrolled in WhatsApp OTP whose phone is lost,
  // stolen or reassigned is locked out permanently: /auth/2fa/disable is
  // self-service and needs that person's own password, and PATCH /auth/users
  // has no twoFactor field. PIN login used to be the accidental escape hatch
  // because staffPinLogin never checked 2FA at all — that hatch closes when
  // PIN login goes, so the deliberate one has to exist first.
  fastify.post<{ Params: { id: string } }>(
    '/users/:id/2fa/reset',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const target = await findManagedStaff(req, req.params.id, { id: true, name: true, email: true, twoFactorEnabledAt: true })
      await prisma.user.update({
        where: { id: target.id },
        data: { twoFactorPhone: null, twoFactorEnabledAt: null },
      })
      // Their sessions die too: whoever holds the old phone should not keep a
      // live session after we have unhooked the second factor.
      await revokeAllForSubject(target.id)
      req.log.warn({ actor: req.staffUser!.id, target: target.id }, '2FA reset by admin')
      // Removing someone's second factor is a change to who can get in; it was
      // never written to the identity trail.
      await audit({
        category: 'identity',
        action: 'user.2fa_reset',
        entity: 'User',
        entityId: target.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        tenantId: auditCompanyOf(target),
        before: { twoFactorEnabled: !!target.twoFactorEnabledAt },
        after: { twoFactorEnabled: false, targetEmail: target.email },
        metadata: { actorTenantId: req.staffUser?.tenantId ?? null },
      })
      return reply.status(200).send({ id: target.id, name: target.name, twoFactorEnabled: false })
    },
  )

  // POST /auth/clock-in and /auth/clock-out are the tablet's and the admin
  // logout's punch calls. They hand off to the time-clock module, which is the
  // ONE punch writer: it applies the company's geofence (lib/setup-config.ts),
  // writes the ClockLog, and turns the punch into the day's HR attendance.
  fastify.post('/clock-in', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      selfieUrl: z.string().url().optional(),
    }).parse(req.body ?? {})
    const u = req.staffUser!
    const r = await clockIn({ id: u.id, role: u.role, tenantId: u.tenantId ?? null, name: u.name }, body, req.ip)
    return reply.status('alreadyClockedIn' in r && r.alreadyClockedIn ? 200 : 201).send(r)
  })

  fastify.post('/clock-out', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const u = req.staffUser!
    await clockOut({ id: u.id, role: u.role, tenantId: u.tenantId ?? null, name: u.name }, {}, req.ip)
    return reply.status(204).send()
  })

  // The punch report is GET /time-clock/logs (admin /hr/attendance) — PKT day
  // boundaries, attendance joined. The old /auth/clock-logs copy is gone (D6).

  // POST /auth/refresh — refresh access token
  fastify.post('/refresh', async (req, reply) => {
    // Refresh token from the body (tablet/mobile) OR the httpOnly cookie
    // (manager web, which holds no token in JS).
    const body = refreshSchema.partial().parse(req.body ?? {})
    const refreshToken = body.refreshToken || readCookie(req, REFRESH_COOKIE)
    if (!refreshToken) return reply.status(401).send({ error: { code: 'NO_REFRESH', message: 'No refresh token provided' } })
    const result = await refreshStaffToken(refreshToken)
    setAccessCookie(reply, result.accessToken)   // rotate the web session cookie
    return reply.status(200).send(result)
  })

  // POST /auth/logout — revoke the caller's session. JWTs are stateless, so we
  // add the presented token (and refresh token, if sent) to the Redis deny
  // list for the remainder of their life. Accepts PIN sessions too (KDS).
  fastify.post('/logout', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    await revokeBearer(req.headers.authorization)
    // Manager web sends no Bearer — revoke whatever's in the cookies, then clear.
    const cookieAt = readCookie(req, ACCESS_COOKIE);  if (cookieAt) await revokeBearer(`Bearer ${cookieAt}`)
    const cookieRt = readCookie(req, REFRESH_COOKIE); if (cookieRt) await revokeBearer(`Bearer ${cookieRt}`)
    const body = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {})
    if (body.refreshToken) await revokeBearer(`Bearer ${body.refreshToken}`)
    await signInAudit(req, 'auth.logout', { userId: req.staffUser!.id, email: req.staffUser!.email })
    clearAuthCookies(reply)
    return reply.status(200).send({ ok: true })
  })

  // POST /auth/customer/logout — revoke the customer's session token.
  fastify.post('/customer/logout', { preHandler: requireCustomerAuth }, async (req, reply) => {
    await revokeBearer(req.headers.authorization)
    return reply.status(200).send({ ok: true })
  })


  // POST /auth/customer/login — email+password login (brute-force protected)
  fastify.post('/customer/login', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(CUSTOMER_PASSWORD_LIMIT, ip)

    const body = z.object({
      email:    z.string().email(),
      password: z.string().min(8),
    }).parse(req.body)

    let result: Awaited<ReturnType<typeof customerLogin>>
    try {
      result = await customerLogin(body.email, body.password)
      await clearFailures(CUSTOMER_PASSWORD_LIMIT, ip)
    } catch (err) {
      await recordFailure(CUSTOMER_PASSWORD_LIMIT, ip)
      throw err
    }
    return reply.status(200).send(result)
  })

  // POST /auth/customer/register — email+password signup
  // Rate-limited per IP to block enumeration; on duplicate email we return 200
  // with the same shape as a successful registration so attackers can't tell
  // whether the address is already in use.
  fastify.post('/customer/register', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(CUSTOMER_PASSWORD_LIMIT, ip)

    const body = z.object({
      name:     z.string().min(1).max(80),
      email:    z.string().email(),
      password: z.string()
        .min(8, 'Password must be at least 8 characters')
        .regex(/[a-zA-Z]/, 'Password must contain a letter')
        .regex(/[0-9]/, 'Password must contain a number'),
      // Every account carries BOTH a phone and an email, and verifies each one
      // a code reached. WhatsApp is unofficial and can drop; email is the
      // second channel that keeps signup working when it does.
      phone:     z.string().min(7).max(20),
      // The one code sent to both channels. otpCode / emailCode are the older
      // field names, still accepted so a page cached before this change works.
      code:      z.string().regex(/^\d{4,6}$/).optional(),
      otpCode:   z.string().regex(/^\d{4,6}$/).optional(),
      emailCode: z.string().regex(/^\d{6}$/).optional(),
      // Optional: 8-char referral code from another customer. If valid, links
      // the two and primes the dual-bonus payout on the new customer's
      // first order.
      referralCode: z.string().min(4).max(16).optional(),
      // Optional device fingerprint from JS. Captured if available — used by
      // the naughty-list gate.
      deviceFingerprint: z.string().max(120).optional(),
    }).parse(req.body)

    // One code went to both channels; entering it from either proves the
    // customer holds at least one of them. Each channel is marked verified if a
    // copy was delivered there — a channel whose copy never arrived (WhatsApp
    // down) stays unverified and can be finished later from /account.
    const code = body.code ?? body.otpCode ?? body.emailCode
    if (!code) {
      throw new AppError('VERIFICATION_REQUIRED', 'Enter the code we sent you to create your account.', 400)
    }
    const verified = await verifySharedCode({ phone: body.phone, email: body.email, code, purpose: 'signup' })
    const otpVerified = verified.deliveredToPhone
    const emailVerified = verified.deliveredToEmail

    // Bans are servd-wide (owner, 2026-10-15) and are enforced where the
    // customer orders or books (checkout / booking time), matched on the
    // account, its email and its phone — a banned contact gains nothing by
    // signing up again.

    try {
      const result = await customerRegister(
        body.name, body.email, body.password,
        normalisePhone(body.phone),
        otpVerified,
        body.referralCode,
        emailVerified,
      )
      await clearFailures(CUSTOMER_PASSWORD_LIMIT, ip)
      return reply.status(201).send(result)
    } catch (err) {
      // Treat conflicts as "ok" externally to avoid leaking which emails exist.
      if (err instanceof AppError && err.code === 'EMAIL_TAKEN') {
        return reply.status(200).send({ ok: true, message: 'If your email is new, your account is ready.' })
      }
      await recordFailure(CUSTOMER_PASSWORD_LIMIT, ip)
      throw err
    }
  })

  // /customer/request-otp and /customer/verify-otp are gone. They had no
  // caller, and request-otp was an unauthenticated, IP-limited-only endpoint
  // that sent a WhatsApp message to any number the caller chose. Signup uses
  // /customer/request-signup-codes below; verify-later uses /customer/contact/*,
  // which read the number from the session. Both share otp.ts's per-contact
  // daily cap.

  // POST /auth/customer/request-signup-codes — ONE code, sent to WhatsApp and
  // email at the same time. One channel failing never blocks the other; that
  // is the point of having two. Only when neither can be reached does signup
  // stop. Per channel: 'sent' or 'failed'.
  fastify.post('/customer/request-signup-codes', async (req, reply) => {
    refuseCodeRequestInPractice('customer') // practice copy: nothing is sent
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(CUSTOMER_PASSWORD_LIMIT, ip)
    const body = z.object({
      phone: z.string().min(7).max(20),
      email: z.string().email(),
    }).parse(req.body)

    // ONE code to both channels (otp.ts requestSharedCode). The customer types
    // whichever copy arrives first. requestSharedCode throws OTP_SEND_FAILED
    // only when neither channel could be reached.
    const sent = await requestSharedCode({ phone: body.phone, email: body.email, purpose: 'signup' })
    const phone = { status: sent.phone }
    const email = { status: sent.email }
    // Delivery detail stays server-side; the client only needs the status.
    return reply.status(200).send({
      phone: { status: phone.status },
      email: { status: email.status },
    })
  })

  // Verify-later, for whichever channel signup could not reach (or accounts
  // created before email verification existed). Uses the contact details on
  // file — the customer cannot point a code at an address that is not theirs.
  fastify.post('/customer/contact/request', { preHandler: requireCustomerAuth }, async (req, reply) => {
    refuseCodeRequestInPractice('customer') // practice copy: nothing is sent
    const body = z.object({ channel: z.enum(['phone', 'email']) }).parse(req.body)
    const c = await prisma.customer.findUnique({
      where: { id: req.customer!.id },
      select: { phone: true, email: true, phoneVerifiedAt: true, emailVerifiedAt: true },
    })
    if (!c) throw new NotFoundError('Customer')
    if (body.channel === 'phone') {
      if (!c.phone) throw new AppError('NO_PHONE', 'Add a phone number to your account first.', 400)
      if (c.phoneVerifiedAt) return reply.status(200).send({ alreadyVerified: true })
      await requestOtp({ phone: c.phone, purpose: 'phone_verify', customerId: req.customer!.id })
    } else {
      if (!c.email) throw new AppError('NO_EMAIL', 'Add an email to your account first.', 400)
      if (c.emailVerifiedAt) return reply.status(200).send({ alreadyVerified: true })
      await requestEmailOtp({ email: c.email, purpose: 'email_verify', customerId: req.customer!.id })
    }
    return reply.status(200).send({ sent: true })
  })

  fastify.post('/customer/contact/confirm', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const body = z.object({
      channel: z.enum(['phone', 'email']),
      code: z.string().regex(/^\d{6}$/),
    }).parse(req.body)
    const c = await prisma.customer.findUnique({
      where: { id: req.customer!.id },
      select: { phone: true, email: true },
    })
    if (!c) throw new NotFoundError('Customer')
    if (body.channel === 'phone') {
      if (!c.phone) throw new AppError('NO_PHONE', 'No phone number on this account.', 400)
      await verifyOtp({ phone: c.phone, code: body.code, purpose: 'phone_verify' })
      await prisma.customer.update({ where: { id: req.customer!.id }, data: { phoneVerifiedAt: new Date() } })
    } else {
      if (!c.email) throw new AppError('NO_EMAIL', 'No email on this account.', 400)
      await verifyEmailOtp({ email: c.email, code: body.code, purpose: 'email_verify' })
      await prisma.customer.update({ where: { id: req.customer!.id }, data: { emailVerifiedAt: new Date() } })
    }
    return reply.status(200).send({ verified: true })
  })

  // ── Pending staff + CEO approval ─────────────────────────────────────────
  //
  // Staff accounts are created by the CEO on /workforce. The public self-signup
  // endpoint (POST /auth/staff/signup) is gone: it had no UI caller, created
  // rows with no company, and let the caller pick their own role — including
  // legacy 'manager'. Existing pending rows are reviewed on /workforce
  // (status filter "pending"), which calls approve / reject below.

  // GET /auth/staff/pending — the CEO's "N pending" badge in the sidebar. The
  // queue itself is reviewed on /workforce?status=pending.
  //
  // Company-scoped (decision 47): the CEO's READ scope — the active company, or
  // every company they belong to in "All companies" view. Company-less legacy
  // rows (the old self-signup made them) stay the CEO's to clear.
  //
  // D3 (hand-over): the CEO's list is exactly today's. Anyone else sees only
  // what they may decide — the floor logins of the companies a live
  // Operations hand-over gives them (approvalQueueTenantIds), never their own
  // invites, each checked with the same rule as the approve route (canApprove).
  // No right anywhere → 403, so the inbox drops the type.
  fastify.get('/staff/pending', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const select = {
      id: true, name: true, email: true, phone: true, role: true,
      signupReason: true, createdAt: true, tenantId: true, invitedById: true, viaHeadOfficeId: true,
    } as const
    let pending: Array<{
      id: string; name: string | null; email: string | null; phone: string | null; role: UserRole
      signupReason: string | null; createdAt: Date; tenantId: string | null; invitedById: string | null; viaHeadOfficeId: string | null
    }>
    if (req.staffUser!.role === 'admin') {
      const scope = await scopeTenantWhere(req, 'read')
      pending = await prisma.user.findMany({
        where: { ...whereAccountState('pending'), deletedAt: null, OR: [scope, { tenantId: null }] },
        select,
        orderBy: { createdAt: 'desc' },
      })
    } else {
      const queue = await approvalQueueTenantIds(req, 'staff_login')
      if (queue.length === 0) throw new AppError('FORBIDDEN', 'Only the CEO, or the Operations approver they handed new logins to, sees this list.', 403)
      const me = req.staffUser!.id
      const rows = await prisma.user.findMany({
        where: {
          ...whereAccountState('pending'), deletedAt: null,
          tenantId: { in: queue },
          role: { in: OTP_LOGIN_ROLES },
          OR: [{ invitedById: null }, { invitedById: { not: me } }],
        },
        select: { ...select, tenantMemberships: { select: { tenantId: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
      pending = []
      for (const { tenantMemberships, ...r } of rows) {
        const companies = Array.from(new Set([...(r.tenantId ? [r.tenantId] : []), ...tenantMemberships.map((m) => m.tenantId)]))
        const ok = await canApprove(req, approvalInputOf('staff_login', r.id, {
          companyIds: companies, ownerTenantId: r.tenantId, submitterIds: r.invitedById ? [r.invitedById] : [],
          viaHeadOfficeId: r.viaHeadOfficeId, status: 'pending', submittedAt: r.createdAt, role: r.role,
        }))
        if (ok) pending.push(r)
      }
    }
    const inviterIds = Array.from(new Set(pending.map((p) => p.invitedById).filter((x): x is string => !!x)))
    const inviters = inviterIds.length
      ? await prisma.user.findMany({ where: { id: { in: inviterIds } }, select: { id: true, name: true } })
      : []
    const byId = new Map(inviters.map((u) => [u.id, u]))
    return pending.map(({ invitedById, ...p }) => ({ ...p, invitedBy: invitedById ? (byId.get(invitedById) ?? null) : null }))
  })

  // POST /auth/staff/invite — a workspace owner adds a login under them
  // (decision 47). The role must be one the caller may add (lib/workspaces.ts
  // CHILD_ROLES); the account is created PENDING in the caller's ACTIVE
  // company and cannot sign in until the CEO approves it. The CEO's own
  // direct path (POST /auth/users) is unchanged and needs no approval.
  //
  // Through head office (D1, HO_SUBMIT_ROUTES): an HOD viewing a company it
  // serves (the lens header) proposes the login IN THAT COMPANY — the
  // middleware makes it the active company for this route only — within the
  // HOD's own childRoles, and the row is stamped with the head office it came
  // through (User.viaHeadOfficeId, A3), so it is decided by the CEO or that
  // head office's Operations approver, never the company's own staff.
  fastify.post('/staff/invite', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    // Practice copy (owner, 2026-10-15): a name and a role are enough, and the
    // login is ACTIVE at once — no CEO approval. Email and phone are optional
    // there (an address is generated); the password is shown once in the reply.
    const practice = isSandbox()
    const body = z.object({
      name:       z.string().trim().min(1).max(120),
      email:      practice ? z.string().email().max(200).optional().or(z.literal('')) : z.string().email().max(200),
      phone:      z.string().min(7).max(20).optional().or(z.literal('')),
      role:       z.string().min(1),
      employeeId: z.string().min(1).optional(),
    }).parse(req.body)

    const allowed = childRolesFor(req.staffUser!.role)
    if (allowed.length === 0) {
      throw new AppError('FORBIDDEN', 'Your role cannot add logins.', 403)
    }
    // The CEO seat is never invited — only the CEO names a successor, through
    // the CEO-only staff editor.
    if (body.role === 'admin' || !(allowed as string[]).includes(body.role)) {
      throw new AppError('ROLE_NOT_ALLOWED', `You cannot add a login with the role "${body.role}".`, 403)
    }
    // HR onboards through the HR back office: the CEO's untick of staff_hr
    // for an HR login closes this too.
    await assertHrBackOffice(req)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) {
      throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — a new login belongs to one company.', 422)
    }
    const typedEmail = body.email || (practice ? await practiceStaffEmail(body.name) : '')
    if (!isStaffEmail(typedEmail)) {
      throw new AppError('EMAIL_NOT_COMPANY_DOMAIN', STAFF_EMAIL_MESSAGE, 400)
    }
    const email = normaliseStaffEmail(typedEmail)
    const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (taken) throw (await loginInTrash(req, taken.id)) ?? new AppError('EMAIL_TAKEN', 'A login with that email already exists.', 409)

    // The employee record, if given, must be this company's and not already
    // linked to a login. It is linked on APPROVAL, not now.
    if (body.employeeId) {
      const emp = await prisma.hrEmployee.findFirst({
        where: { id: body.employeeId, tenantId },
        select: { id: true, userId: true },
      })
      if (!emp) throw new AppError('EMPLOYEE_NOT_IN_COMPANY', 'That employee is not in your active company.', 422)
      if (emp.userId) throw new AppError('EMPLOYEE_ALREADY_LINKED', 'That employee already has a login.', 409)
    }

    // Floor roles sign in only with a code to this number, and one number is
    // one login across every company (staffAccounts.ts).
    const phone = normaliseStaffPhone(body.phone)
    assertPhoneForRole(body.role, phone)

    // Live: nobody signs in with this — the invitee sets their own password
    // from the link sent on approval (or the CEO issues one from Workforce).
    // Practice copy: it is THE sign-in, shown once to the person who added it.
    const temporaryPassword = generateStaffPassword()
    const password = await hashPassword(temporaryPassword)
    // Check and write under one per-number lock (AUTH-R5).
    const viaHeadOfficeId = await viaHeadOfficeForSubmit(req, tenantId)
    // HR (or the CEO) adding a FLOOR login: active at once, with the same side
    // effects as an approval (offboarding.ts). Manager / office logins, and
    // anything proposed through a head office, wait for the CEO as before.
    // Module access is never set here — only the CEO changes what anyone sees.
    const activeNow = !practice && !viaHeadOfficeId && activeAtOnce(req.staffUser!.role, body.role)
    const user = await withStaffPhoneLock(phone, async (tx) => {
      await assertPhoneFree(req, phone, { role: body.role, db: tx })
      return tx.user.create({
        data: {
          name: body.name,
          email,
          ...(phone ? { phone } : {}),
          password,
          role: body.role as UserRole,
          tenantId,
          ...(practice || activeNow ? approveData() : { accountStatus: 'pending' as const, isActive: true }),
          mustChangePassword: true,
          invitedById: req.staffUser!.id,
          ...(viaHeadOfficeId ? { viaHeadOfficeId } : {}),
          // Linked to the HrEmployee on approval (validated above, re-checked
          // then) — or at once in the practice copy, below.
          ...(body.employeeId && !practice && !activeNow ? { inviteEmployeeId: body.employeeId } : {}),
          tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
        },
        select: { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true, createdAt: true, tenantId: true },
      })
    })
    await audit({
      category: 'identity',
      action: 'staff.invite',
      entity: 'User',
      entityId: user.id,
      userId: req.staffUser!.id,
      userEmail: req.staffUser!.email,
      tenantId,
      after: { name: user.name, email: user.email, role: user.role, tenantId, employeeId: body.employeeId ?? null, accountStatus: user.accountStatus },
      ...(viaHeadOfficeId || practice || activeNow ? { metadata: {
        ...(viaHeadOfficeId ? { viaHeadOfficeId } : {}),
        ...(practice ? { practiceNoApproval: true } : {}),
        ...(activeNow ? { activeAtOnce: true } : {}),
      } } : {}),
    })
    if (practice) {
      await activationSideEffects(req, user, body.employeeId, { sendPasswordLink: false })
      return reply.status(201).send({ ...user, status: accountStateOf(user), isActive: undefined, temporaryPassword })
    }
    if (activeNow) {
      const { linkedEmployeeId, passwordLink } = await activationSideEffects(req, user, body.employeeId)
      return reply.status(201).send({ ...user, status: accountStateOf(user), isActive: undefined, linkedEmployeeId, passwordLink })
    }
    return reply.status(201).send({ ...user, status: accountStateOf(user), isActive: undefined })
  })

  // GET /auth/staff/invites — the caller's own invites and where each stands.
  fastify.get('/staff/invites', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const rows = await prisma.user.findMany({
      where: { invitedById: req.staffUser!.id, deletedAt: null },
      select: { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, status: accountStateOf(r), createdAt: r.createdAt }))
  })

  // PATCH /auth/staff/:id/approve — CEO flips a pending hire to active.
  // When the server can send one, the new login gets the password-set link
  // (the same one /password/forgot sends); otherwise the CEO issues a
  // password from Workforce as before.
  fastify.patch<{ Params: { id: string } }>(
    '/staff/:id/approve',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      // D3: the CEO as today, or the Operations approver a head office was
      // handed new logins to (floor logins only; never their own invite).
      const right = await loginDecisionRight(req, req.params.id, 'approve')
      const isCeo = req.staffUser!.role === 'admin'
      const found = await prisma.user.findFirst({
        where: { id: req.params.id, deletedAt: null },
        select: { id: true, name: true, email: true, phone: true, role: true, accountStatus: true, isActive: true, tenantId: true, inviteEmployeeId: true },
      })
      if (!found) throw new NotFoundError('Staff member')
      const user = { ...found, companies: right.companies }
      if (accountStateOf(user) === 'active') {
        const { inviteEmployeeId: _drop, companies: _c, ...shown } = user
        return reply.status(200).send({ ...shown, message: 'Already active' })
      }
      // A login with no company would sign in to nothing; the CEO picks one on
      // Workforce first (the approvals inbox shows the same hint).
      if (!user.tenantId) throw new AppError('LOGIN_NEEDS_COMPANY', 'Pick a company for this login on Workforce before approving it.', 422)

      // Re-checked here as well as at invite: the row may predate those checks
      // (or a number may have been taken since). Approving a floor login with
      // no number, or with one another login holds, makes an account nobody can
      // sign in to — and, for the duplicate, locks the OTHER person out too.
      const phone = normaliseStaffPhoneLenient(user.phone)
      assertPhoneForRole(user.role, phone)

      // The check and the approval under one per-number lock (AUTH-R5). Only
      // ACTIVE floor logins count as holders here: a second pending invite of
      // the same person does not block this one (AUTH-R7) — it is refused when
      // it in turn is approved.
      const updated = await withStaffPhoneLock(phone, async (tx) => {
        await assertPhoneFree(req, phone, { role: user.role, excludeUserId: user.id, countPending: false, db: tx })
        // The pending link is spent either way. A number stored the old way
        // (0300…, +92…) is rewritten in the one normalised form.
        const data = { ...approveData(), inviteEmployeeId: null, ...(phone && phone !== user.phone ? { phone } : {}) }
        if (!isCeo) {
          // A delegate claims the PENDING row: two approvers (or an approve
          // racing a reject) act once.
          const claimed = await tx.user.updateMany({ where: { id: req.params.id, accountStatus: 'pending', deletedAt: null }, data })
          if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This login is no longer waiting for approval.', 409)
        }
        return isCeo
          ? tx.user.update({ where: { id: req.params.id }, data, select: { id: true, name: true, email: true, role: true, accountStatus: true } })
          : tx.user.findUniqueOrThrow({ where: { id: req.params.id }, select: { id: true, name: true, email: true, role: true, accountStatus: true } })
      })

      // Link the HR employee named at invite time (re-validated now) and send
      // the set-your-password link when a channel exists — the same side
      // effects as HR's active-at-once floor login (offboarding.ts). Never
      // fatal: HR can link it from the employee record, the CEO can issue a
      // password.
      const { linkedEmployeeId, passwordLink } = await activationSideEffects(req, user, user.inviteEmployeeId)

      // Letting someone in is half of "who can get in"; it was never recorded.
      await audit({
        category: 'identity',
        action: 'user.approve',
        entity: 'User',
        entityId: user.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        tenantId: auditCompanyOf(user),
        before: { accountStatus: user.accountStatus },
        after: { accountStatus: updated.accountStatus, targetEmail: user.email, role: user.role, linkedEmployeeId, passwordLink },
        metadata: { actorTenantId: req.staffUser?.tenantId ?? null, via: right.grant.via, ...(right.grant.delegationId ? { delegationId: right.grant.delegationId } : {}) },
      })
      await auditApproval(req, { type: 'staff_login', id: user.id, tenantId: auditCompanyOf(user), decision: 'approve', grant: right.grant, entity: 'User' })
      return reply.status(200).send({ ...updated, linkedEmployeeId, passwordLink })
    },
  )

  // PATCH /auth/staff/:id/reject — CEO rejects (soft-deletes). We keep the row
  // for audit + so the same email can't re-sign-up without an admin first
  // restoring it.
  fastify.patch<{ Params: { id: string } }>(
    '/staff/:id/reject',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      // D3: the CEO as today, or the Operations approver of a floor login
      // (pending only; never their own invite).
      const right = await loginDecisionRight(req, req.params.id, 'reject')
      const isCeo = req.staffUser!.role === 'admin'
      const found = await prisma.user.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { accountStatus: true, email: true, tenantId: true } })
      if (!found) throw new NotFoundError('Staff member')
      const before = { ...found, companies: right.companies }
      if (!isCeo) {
        const claimed = await prisma.user.updateMany({ where: { id: req.params.id, accountStatus: 'pending', deletedAt: null }, data: suspendData() })
        if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This login is no longer waiting for approval.', 409)
      }
      const updated = isCeo
        ? await prisma.user.update({
            where: { id: req.params.id },
            data: suspendData(),
            select: { id: true, name: true, accountStatus: true },
          })
        : await prisma.user.findUniqueOrThrow({ where: { id: req.params.id }, select: { id: true, name: true, accountStatus: true } })
      await revokeAllForSubject(req.params.id) // kill the rejected user's sessions now
      await audit({
        category: 'identity',
        action: 'user.reject',
        entity: 'User',
        entityId: req.params.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        tenantId: auditCompanyOf(before),
        before: { accountStatus: before.accountStatus },
        after: { accountStatus: updated.accountStatus, targetEmail: before.email },
        metadata: { actorTenantId: req.staffUser?.tenantId ?? null, via: right.grant.via, ...(right.grant.delegationId ? { delegationId: right.grant.delegationId } : {}) },
      })
      await auditApproval(req, { type: 'staff_login', id: req.params.id, tenantId: auditCompanyOf(before), decision: 'reject', grant: right.grant, entity: 'User' })
      return reply.status(200).send(updated)
    },
  )

  // POST /auth/staff/:id/offboard — HR or the CEO switches a login off, same
  // as someone leaving in real life (owner, 2026-10-15). The login must be in
  // the caller's companies (404 / 403 LOGIN_IN_OTHER_COMPANY, findManagedStaff).
  // Never the CEO's login (403 CANNOT_OFFBOARD_CEO) and never your own (403
  // CANNOT_OFFBOARD_SELF): "the only person HR can't fire is me and the only
  // person I can't fire is me". Suspends (accountStatus.ts) and revokes every
  // session through the one switch-off (offboarding.ts), shared with the HR
  // leaver sweep. Pay is HR's separation, not this.
  fastify.post<{ Params: { id: string } }>(
    '/staff/:id/offboard',
    { preHandler: requireAuth(...OFFBOARDERS) },
    async (req) => {
      await assertHrBackOffice(req)
      const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
      const target = await findManagedStaff(req, req.params.id, { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true })
      if (target.id === req.staffUser!.id) throw new AppError('CANNOT_OFFBOARD_SELF', 'You cannot offboard your own login.', 403)
      if (target.role === 'admin') throw new AppError('CANNOT_OFFBOARD_CEO', "The CEO's login cannot be offboarded.", 403)
      const before = accountStateOf(target)
      const changed = await switchOffLogin(target.id)
      if (changed) {
        await audit({
          category: 'identity',
          action: 'staff.offboard',
          entity: 'User',
          entityId: target.id,
          userId: req.staffUser!.id,
          userEmail: req.staffUser!.email,
          tenantId: auditCompanyOf(target),
          before: { accountStatus: before },
          after: { accountStatus: 'suspended', reason: body.reason, targetEmail: target.email, role: target.role },
          metadata: { actorTenantId: req.staffUser!.tenantId ?? null, actorRole: req.staffUser!.role },
        })
      }
      return { id: target.id, name: target.name, status: 'suspended' as const, alreadyOffboarded: !changed }
    },
  )

  // POST /auth/staff/:id/reinstate — bring an offboarded login back. The CEO's
  // reinstate is immediate. HR's: a floor login (code sign-in) is active at
  // once; a manager / office login goes back to PENDING and waits for the CEO
  // in the approvals inbox (staff_login), like a new one. Same scope and
  // refusals as offboard (HR never touches the CEO's login).
  fastify.post<{ Params: { id: string } }>(
    '/staff/:id/reinstate',
    { preHandler: requireAuth(...OFFBOARDERS) },
    async (req) => {
      await assertHrBackOffice(req)
      const isCeo = req.staffUser!.role === 'admin'
      const target = await findManagedStaff(req, req.params.id, { id: true, name: true, email: true, phone: true, role: true, accountStatus: true, isActive: true })
      if (target.id === req.staffUser!.id) throw new AppError('CANNOT_OFFBOARD_SELF', 'You cannot change your own login here.', 403)
      if (target.role === 'admin' && !isCeo) throw new AppError('CANNOT_OFFBOARD_CEO', "Only the CEO can change a CEO login.", 403)
      if (accountStateOf(target) !== 'suspended') throw new AppError('NOT_SUSPENDED', 'This login is not switched off.', 409)
      const immediate = isCeo || activeAtOnce(req.staffUser!.role, target.role)
      // A floor login coming back must have a number nobody else holds
      // (PPL-04/05, AUTH-R5) — the same check as a reactivation on Workforce.
      const phone = normaliseStaffPhoneLenient(target.phone)
      const floorActive = immediate && usesOtpLogin(target.role)
      if (floorActive) assertPhoneForRole(target.role, phone)
      const data = immediate ? approveData() : { accountStatus: 'pending' as const, isActive: true }
      const updated = await withStaffPhoneLock(floorActive ? phone : null, async (tx) => {
        if (floorActive) await assertPhoneFree(req, phone, { role: target.role, excludeUserId: target.id, db: tx })
        const claimed = await tx.user.updateMany({
          where: { id: target.id, deletedAt: null, OR: [{ accountStatus: 'suspended' }, { isActive: false }] },
          data,
        })
        if (claimed.count === 0) throw new AppError('NOT_SUSPENDED', 'This login is not switched off.', 409)
        return tx.user.findUniqueOrThrow({ where: { id: target.id }, select: { id: true, name: true, accountStatus: true, isActive: true } })
      })
      await audit({
        category: 'identity',
        action: 'staff.reinstate',
        entity: 'User',
        entityId: target.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        tenantId: auditCompanyOf(target),
        before: { accountStatus: 'suspended' },
        after: { accountStatus: updated.accountStatus, targetEmail: target.email, role: target.role },
        metadata: { actorTenantId: req.staffUser!.tenantId ?? null, actorRole: req.staffUser!.role, waitsForCeo: !immediate },
      })
      return { id: updated.id, name: updated.name, status: accountStateOf(updated), waitsForCeo: !immediate }
    },
  )

  // POST /auth/staff/:id/issue-pin is gone — it had no caller. The CEO sets a
  // manager-override PIN on /workforce (PATCH /auth/users/:id), through the
  // same setter as /pin/change below.

  // POST /auth/pin/change — staff sets their OWN manager-override PIN.
  //
  // Changing an existing PIN requires the CURRENT PIN, so a borrowed unlocked
  // tablet can't be used to silently take over an account's approvals.
  //
  // Setting the FIRST one (no PIN yet) requires the account PASSWORD instead —
  // there is no current PIN to prove. Without this path every override PIN was
  // chosen by the CEO (PATCH /auth/users), who then knew it; staff choose their
  // own (CLAUDE.md). Only override approvers hold a PIN at all — for anyone
  // else it approves nothing (managerPin.ts verifyManagerPin), so they are not
  // offered a first one.
  //
  // Wrong PIN / password: 400 (not 401, which makes the web client refresh and
  // retry), and counted per account.
  fastify.post('/pin/change', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      currentPin: z.string().regex(/^\d{4,8}$/).optional(),
      password:   z.string().min(1).max(200).optional(),
      newPin:     z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
    }).parse(req.body)

    const me = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { id: true, email: true, role: true, pin: true, password: true, tenantId: true },
    })
    if (!me) throw new UnauthorizedError('Account is no longer active')
    const limitKey = `user:${me.id}`

    const firstPin = !me.pin
    if (firstPin && !isOverrideApprover(me.role)) {
      throw new AppError('PIN_NOT_FOR_ROLE', 'Only managers approve with an override PIN, so your role does not have one.', 403)
    }
    if (firstPin && !body.password) {
      throw new AppError('PASSWORD_REQUIRED', 'Enter your password to set your first PIN.', 400)
    }
    // A malformed or guessable new PIN is refused before any bucket is touched
    // — it says nothing about anyone's PIN, so it should not cost an attempt.
    if (!PIN_FORMAT.test(body.newPin) || isWeakPin(body.newPin)) {
      await preparePin(body.newPin, { tenantIds: [] }) // throws INVALID_PIN / WEAK_PIN
    }

    // Every PIN-setting attempt counts, success or not (AUTH-R4). The collision
    // check below answers "is this PIN someone else's?", and an override PIN
    // alone identifies its approver — so an uncounted loop of
    // { currentPin: mine, newPin: guess } enumerated colleagues' PINs (the
    // CEO's included). A few changes an hour is plenty for a real person.
    await claimRateLimit(PIN_CHANGE_ATTEMPT_LIMIT, limitKey)
    // Wrong current PIN / password: claimed BEFORE the compare (AUTH-R3), so a
    // parallel burst cannot all pass a read before any failure is recorded.
    await claimRateLimit(PIN_CHANGE_USER_LIMIT, limitKey)

    if (firstPin) {
      if (!(await bcrypt.compare(body.password!, me.password))) {
        throw new AppError('WRONG_PASSWORD', 'Your password is not right.', 400)
      }
    } else if (!body.currentPin || !(await bcrypt.compare(body.currentPin, me.pin!))) {
      throw new AppError('BAD_PIN', 'Current PIN is incorrect.', 400)
    }
    // Right credential: this attempt does not count toward the wrong-credential
    // bucket. (Earlier wrong guesses still do — release, not clear, so a burst
    // that contains one right answer cannot wipe the others' strikes.)
    await releaseRateLimit(PIN_CHANGE_USER_LIMIT, limitKey)

    // Same rules as the CEO's setter: format, weak-PIN list, and no two
    // people in one company sharing a PIN.
    try {
      await setManagerPin(me.id, body.newPin)
    } catch (err) {
      if (err instanceof AppError && err.code === 'PIN_COLLISION') {
        // A hit means the guess is a colleague's PIN. Counted as a failure and
        // put on the identity trail, so a sweep is both capped and visible.
        await recordFailure(PIN_CHANGE_USER_LIMIT, limitKey)
        await audit({
          category: 'identity',
          action: 'user.pin_collision',
          entity: 'User',
          entityId: me.id,
          userId: me.id,
          userEmail: me.email,
          tenantId: me.tenantId ?? req.staffUser!.tenantId ?? null,
          metadata: { ip: req.ip ?? null },
        })
      }
      throw err
    }
    await audit({
      category: 'identity',
      action: firstPin ? 'user.pin_set' : 'user.pin_change',
      entity: 'User',
      entityId: me.id,
      userId: me.id,
      userEmail: me.email,
      tenantId: me.tenantId ?? req.staffUser!.tenantId ?? null,
    })
    return reply.status(200).send({ message: firstPin ? 'PIN set.' : 'PIN updated.' })
  })

  // GET /auth/users — list staff (admin/manager only).
  // Powers the /workforce hub. `?role=foh,boh,kitchen` filters by enum value
  // so the sidebar's per-category entries can deep-link straight to the right
  // slice. `?status=pending|active|suspended` filters on accountStatus.
  //
  // Tenant scope: single-tenant view returns only that tenant's staff;
  // portfolio view (x-servd-portfolio: 1) unions every tenant the user is a
  // member of and includes the tenant relation so the frontend can render
  // the indigo brand chip per row. Rows with no tenantId (legacy back-fill
  // gap) come through too, with `tenant: null`.
  // ── Email (SMTP) settings ─────────────────────────────────────────────────
  //
  // Same shape as the WhatsApp settings below, for the same reason, and with
  // the same rule: the password is never returned.
  //
  // Email matters here as the SECOND channel. WhatsApp is a linked web session
  // and those drop; when one does, signup, password reset and staff sign-in
  // stop together because there is nothing else to reach anyone with.

  // Who: READ — the CEO and IT (CONNECTOR_ADMINS, Dev workspace, wave 3
  // UI-08), and IT only while it holds module `api_whatsapp` — the module the
  // Email page sits under in the sidebar (lib/moduleCatalog.ts, Dev → API),
  // so the CEO's untick closes it. GET returns `passSet` only, never the password.
  // WRITE and TEST — the CEO only. Email is PLATFORM-WIDE (Setting rows with
  // no company) and the stored password, or the box's env SMTP_PASS, is
  // paired with whatever host is saved: whoever can change the host (and run
  // the test send) can receive that secret in SMTP AUTH and every company's
  // password-reset mail (wave 3 review W3C-RV-1). Opening the writes to IT,
  // like WhatsApp's D14, needs an explicit owner decision first.
  fastify.get('/integrations/email', { preHandler: [requireAuth(...CONNECTOR_ADMINS), requireModule('api_whatsapp')] }, async () => {
    const keys = [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY]
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
    const get = (k: string) => rows.find((r) => r.key === k)?.value ?? ''
    const cfg = await mailConfig()
    // passSet / passAtRest / passSource only — never the password, nor a hint
    // of it (ops round 5: it is encrypted at rest when SERVD_SECRET_KEY is set).
    const { smtpPassView } = await import('../../lib/mailer.js')
    const pass = await smtpPassView()
    return {
      host: get(SMTP_HOST_KEY),
      port: get(SMTP_PORT_KEY),
      user: get(SMTP_USER_KEY),
      from: get(SMTP_FROM_KEY),
      passSet: pass.passSet,
      passAtRest: pass.passAtRest,
      passSource: pass.passSource,
      // What is actually in force, whatever the fields above show — the values
      // may be coming from the environment.
      effective: { host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from },
      configured: await isEmailConfigured(),
    }
  })

  fastify.put('/integrations/email', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      host: z.string().max(200),
      port: z.string().max(6),
      user: z.string().max(200),
      // Omit to leave the stored password alone — so the host can be corrected
      // without re-typing a secret the screen never shows.
      pass: z.string().max(400).optional(),
      from: z.string().max(200),
    }).parse(req.body)

    const pairs: Array<[string, string]> = [
      [SMTP_HOST_KEY, body.host.trim()],
      [SMTP_PORT_KEY, body.port.trim()],
      [SMTP_USER_KEY, body.user.trim()],
      [SMTP_FROM_KEY, body.from.trim()],
    ]
    // The password is stored encrypted when SERVD_SECRET_KEY is set; without
    // it, as typed — saving is never refused (email is the fallback channel
    // when WhatsApp drops) and the answer + /health smtpPassAtRest say so.
    const { sealSmtpPass } = await import('../../lib/mailer.js')
    const sealed = body.pass !== undefined ? sealSmtpPass(body.pass) : null
    if (sealed) pairs.push([SMTP_PASS_KEY, sealed.value])
    await prisma.$transaction(pairs.map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })))
    invalidateMailConfig()

    await audit({
      category: 'identity',
      action: 'integrations.email.update',
      entity: 'Setting',
      entityId: SMTP_USER_KEY,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: req.staffUser?.tenantId ?? null,
      after: { host: body.host, port: body.port, user: body.user, from: body.from, passChanged: body.pass !== undefined, ...(sealed && { passAtRest: sealed.atRest }) },
    })
    return reply.status(200).send({
      ok: true,
      ...(sealed && { passAtRest: sealed.atRest }),
      ...(sealed?.atRest === 'plaintext' && {
        warning: 'Saved, but the password is stored in plain text because SERVD_SECRET_KEY is not set on the server. Ask IT to set it — the password is then encrypted on the next read.',
      }),
    })
  })

  fastify.post('/integrations/email/test', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ to: z.string().email() }).parse(req.body)
    if (sandboxBlocks('email', { to: body.to, summary: 'admin test' })) return { ok: true, practice: true, note: PRACTICE_NOTE }
    try {
      await sendEmail({
        to: body.to,
        subject: 'servd: email is working',
        html: '<p>If you can read this, servd can send email — so password resets and backup codes will reach inboxes.</p>',
      })
      return { ok: true }
    } catch (err) {
      // The transport's own words are the diagnosis: bad credentials, wrong
      // port, blocked connection all read differently.
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Delivery status ───────────────────────────────────────────────────────
  // What the watchdog last saw, so the dashboard can say "signup is down and
  // here is the fix" instead of the operator finding out from a customer.
  // Read: the managers (their dashboard banner) plus IT, who own the WhatsApp
  // connector in Dev → API (CONNECTOR_ADMINS). Check now: CONNECTOR_ADMINS.
  fastify.get('/integrations/delivery-status', { preHandler: requireAuth(...MANAGERS, ...CONNECTOR_ADMINS) }, async () => {
    const row = await prisma.setting.findUnique({ where: { key: DELIVERY_STATE_KEY } })
    if (!row) return { ok: true, cause: 'ok', detail: 'Not checked yet.', fix: '', checkedAt: null }
    try { return JSON.parse(row.value) } catch { return { ok: true, cause: 'ok', detail: '', fix: '', checkedAt: null } }
  })

  // Run the check on demand, for the "check now" button.
  fastify.post('/integrations/delivery-status/check', { preHandler: requireAuth(...CONNECTOR_ADMINS) }, async () => {
    return runDeliveryWatch()
  })

  // ── WhatsApp gateway settings ─────────────────────────────────────────────
  //
  // These two values are the difference between the storefront taking signups
  // and not. They lived only in an env file on the production box, which meant
  // the person who owns them could not set them — and while they were blank,
  // customer signup, password reset and staff code sign-in were all down.
  //
  // Dev → API → WhatsApp connector: the CEO and IT (CONNECTOR_ADMINS, spec
  // D14). PLATFORM-WIDE: one gateway for every company (lib/whatsapp.ts), so
  // these rows carry no company and GET says `scope: 'platform'`. The key is a
  // live credential: encrypted at rest (lib/secretBox) and never returned —
  // only a hint (first 4 + last 4) so the screen can show which one is saved.

  fastify.get('/integrations/whatsapp', { preHandler: requireAuth(...CONNECTOR_ADMINS) }, async () => {
    return whatsappSettingsView()
  })

  fastify.put('/integrations/whatsapp', { preHandler: requireAuth(...CONNECTOR_ADMINS) }, async (req, reply) => {
    const body = z.object({
      // Empty string clears the stored value and falls back to the environment.
      apiUrl: z.string().max(500),
      // Optional: omitting it leaves the stored key untouched, so the URL can
      // be corrected without re-typing a 50-character secret. '' clears it.
      apiKey: z.string().max(200).optional(),
    }).parse(req.body)

    const url = body.apiUrl.trim()
    if (url && !/^https:\/\/\S+$/.test(url)) {
      throw new AppError('INVALID_URL', 'The endpoint must be a https:// URL, copied from the gateway\'s API Info tab.', 400)
    }

    // Encrypts a new key; 503 SECRET_KEY_MISSING (nothing written) when the
    // server has no SERVD_SECRET_KEY.
    await saveWhatsappSettings({ apiUrl: url, ...(body.apiKey !== undefined && { apiKey: body.apiKey }) })

    await audit({
      category: 'identity',
      action: 'integrations.whatsapp.update',
      entity: 'Setting',
      entityId: 'integrations.whatsapp.apiUrl',
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      // Platform setting (no company of its own); the operator's active
      // company is recorded so the trail shows where the change came from.
      tenantId: req.staffUser?.tenantId ?? null,
      // The endpoint is not a secret; the key never goes in the log.
      after: { apiUrl: url, apiKeyChanged: body.apiKey !== undefined, scope: 'platform' },
    })
    return reply.status(200).send({ ok: true })
  })

  // Prove it end to end from the screen, rather than finding out when a
  // customer cannot sign up.
  fastify.post('/integrations/whatsapp/test', { preHandler: requireAuth(...CONNECTOR_ADMINS) }, async (req) => {
    const body = z.object({ phone: z.string().min(7).max(20) }).parse(req.body)
    const phone = normalisePhone(body.phone)
    if (sandboxBlocks('whatsapp', { to: phone, summary: 'admin test' })) return { ok: true, sentTo: `…${phone.slice(-4)}`, practice: true, note: PRACTICE_NOTE }
    try {
      await sendText(phone, 'servd: WhatsApp gateway test. If you can read this, signup and sign-in codes will arrive here.')
      return { ok: true, sentTo: `…${phone.slice(-4)}` }
    } catch (err) {
      // The gateway's own message is the useful part — "not ready
      // (INITIALIZING)" means scan the QR, "Invalid API key" means the key is
      // wrong. Passing it through saves a round-trip to whoever runs it.
      return { ok: false, error: (err as Error).message }
    }
  })

  // GET /auth/audit-log — the IDENTITY trail.
  //
  // Who exists, what access they hold, and what they did on shift: account
  // creation, role assignment, enable/disable, credential reissues, permission
  // changes, plus the operational actions staff take (refunds, voids, comps,
  // gift cards, stock moves).
  //
  // Separate from the accounting trail on purpose. This one answers "who did
  // that, and who let them"; the accounting one answers "who moved the books",
  // and only the CEO and exec may read that. A manager needs the first to run a
  // shift and has no business in the second.
  //
  // Decision 47: IT (role `it`, module audit_log) reads it too, and it filters
  // by user, action prefix (e.g. `auth.`) and a from/to window.
  const AUDIT_READERS = [...MANAGERS, 'it'] as UserRole[]
  async function identityTrailWhere(req: FastifyRequest) {
    const scope = await resolveTenantScope(req)
    // Same rule as the accounting trail: unattributed legacy rows (and failed
    // sign-ins against unknown emails) are the CEO's to read, nobody else's.
    return {
      category: 'identity',
      ...(req.staffUser!.role === 'admin'
        ? { OR: [{ tenantId: { in: scope.tenantIds } }, { tenantId: null }] }
        : { tenantId: { in: scope.tenantIds } }),
    }
  }
  const parseDate = (s?: string) => {
    if (!s) return undefined
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) throw new AppError('INVALID_DATE', `Not a date: ${s}`, 400)
    return d
  }

  fastify.get<{ Querystring: { action?: string; entity?: string; userId?: string; from?: string; to?: string; limit?: string; cursor?: string } }>(
    '/audit-log',
    { preHandler: requireAuth(...AUDIT_READERS) },
    async (req) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? '100', 10) || 100, 1), 500)
      const from = parseDate(req.query.from)
      const to = parseDate(req.query.to)
      const rows = await prisma.auditLog.findMany({
        where: {
          ...(await identityTrailWhere(req)),
          ...(req.query.action && { action: { startsWith: req.query.action } }),
          ...(req.query.entity && { entity: req.query.entity }),
          ...(req.query.userId && { userId: req.query.userId }),
          ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
          ...(req.query.cursor && { id: { lt: req.query.cursor } }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      })
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return { data: rows, cursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null, hasMore }
    },
  )

  // GET /auth/audit-log/users/:userId/summary — one person's sign-in and
  // activity picture over the last 30 days, from the same scoped trail.
  fastify.get<{ Params: { userId: string } }>(
    '/audit-log/users/:userId/summary',
    { preHandler: requireAuth(...AUDIT_READERS) },
    async (req) => {
      const scope = await resolveTenantScope(req)
      const isAdmin = req.staffUser!.role === 'admin'
      // The person must be someone the caller can see: in a company of their
      // read scope (the CEO also sees company-less legacy rows). Else 404.
      const user = await prisma.user.findFirst({
        where: {
          id: req.params.userId,
          OR: [
            { tenantId: { in: scope.tenantIds } },
            { tenantMemberships: { some: { tenantId: { in: scope.tenantIds } } } },
            ...(isAdmin ? [{ tenantId: null }] : []),
          ],
        },
        select: { id: true, name: true, email: true, role: true },
      })
      if (!user) throw new NotFoundError('User')

      const base = { ...(await identityTrailWhere(req)), userId: user.id }
      const since = new Date(Date.now() - 30 * 86_400_000)
      const SIGN_INS = ['auth.login', 'auth.otp_login']
      const FAILS = ['auth.login_failed', 'auth.2fa_failed']
      const [last, signIns, failed, actions, top] = await Promise.all([
        prisma.auditLog.findFirst({ where: { ...base, action: { in: SIGN_INS } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        prisma.auditLog.count({ where: { ...base, action: { in: SIGN_INS }, createdAt: { gte: since } } }),
        prisma.auditLog.count({ where: { ...base, action: { in: FAILS }, createdAt: { gte: since } } }),
        prisma.auditLog.count({ where: { ...base, createdAt: { gte: since } } }),
        prisma.auditLog.groupBy({
          by: ['action'],
          where: { ...base, createdAt: { gte: since } },
          _count: { _all: true },
          orderBy: { _count: { action: 'desc' } },
          take: 10,
        }),
      ])
      return {
        user,
        lastSignInAt: last?.createdAt ?? null,
        signInsLast30d: signIns,
        failedLast30d: failed,
        actionsLast30d: actions,
        topActions: top.map((t) => ({ action: t.action, count: t._count._all })),
      }
    },
  )

  // Read: the managers, plus HR — the Workforce staff list is HR's
  // (staff_directory, wave 3 UI-09). Read only: every write on a login stays
  // the CEO's (POST/PATCH/DELETE /users are ADMIN_ONLY) and HR adds logins
  // only through the invite flow (childRoles). Same company scope for all.
  fastify.get('/users', { preHandler: requireAuth(...MANAGERS, 'hr') }, async (req) => {
    const q = z.object({
      role:   z.string().optional(),  // comma-separated list of UserRole values
      status: z.enum(['pending', 'active', 'suspended']).optional(),
    }).parse(req.query)

    const scope = await resolveTenantScope(req)
    const isAdmin = req.staffUser!.role === 'admin'
    // Company-scoped like every other list (standing rule, 2026-09-28): the
    // operator's READ scope — the active company, or every company they belong
    // to in "All companies" view — matched on the login's primary company OR a
    // membership. The CEO also sees company-less legacy rows, to fix them.
    //
    // It used to skip the scope for every admin, so another company's CEO could
    // list (and then re-role, move and delete) GS Foods' logins. A CEO who runs
    // several companies is a MEMBER of each of them, and sees them all here.
    // An empty scope lists nobody (`in: []`), never "no filter".
    const where: Record<string, unknown> = {
      deletedAt: null,
      AND: [staffInCompaniesWhere(scope.tenantIds, isAdmin && scope.tenantIds.length > 0)],
    }

    if (q.role) {
      const roles = q.role.split(',').map((r) => r.trim()).filter(Boolean)
      if (roles.length > 0) where.role = { in: roles }
    }
    // Status is derived in ONE place (accountStatus.ts) so a row switched off
    // through the legacy isActive column still lists as suspended.
    if (q.status) (where.AND as unknown[]).push(whereAccountState(q.status))

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, phone: true, role: true, jobTitle: true,
        isActive: true, accountStatus: true, createdAt: true,
        // `pin` is selected only so the mapper below can derive `hasPin`; it is
        // stripped (pin: undefined) before the response leaves the server and
        // must stay that way — it is a bcrypt hash of a 4–8 digit number and
        // would be trivially crackable offline if it ever shipped to a client.
        pin: true,
        pinMustReset: true, pinResetRequestedAt: true,
        tenantId: true,
        // Per-user overrides — used by the inline editor's tri-state chips
        // to show which actions/modules diverge from the role default.
        permissionAllow: true, permissionDeny: true, moduleAllow: true, moduleDeny: true,
        // Station roster — drives Kitchen view (/kds) scoping.
        stationIds: true,
        // Include the primary tenant relation in portfolio mode so the
        // frontend can render the indigo chip on each row.
        ...(scope.portfolio ? { tenant: { select: { id: true, name: true, slug: true } } } : {}),
        // Additional tenant memberships — surfaced as chips next to the
        // primary so the operator can see when a staff member works across
        // companies (the "head office team" pattern — procurement, finance,
        // HR people typically span both restaurants). The relation field is
        // `tenantMemberships` on the User model.
        tenantMemberships: {
          select: {
            tenantId: true,
            role: true,
            tenant: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    // Still on payroll (PPL-10). Switching a login off does not stop pay: HR
    // payroll reads only the employee record, and it pays everyone not
    // separated. So for each login, the linked employee record in the
    // operator's companies that payroll would still include — Workforce warns
    // on a suspended login that still has one.
    const mine = new Set(req.staffUser!.memberTenantIds)
    const today = new Date(); today.setUTCHours(0, 0, 0, 0)
    const onPayroll = users.length === 0 ? [] : await prisma.hrEmployee.findMany({
      where: {
        userId: { in: users.map((u) => u.id) },
        tenantId: { in: Array.from(mine) },
        NOT: { status: 'separated' },
        OR: [{ lastWorkingDay: null }, { lastWorkingDay: { gte: today } }],
      },
      select: { id: true, userId: true, status: true, tenantId: true },
    })
    const payrollOf = new Map(onPayroll.map((e) => [e.userId!, { employeeId: e.id, status: e.status, tenantId: e.tenantId }]))

    return users.map((u) => {
      const memberCompanies = u.tenantMemberships.map((m) => m.tenantId)
      const allCompanies = Array.from(new Set([...(u.tenantId ? [u.tenantId] : []), ...memberCompanies]))
      const primary = (u as { tenant?: TenantLite | null }).tenant ?? null
      return {
        ...u,
        // The primary company's relation only when it is one of the viewer's —
        // another company's name is not theirs to read off this list.
        ...(primary && !mine.has(primary.id) ? { tenant: null } : {}),
        accountStatus: accountStateOf(u),
        hasPin: !!u.pin,
        pin: undefined,
        // Flatten memberships into a `tenants` array — primary tenant first,
        // then any TenantMember-only tenants, limited to the viewer's own
        // companies. The frontend renders the chip group from it and edits
        // memberships through it; a login that also belongs elsewhere is
        // flagged instead (and only someone in every one of its companies may
        // edit it — staffAccounts.ts findManagedStaff).
        tenants: dedupeTenants([
          ...(u.tenantId && primary ? [primary] : []),
          ...u.tenantMemberships.map((m) => m.tenant),
        ]).filter((t) => mine.has(t.id)),
        inOtherCompanies: allCompanies.some((t) => !mine.has(t)),
        payroll: payrollOf.get(u.id) ?? null,
        // Floor roles sign in with a code (middleware.ts OTP_LOGIN_ROLES) —
        // the server's list, so Workforce keeps no copy of it.
        usesCodeLogin: usesOtpLogin(u.role),
        tenantMemberships: undefined,
      }
    })
  })

  // POST /auth/users — create staff member (admin only).
  //
  // /workforce sends a "stub" payload (just name + role category + jobTitle)
  // — the CEO fills in email / phone / PIN inline on the row afterward. So
  // every field except role is optional at create time. PIN missing → the
  // account can't log in until the CEO sets one (the row shows a 🚫 No PIN
  // chip to make that obvious).
  fastify.post('/users', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      name:     z.string().min(1).optional(),
      email:    z.string().email().optional().or(z.literal('')),
      phone:    z.string().min(7).max(20).optional().or(z.literal('')),
      pin:      z.string().min(4).max(8).optional().or(z.literal('')),
      role:     STAFF_ROLE_WITH_ADMIN,
      jobTitle: z.string().max(120).optional().or(z.literal('')),
      // Primary tenant — anchors User.tenantId. Required-ish: falls back to
      // the operator's active tenant when omitted. CUID, not UUID.
      tenantId:  z.string().min(1).optional(),
      // Additional tenants this staff member also works for (head-office
      // pattern: one procurement officer servicing both restaurants).
      // Backed by TenantMember rows. Primary tenantId is auto-included.
      tenantIds: z.array(z.string().min(1)).optional(),
    }).parse(req.body)

    // Password not used for login (PIN-only) — store a random unusable hash
    // The generated password. This is the account's ONLY credential under
    // email+password login, so two things matter:
    //
    //  1. It is CSPRNG. It used to be `Math.random() + Date.now()` —
    //     xorshift128+ plus a value readable from the API's own response
    //     headers, which narrows the search space for anyone who can observe
    //     one account creation and guess at others made in the same process.
    //  2. The PLAINTEXT is returned ONCE, below. Until now the response
    //     carried no credential at all, so creating a staff member produced an
    //     account nobody could ever sign into — the CEO had no password to
    //     hand over and there is no reset flow to recover with.
    const temporaryPassword = generateStaffPassword()
    const password = await hashPassword(temporaryPassword)
    // A manager-override PIN is set only when the CEO types one. It used to
    // generate a random temporary PIN that was never returned or shown to
    // anyone — a credential nobody knew. Validated by the same rules as every
    // other PIN write (format, weak list, per-company collision) below, once
    // the target companies are known.

    // Resolve the target company: explicit body.tenantId wins; falls back to
    // the operator's ACTIVE company. Every company the new login is bound to
    // must be one the operator belongs to — admins included. This used to let
    // any admin create logins in ANY company, so another company's CEO could
    // put people into GS Foods. The group owner belongs to every company, so
    // they still can.
    const tenantId = body.tenantId ?? req.staffUser!.tenantId
    if (!tenantId) {
      throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — a new login belongs to a company.', 422)
    }
    const extraIds = (body.tenantIds ?? []).filter((id) => id !== tenantId)
    assertCompaniesInScope(req, [tenantId, ...extraIds])

    // Email is now mandatory and must be on the company domain: it is the ONLY
    // way to sign in, so creating a staff row without one creates an account
    // nobody can ever use. Practice copy: a name and a role are enough — an
    // address is generated when none is typed (owner, 2026-10-15).
    const practice = isSandbox()
    if (practice && !body.email) body.email = await practiceStaffEmail(body.name?.trim() || 'staff')
    if (!isStaffEmail(body.email)) {
      return reply.status(400).send({ error: { code: 'EMAIL_NOT_COMPANY_DOMAIN', message: STAFF_EMAIL_MESSAGE } })
    }
    const emailHolder = await prisma.user.findUnique({ where: { email: normaliseStaffEmail(body.email!) }, select: { id: true } })
    if (emailHolder) {
      throw (await loginInTrash(req, emailHolder.id)) ?? new AppError('EMAIL_TAKEN', 'A login with that email already exists.', 409)
    }

    // Floor roles sign in only with a code to this number; one number is one
    // login across every company (staffAccounts.ts).
    const phone = normaliseStaffPhone(body.phone)
    assertPhoneForRole(body.role, phone)

    const pin = body.pin
      ? await preparePin(body.pin, { tenantIds: dedupeStrings([...(tenantId ? [tenantId] : []), ...extraIds]) })
      : null

    // Check and write under one per-number lock (AUTH-R5).
    const user = await withStaffPhoneLock(phone, async (tx) => {
      await assertPhoneFree(req, phone, { role: body.role, db: tx })
      return tx.user.create({
        data: {
          name: body.name?.trim() || 'Unnamed staff',
          email: normaliseStaffEmail(body.email!),
          ...(phone ? { phone } : {}),
          ...(body.jobTitle ? { jobTitle: body.jobTitle.trim() } : {}),
          password,
          // The CEO is shown this password; the person is prompted to replace
          // it at first sign-in (the flag rides on the login response).
          mustChangePassword: true,
          pin,
          pinMustReset: false,
          tenantId,
          role: body.role,
          // Mirror the primary tenant as a membership row too — keeps "is this
          // user a member of tenant X?" queries simple (just check TenantMember,
          // no UNION with User.tenantId needed).
          //
          // Nested writes use `tenant: { connect }` not raw `tenantId` — Prisma
          // disallows the FK column inside a nested-create when the relation is
          // already implicit from the parent.
          tenantMemberships: {
            create: dedupeStrings([
              ...(tenantId ? [tenantId] : []),
              ...extraIds,
            ]).map((id) => ({
              tenant: { connect: { id } },
              role: 'member',
            })),
          },
        },
        select: {
          id: true, name: true, email: true, phone: true, role: true, jobTitle: true,
          isActive: true, accountStatus: true, createdAt: true, pin: true, tenantId: true,
          permissionAllow: true, permissionDeny: true, moduleAllow: true, moduleDeny: true,
          tenant: { select: { id: true, name: true, slug: true } },
          tenantMemberships: { select: { tenantId: true, tenant: { select: { id: true, name: true, slug: true } } } },
        },
      })
    })
    // Creating a staff account is the first half of "who can get in"; the role
    // it is created WITH is the second. Neither was recorded anywhere before.
    await audit({
      category: 'identity',
      action: 'user.create',
      entity: 'User',
      entityId: user.id,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: user.tenantId,
      after: { name: user.name, email: user.email, role: user.role, tenantId: user.tenantId },
      metadata: { actorTenantId: req.staffUser?.tenantId ?? null },
    })
    return reply.status(201).send({
      ...user,
      // Shown once, then unrecoverable — only the bcrypt hash is stored. The
      // admin UI must surface this at creation time or the account is dead on
      // arrival.
      temporaryPassword,
      hasPin: !!user.pin,
      pin: undefined,
      tenants: dedupeTenants([
        user.tenant ?? null,
        ...user.tenantMemberships.map((m) => m.tenant),
      ]),
      tenantMemberships: undefined,
    })
  })

  // PATCH /auth/users/:id — update staff (admin only).
  // Used by both the /workforce inline editor and the legacy admin user
  // editor. Every field is optional — only the ones supplied get written.
  // Empty string is treated as "clear this field" so the CEO can wipe a
  // wrong email or phone without deleting the whole row.
  fastify.patch<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({
        name:     z.string().min(1).optional(),
        email:    z.string().email().optional().or(z.literal('')),
        phone:    z.string().min(7).max(20).optional().or(z.literal('')),
        role:     STAFF_ROLE_WITH_ADMIN.optional(),
        pin:      z.string().min(4).max(8).optional().or(z.literal('')),
        isActive: z.boolean().optional(),
        jobTitle: z.string().max(120).optional().or(z.literal('')),
        // Primary tenant transfer. CUID, not UUID.
        tenantId:  z.string().min(1).optional(),
        // Full multi-tenant membership rewrite — when present, replaces the
        // user's TenantMember rows with exactly these tenants. First entry
        // is treated as the primary (also sets User.tenantId) unless
        // tenantId is also explicitly supplied above.
        tenantIds: z.array(z.string().min(1)).optional(),
        // Per-user permission + module overrides. Sent as full-replacement
        // arrays — the frontend computes the delta against role defaults
        // and posts the resulting allow/deny lists. Empty arrays = "follow
        // role baseline exactly."
        permissionAllow: z.array(z.string().min(1)).optional(),
        permissionDeny:  z.array(z.string().min(1)).optional(),
        moduleAllow:     z.array(z.string().min(1)).optional(),
        moduleDeny:      z.array(z.string().min(1)).optional(),
        // Station roster. Full-replacement array — empty means "not
        // station-restricted" (Kitchen view falls back to every active
        // station). The CRUD-only guarantees on /stations stay; assigning
        // a station here just gates *visibility* on /kds.
        stationIds:      z.array(z.string().min(1)).optional(),
      }).parse(req.body)

      // Company scope (staffAccounts.ts findManagedStaff), admins included: the
      // login must be in the operator's WRITE scope (every company they belong
      // to) — another company's login is 404, and one shared with a company
      // they are not in is 403. It used to apply only to non-admins, so another
      // company's CEO could re-role GS Foods staff and move them into their own
      // company. The group owner belongs to every company, so they still can —
      // including giving someone a second company from the all-companies view
      // (write scope is every membership, not the active company).
      const existing = await findManagedStaff(req, req.params.id, {
        // role / isActive / email are read for the audit trail's before-state —
        // a role change is only meaningful in the log if you can see what it
        // moved FROM. phone for the floor-login rules below.
        role: true, isActive: true, accountStatus: true, email: true, phone: true,
      })

      // "The only person I can't fire is me" (owner, 2026-10-15): the CEO
      // never switches their own login off here.
      if (body.isActive === false && req.params.id === req.staffUser!.id) {
        throw new AppError('CANNOT_OFFBOARD_SELF', 'You cannot switch off your own login.', 403)
      }

      // Moving or adding companies: only ones the operator belongs to (422).
      assertCompaniesInScope(req, [...(body.tenantId ? [body.tenantId] : []), ...(body.tenantIds ?? [])])

      // Resolve final primary tenantId — explicit tenantId wins; otherwise
      // first entry of tenantIds; otherwise leave existing value alone.
      const finalPrimary = body.tenantId ?? body.tenantIds?.[0]

      // Floor-login rules (PPL-04/05), on the state this save produces, and only
      // for what the save CHANGES — a name edit, a promotion between office
      // roles, or re-saving an unchanged number on a legacy row must never be
      // blocked by a duplicate or a missing phone that predates the rules
      // (only NEW conflicts are refused):
      //   • PHONE_REQUIRED: the number is cleared on a floor login, or a login
      //     moves INTO a floor role without one. Enforced even while the login
      //     is (or is being) suspended — otherwise "suspend + make cashier +
      //     clear phone", then "switch back on", produced an active cashier
      //     nobody can sign in to (AUTH-R6). A plain reactivation of a legacy
      //     floor login with no number is still allowed ("No phone" on
      //     Workforce), as is a floor-to-floor role change on one.
      //   • PHONE_IN_USE: only for a login that ends up an active/pending FLOOR
      //     login, when its number actually changed, it moved into a floor role,
      //     or it is being switched back on (a suspended login gives its number
      //     up, so a duplicate could otherwise come back this way). Office
      //     logins never collide (AUTH-R7).
      const finalRole = body.role ?? existing.role
      const reactivating = body.isActive === true && accountStateOf(existing) === 'suspended'
      const existingPhone = normaliseStaffPhoneLenient(existing.phone)
      // Re-sending the number already on file, character for character, is not
      // a change — even a legacy value that would fail today's format check
      // (F4: an old row must stay editable, only NEW bad numbers are refused).
      const phoneUntouched = body.phone == null || body.phone.trim() === (existing.phone ?? '').trim()
      const finalPhone = phoneUntouched ? existingPhone : normaliseStaffPhone(body.phone)
      const phoneChanged = !phoneUntouched && finalPhone !== existingPhone
      const intoFloorRole = body.role != null && usesOtpLogin(body.role) && !usesOtpLogin(existing.role)
      const finalState = body.isActive === false ? 'suspended'
        : reactivating ? reactivateData(existing.accountStatus).accountStatus
        : accountStateOf(existing)
      if (phoneChanged || intoFloorRole) assertPhoneForRole(finalRole, finalPhone)
      const checkPhoneFree = finalState !== 'suspended' && (phoneChanged || intoFloorRole || reactivating)

      const data: Record<string, unknown> = {}
      if (body.name     != null) data.name      = body.name
      if (!phoneUntouched)       data.phone     = finalPhone
      // Refuse to CLEAR an email. Sign-in matches on email alone and there is
      // no reset flow, so blanking it from this ordinary admin form is an
      // unrecoverable action — the account can never be signed into again.
      if (body.email != null) {
        if (!body.email.trim()) {
          throw new AppError(
            'EMAIL_REQUIRED',
            'Staff sign in with their email, so it cannot be removed. Change it to a different address instead.',
            400,
          )
        }
        if (!isStaffEmail(body.email)) {
          throw new AppError('EMAIL_NOT_COMPANY_DOMAIN', STAFF_EMAIL_MESSAGE, 400)
        }
        data.email = normaliseStaffEmail(body.email)
      }
      if (body.role     != null) data.role      = body.role
      // Suspend / reactivate: accountStatus is the canonical column and
      // isActive its mirror — both written together (accountStatus.ts), so the
      // "suspended" filter and the auth gate can never disagree again.
      if (body.isActive != null) {
        Object.assign(data, body.isActive ? reactivateData(existing.accountStatus) : suspendData())
      }
      if (body.jobTitle != null) data.jobTitle  = body.jobTitle || null
      // NOTE: changing the phone number deliberately does NOT touch the PIN.
      // PINs used to be re-derived from the phone's last 4 digits here, which
      // meant editing someone's number silently reset their credential to a
      // publicly-guessable value.
      if (body.pin != null) {
        if (body.pin === '') {
          data.pin = null
        } else {
          // THE setter's rules (managerPin.ts): 4-8 digits, not guessable, and
          // not already held by anyone in the companies this person will
          // belong to after this save.
          const companies = body.tenantIds
            ? dedupeStrings([...(finalPrimary ? [finalPrimary] : []), ...body.tenantIds])
            : dedupeStrings([
                ...(finalPrimary ? [finalPrimary] : []),
                ...(await prisma.tenantMember.findMany({ where: { userId: req.params.id }, select: { tenantId: true } })).map((m) => m.tenantId),
                ...(existing.tenantId ? [existing.tenantId] : []),
              ])
          data.pin = await preparePin(body.pin, { tenantIds: companies, excludeUserId: req.params.id })
          data.pinMustReset        = false
          data.pinResetRequestedAt = null
        }
      }
      if (finalPrimary)          data.tenantId  = finalPrimary
      // Override arrays — full-replacement semantics. The frontend computes
      // diffs against role defaults and posts the resulting state; if the
      // operator clears every override the arrays come through as empty,
      // which is also "back to role default."
      if (body.permissionAllow != null) data.permissionAllow = body.permissionAllow
      if (body.permissionDeny  != null) data.permissionDeny  = body.permissionDeny
      // CEO-only modules (Brands) are never granted per user either.
      if (body.moduleAllow     != null) data.moduleAllow     = withoutCeoOnlyModules(body.moduleAllow)
      if (body.moduleDeny      != null) data.moduleDeny      = body.moduleDeny
      if (body.stationIds      != null) data.stationIds      = body.stationIds

      const user = await withStaffPhoneLock(checkPhoneFree ? finalPhone : null, async (tx) => {
        // Under the per-number lock, so the check and this write cannot
        // interleave with another save of the same number (AUTH-R5).
        if (checkPhoneFree) {
          await assertPhoneFree(req, finalPhone, { role: finalRole, excludeUserId: req.params.id, db: tx })
        }
        const updated = await tx.user.update({ where: { id: req.params.id }, data })
        // Membership rewrite — only when the caller supplied tenantIds.
        // Treat the request as the source of truth: drop old rows, recreate
        // the union of (final primary + body.tenantIds).
        if (body.tenantIds) {
          const desired = dedupeStrings([
            ...(finalPrimary ? [finalPrimary] : []),
            ...body.tenantIds,
          ])
          await tx.tenantMember.deleteMany({ where: { userId: req.params.id } })
          if (desired.length > 0) {
            await tx.tenantMember.createMany({
              data: desired.map((tid) => ({ userId: req.params.id, tenantId: tid, role: 'member' })),
            })
          }
        } else if (finalPrimary) {
          // A primary-company move without a membership list: the new primary
          // is also a real membership, as at create — so a later company switch
          // (which overwrites users.tenantId) can never drop it (AUTH-R1).
          await tx.tenantMember.upsert({
            where:  { userId_tenantId: { userId: req.params.id, tenantId: finalPrimary } },
            create: { userId: req.params.id, tenantId: finalPrimary, role: 'member' },
            update: {},
          })
        }
        return tx.user.findUnique({
          where: { id: req.params.id },
          select: {
            id: true, name: true, email: true, phone: true, role: true, jobTitle: true,
            isActive: true, accountStatus: true, createdAt: true, pin: true, tenantId: true,
            permissionAllow: true, permissionDeny: true, moduleAllow: true, moduleDeny: true,
            stationIds: true,
            tenant: { select: { id: true, name: true, slug: true } },
            tenantMemberships: { select: { tenantId: true, tenant: { select: { id: true, name: true, slug: true } } } },
          },
        })
      })
      if (!user) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such staff' } })
      // Kill outstanding sessions when an access-affecting field changes — a
      // deactivated / demoted / re-PINned user must not keep a live token.
      if (body.isActive === false || body.role != null || body.pin != null) {
        await revokeAllForSubject(req.params.id)
      }
      // Role assignment is the most consequential edit on this screen — it is
      // how someone comes to hold access they did not have. Logged only when
      // the value actually moved, so the trail is not buried under name and
      // phone edits.
      // Identity-trail rows are filed under the TARGET's company (the one it
      // belonged to when it was changed), so that company's CEO and IT see what
      // happened to their own people. They used to carry the ACTOR's active
      // company, which hid a change made from another company from the one it
      // happened to. The actor's company rides along in metadata.
      const trail = {
        category: 'identity' as const,
        entity: 'User',
        entityId: req.params.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        tenantId: auditCompanyOf(existing),
        metadata: { actorTenantId: req.staffUser?.tenantId ?? null },
      }
      if (body.role != null && existing.role !== body.role) {
        await audit({
          ...trail,
          action: 'user.role_change',
          before: { role: existing.role },
          after: { role: body.role, targetEmail: existing.email },
        })
      }
      if (body.isActive != null && (accountStateOf(existing) === 'suspended') === body.isActive) {
        await audit({
          ...trail,
          action: body.isActive ? 'user.enable' : 'user.disable',
          after: { targetEmail: existing.email },
        })
      }
      if (body.pin != null && body.pin !== '') {
        await audit({
          ...trail,
          action: 'user.pin_reissue',
          after: { targetEmail: existing.email },
        })
      }
      // Moving a login between companies, or changing which companies it works
      // for, was not recorded at all. Filed under the company it left AND the
      // one(s) it joined, so both sides can see it.
      const afterCompanies = dedupeStrings([...(user.tenantId ? [user.tenantId] : []), ...user.tenantMemberships.map((m) => m.tenantId)])
      const companiesMoved = user.tenantId !== existing.tenantId
        || afterCompanies.slice().sort().join(',') !== existing.companies.slice().sort().join(',')
      if (companiesMoved) {
        const filedUnder = dedupeStrings([
          ...(existing.tenantId ? [existing.tenantId] : []),
          ...afterCompanies.filter((t) => !existing.companies.includes(t)),
        ])
        for (const t of filedUnder.length ? filedUnder : [null]) {
          await audit({
            ...trail,
            tenantId: t,
            action: 'user.company_change',
            before: { tenantId: existing.tenantId, companies: existing.companies },
            after: { tenantId: user.tenantId, companies: afterCompanies, targetEmail: existing.email },
          })
        }
      }
      return {
        ...user,
        accountStatus: accountStateOf(user),
        hasPin: !!user.pin,
        pin: undefined,
        tenants: dedupeTenants([
          user.tenant ?? null,
          ...user.tenantMemberships.map((m) => m.tenant),
        ]),
        tenantMemberships: undefined,
      }
    },
  )

  // DELETE /auth/users/:id — soft-delete staff (admin only).
  //
  // Same company scope as every staff-admin route (another company's login is
  // 404), and audited: removing a login is the last word on "who can get in",
  // and it used to leave no trace at all.
  fastify.delete<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const target = await findManagedStaff(req, req.params.id, { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true })
      // To the Trash (type `login`, CEO only): a restore brings it back
      // SUSPENDED, and the sessions revoked below stay dead.
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: TRASH_COMPANY.login, entityId: target.id, tenantId: auditCompanyOf(target),
          title: target.name || target.email || 'Login', subtitle: target.email, reason: trashReasonOf(req),
          meta: { previous: { accountStatus: target.accountStatus, isActive: target.isActive }, role: target.role, companies: target.companies },
        })
        await tx.user.update({
          where: { id: target.id },
          data: softDeleteData(),
        })
      })
      await revokeAllForSubject(target.id) // kill the deleted user's sessions now
      await audit({
        category: 'identity',
        action: 'user.delete',
        entity: 'User',
        entityId: target.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        tenantId: auditCompanyOf(target),
        before: { name: target.name, role: target.role, accountStatus: accountStateOf(target), companies: target.companies },
        after: { deleted: true, targetEmail: target.email },
        metadata: { actorTenantId: req.staffUser?.tenantId ?? null },
      })
      return reply.status(204).send()
    },
  )

  // POST /auth/staff/:id/sign-in-code — a manager hands a floor-staff member a
  // one-time sign-in code in person (FOH-19).
  //
  // Floor staff have no password: a code to WhatsApp or email is their only way
  // in. When neither can be delivered (gateway down, SMTP down, phone dead), the
  // till used to say "ask a manager to sign you in" — and no manager could.
  // This is that path, kept as narrow as the rest of code sign-in:
  //   • who: a signed-in manager whose role may manage the target's role
  //     (lib/workspaces.ts childRoles — foh_management for cashiers and
  //     servers, boh_management for the kitchen, management / F&B / CEO for
  //     all floor roles). Owners get none, as everywhere in staff admin.
  //   • whom: an active floor-role login in the manager's own companies
  //     (write scope; another company's login is 404) with a phone on file
  //     that no other login shares.
  //   • what: the SAME staff_login code row the WhatsApp path writes — 5-minute
  //     life, single use, the per-number lock, cooldown and daily cap — shown
  //     on the manager's screen instead of sent. The staff member redeems it at
  //     the normal POST /auth/staff/otp/verify, with its attempt limit and
  //     per-phone rate limit.
  //   • rate-limited per manager, and audited (actor + target, in the
  //     target's company). The code itself is never logged or stored anywhere
  //     but the code row.
  fastify.post<{ Params: { id: string } }>(
    '/staff/:id/sign-in-code',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const actor = req.staffUser!
      const target = await findManagedStaff(req, req.params.id, {
        id: true, name: true, email: true, phone: true, role: true, accountStatus: true, isActive: true,
      })
      if (!usesOtpLogin(target.role)) {
        throw new AppError('NOT_A_CODE_LOGIN', 'Only cashiers, servers and kitchen staff sign in with a code. Managers and office staff use their password.', 400)
      }
      if (!childRolesFor(actor.role).includes(target.role)) {
        throw new AppError('ROLE_NOT_ALLOWED', 'Your role cannot sign this person in. Ask their own manager.', 403)
      }
      if (accountStateOf(target) !== 'active') {
        throw new AppError('ACCOUNT_NOT_ACTIVE', 'This login is not active, so it cannot sign in.', 409)
      }
      const phone = normaliseStaffPhoneLenient(target.phone)
      if (!phone) {
        throw new AppError('PHONE_REQUIRED', 'Add their mobile number on Workforce first — they type it with the code to sign in.', 400)
      }
      // The code is redeemed by number. If the number resolves to anyone else
      // (or to nobody, because two logins share it), the code would not sign
      // THIS person in — refuse rather than hand over a dead code.
      const resolved = await findOtpLoginStaff(phone)
      if (resolved?.id !== target.id) {
        throw new AppError('PHONE_IN_USE', 'Another login has the same mobile number, so a code cannot tell them apart. Fix the duplicate on Workforce first.', 409)
      }

      await claimRateLimit(STAFF_CODE_ISSUER_LIMIT, `user:${actor.id}`)
      const { code, expiresAt } = await issueStaffCodeInPerson(phone)
      // The usual reason a manager is here is that the cashier has already
      // tapped "Send code" until the per-phone bucket locked (every send counts
      // toward it). Left alone, that lock (15 min) outlives this code (5 min),
      // so the code would be refused at verify with 429 and die unused (AUTH-R2).
      // A manager has vouched for the person in front of them, so the bucket
      // starts fresh. Guessing stays bounded: the code row's own attempt limit
      // (5) and the per-IP bucket still apply at verify.
      await clearFailures(STAFF_OTP_PHONE_LIMIT, `phone:${phone}`)

      await audit({
        category: 'identity',
        action: 'user.signin_code_issue',
        entity: 'User',
        entityId: target.id,
        userId: actor.id,
        userEmail: actor.email,
        tenantId: auditCompanyOf(target),
        after: { targetEmail: target.email, targetRole: target.role, expiresAt },
        metadata: { actorTenantId: actor.tenantId ?? null, ip: req.ip ?? null },
      })
      req.log.warn({ actor: actor.id, target: target.id, phone: maskPhoneForLog(phone) }, 'sign-in code issued in person')

      return reply.status(201).send({
        code,
        expiresAt,
        name: target.name,
        // What the staff member types with the code — their own number, masked
        // here because the manager does not need to read it back.
        phoneHint: maskPhoneForLog(phone),
      })
    },
  )

  // GET /auth/account — the signed-in person's own sign-in settings, for the
  // admin's /account/password page: whether their password was issued by
  // someone else, and whether they hold (or may hold) a manager-override PIN.
  fastify.get('/account', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { id: true, name: true, email: true, role: true, pin: true, mustChangePassword: true },
    })
    if (!me) throw new UnauthorizedError('Account is no longer active')
    const codeLogin = usesOtpLogin(me.role)
    return {
      id: me.id,
      name: me.name,
      email: me.email,
      role: me.role,
      usesCodeLogin: codeLogin,
      mustChangePassword: !codeLogin && me.mustChangePassword,
      hasPin: !!me.pin,
      canHoldPin: isOverrideApprover(me.role),
    }
  })

  // POST /auth/customer/request — send a sign-in link to the email or phone.
  // Used by the mobile app login flow. Always returns 200 to prevent
  // enumeration.
  //
  // Unauthenticated, and it sends a message to a contact the CALLER chose —
  // the shape the 2026-09-09 audit removed /customer/request-otp for. So:
  //   • capped PER CONTACT per day (MAGIC_LINK_CONTACT_LIMIT), every request
  //     counted whether or not the contact has an account; the per-IP limit
  //     stays underneath, but it is the easy half to get around;
  //   • the phone is normalised before lookup, so 0300… finds the 92300…
  //     account instead of making a second, empty one;
  //   • no account is created here. A contact with none gets a signed link,
  //     and the account is made when the link is followed (service.ts).
  fastify.post('/customer/request', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    refuseCodeRequestInPractice('customer') // practice copy: no link is sent
    const body = z.object({
      email: z.string().email().optional(),
      phone: z.string().min(7).max(20).optional(),
      name:  z.string().min(1).max(80).optional(),
    }).refine((v) => !!(v.email || v.phone), { message: 'Provide email or phone' })
      .parse(req.body)

    const { isEmail, contact } = normaliseCustomerContact((body.email ?? body.phone)!)
    try {
      await claimRateLimit(MAGIC_LINK_CONTACT_LIMIT, `${isEmail ? 'email' : 'phone'}:${contact}`)
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 429) {
        throw new AppError('MAGIC_LINK_LIMIT', 'Too many sign-in links have been requested for this contact today. Try again tomorrow.', 429)
      }
      throw err
    }

    try {
      await requestMagicLink(contact, body.name)
    } catch (err) {
      // Log but always return 200 — don't leak whether the address exists.
      req.log.warn({ err: (err as Error).message }, 'requestMagicLink failed')
    }
    return reply.status(200).send({ ok: true })
  })

  // POST /auth/customer/verify — verify magic link token
  // Rate-limited per IP so a token-guessing bot can't spam the endpoint.
  fastify.post('/customer/verify', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(MAGIC_LINK_VERIFY_LIMIT, ip)
    const body = magicLinkVerifySchema.parse(req.body)
    try {
      const result = await verifyMagicLink(body.token)
      await clearFailures(MAGIC_LINK_VERIFY_LIMIT, ip)
      return reply.status(200).send(result)
    } catch (err) {
      await recordFailure(MAGIC_LINK_VERIFY_LIMIT, ip)
      throw err
    }
  })
}
