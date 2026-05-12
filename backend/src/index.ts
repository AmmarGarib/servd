import 'dotenv/config'

// Keep the process alive even if Redis/BullMQ throws an unhandled rejection
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err instanceof Error ? err.message : err)
})

import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

import { initWebSocket } from './lib/ws.js'
import { prisma } from './lib/prisma.js'
import { redis } from './lib/redis.js'
import { AppError, errorResponse } from './lib/errors.js'
import { ZodError } from 'zod'
import { startCartReleaseWorker } from './lib/reservation.js'
import { startOrderIngestionWorker } from './workers/orderIngestion.js'
import { startCoursePacingWorker } from './workers/coursePacing.js'
import { startLoyaltyTriggerWorker } from './workers/loyaltyTriggers.js'
import { startLoyaltyExpirationWorker } from './workers/loyaltyExpiration.js'
import { startReservationReminderWorker } from './workers/reservationReminders.js'
import { startDailyDigestWorker } from './workers/dailyDigest.js'
import { startReviewPromptWorker } from './workers/reviewPrompt.js'
import { startFbrSubmissionWorker } from './workers/fbrSubmission.js'
import { startWebhookDeliveryWorker } from './workers/webhookDelivery.js'
import { startScheduledReportsWorker } from './workers/scheduledReports.js'
import { startShrinkageTrendWorker } from './workers/shrinkageTrend.js'
import { startRiderScoringWorker } from './workers/riderScoring.js'
import { startOrderAutoCancelWorker } from './workers/orderAutoCancel.js'
import { startPaymentRetryWorker } from './workers/paymentRetry.js'
import { startInventorySyncWorker } from './workers/inventorySync.js'
import { startRiderDispatchWorker } from './workers/riderDispatch.js'
import { analyticsRoutes } from './modules/analytics/routes.js'
import { startSegmentComputationWorker } from './workers/segmentComputation.js'
import { calendarRoutes } from './modules/calendar/routes.js'
import { supplierChatRoutes } from './modules/procurement/chat.js'
import { startSocialPublishWorker } from './workers/socialPublish.js'
import { getOAuthUrl, exchangeCodeForTokens } from './lib/meta-social.js'
import { requireAuth, MANAGERS } from './modules/auth/middleware.js'

// Modules
import { authRoutes } from './modules/auth/routes.js'
import { conceptRoutes } from './modules/concepts/routes.js'
import { stationRoutes } from './modules/stations/routes.js'
import { orderRoutes, orderItemRoutes, orderCourseRoutes } from './modules/orders/routes.js'
import { menuRoutes } from './modules/menu/routes.js'
import { posRoutes } from './modules/pos/routes.js'
import { inventoryRoutes } from './modules/inventory/routes.js'
import { tableRoutes } from './modules/tables/routes.js'
import { reportRoutes } from './modules/reports/routes.js'
import { accountingRoutes } from './modules/accounting/routes.js'
import { crmRoutes } from './modules/crm/routes.js'
import { loyaltyRoutes } from './modules/loyalty/routes.js'
import { storefrontRoutes } from './modules/storefront/routes.js'
import { webhookRoutes, webhookManagementRoutes } from './modules/webhooks/routes.js'
import { financeRoutes } from './modules/finance/routes.js'
import { reviewRoutes } from './modules/reviews/routes.js'
import { complaintRoutes } from './modules/complaints/routes.js'
import { feedbackRoutes } from './modules/feedback/routes.js'
import { stockTransferRoutes } from './modules/stockTransfers/routes.js'
import { riderRoutes } from './modules/riders/routes.js'
import { promoRoutes } from './modules/promos/routes.js'
import { walletRoutes } from './modules/wallet/routes.js'
import { discountRoutes } from './modules/discounts/routes.js'
import { qrCodeRoutes } from './modules/qrcodes/routes.js'
import { recipeRoutes } from './modules/recipes/routes.js'
import { procurementRoutes } from './modules/procurement/routes.js'
import { reconciliationRoutes } from './modules/reconciliation/routes.js'
import { payrollRoutes } from './modules/payroll/routes.js'
import { allocationRoutes } from './modules/allocations/routes.js'
import { invoiceRoutes } from './modules/invoices/routes.js'
import { floorRoutes } from './modules/floors/routes.js'
import { reservationRoutes } from './modules/reservations/routes.js'
import { giftCardRoutes } from './modules/giftCards/routes.js'
import { dispatchRoutes } from './modules/dispatch/routes.js'
import { checkSplitRoutes } from './modules/checkSplit/routes.js'
import { tipPoolRoutes } from './modules/tipPools/routes.js'
import { groupOrderRoutes } from './modules/groupOrders/routes.js'
import { siteLayoutRoutes } from './modules/siteLayouts/routes.js'
import { schedulingRoutes } from './modules/scheduling/routes.js'
import { mediaRoutes } from './modules/media/routes.js'
// B07: apiTokens module removed — no third-party integrations need this in v1.
// If you re-introduce partner API access later, prefer a scoped OAuth2 flow
// over long-lived bearer tokens.
import { permissionRoutes } from './modules/permissions/routes.js'
import { seedPermissions } from './lib/permissions.js'
import { locationRoutes } from './modules/locations/routes.js'
import { paymentGatewayRoutes } from './modules/paymentGateways/routes.js'
import { marketingActivityRoutes } from './modules/marketingActivity/routes.js'
import { opsReportRoutes } from './modules/opsReports/routes.js'
import { tenantRoutes } from './modules/tenants/routes.js'
import { domainRoutes } from './modules/domains/routes.js'
import { financePlanningRoutes } from './modules/financePlanning/routes.js'
import { componentRoutes } from './modules/components/routes.js'
import { setupRoutes } from './modules/setup/routes.js'
import { crosschecksRoutes } from './modules/crosschecks/routes.js'
import { trustopsRoutes } from './modules/trustops/routes.js'
import { opexRoutes } from './modules/opex/routes.js'
import { notificationRoutes } from './modules/notifications/routes.js'
import { kdsRoutes } from './modules/kds/routes.js'
import { kitchenStaffRoutes } from './modules/kitchen-staff/routes.js'
import { expoRoutes } from './modules/expo/routes.js'
import { parSheetRoutes } from './modules/par-sheet/routes.js'

const PORT = parseInt(process.env['PORT'] ?? '3001', 10)
const HOST = '0.0.0.0'

async function build() {
  const fastify = Fastify({
    logger: {
      level: process.env['NODE_ENV'] === 'production' ? 'warn' : 'info',
      transport:
        process.env['NODE_ENV'] !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
      // PII redaction — applied to BOTH structured fields and request/response
      // shapes. Anything that ever sees customer email/phone/address, payment
      // tokens, or auth secrets must land at one of these paths.
      redact: {
        paths: [
          // Auth + secrets
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.headers["x-keenu-signature"]',
          'req.headers["x-foodpanda-signature"]',
          'res.headers["set-cookie"]',
          '*.password', '*.pin', '*.token', '*.refreshToken', '*.accessToken',
          '*.jwt', '*.apiKey', '*.secret', '*.webhookSecret',
          // Customer PII
          '*.email', '*.phone', '*.address',
          'req.body.email', 'req.body.phone', 'req.body.password', 'req.body.pin',
          // Payment fields (transaction IDs are OK; PANs/CVVs would be in raw payloads)
          '*.cardNumber', '*.cvv', '*.cvc', '*.cardHolderName',
          'payload.card', 'payload.account_number', 'payload.cnic',
          // Webhook raw bodies — they often carry the full customer record
          '*.raw',
        ],
        censor: '[REDACTED]',
        remove: false,
      },
      serializers: {
        // Default serializer leaks request/response headers; override to keep
        // method+url+status only. Detailed bodies are captured separately when
        // needed.
        req(req: { method: string; url: string; remoteAddress?: string }) {
          return { method: req.method, url: req.url, ip: req.remoteAddress }
        },
        res(res: { statusCode: number }) {
          return { statusCode: res.statusCode }
        },
      },
    },
    trustProxy: true,
  })

  // ─── Plugins ───────────────────────────────────────────────────────────────

  await fastify.register(helmet, { contentSecurityPolicy: false })

  // CORS allowlist lives in lib/corsAllowlist.ts — handles the canonical
  // servd hosts AND each brand's custom domain (eatstax.com, bukharirice.com,
  // etc.) AND the *.localhost / *.servd.{app,pk} wildcard patterns. New brand
  // domains: edit BRAND_HOSTS env (comma-separated), no code change needed.
  const { isAllowedOrigin, describeAllowlist } = await import('./lib/corsAllowlist.js')
  fastify.log.info(describeAllowlist())
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true)
      fastify.log.warn({ origin }, 'CORS rejected origin')
      cb(null, false)
    },
    credentials: true,
    maxAge: 3600,
  })

  // Global default rate limit. Hot routes override via { config: { rateLimit } }.
  // Authenticated requests get a higher allowance keyed on user ID; anon falls
  // back to IP. This keeps a single staff iPad from sharing a quota with the
  // whole café Wi-Fi.
  await fastify.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const staffId = req.staffUser?.id
      const customerId = req.customer?.id
      if (staffId) return `staff:${staffId}`
      if (customerId) return `customer:${customerId}`
      return `ip:${req.ip}`
    },
  })

  // Swagger is for developer reconnaissance — never expose it in prod.
  if (process.env['NODE_ENV'] !== 'production') {
    await fastify.register(swagger, {
      openapi: {
        info: { title: 'servd API', version: '1.0.0', description: 'Hospitality Operations Platform' },
        servers: [{ url: '/api/v1' }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
    })
    await fastify.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list' },
    })
  }

  // ─── Error handler ─────────────────────────────────────────────────────────

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorResponse(err))
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.issues },
      })
    }
    // Fastify validation errors
    if (err.validation) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.validation },
      })
    }
    fastify.log.error(err)
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
  })

  // ─── Routes ────────────────────────────────────────────────────────────────

  await fastify.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' })
      await api.register(conceptRoutes, { prefix: '/concepts' })
      await api.register(stationRoutes, { prefix: '/stations' })
      await api.register(orderRoutes,      { prefix: '/orders' })
      await api.register(orderItemRoutes,  { prefix: '/order-items' })
      await api.register(orderCourseRoutes, { prefix: '/orders' })
      await api.register(menuRoutes, { prefix: '/menu' })
      await api.register(posRoutes, { prefix: '/pos' })
      await api.register(inventoryRoutes, { prefix: '/inventory' })
      await api.register(tableRoutes, { prefix: '/tables' })
      await api.register(reportRoutes, { prefix: '/reports' })
      await api.register(accountingRoutes, { prefix: '/accounting' })
      await api.register(financeRoutes, { prefix: '/finance' })
      await api.register(crmRoutes, { prefix: '/crm' })
      await api.register(loyaltyRoutes, { prefix: '/loyalty' })
      await api.register(storefrontRoutes, { prefix: '/storefront' })
      await api.register(reviewRoutes, { prefix: '/reviews' })
      await api.register(complaintRoutes, { prefix: '/complaints' })
      await api.register(feedbackRoutes, { prefix: '/feedback' })
      await api.register(stockTransferRoutes, { prefix: '/stock-transfers' })
      await api.register(riderRoutes, { prefix: '/riders' })
      await api.register(promoRoutes, { prefix: '/promos' })
      await api.register(walletRoutes, { prefix: '/wallet' })
      await api.register(discountRoutes, { prefix: '/discounts' })
      await api.register(qrCodeRoutes, { prefix: '/qrcodes' })
      await api.register(recipeRoutes, { prefix: '/recipes' })
      await api.register(procurementRoutes, { prefix: '/procurement' })
      await api.register(reconciliationRoutes, { prefix: '/reconciliation' })
      await api.register(payrollRoutes, { prefix: '/payroll' })
      await api.register(allocationRoutes, { prefix: '/allocations' })
      await api.register(invoiceRoutes, { prefix: '/invoices' })
      await api.register(floorRoutes,        { prefix: '/floors' })
      await api.register(reservationRoutes,  { prefix: '/reservations' })
      await api.register(giftCardRoutes,     { prefix: '/gift-cards' })
      await api.register(dispatchRoutes,     { prefix: '/dispatch' })
      await api.register(checkSplitRoutes,   { prefix: '/check-split' })
      await api.register(tipPoolRoutes,      { prefix: '/tip-pools' })
      await api.register(groupOrderRoutes,   { prefix: '/group-orders' })
      await api.register(siteLayoutRoutes,   { prefix: '/site-layouts' })
      await api.register(schedulingRoutes,   { prefix: '/scheduling' })
      await api.register(analyticsRoutes,    { prefix: '/analytics' })
      await api.register(calendarRoutes,     { prefix: '/calendar' })
      await api.register(mediaRoutes,        { prefix: '/media' })
      // B07: apiTokens removed — see import-block note above.
      await api.register(permissionRoutes,   { prefix: '/permissions' })
      await api.register(locationRoutes,     { prefix: '/locations' })
      await api.register(paymentGatewayRoutes, { prefix: '/payment-gateways' })
      await api.register(marketingActivityRoutes, { prefix: '/marketing' })
      await api.register(opsReportRoutes,         { prefix: '/ops' })
      await api.register(tenantRoutes,            { prefix: '/tenants' })
      await api.register(domainRoutes,            { prefix: '/domains' })
      await api.register(financePlanningRoutes,   { prefix: '/finance' })
      await api.register(componentRoutes,         { prefix: '/components' })
      await api.register(setupRoutes,             { prefix: '/setup' })
      await api.register(crosschecksRoutes,       { prefix: '/crosschecks' })
      await api.register(trustopsRoutes,          { prefix: '/trustops' })
      await api.register(opexRoutes,              { prefix: '/opex' })
      await api.register(supplierChatRoutes,      { prefix: '/procurement' })
      await api.register(notificationRoutes,      { prefix: '/notifications' })
      await api.register(kdsRoutes,               { prefix: '/kds' })
      await api.register(kitchenStaffRoutes,      { prefix: '/kitchen-staff' })
      await api.register(expoRoutes,              { prefix: '/expo' })
      await api.register(parSheetRoutes,          { prefix: '/par-sheet' })

      // Meta OAuth: GET /api/v1/integrations/social/connect → redirect
      //             GET /api/v1/integrations/social/callback → exchange code + store tokens
      api.get('/integrations/social/connect', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
        const redirectUri = `${process.env['API_URL'] ?? 'http://localhost:3001'}/api/v1/integrations/social/callback`
        const url = await getOAuthUrl(redirectUri)
        return reply.redirect(url)
      })
      api.get<{ Querystring: { code?: string; error?: string } }>(
        '/integrations/social/callback',
        async (req, reply) => {
          if (req.query.error) return reply.redirect(`${process.env['WEB_URL'] ?? 'http://localhost:3000'}/settings?social_error=${req.query.error}`)
          if (!req.query.code) return reply.redirect(`${process.env['WEB_URL'] ?? 'http://localhost:3000'}/settings?social_error=no_code`)
          try {
            const redirectUri = `${process.env['API_URL'] ?? 'http://localhost:3001'}/api/v1/integrations/social/callback`
            const result = await exchangeCodeForTokens(req.query.code, redirectUri)
            return reply.redirect(`${process.env['WEB_URL'] ?? 'http://localhost:3000'}/settings?social_connected=${result.pageName}`)
          } catch (err) {
            return reply.redirect(`${process.env['WEB_URL'] ?? 'http://localhost:3000'}/settings?social_error=${encodeURIComponent((err as Error).message)}`)
          }
        },
      )
      await api.register(webhookRoutes,           { prefix: '/webhooks' })
      await api.register(webhookManagementRoutes, { prefix: '/webhooks' })
    },
    { prefix: '/api/v1' },
  )

  // ─── Health check ──────────────────────────────────────────────────────────

  fastify.get('/health', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'error' | 'warn'> = {}
    const details: Record<string, string> = {}

    try {
      await prisma.$queryRaw`SELECT 1`
      checks.db = 'ok'
    } catch (err) {
      checks.db = 'error'
      details.db = (err as Error).message
    }

    try {
      await redis.ping()
      checks.redis = 'ok'
    } catch (err) {
      checks.redis = 'error'
      details.redis = (err as Error).message
    }

    // Ledger readiness — every account code the posting engine references must
    // exist. If someone runs the API without seeding the CoA, postings will
    // fail at runtime; surfacing that here lets ALB pull the task before
    // customers feel it.
    const REQUIRED_CODES = [
      '1010','1015','1020','1030','1110','1120','1210','1320',
      '2010','2020','2030','2050','2060','2095',
      '4001','4090','4100',
      '5010',
      '6030','6090',
      '7010','7020','7040',
      '8010',
    ]
    try {
      const found = await prisma.account.findMany({
        where: { code: { in: REQUIRED_CODES }, isActive: true },
        select: { code: true },
      })
      const missing = REQUIRED_CODES.filter((c) => !found.some((f) => f.code === c))
      if (missing.length === 0) {
        checks.ledger = 'ok'
      } else if (missing.length <= 3) {
        checks.ledger = 'warn'
        details.ledger = `missing accounts: ${missing.join(',')} — run pnpm db:seed`
      } else {
        checks.ledger = 'error'
        details.ledger = `${missing.length} required accounts missing — run pnpm db:seed`
      }
    } catch (err) {
      checks.ledger = 'error'
      details.ledger = (err as Error).message
    }

    const hasError = Object.values(checks).some((v) => v === 'error')
    const status = hasError ? 'degraded' : Object.values(checks).some((v) => v === 'warn') ? 'warn' : 'ok'
    const body = { status, checks, details, ts: new Date().toISOString() }

    return hasError ? reply.status(503).send(body) : reply.send(body)
  })

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  initWebSocket(fastify)

  // ─── Background workers ────────────────────────────────────────────────────
  // Workers connect to Redis (rate-limit-prone) and hammer Postgres on boot.
  // Default: enabled in production, disabled in dev. Force with ENABLE_WORKERS=true|false.

  const workersEnabled =
    process.env['ENABLE_WORKERS'] != null
      ? process.env['ENABLE_WORKERS'] === 'true'
      : process.env['NODE_ENV'] === 'production'

  // Seed any newly-defined permissions on startup (idempotent — won't overwrite
  // existing admin customisations). Logs the count of inserted rows.
  try {
    const { inserted } = await seedPermissions(prisma)
    if (inserted > 0) fastify.log.info(`[permissions] seeded ${inserted} new role × permission rows`)
  } catch (err) {
    fastify.log.warn(`[permissions] seed skipped: ${(err as Error).message}`)
  }

  // Tenants bootstrap: if no tenant exists, create a "main" tenant and attach
  // every existing concept + user to it. Idempotent — safe to run on every boot.
  try {
    const tenantCount = await prisma.tenant.count({ where: { deletedAt: null } })
    if (tenantCount === 0) {
      const main = await prisma.tenant.create({
        data: { slug: 'main', name: 'Main Tenant', plan: 'starter', isActive: true },
      })
      await prisma.concept.updateMany({ where: { tenantId: null }, data: { tenantId: main.id } })
      await prisma.user.updateMany({ where: { tenantId: null }, data: { tenantId: main.id } })
      fastify.log.info(`[tenants] seeded default tenant + linked existing concepts/users`)
    } else {
      // Defensive: any concept/user without a tenant gets attached to the
      // first active tenant (in case migrations created loose rows).
      const orphanConcepts = await prisma.concept.count({ where: { tenantId: null } })
      const orphanUsers    = await prisma.user.count({ where: { tenantId: null } })
      if (orphanConcepts > 0 || orphanUsers > 0) {
        const first = await prisma.tenant.findFirst({ where: { isActive: true, deletedAt: null }, orderBy: { createdAt: 'asc' } })
        if (first) {
          await prisma.concept.updateMany({ where: { tenantId: null }, data: { tenantId: first.id } })
          await prisma.user.updateMany({ where: { tenantId: null }, data: { tenantId: first.id } })
          fastify.log.info(`[tenants] linked ${orphanConcepts} orphan concepts + ${orphanUsers} orphan users to tenant "${first.slug}"`)
        }
      }
    }
  } catch (err) {
    fastify.log.warn(`[tenants] seed/backfill skipped: ${(err as Error).message}`)
  }

  // Locations bootstrap: if no locations exist yet, create a default one and
  // link every active concept to it. Existing orders stay locationId=null;
  // POS/storefront paths populate locationId on new orders going forward.
  try {
    const count = await prisma.location.count({ where: { deletedAt: null } })
    if (count === 0) {
      const concepts = await prisma.concept.findMany({ where: { deletedAt: null }, select: { id: true } })
      const loc = await prisma.location.create({
        data: { slug: 'main', name: 'Main Location', isActive: true },
      })
      if (concepts.length > 0) {
        await prisma.conceptLocation.createMany({
          data: concepts.map((c) => ({ conceptId: c.id, locationId: loc.id, isPrimary: true })),
          skipDuplicates: true,
        })
      }
      fastify.log.info(`[locations] seeded default location with ${concepts.length} concept links`)
    }
  } catch (err) {
    fastify.log.warn(`[locations] seed skipped: ${(err as Error).message}`)
  }

  if (workersEnabled) {
    startCartReleaseWorker()
    startOrderIngestionWorker()
    startLoyaltyTriggerWorker()
    startLoyaltyExpirationWorker()
    startReservationReminderWorker()
    startDailyDigestWorker()
    startReviewPromptWorker()
    startFbrSubmissionWorker()
    startSegmentComputationWorker()
    startSocialPublishWorker()
    startCoursePacingWorker()
    startWebhookDeliveryWorker()
    startScheduledReportsWorker()
    startShrinkageTrendWorker()
    startRiderScoringWorker()
    startOrderAutoCancelWorker()
    startPaymentRetryWorker()
    startInventorySyncWorker()
    startRiderDispatchWorker()
  } else {
    fastify.log.warn('Background workers disabled (set ENABLE_WORKERS=true to run them)')
  }

  return fastify
}

function validateProductionEnv() {
  if (process.env['NODE_ENV'] !== 'production') return

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'WEB_URL',
    'STOREFRONT_URL',
    // Webhooks must verify signatures in prod — empty secret is a silent bypass
    'KEENU_WEBHOOK_SECRET',
    'FOODPANDA_WEBHOOK_SECRET',
  ]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`[startup] FATAL: missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  // JWT secrets must be strong — any "change-me" default or a value shorter
  // than 32 bytes lets an attacker who has the repo forge tokens. Fail-fast
  // before serving a single request.
  const weakDefaults = [
    'servd-jwt-secret-change-before-production-2024',
    'change-me',
    'changeme',
    'secret',
    'dev-secret',
    'dev-jwt-secret',
  ]
  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const v = process.env[name] ?? ''
    if (v.length < 32 || weakDefaults.some((d) => v.toLowerCase().includes(d))) {
      console.error(`[startup] FATAL: ${name} is weak. Use a random ≥32-byte value (openssl rand -hex 32) and set it via your secrets manager.`)
      process.exit(1)
    }
  }
  if (process.env['JWT_SECRET'] === process.env['JWT_REFRESH_SECRET']) {
    console.error('[startup] FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be different values.')
    process.exit(1)
  }

  const localhostVars = ['WEB_URL', 'STOREFRONT_URL', 'DATABASE_URL', 'REDIS_URL']
  const stillLocal = localhostVars.filter((k) => process.env[k]?.includes('localhost'))
  if (stillLocal.length) {
    console.error(`[startup] FATAL: NODE_ENV=production but ${stillLocal.join(', ')} still point to localhost — set real values before deploying`)
    process.exit(1)
  }

  const weakSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET'].filter(
    (k) => (process.env[k]?.length ?? 0) < 32
  )
  if (weakSecrets.length) {
    console.error(`[startup] FATAL: ${weakSecrets.join(', ')} must be at least 32 characters — generate with: openssl rand -base64 64`)
    process.exit(1)
  }

  const knownLeakedSecrets = [
    'servd-jwt-secret-change-before-production-2024',
    'change-before-production',
    'admin123!',
  ]
  const usingLeaked = (['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const).filter((k) =>
    knownLeakedSecrets.some((bad) => process.env[k]?.includes(bad)),
  )
  if (usingLeaked.length) {
    console.error(`[startup] FATAL: ${usingLeaked.join(', ')} matches a known-leaked default value — rotate before deploying`)
    process.exit(1)
  }

  // Warn (not fatal) on optional but high-value services left empty
  const warnIfEmpty = ['TWILIO_AUTH_TOKEN', 'KEENU_API_KEY', 'SES_SMTP_USER']
  const emptyOptional = warnIfEmpty.filter((k) => !process.env[k])
  if (emptyOptional.length) {
    console.warn(`[startup] WARN: optional integrations disabled (empty env): ${emptyOptional.join(', ')}`)
  }
}

async function start() {
  validateProductionEnv()
  const fastify = await build()

  try {
    await fastify.listen({ port: PORT, host: HOST })
    fastify.log.info(`servd API listening on ${HOST}:${PORT}`)
  } catch (err) {
    fastify.log.error(err)
    await prisma.$disconnect()
    process.exit(1)
  }

  const shutdown = async () => {
    fastify.log.info('Shutting down...')
    await fastify.close()
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

void start()
