import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'                  // PIN collision check on staff signup
import { z } from 'zod'
import { staffLogin, staffPinLogin, refreshStaffToken, customerRegister, customerLogin, verifyMagicLink, requestMagicLink, hashPassword, hashPin, issueStaffSession } from './service.js'
import {
  verifyLoginChallenge,
  startEnrolment,
  completeEnrolment,
  disable as disableTwoFactor,
  maskPhone,
} from './twoFactor.js'
import { requestOtp, verifyOtp, normalisePhone } from './otp.js'
import { requireAuth, requireAuthOrPin, requireCustomerAuth, ADMIN_ONLY, MANAGERS, ALL_STAFF } from './middleware.js'
import { revokeBearer, revokeAllForSubject } from '../../lib/tokenRevocation.js'
import { setAuthCookies, setAccessCookie, clearAuthCookies, readCookie, ACCESS_COOKIE, REFRESH_COOKIE } from '../../lib/cookies.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { resolveTenantScope, tenantWhere } from '../../lib/tenantScope.js'
import { AppError } from '../../lib/errors.js'
import {
  check as checkRateLimit,
  recordFailure,
  clearFailures,
  PIN_LIMIT,
  PIN_USER_LIMIT,
  STAFF_PASSWORD_LIMIT,
  CUSTOMER_PASSWORD_LIMIT,
  MAGIC_LINK_VERIFY_LIMIT,
} from '../../lib/loginRateLimit.js'

const staffLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

const pinLoginSchema = z.object({
  pin: z.string().min(4).max(8),
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

export async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/login — staff email+password login (brute-force protected)
  fastify.post('/login', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(STAFF_PASSWORD_LIMIT, ip)

    const body = staffLoginSchema.parse(req.body)
    let result: Awaited<ReturnType<typeof staffLogin>>
    try {
      result = await staffLogin(body.email, body.password)
      await clearFailures(STAFF_PASSWORD_LIMIT, ip)
    } catch (err) {
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

  // POST /auth/pin — staff PIN login with rate limiting + geolocation + auto clock-in
  fastify.post('/pin', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(PIN_LIMIT, ip)
    // Per-person lockout — keyed by the typed name/email. Now possible because
    // staff identify themselves before the PIN (5 wrong tries → 1h lockout for
    // THAT person, independent of the per-IP limit above).
    const idKeyRaw = (req.body as { identifier?: unknown })?.identifier
    const idKey = typeof idKeyRaw === 'string' ? idKeyRaw.trim().toLowerCase() : ''
    if (idKey) await checkRateLimit(PIN_USER_LIMIT, idKey)

    const body = z.object({
      identifier: z.string().min(1).max(120).optional(), // staff name or email — entered before the PIN (clients send it; optional during rollout)
      pin: z.string().min(4).max(8),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      selfieUrl: z.string().url().optional(),         // captured at clock-in to prevent buddy-punching
    }).parse(req.body)

    let result: Awaited<ReturnType<typeof staffPinLogin>>
    try {
      result = await staffPinLogin(body.identifier, body.pin)
      await clearFailures(PIN_LIMIT, ip)
      if (idKey) await clearFailures(PIN_USER_LIMIT, idKey)
    } catch (err) {
      await recordFailure(PIN_LIMIT, ip)
      if (idKey) await recordFailure(PIN_USER_LIMIT, idKey)
      throw err
    }

    // Geofence + selfie enforcement — skip for admin / manager. New
    // OperationsConfig fields drive this; falls back to the legacy Setting
    // row if no OperationsConfig exists yet.
    let geofenceMatched: boolean | null = null
    let geofenceDistanceM: number | null = null
    if (!['admin', 'manager'].includes(result.user.role)) {
      const { getOperationsConfig } = await import('../../lib/setup-config.js')
      const ops = await getOperationsConfig(
        (await prisma.user.findUnique({ where: { id: result.user.id }, select: { tenantId: true } }))?.tenantId,
      )
      const ratioEnforced = ops?.geofenceEnforced ?? false
      const selfieRequired = ops?.selfieRequiredAtClockIn ?? false
      const radiusM = ops?.geofenceRadiusMetres ?? 150

      // Concept geofence — read the first active concept's lat/lng. Multi-
      // concept tenants will eventually need per-concept clock-in but for
      // now a single tenant lat/lng works.
      const concept = await prisma.concept.findFirst({
        where: { latitude: { not: null }, longitude: { not: null }, isActive: true, deletedAt: null },
        select: { latitude: true, longitude: true, name: true },
      })

      // Selfie required when configured
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
        // Soft mode: still record distance, just don't enforce
        geofenceDistanceM = haversineMeters(concept.latitude, concept.longitude!, body.lat, body.lng)
        geofenceMatched = geofenceDistanceM <= radiusM
      }

      // Legacy Setting row fallback (unchanged behaviour for any tenant
      // already using it). Removed once all tenants migrate to OperationsConfig.
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
    }

    // Auto clock-in record — capture selfie + geofence verdict for audit
    await prisma.clockLog.create({
      data: {
        userId: result.user.id,
        type: 'in',
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        selfieUrl: body.selfieUrl ?? null,
        geofenceMatched,
        geofenceDistanceM,
        ipAddress: req.ip,
      },
    })

    setAuthCookies(reply, result.accessToken, result.refreshToken)
    return reply.status(200).send(result)
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
  fastify.post('/logout', { preHandler: requireAuthOrPin(...ALL_STAFF) }, async (req, reply) => {
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
      // The new hire chooses their own PIN. Never derived from the phone
      // number any more — a phone's last 4 digits are effectively public, and
      // anyone who knew them could log in as that person.
      pin:     z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits'),
    }).parse(req.body)

    if (isWeakPin(body.pin)) {
      return reply.status(400).send({
        error: { code: 'WEAK_PIN', message: 'That PIN is too easy to guess — avoid repeated digits (1111), runs (1234), and your birth year.' },
      })
    }

    const email = body.email.toLowerCase()
    // Duplicate email = nicer error than a 500 from the unique constraint.
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return reply.status(409).send({
        error: { code: 'EMAIL_TAKEN', message: 'A staff account with this email already exists' },
      })
    }

    // The staff member's own PIN. The CEO never sees it — approval gates the
    // ACCOUNT, not the credential, and the account stays `pending` (unable to
    // log in) until the CEO activates it.
    const pinPlain = body.pin

    // Random unusable password hash — we don't use password login at all.
    const password = await hashPassword(randomBytes(16).toString('hex'))
    const pin      = await hashPin(pinPlain)

    const user = await prisma.user.create({
      data: {
        name: body.name.trim(),
        email,
        phone: body.phone.trim(),
        password, pin,
        role: body.role,
        accountStatus: 'pending',
        signupReason: body.reason ?? null,
        // isActive stays true; accountStatus is the real gate. We keep isActive
        // for legacy "soft disable" semantics.
      },
      select: { id: true, name: true, email: true, role: true, phone: true, accountStatus: true },
    })

    // No PIN echoed back — they chose it, they already know it. Only the
    // bcrypt hash is stored, so nobody (CEO included) can read it later.
    return reply.status(201).send({
      ...user,
      message: 'Account created with the PIN you chose. The CEO will review and activate your account — you can log in once it is approved.',
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

  // POST /auth/pin/forgot — staff raises a "forgot my PIN" escalation.
  //
  // Unauthenticated by necessity (they can't log in). Deliberately
  // enumeration-safe: always returns the same 200 whether or not the
  // identifier matches, so this can't be used to discover who works here.
  // It never touches the existing PIN — it only raises a flag the CEO sees in
  // the staff directory, and the CEO issues a temporary PIN from there.
  fastify.post('/pin/forgot', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(STAFF_PASSWORD_LIMIT, ip)

    const body = z.object({
      identifier: z.string().min(1).max(120),   // name or email
    }).parse(req.body)

    const id = body.identifier.trim().toLowerCase()
    const user = await prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: id }, { name: { equals: body.identifier.trim(), mode: 'insensitive' } }],
      },
      select: { id: true },
    })
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { pinResetRequestedAt: new Date() },
      })
    }

    return reply.status(200).send({
      message: 'If that account exists, your manager has been notified. They will give you a temporary PIN.',
    })
  })

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
    const password = await hashPassword(Math.random().toString(36) + Date.now())
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

    const user = await prisma.user.create({
      data: {
        name: body.name?.trim() || 'Unnamed staff',
        ...(body.email ? { email: body.email.toLowerCase() } : {}),
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
    return reply.status(201).send({
      ...user,
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
        select: { tenantId: true },
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
      if (body.email    != null) data.email     = body.email ? body.email.toLowerCase() : null
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
