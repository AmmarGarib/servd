import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { staffLogin, staffPinLogin, refreshStaffToken, customerRegister, customerLogin, verifyMagicLink, requestMagicLink, hashPassword, hashPin } from './service.js'
import { requestOtp, verifyOtp, normalisePhone } from './otp.js'
import { requireAuth, ADMIN_ONLY, MANAGERS, ALL_STAFF } from './middleware.js'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import {
  check as checkRateLimit,
  recordFailure,
  clearFailures,
  PIN_LIMIT,
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
    return reply.status(200).send(result)
  })

  // POST /auth/pin — staff PIN login with rate limiting + geolocation + auto clock-in
  fastify.post('/pin', async (req, reply) => {
    const ip = req.ip ?? 'unknown'
    await checkRateLimit(PIN_LIMIT, ip)

    const body = z.object({
      pin: z.string().min(4).max(8),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      selfieUrl: z.string().url().optional(),         // captured at clock-in to prevent buddy-punching
    }).parse(req.body)

    let result: Awaited<ReturnType<typeof staffPinLogin>>
    try {
      result = await staffPinLogin(body.pin)
      await clearFailures(PIN_LIMIT, ip)
    } catch (err) {
      await recordFailure(PIN_LIMIT, ip)
      throw err
    }

    // Geofence + selfie enforcement — skip for admin / manager. New
    // OperationsConfig fields drive this; falls back to the legacy Setting
    // row if no OperationsConfig exists yet.
    let geofenceMatched: boolean | null = null
    let geofenceDistanceM: number | null = null
    if (!['admin', 'manager'].includes(result.user.role)) {
      const { getOperationsConfig } = await import('../../lib/setup-config.js')
      const ops = await getOperationsConfig()
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
    const body = refreshSchema.parse(req.body)
    const result = await refreshStaffToken(body.refreshToken)
    return reply.status(200).send(result)
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
      password: z.string().min(8, 'Password must be at least 8 characters'),
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

  // GET /auth/users — list staff (admin/manager only)
  fastify.get('/users', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true, pin: true },
      orderBy: { name: 'asc' },
    })
    return users.map((u) => ({ ...u, hasPin: !!u.pin, pin: undefined }))
  })

  // POST /auth/users — create staff member (admin only)
  fastify.post('/users', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      name:     z.string().min(1),
      email:    z.string().email(),
      pin:      z.string().min(4).max(8),
      role:     z.enum(['admin', 'manager', 'cashier', 'kitchen', 'expediter', 'marketing']),
    }).parse(req.body)

    // Password not used for login (PIN-only) — store a random unusable hash
    const password = await hashPassword(Math.random().toString(36) + Date.now())
    const pin      = await hashPin(body.pin)

    const user = await prisma.user.create({
      data: { name: body.name, email: body.email.toLowerCase(), password, pin, role: body.role as never },
      select: { id: true, name: true, email: true, role: true, isActive: true, pin: true },
    })
    return reply.status(201).send({ ...user, hasPin: !!user.pin, pin: undefined })
  })

  // PATCH /auth/users/:id — update staff (admin only)
  fastify.patch<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const body = z.object({
        name:     z.string().min(1).optional(),
        role:     z.enum(['admin', 'manager', 'cashier', 'kitchen', 'expediter', 'marketing']).optional(),
        pin:      z.string().min(4).max(8).optional(),
        isActive: z.boolean().optional(),
      }).parse(req.body)

      const data: Record<string, unknown> = {}
      if (body.name     != null) data.name     = body.name
      if (body.role     != null) data.role      = body.role
      if (body.isActive != null) data.isActive  = body.isActive
      if (body.pin      != null) data.pin       = await hashPin(body.pin)

      const user = await prisma.user.update({
        where: { id: req.params.id },
        data,
        select: { id: true, name: true, email: true, role: true, isActive: true, pin: true },
      })
      return { ...user, hasPin: !!user.pin, pin: undefined }
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
