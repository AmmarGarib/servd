import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'                  // PIN collision check on staff signup
import { z } from 'zod'
import { staffLogin, refreshStaffToken, customerRegister, customerLogin, verifyMagicLink, requestMagicLink, hashPassword, hashPin, issueStaffSession, findOtpLoginStaff } from './service.js'
import {
  verifyLoginChallenge,
  startEnrolment,
  completeEnrolment,
  disable as disableTwoFactor,
  maskPhone,
} from './twoFactor.js'
import { requestOtp, verifyOtp, normalisePhone } from './otp.js'
import { sendText, invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY } from '../../lib/whatsapp.js'
import { sendEmail, mailConfig, invalidateMailConfig, emailConfigured as isEmailConfigured, SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY } from '../../lib/mailer.js'
import { runDeliveryWatch, DELIVERY_STATE_KEY } from '../../workers/deliveryWatch.js'
import { requestPasswordReset, consumeResetToken, checkResetToken, deliveryConfigured } from './passwordReset.js'
import { requireAuth, requireCustomerAuth, ADMIN_ONLY, MANAGERS, ALL_STAFF, usesOtpLogin } from './middleware.js'
import { revokeBearer, revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { setAuthCookies, setAccessCookie, clearAuthCookies, readCookie, ACCESS_COOKIE, REFRESH_COOKIE } from '../../lib/cookies.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { resolveTenantScope, tenantWhere } from '../../lib/tenantScope.js'
import { AppError, UnauthorizedError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { isStaffEmail, normaliseStaffEmail, STAFF_EMAIL_MESSAGE } from '../../lib/staffEmail.js'
import { generateStaffPassword } from '../../lib/generatePassword.js'
import {
  check as checkRateLimit,
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

const magicLinkVerifySchema = z.object({
  token: z.string().length(32),
})

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

// All UserRole enum values *except* admin — admin is reserved for the CEO and
// can only be granted by another admin via PATCH /auth/users/:id; new staff
// signing themselves up never get it. Keep in sync with backend/prisma/schema.prisma.
const STAFF_ROLE_VALUES = [
  'manager', 'management', 'foh_management', 'boh_management',
  'foh', 'boh', 'kitchen', 'expediter', 'cashier',
  'procurement', 'marketing', 'finance', 'hr',
] as const
const STAFF_ROLE = z.enum(STAFF_ROLE_VALUES)
// CEO-only assignment includes `admin` so the founder can promote a successor.
const STAFF_ROLE_WITH_ADMIN = z.enum(['admin', ...STAFF_ROLE_VALUES])

// 6-digit PIN, 10^6 = 1M keyspace. Combined with per-IP lockout on /auth/pin,
// this is brute-force-resistant in practice. Used by both staff signup and
// the admin-driven re-issue flow for legacy PIN rotation.
/**
 * Reject PINs that a shoulder-surfer or a casual guesser would land quickly:
 * all-same digits (0000), ascending/descending runs (1234, 4321), and
 * plausible birth years. Not a substitute for lockout, but it removes the
 * handful of PINs that a meaningful share of people actually pick.
 */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true                      // 1111, 000000
  const asc  = '01234567890'
  const desc = '09876543210'
  if (asc.includes(pin) || desc.includes(pin)) return true      // 1234, 4321
  if (/^(19|20)\d{2}$/.test(pin)) return true                   // 1998, 2024
  return false
}

function generateRandomPin(): string {
  const buf = randomBytes(4)
  const n = buf.readUInt32BE(0) % 1_000_000
  return n.toString().padStart(6, '0')
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Clock-in policy: geofence + anti-buddy-punching selfie.
//
// Extracted so POST /auth/pin and POST /auth/clock-in enforce the SAME rules.
// It previously lived only inside the PIN handler, which meant deleting PIN
// login would have switched attendance fraud control off silently — the
// OperationsConfig screen would keep rendering settings that controlled
// nothing. Returns the geofence verdict for the audit record.
async function enforceClockInPolicy(
  user: { id: string; role: string },
  body: { lat?: number; lng?: number; selfieUrl?: string },
): Promise<{ geofenceMatched: boolean | null; geofenceDistanceM: number | null }> {
  let geofenceMatched: boolean | null = null
  let geofenceDistanceM: number | null = null
  if (['admin', 'manager'].includes(user.role)) return { geofenceMatched, geofenceDistanceM }

  const { getOperationsConfig } = await import('../../lib/setup-config.js')
  const ops = await getOperationsConfig(
    (await prisma.user.findUnique({ where: { id: user.id }, select: { tenantId: true } }))?.tenantId,
  )
  const ratioEnforced = ops?.geofenceEnforced ?? false
  const selfieRequired = ops?.selfieRequiredAtClockIn ?? false
  const radiusM = ops?.geofenceRadiusMetres ?? 150

  const concept = await prisma.concept.findFirst({
    where: { latitude: { not: null }, longitude: { not: null }, isActive: true, deletedAt: null },
    select: { latitude: true, longitude: true, name: true },
  })

  if (selfieRequired && !body.selfieUrl) {
    throw new AppError('SELFIE_REQUIRED', 'Snap a selfie to clock in. Buddy-punching is blocked.', 403)
  }

  if (ratioEnforced && concept?.latitude != null && concept?.longitude != null) {
    if (body.lat == null || body.lng == null) {
      throw new AppError('LOCATION_REQUIRED', 'Allow location in your browser — you can only clock in on-site.', 403)
    }
    geofenceDistanceM = haversineMeters(concept.latitude, concept.longitude, body.lat, body.lng)
    geofenceMatched = geofenceDistanceM <= radiusM
    if (!geofenceMatched) {
      throw new AppError(
        'OUTSIDE_GEOFENCE',
        `You must be within ${radiusM}m of ${concept.name} to clock in (you are ${Math.round(geofenceDistanceM)}m away).`,
        403,
      )
    }
  } else if (concept?.latitude != null && body.lat != null && body.lng != null) {
    geofenceDistanceM = haversineMeters(concept.latitude, concept.longitude!, body.lat, body.lng)
    geofenceMatched = geofenceDistanceM <= radiusM
  }

  if (!ratioEnforced) {
    const row = await prisma.setting.findUnique({ where: { key: 'location_config' } })
    if (row) {
      let cfg: { enabled: boolean; lat: number | null; lng: number | null; radiusMeters: number }
      try { cfg = JSON.parse(row.value) } catch { cfg = { enabled: false, lat: null, lng: null, radiusMeters: 200 } }
      if (cfg.enabled && cfg.lat !== null && cfg.lng !== null) {
        if (body.lat == null || body.lng == null) {
          throw new AppError('LOCATION_REQUIRED', 'Location access is required to sign in. Please allow location in your browser.', 403)
        }
        const dist = haversineMeters(cfg.lat, cfg.lng, body.lat, body.lng)
        if (dist > cfg.radiusMeters) {
          throw new AppError('OUTSIDE_LOCATION', `You must be within ${cfg.radiusMeters}m of the restaurant to clock in (you are ${Math.round(dist)}m away).`, 403)
        }
      }
    }
  }
  return { geofenceMatched, geofenceDistanceM }
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
      if (!result.twoFactorRequired && usesOtpLogin(result.user?.role)) {
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
      throw err
    }
    // 2FA accounts get no session yet — just the challenge and a masked hint
    // of where the code went. No cookies are set here.
    if (result.twoFactorRequired) {
      return reply.status(200).send({
        twoFactorRequired: true,
        challengeToken: result.challengeToken,
        phoneHint: result.phoneHint,
      })
    }

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
    const body = staffOtpRequestSchema.parse(req.body)
    const phone = normalisePhone(body.phone)

    await checkRateLimit(STAFF_PASSWORD_LIMIT, req.ip ?? 'unknown')
    await checkRateLimit(STAFF_OTP_PHONE_LIMIT, `phone:${phone}`)

    const staff = await findOtpLoginStaff(phone)
    if (staff) {
      try {
        await requestOtp({ phone, purpose: 'staff_login' })
      } catch (err) {
        // A cooldown is the caller's own doing and worth saying out loud —
        // silence here reads as "my number is wrong" and they try another one.
        if (err instanceof AppError && err.code === 'OTP_COOLDOWN') throw err
        // Anything else (WhatsApp down or unconfigured) is ours. Say so plainly
        // rather than returning the generic success: a cashier standing at a
        // till needs to know to go and find a manager, not to keep retrying.
        req.log.error({ err, staffId: staff.id }, 'staff login OTP send failed')
        throw new AppError(
          'OTP_UNAVAILABLE',
          'Sign-in codes cannot be sent right now. Ask a manager to sign you in.',
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
      await verifyOtp({ phone, code: body.code, purpose: 'staff_login' })
    } catch (err) {
      await recordFailure(STAFF_OTP_PHONE_LIMIT, key)
      throw err
    }
    await clearFailures(STAFF_OTP_PHONE_LIMIT, key)

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
      throw err
    }

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

    // Say so rather than promising a link that physically cannot be sent.
    // This is a fact about the server, not about the account, so it gives away
    // nothing — and the alternative is someone refreshing an inbox forever.
    if (!deliveryConfigured()) {
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

  // POST /auth/password/change-authed — same thing for a signed-in user.
  fastify.post('/password/change-authed', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = passwordChangeSchema.extend({
      currentPassword: z.string().min(1).max(200),
    }).parse(req.body)
    const me = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { id: true, email: true, password: true },
    })
    if (!me || !await bcrypt.compare(body.currentPassword, me.password)) {
      throw new AppError('UNAUTHORIZED', 'Current password is incorrect', 401)
    }
    if (body.currentPassword === body.newPassword) {
      throw new AppError('WEAK_PASSWORD', 'Your new password must be different from the current one.', 400)
    }
    await applyPasswordChange(me.id, me.email ?? '@', body.newPassword)
    return reply.status(204).send()
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
      const target = await prisma.user.findFirst({
        where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
        select: { id: true, name: true, email: true },
      })
      if (!target) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Staff member not found in your active company' } })
      }
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
        tenantId: req.staffUser?.tenantId ?? null,
        after: { targetEmail: target.email },
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
      const target = await prisma.user.findFirst({
        where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
        select: { id: true, name: true, twoFactorEnabledAt: true },
      })
      if (!target) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Staff member not found in your active company' } })
      }
      await prisma.user.update({
        where: { id: target.id },
        data: { twoFactorPhone: null, twoFactorEnabledAt: null },
      })
      // Their sessions die too: whoever holds the old phone should not keep a
      // live session after we have unhooked the second factor.
      await revokeAllForSubject(target.id)
      req.log.warn({ actor: req.staffUser!.id, target: target.id }, '2FA reset by admin')
      return reply.status(200).send({ id: target.id, name: target.name, twoFactorEnabled: false })
    },
  )

  // POST /auth/clock-in — staff clocks in.
  //
  // Until now the ONLY thing in the backend that created a `type: 'in'`
  // ClockLog was the PIN-login handler. That made clock-in a side effect of a
  // login method we are removing, and removing it would have been silent and
  // expensive: payroll pairs in/out (payroll/service.ts computeHoursForPeriod)
  // and an 'out' with no open 'in' contributes nothing, so every hourly
  // staffer would compute ZERO hours and zero wages. Tip pools pair the same
  // way and skip anyone with hours <= 0, so a pool would be built with no
  // members and tips already booked as owed to staff would go to nobody.
  // Neither surfaces an error — the numbers just get smaller.
  //
  // So clock-in becomes its own authenticated action, enforcing the same
  // geofence + selfie policy the PIN route did.
  fastify.post('/clock-in', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      selfieUrl: z.string().url().optional(),
    }).parse(req.body ?? {})

    const user = req.staffUser!

    // Already clocked in? Return the open shift rather than stacking a second
    // 'in', which would leave an unpaired record and skew the hours pairing.
    const lastLog = await prisma.clockLog.findFirst({
      where: { userId: user.id },
      orderBy: { recordedAt: 'desc' },
      select: { type: true, recordedAt: true },
    })
    if (lastLog?.type === 'in') {
      return reply.status(200).send({ alreadyClockedIn: true, since: lastLog.recordedAt })
    }

    const { geofenceMatched, geofenceDistanceM } = await enforceClockInPolicy(
      { id: user.id, role: user.role },
      body,
    )

    const log = await prisma.clockLog.create({
      data: {
        userId: user.id,
        type: 'in',
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        selfieUrl: body.selfieUrl ?? null,
        geofenceMatched,
        geofenceDistanceM,
        ipAddress: req.ip,
      },
    })
    return reply.status(201).send({ clockedInAt: log.recordedAt, geofenceMatched, geofenceDistanceM })
  })

  // POST /auth/clock-out — staff clocks out
  fastify.post('/clock-out', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const userId = req.staffUser!.id
    await prisma.clockLog.create({ data: { userId, type: 'out' } })
    return reply.status(204).send()
  })

  // GET /auth/clock-logs — shift report for managers
  // A manager may only see clock logs for staff that share at least one of
  // their assigned concepts. Admins see all. (Closes IDOR §C5.)
  fastify.get<{ Querystring: { date?: string; userId?: string } }>(
    '/clock-logs',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const date  = req.query.date ? new Date(req.query.date) : new Date()
      const start = new Date(date); start.setHours(0, 0, 0, 0)
      const end   = new Date(date); end.setHours(23, 59, 59, 999)

      const isAdmin = req.staffUser!.role === 'admin'
      const myConceptIds: string[] = (req.staffUser as unknown as { conceptIds?: string[] }).conceptIds ?? []

      // If a specific userId is requested, validate the requester is allowed
      // to see them.
      if (!isAdmin && req.query.userId) {
        const target = await prisma.user.findUnique({
          where: { id: req.query.userId },
          select: { conceptIds: true },
        })
        const targetConceptIds = (target?.conceptIds ?? []) as string[]
        const hasOverlap = targetConceptIds.some((c) => myConceptIds.includes(c))
        if (!hasOverlap) throw new AppError('FORBIDDEN', 'Cannot view clock logs for this user', 403)
      }

      // Without a specific userId, restrict to staff in the manager's concepts.
      const userScope = !isAdmin && !req.query.userId
        ? {
            user: { conceptIds: { hasSome: myConceptIds } },
          }
        : undefined

      return prisma.clockLog.findMany({
        where: {
          recordedAt: { gte: start, lte: end },
          ...(req.query.userId && { userId: req.query.userId }),
          ...(userScope ?? {}),
        },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { recordedAt: 'desc' },
      })
    },
  )

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
    clearAuthCookies(reply)
    return reply.status(200).send({ ok: true })
  })

  // POST /auth/customer/logout — revoke the customer's session token.
  fastify.post('/customer/logout', { preHandler: requireCustomerAuth }, async (req, reply) => {
    await revokeBearer(req.headers.authorization)
    return reply.status(200).send({ ok: true })
  })

  // GET /auth/location-config — get on-site sign-in config
  fastify.get('/location-config', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const row = await prisma.setting.findUnique({ where: { key: 'location_config' } })
    if (!row) return { enabled: false, lat: null, lng: null, radiusMeters: 200 }
    try { return JSON.parse(row.value) } catch { return { enabled: false, lat: null, lng: null, radiusMeters: 200 } }
  })

  // PUT /auth/location-config — save on-site sign-in config (admin only)
  fastify.put('/location-config', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      enabled:      z.boolean(),
      lat:          z.number().min(-90).max(90).nullable(),
      lng:          z.number().min(-180).max(180).nullable(),
      radiusMeters: z.number().min(10).max(5000).default(200),
    }).parse(req.body)

    await prisma.setting.upsert({
      where:  { key: 'location_config' },
      create: { key: 'location_config', value: JSON.stringify(body) },
      update: { value: JSON.stringify(body) },
    })
    return body
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
      // F19: phone + OTP. Both optional today because legacy clients won't
      // send them, but new web/storefront flows always do. Server validates
      // the OTP one more time before stamping phoneVerifiedAt.
      phone:    z.string().min(7).max(20).optional(),
      otpCode:  z.string().regex(/^\d{4,6}$/).optional(),
      // Optional: 8-char referral code from another customer. If valid, links
      // the two and primes the dual-bonus payout on the new customer's
      // first order.
      referralCode: z.string().min(4).max(16).optional(),
      // Optional device fingerprint from JS. Captured if available — used by
      // the naughty-list gate.
      deviceFingerprint: z.string().max(120).optional(),
    }).parse(req.body)

    // If phone + OTP supplied, verify the code now so phoneVerifiedAt can be
    // stamped inside customerRegister. A bad OTP throws before we touch the
    // customer table.
    let otpVerified = false
    if (body.phone && body.otpCode) {
      await verifyOtp({ phone: body.phone, code: body.otpCode, purpose: 'signup' })
      otpVerified = true
    }

    // Naughty-list gate. Reject signup if the email or device matches an
    // active ban. Throws AppError(403, 'BANNED') which the global error
    // handler turns into a clean response.
    const { assertNotBanned } = await import('../../lib/banCheck.js')
    await assertNotBanned({
      email: body.email,
      ip: req.ip ?? null,
      deviceFingerprint: body.deviceFingerprint ?? null,
      intent: 'signup',
    })

    try {
      const result = await customerRegister(
        body.name, body.email, body.password,
        body.phone ? normalisePhone(body.phone) : undefined,
        otpVerified,
        body.referralCode,
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

  // F19: POST /auth/customer/request-otp — sends a 6-digit code over WhatsApp.
  // Rate-limited per-IP via the same customer-password limit so we don't get
  // abused as a free SMS gateway. The `purpose` lets the same endpoint serve
  // signup, phone-change, and password-reset later — front-end always sends
  // the matching purpose to verify.
  fastify.post('/customer/request-otp', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(CUSTOMER_PASSWORD_LIMIT, ip)

    const body = z.object({
      phone:   z.string().min(7).max(20),
      purpose: z.enum(['signup', 'phone_verify', 'password_reset']).default('signup'),
    }).parse(req.body)

    const result = await requestOtp({ phone: body.phone, purpose: body.purpose })
    // Don't echo the code back; the client only needs to know it's on its way.
    return reply.status(200).send({ phone: result.phone, expiresAt: result.expiresAt })
  })

  // POST /auth/customer/verify-otp — front-end uses this to validate before
  // submitting the registration form, so the user gets immediate "✓ verified"
  // feedback. The signup endpoint re-verifies server-side regardless.
  fastify.post('/customer/verify-otp', async (req, reply) => {
    const body = z.object({
      phone:   z.string().min(7).max(20),
      code:    z.string().regex(/^\d{4,6}$/),
      purpose: z.enum(['signup', 'phone_verify', 'password_reset']).default('signup'),
    }).parse(req.body)
    await verifyOtp({ phone: body.phone, code: body.code, purpose: body.purpose })
    return reply.status(200).send({ ok: true })
  })

  // ── Staff self-signup + CEO approval ───────────────────────────────────────
  //
  // Workflow:
  //   1. New hire fills the signup form on /login (name, email, phone, role).
  //   2. POST /auth/staff/signup creates a User row with status='pending'.
  //      PIN is a freshly-generated 6-digit random value, shown ONCE in the
  //      signup response so the new hire can save it. Phone-derived PINs
  //      used to be the default — that meant anyone who knew a staff member's
  //      phone (business cards, Instagram, reservation history) had their
  //      admin PIN. CSPRNG closes that.
  //   3. CEO reviews pending accounts and approves/rejects.
  //   4. Until approved, PIN login is blocked at the service layer.

  // POST /auth/staff/signup — public, IP-rate-limited. Creates a pending User.
  fastify.post('/staff/signup', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(STAFF_PASSWORD_LIMIT, ip)

    const body = z.object({
      name:    z.string().min(1).max(80),
      email:   z.string().email(),
      phone:   z.string().min(7).max(20),
      role:    STAFF_ROLE,
      reason:  z.string().max(280).optional(),    // free-text "why I'm joining"
    }).parse(req.body)

    if (!isStaffEmail(body.email)) {
      return reply.status(400).send({ error: { code: 'EMAIL_NOT_COMPANY_DOMAIN', message: STAFF_EMAIL_MESSAGE } })
    }
    const email = normaliseStaffEmail(body.email)
    // Duplicate email = nicer error than a 500 from the unique constraint.
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return reply.status(409).send({
        error: { code: 'EMAIL_TAKEN', message: 'A staff account with this email already exists' },
      })
    }

    // This is a REQUEST TO JOIN, not an account with a credential.
    //
    // It used to be: the hire picks a PIN, the CEO approves, the PIN works.
    // Under email+password there is no credential a stranger can safely set
    // for themselves, so the row is created with an unusable random password
    // and NO way in. Approving it is not enough either — the CEO then issues a
    // password from Workforce, which is the only path that produces one.
    // Saying that here matters: the old copy told the hire they could sign in
    // after approval, which would now be a lie.
    const password = await hashPassword(randomBytes(24).toString('base64url'))

    const user = await prisma.user.create({
      data: {
        name: body.name.trim(),
        email,
        phone: body.phone.trim(),
        password,
        role: body.role,
        accountStatus: 'pending',
        mustChangePassword: true,
        signupReason: body.reason ?? null,
        // isActive stays true; accountStatus is the real gate. We keep isActive
        // for legacy "soft disable" semantics.
      },
      select: { id: true, name: true, email: true, role: true, phone: true, accountStatus: true },
    })

    return reply.status(201).send({
      ...user,
      message: 'Request sent. Once the CEO approves you they will give you a password to sign in with.',
    })
  })

  // GET /auth/staff/pending — CEO lists everyone waiting for approval.
  fastify.get('/staff/pending', { preHandler: requireAuth('admin') }, async () => {
    const pending = await prisma.user.findMany({
      where: { accountStatus: 'pending', deletedAt: null },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        signupReason: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    return pending
  })

  // PATCH /auth/staff/:id/approve — CEO flips status to active. PIN was set
  // at signup so they can log in immediately after approval.
  fastify.patch<{ Params: { id: string } }>(
    '/staff/:id/approve',
    { preHandler: requireAuth('admin') },
    async (req, reply) => {
      const user = await prisma.user.findUnique({ where: { id: req.params.id } })
      if (!user) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such staff' } })
      if (user.accountStatus === 'active') {
        return reply.status(200).send({ ...user, pin: undefined, password: undefined, message: 'Already active' })
      }
      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: { accountStatus: 'active' },
        select: { id: true, name: true, email: true, role: true, accountStatus: true },
      })
      return reply.status(200).send(updated)
    },
  )

  // PATCH /auth/staff/:id/reject — CEO rejects (soft-deletes). We keep the row
  // for audit + so the same email can't re-sign-up without an admin first
  // restoring it.
  fastify.patch<{ Params: { id: string } }>(
    '/staff/:id/reject',
    { preHandler: requireAuth('admin') },
    async (req, reply) => {
      const updated = await prisma.user.update({
        where: { id: req.params.id },
        data: { accountStatus: 'suspended', isActive: false },
        select: { id: true, name: true, accountStatus: true },
      })
      await revokeAllForSubject(req.params.id) // kill the rejected user's sessions now
      return reply.status(200).send(updated)
    },
  )

  // POST /auth/staff/:id/issue-pin — admin rotates a staff member's PIN.
  //
  // Use case: legacy accounts whose PIN was derived from their phone are
  // flagged pinMustReset=true and blocked from PIN login. This endpoint
  // replaces the bcrypt hash and clears the flag.
  //
  // Body is optional. With no body, a fresh 6-digit CSPRNG PIN is generated
  // and returned once in the response so the admin can hand it to the staff
  // member out-of-band. With `{ pin: "<6 digits>" }`, the admin sets a
  // specific value — useful when the staff member wants a memorable PIN
  // (kept loosely random, never derived from PII).
  fastify.post<{ Params: { id: string } }>(
    '/staff/:id/issue-pin',
    { preHandler: requireAuth('admin') },
    async (req, reply) => {
      const body = z.object({
        pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits').optional(),
      }).parse(req.body ?? {})

      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, role: true, isActive: true, deletedAt: true },
      })
      if (!user || user.deletedAt) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such staff' } })

      // Collision check against every active PIN — see /auth/staff/signup
      // for the same logic. Retry until we find a unique value, or — when
      // the admin supplied a specific PIN — reject if it clashes.
      const candidates = await prisma.user.findMany({
        where: { isActive: true, pin: { not: null }, accountStatus: 'active', id: { not: user.id } },
        select: { pin: true },
      })

      let pinPlain: string | null = null
      if (body.pin) {
        for (const c of candidates) {
          if (c.pin && await bcrypt.compare(body.pin, c.pin)) {
            return reply.status(409).send({ error: { code: 'PIN_COLLISION', message: 'That PIN is already in use by another staff member. Pick a different value.' } })
          }
        }
        pinPlain = body.pin
      } else {
        for (let attempt = 0; attempt < 5; attempt++) {
          const tryPin = generateRandomPin()
          let collides = false
          for (const c of candidates) {
            if (c.pin && await bcrypt.compare(tryPin, c.pin)) { collides = true; break }
          }
          if (!collides) { pinPlain = tryPin; break }
        }
        if (!pinPlain) {
          return reply.status(503).send({ error: { code: 'PIN_GENERATION_FAILED', message: 'Could not allocate a unique PIN. Try again.' } })
        }
      }

      const pin = await hashPin(pinPlain)
      await prisma.user.update({
        where: { id: user.id },
        data: {
          pin,
          // Temporary by design: the staff member must pick their own PIN on
          // next login, so the CEO never ends up knowing a live credential.
          pinMustReset: true,
          // Their "forgot PIN" escalation is now handled.
          pinResetRequestedAt: null,
        },
      })

      return reply.status(200).send({
        id: user.id,
        name: user.name,
        pin: pinPlain,
        temporary: true,
        message: 'Temporary PIN issued. Share it with the staff member now — they will be asked to choose their own PIN when they log in.',
      })
    },
  )

  // POST /auth/pin/change — staff sets their OWN PIN.
  //
  // Used both for the forced change after a temporary PIN is issued
  // (pinMustReset) and for a voluntary change. Requires the CURRENT PIN, so a
  // borrowed unlocked tablet can't be used to silently take over an account.
  fastify.post('/pin/change', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      currentPin: z.string().regex(/^\d{4,8}$/),
      newPin:     z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
    }).parse(req.body)

    if (isWeakPin(body.newPin)) {
      return reply.status(400).send({
        error: { code: 'WEAK_PIN', message: 'That PIN is too easy to guess — avoid repeated digits (1111), runs (1234), and years.' },
      })
    }

    const me = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { id: true, pin: true },
    })
    if (!me?.pin || !(await bcrypt.compare(body.currentPin, me.pin))) {
      return reply.status(401).send({ error: { code: 'BAD_PIN', message: 'Current PIN is incorrect.' } })
    }

    await prisma.user.update({
      where: { id: me.id },
      data: {
        pin: await hashPin(body.newPin),
        pinMustReset: false,
        pinResetRequestedAt: null,
      },
    })
    return reply.status(200).send({ message: 'PIN updated.' })
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

  fastify.get('/integrations/email', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const keys = [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY]
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
    const get = (k: string) => rows.find((r) => r.key === k)?.value ?? ''
    const cfg = await mailConfig()
    return {
      host: get(SMTP_HOST_KEY),
      port: get(SMTP_PORT_KEY),
      user: get(SMTP_USER_KEY),
      from: get(SMTP_FROM_KEY),
      passSet: Boolean(get(SMTP_PASS_KEY) || (process.env['SMTP_PASS'] ?? '').trim()),
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
    if (body.pass !== undefined) pairs.push([SMTP_PASS_KEY, body.pass.trim()])
    for (const [key, value] of pairs) {
      await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    invalidateMailConfig()

    await audit({
      category: 'identity',
      action: 'integrations.email.update',
      entity: 'Setting',
      entityId: SMTP_USER_KEY,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: req.staffUser?.tenantId ?? null,
      after: { host: body.host, port: body.port, user: body.user, from: body.from, passChanged: body.pass !== undefined },
    })
    return reply.status(200).send({ ok: true })
  })

  fastify.post('/integrations/email/test', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ to: z.string().email() }).parse(req.body)
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
  fastify.get('/integrations/delivery-status', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const row = await prisma.setting.findUnique({ where: { key: DELIVERY_STATE_KEY } })
    if (!row) return { ok: true, cause: 'ok', detail: 'Not checked yet.', fix: '', checkedAt: null }
    try { return JSON.parse(row.value) } catch { return { ok: true, cause: 'ok', detail: '', fix: '', checkedAt: null } }
  })

  // Run the check on demand, for the "check now" button.
  fastify.post('/integrations/delivery-status/check', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    return runDeliveryWatch()
  })

  // ── WhatsApp gateway settings ─────────────────────────────────────────────
  //
  // These two values are the difference between the storefront taking signups
  // and not. They lived only in an env file on the production box, which meant
  // the person who owns them could not set them — and while they were blank,
  // customer signup, password reset and staff code sign-in were all down.
  //
  // CEO only. The key is a live credential: it is never returned, only a masked
  // tail so the screen can show that something is saved and which one.

  fastify.get('/integrations/whatsapp', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const rows = await prisma.setting.findMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
    const url = rows.find((r) => r.key === WA_URL_KEY)?.value ?? ''
    const key = rows.find((r) => r.key === WA_KEY_KEY)?.value ?? ''
    // Where the value in force actually comes from — without this the screen
    // cannot explain why sending works when both fields look empty.
    const envUrl = (process.env['WHATSAPP_API_URL'] ?? '').trim()
    const envKey = (process.env['WHATSAPP_API_KEY'] ?? '').trim()
    return {
      apiUrl: url,
      // Never the key itself. Enough to recognise which one is stored.
      apiKeyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : (envKey ? 'set in environment' : ''),
      source: url || key ? 'database' : (envUrl || envKey ? 'environment' : 'unset'),
      configured: Boolean(url || envUrl),
    }
  })

  fastify.put('/integrations/whatsapp', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      // Empty string clears the stored value and falls back to the environment.
      apiUrl: z.string().max(500),
      // Optional: omitting it leaves the stored key untouched, so the URL can
      // be corrected without re-typing a 50-character secret.
      apiKey: z.string().max(200).optional(),
    }).parse(req.body)

    const url = body.apiUrl.trim()
    if (url && !/^https:\/\/\S+$/.test(url)) {
      throw new AppError('INVALID_URL', 'The endpoint must be a https:// URL, copied from the gateway\'s API Info tab.', 400)
    }

    await prisma.setting.upsert({
      where: { key: WA_URL_KEY }, create: { key: WA_URL_KEY, value: url }, update: { value: url },
    })
    if (body.apiKey !== undefined) {
      const key = body.apiKey.trim()
      await prisma.setting.upsert({
        where: { key: WA_KEY_KEY }, create: { key: WA_KEY_KEY, value: key }, update: { value: key },
      })
    }
    invalidateWhatsappConfig()

    await audit({
      category: 'identity',
      action: 'integrations.whatsapp.update',
      entity: 'Setting',
      entityId: WA_URL_KEY,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: req.staffUser?.tenantId ?? null,
      // The endpoint is not a secret; the key never goes in the log.
      after: { apiUrl: url, apiKeyChanged: body.apiKey !== undefined },
    })
    return reply.status(200).send({ ok: true })
  })

  // Prove it end to end from the screen, rather than finding out when a
  // customer cannot sign up.
  fastify.post('/integrations/whatsapp/test', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ phone: z.string().min(7).max(20) }).parse(req.body)
    const phone = normalisePhone(body.phone)
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
  fastify.get<{ Querystring: { action?: string; entity?: string; userId?: string; limit?: string; cursor?: string } }>(
    '/audit-log',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const scope = await resolveTenantScope(req)
      const rows = await prisma.auditLog.findMany({
        where: {
          category: 'identity',
          // Same rule as the accounting trail: unattributed legacy rows are the
          // CEO's to read, nobody else's.
          ...(req.staffUser!.role === 'admin'
            ? { OR: [{ tenantId: { in: scope.tenantIds } }, { tenantId: null }] }
            : { tenantId: { in: scope.tenantIds } }),
          ...(req.query.action && { action: { startsWith: req.query.action } }),
          ...(req.query.entity && { entity: req.query.entity }),
          ...(req.query.userId && { userId: req.query.userId }),
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

  fastify.get('/users', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const q = z.object({
      role:   z.string().optional(),  // comma-separated list of UserRole values
      status: z.enum(['pending', 'active', 'suspended']).optional(),
    }).parse(req.query)

    const scope = await resolveTenantScope(req)
    const where: Record<string, unknown> = { deletedAt: null }

    // Scope to current/visible tenant(s). We also accept rows where tenantId
    // IS NULL so legacy/back-fill users don't vanish; the frontend tags them
    // with a "No company" chip so the CEO can fix them up.
    //
    // Admins (owners) see EVERY staff member across all companies — otherwise a
    // pending hire who signed up under a company the CEO isn't a formal member
    // of would be invisible, so the CEO couldn't approve them or reissue a PIN.
    if (req.staffUser!.role !== 'admin' && scope.tenantIds.length > 0) {
      where.OR = [
        { tenantId: { in: scope.tenantIds } },
        { tenantId: null },
      ]
    }

    if (q.role) {
      const roles = q.role.split(',').map((r) => r.trim()).filter(Boolean)
      if (roles.length > 0) where.role = { in: roles }
    }
    if (q.status) where.accountStatus = q.status

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
    return users.map((u) => ({
      ...u,
      hasPin: !!u.pin,
      pin: undefined,
      // Flatten memberships into a `tenants` array — primary tenant first,
      // then any TenantMember-only tenants. The frontend uses this to render
      // the multi-tenant chip group + populate the multi-select on edit.
      tenants: dedupeTenants([
        ...(u.tenantId && (u as { tenant?: TenantLite | null }).tenant ? [(u as { tenant: TenantLite }).tenant] : []),
        ...u.tenantMemberships.map((m) => m.tenant),
      ]),
      tenantMemberships: undefined,
    }))
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
    // PIN = the explicit body.pin if the CEO typed one, otherwise a CSPRNG
    // temporary PIN that the staff member MUST change on first login. Never
    // derived from the phone number — a phone's last 4 digits are effectively
    // public and made every account guessable.
    const pinPlain    = body.pin || generateRandomPin()
    const pin         = await hashPin(pinPlain)
    const pinIsTemporary = !body.pin

    // Resolve the target tenant: explicit body.tenantId wins; falls back to
    // the operator's active tenantId. Validate either way — you can only
    // create staff into a company you actually belong to.
    // ADMIN_ONLY endpoint — the admin owns the portfolio and can create staff
    // in any company. Scope checks apply only to non-admins (defensive, should
    // ADMIN_ONLY ever widen).
    const isAdmin = req.staffUser!.role === 'admin'
    const scope = await resolveTenantScope(req)
    const tenantId = body.tenantId ?? req.staffUser!.tenantId
    if (!isAdmin && tenantId && scope.tenantIds.length > 0 && !scope.tenantIds.includes(tenantId)) {
      return reply.status(403).send({ error: {
        code: 'CROSS_TENANT',
        message: 'You can only create staff inside a company you belong to.',
      }})
    }

    // Validate every extra tenant the body wants this user added to.
    const extraIds = (body.tenantIds ?? []).filter((id) => id !== tenantId)
    for (const id of extraIds) {
      if (!isAdmin && scope.tenantIds.length > 0 && !scope.tenantIds.includes(id)) {
        return reply.status(403).send({ error: {
          code: 'CROSS_TENANT',
          message: 'You can only add staff to companies you belong to.',
        }})
      }
    }

    // Email is now mandatory and must be on the company domain: it is the ONLY
    // way to sign in, so creating a staff row without one creates an account
    // nobody can ever use.
    if (!isStaffEmail(body.email)) {
      return reply.status(400).send({ error: { code: 'EMAIL_NOT_COMPANY_DOMAIN', message: STAFF_EMAIL_MESSAGE } })
    }

    const user = await prisma.user.create({
      data: {
        name: body.name?.trim() || 'Unnamed staff',
        email: normaliseStaffEmail(body.email!),
        ...(body.phone ? { phone: body.phone.trim() } : {}),
        ...(body.jobTitle ? { jobTitle: body.jobTitle.trim() } : {}),
        password,
        pin,
        // A CEO-generated temporary PIN must be changed by the staff member
        // on first login; an explicitly-typed one is treated as final.
        pinMustReset: pinIsTemporary,
        ...(tenantId ? { tenantId } : {}),
        role: body.role as never,
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
    // Creating a staff account is the first half of "who can get in"; the role
    // it is created WITH is the second. Neither was recorded anywhere before.
    await audit({
      category: 'identity',
      action: 'user.create',
      entity: 'User',
      entityId: user.id,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      tenantId: req.staffUser?.tenantId ?? null,
      after: { name: user.name, email: user.email, role: user.role, tenantId: user.tenantId },
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

      // Cross-tenant guard. This endpoint is ADMIN_ONLY and the admin owns the
      // whole portfolio, so they may edit any staff row and assign staff to ANY
      // company. The per-tenant scope checks below only apply to non-admins
      // (should ADMIN_ONLY ever widen). Previously they wrongly scoped admins
      // to their active tenant, blocking the CEO from giving a staff member
      // access to a second company (e.g. GS Foods + GSX Viva) from the
      // all-companies view — the write carries no portfolio header, so scope
      // collapsed to the single active tenant and rejected the extra company.
      const isAdmin = req.staffUser!.role === 'admin'
      const scope = await resolveTenantScope(req)
      const existing = await prisma.user.findUnique({
        where: { id: req.params.id },
        // role / isActive / email are read for the audit trail's before-state,
        // not for the tenant check — a role change is only meaningful in the
        // log if you can see what it moved FROM.
        select: { tenantId: true, role: true, isActive: true, email: true },
      })
      if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such staff' } })
      if (!isAdmin && existing.tenantId && scope.tenantIds.length > 0 && !scope.tenantIds.includes(existing.tenantId)) {
        return reply.status(403).send({ error: {
          code: 'CROSS_TENANT',
          message: 'This staff member belongs to a company you don\'t have access to.',
        }})
      }

      // Tenant transfer validation: target tenant must be one you belong to
      // (admins may transfer into any company).
      if (!isAdmin && body.tenantId && !scope.tenantIds.includes(body.tenantId)) {
        return reply.status(403).send({ error: {
          code: 'CROSS_TENANT',
          message: 'You can only transfer staff into a company you belong to.',
        }})
      }
      if (!isAdmin && body.tenantIds) {
        for (const id of body.tenantIds) {
          if (!scope.tenantIds.includes(id)) {
            return reply.status(403).send({ error: {
              code: 'CROSS_TENANT',
              message: 'One or more selected companies aren\'t accessible to you.',
            }})
          }
        }
      }

      // Resolve final primary tenantId — explicit tenantId wins; otherwise
      // first entry of tenantIds; otherwise leave existing value alone.
      const finalPrimary = body.tenantId ?? body.tenantIds?.[0]

      const data: Record<string, unknown> = {}
      if (body.name     != null) data.name      = body.name
      if (body.phone    != null) data.phone     = body.phone || null
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
      if (body.isActive != null) data.isActive  = body.isActive
      if (body.jobTitle != null) data.jobTitle  = body.jobTitle || null
      if (body.pin      != null) data.pin       = body.pin ? await hashPin(body.pin) : null
      // NOTE: changing the phone number deliberately does NOT touch the PIN.
      // PINs used to be re-derived from the phone's last 4 digits here, which
      // meant editing someone's number silently reset their credential to a
      // publicly-guessable value. Staff own their own PIN now.
      if (body.pin != null && body.pin !== '') {
        if (isWeakPin(body.pin)) {
          return reply.status(400).send({
            error: { code: 'WEAK_PIN', message: 'That PIN is too easy to guess.' },
          })
        }
        data.pinMustReset       = false
        data.pinResetRequestedAt = null
      }
      if (finalPrimary)          data.tenantId  = finalPrimary
      // Override arrays — full-replacement semantics. The frontend computes
      // diffs against role defaults and posts the resulting state; if the
      // operator clears every override the arrays come through as empty,
      // which is also "back to role default."
      if (body.permissionAllow != null) data.permissionAllow = body.permissionAllow
      if (body.permissionDeny  != null) data.permissionDeny  = body.permissionDeny
      if (body.moduleAllow     != null) data.moduleAllow     = body.moduleAllow
      if (body.moduleDeny      != null) data.moduleDeny      = body.moduleDeny
      if (body.stationIds      != null) data.stationIds      = body.stationIds

      const user = await prisma.$transaction(async (tx) => {
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
      if (body.role != null && existing.role !== body.role) {
        await audit({
          category: 'identity',
          action: 'user.role_change',
          entity: 'User',
          entityId: req.params.id,
          userId: req.staffUser?.id ?? null,
          userEmail: req.staffUser?.email ?? null,
          tenantId: req.staffUser?.tenantId ?? null,
          before: { role: existing.role },
          after: { role: body.role, targetEmail: existing.email },
        })
      }
      if (body.isActive != null && existing.isActive !== body.isActive) {
        await audit({
          category: 'identity',
          action: body.isActive ? 'user.enable' : 'user.disable',
          entity: 'User',
          entityId: req.params.id,
          userId: req.staffUser?.id ?? null,
          userEmail: req.staffUser?.email ?? null,
          tenantId: req.staffUser?.tenantId ?? null,
          after: { targetEmail: existing.email },
        })
      }
      if (body.pin != null && body.pin !== '') {
        await audit({
          category: 'identity',
          action: 'user.pin_reissue',
          entity: 'User',
          entityId: req.params.id,
          userId: req.staffUser?.id ?? null,
          userEmail: req.staffUser?.email ?? null,
          tenantId: req.staffUser?.tenantId ?? null,
          after: { targetEmail: existing.email },
        })
      }
      return {
        ...user,
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

  // DELETE /auth/users/:id — soft-delete staff (admin only)
  fastify.delete<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      await prisma.user.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date(), isActive: false },
      })
      await revokeAllForSubject(req.params.id) // kill the deleted user's sessions now
      return reply.status(204).send()
    },
  )

  // POST /auth/customer/request — send a magic-link / OTP to the email or
  // phone. Used by the mobile app login flow + the storefront magic-link
  // sign-in. Always returns 200 to prevent enumeration.
  fastify.post('/customer/request', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const body = z.object({
      email: z.string().email().optional(),
      phone: z.string().min(7).max(20).optional(),
      name:  z.string().min(1).max(80).optional(),
    }).refine((v) => !!(v.email || v.phone), { message: 'Provide email or phone' })
      .parse(req.body)

    try {
      await requestMagicLink((body.email ?? body.phone)!, body.name)
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
