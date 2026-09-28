// The Fastify application: plugins, routes, error handler and /health.
//
// Shared by both entry points:
//   - src/index.ts  — the long-running Docker process. Adds socket.io, the
//                     boot-time seeds (src/bootstrap.ts) and the background
//                     workers, then listens on PORT.
//   - api/index.js  — the Vercel serverless function. Builds this app once per
//                     warm instance and hands it each request. No listen, no
//                     socket.io, no workers, no seeds.
//
// Keep side effects OUT of this file: anything that must only run in the
// long-running process (timers that do real work, BullMQ workers, cron,
// one-off data backfills) belongs in index.ts or bootstrap.ts.

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { serviceClient as prisma } from './lib/prisma.js'
import { runWithRlsContext } from './lib/rlsContext.js'
import { redis, redisFast } from './lib/redis.js'
import { AppError, errorResponse } from './lib/errors.js'
import { flushRealtime } from './lib/realtime.js'
import { ZodError } from 'zod'
import { analyticsRoutes } from './modules/analytics/routes.js'
import { calendarRoutes } from './modules/calendar/routes.js'
import { supplierChatRoutes } from './modules/procurement/chat.js'
import { randomBytes } from 'crypto'
import { getOAuthUrl, exchangeCodeForTokens } from './lib/meta-social.js'
import { requireAuth, MANAGERS, OTP_LOGIN_ROLES } from './modules/auth/middleware.js'

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
import { managementRoutes } from './modules/management/routes.js'
import { trackingRoutes } from './modules/tracking/routes.js'
import { accountingRoutes } from './modules/accounting/routes.js'
import { crmRoutes } from './modules/crm/routes.js'
import { fixedAssetRoutes } from './modules/fixedAssets/routes.js'
import { receivableRoutes } from './modules/receivables/routes.js'
import { foodSafetyRoutes } from './modules/foodSafety/routes.js'
import { hrRoutes } from './modules/hr/routes.js'
import { loyaltyRoutes } from './modules/loyalty/routes.js'
import { storefrontRoutes } from './modules/storefront/routes.js'
import { webhookRoutes, webhookManagementRoutes } from './modules/webhooks/routes.js'
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
import { timeClockRoutes } from './modules/timeclock/routes.js'
import { locationRoutes } from './modules/locations/routes.js'
import { paymentGatewayRoutes } from './modules/paymentGateways/routes.js'
import { marketingActivityRoutes } from './modules/marketingActivity/routes.js'
import { opsReportRoutes } from './modules/opsReports/routes.js'
import { tenantRoutes } from './modules/tenants/routes.js'
import { domainRoutes } from './modules/domains/routes.js'
import { financePlanningRoutes } from './modules/financePlanning/routes.js'
import { projectionsRoutes } from './modules/projections/routes.js'
import { componentRoutes } from './modules/components/routes.js'
import { setupRoutes } from './modules/setup/routes.js'
import { crosschecksRoutes } from './modules/crosschecks/routes.js'
import { trustopsRoutes } from './modules/trustops/routes.js'
import { opexRoutes } from './modules/opex/routes.js'
import { notificationRoutes } from './modules/notifications/routes.js'
import { kdsRoutes } from './modules/kds/routes.js'
import { positionRoutes } from './modules/positions/routes.js'
import { expoRoutes } from './modules/expo/routes.js'
import { parSheetRoutes } from './modules/par-sheet/routes.js'
import { internalRoutes } from './modules/internal/routes.js'
import { REQUIRED_ACCOUNT_CODES } from './lib/chartOfAccounts.js'
import { isDegraded as loginLimiterDegraded } from './lib/loginRateLimit.js'
import { whatsappConfigured as isWhatsappConfigured } from './lib/whatsapp.js'
import { emailConfigured as isEmailConfigured } from './lib/mailer.js'
import { registerBrandScope } from './lib/brandScope.js'

export interface BuildAppOptions {
  /** True when running as a Vercel function (no socket.io, no listen). */
  serverless: boolean
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { serverless } = opts
  // On Vercel the platform proxy overwrites X-Forwarded-For with the real
  // client IP, so trusting the header is safe there — and necessary: with the
  // loopback-only list below every request would carry the proxy's address and
  // all clients would share one rate-limit / login-lockout bucket.
  const onVercel = Boolean(process.env['VERCEL'])
  const fastify = Fastify({
    logger: {
      level: process.env['NODE_ENV'] === 'production' ? 'warn' : 'info',
      // pino-pretty runs in a worker thread that the serverless bundler does
      // not trace; plain JSON logs are what Vercel's log viewer wants anyway.
      transport:
        !serverless && process.env['NODE_ENV'] !== 'production'
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
          'res.headers["set-cookie"]',
          '*.password', '*.pin', '*.token', '*.refreshToken', '*.accessToken',
          // pino's '*.password' matches a key named exactly `password`, so the
          // change-password bodies would otherwise land in production logs in
          // plaintext.
          '*.currentPassword', '*.newPassword',
          'req.body.currentPassword', 'req.body.newPassword',
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
    // Trust ONLY proxies we run (the Cloudflare tunnel / reverse proxy on the
    // same box). `true` trusted the whole X-Forwarded-For chain, so any client
    // could set that header and rewrite its own req.ip — which every login
    // lockout keys on. Rotating the header gave an attacker a fresh rate-limit
    // bucket per request and unlimited PIN/password guesses.
    // (Exception: on Vercel, see `onVercel` above.)
    trustProxy: onVercel ? true : ['loopback', 'linklocal', 'uniquelocal'],
  })

  // ─── Plugins ───────────────────────────────────────────────────────────────

  await fastify.register(helmet, { contentSecurityPolicy: false })

  // A serverless function may be frozen the instant its response is sent,
  // which would strand the fire-and-forget realtime broadcasts an order
  // handler queued. Drain them before the payload leaves.
  if (opts.serverless) {
    fastify.addHook('onSend', async () => { await flushRealtime() })
  }

  // RLS context bootstrap — every request runs inside an AsyncLocalStorage
  // bubble so auth middleware can stash tenant_id / customer_id once the
  // JWT clears, and the Prisma extension picks those up to scope queries.
  // Workers and webhooks don't go through this — they import `serviceClient`.
  fastify.addHook('onRequest', (_req, _reply, done) => {
    runWithRlsContext({}, () => done())
  })

  // CORS allowlist lives in lib/corsAllowlist.ts — handles the canonical
  // servd hosts AND each brand's custom domain (eatstax.com, bukharirice.com,
  // etc.) AND the *.localhost / *.servd.{app,pk} wildcard patterns. New brand
  // domains: edit BRAND_HOSTS env (comma-separated), no code change needed.
  // Global brand filter — must be registered before the routes it applies to.
  registerBrandScope(fastify)

  const { isAllowedOrigin, describeAllowlist } = await import('./lib/corsAllowlist.js')
  // Brand domains for CORS come from the Domain table; load them before the
  // allowlist is described, and refresh them on a timer.
  const { startDomainOriginRefresh } = await import('./modules/domains/hostCache.js')
  await startDomainOriginRefresh()
  fastify.log.info(describeAllowlist())
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true)
      fastify.log.warn({ origin }, 'CORS rejected origin')
      cb(null, false)
    },
    // MUST be explicit. @fastify/cors v9 defaulted to
    // 'GET,HEAD,PUT,PATCH,POST,DELETE'; v10 narrowed the default to the
    // CORS-safelisted 'GET,HEAD,POST'. Nothing here changed except the major
    // version, and every write from a browser silently stopped: the preflight
    // still answered 204, so the API looked healthy while Chrome refused to
    // send the PUT and the admin reported "Backend unreachable". Never rely on
    // this default — the whole admin is PUT/PATCH/DELETE.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Readable by the admin so it can say when the brand filter did NOT apply.
    exposedHeaders: ['x-servd-brand-applied'],
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

  // Fastify 5 types the caught error as `unknown` rather than FastifyError,
  // because a thrown value need not be an Error at all. Narrow before reading
  // anything off it.
  fastify.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorResponse(err))
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.issues },
      })
    }
    // Fastify validation errors
    const validation = (err as FastifyError | undefined)?.validation
    if (validation) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: validation },
      })
    }
    // Errors raised by Fastify itself and by its plugins carry a real status
    // code and a safe, client-facing message: rate limiting (429), payload too
    // large (413), unsupported media type (415), bad JSON (400). Reporting them
    // as 500 "Internal server error" told a guest who had simply booked too
    // fast that the restaurant's system was broken, and left the client no
    // status to branch on. Only 4xx is passed through — a 5xx from a plugin is
    // still ours to own and still gets the generic message.
    const e = err as FastifyError | undefined
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 0
    if (status >= 400 && status < 500) {
      fastify.log.warn({ err, code: e?.code, statusCode: status }, 'request rejected')
      return reply.status(status).send({
        error: { code: e?.code ?? 'BAD_REQUEST', message: e?.message ?? 'Request rejected' },
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
      await api.register(managementRoutes, { prefix: '/management' })
      await api.register(accountingRoutes, { prefix: '/accounting' })
      // Base layers (2026-09-23). Under /accounting so the accounting module
      // permission gates them like the rest of the books.
      await api.register(fixedAssetRoutes, { prefix: '/accounting/fixed-assets' })
      await api.register(receivableRoutes, { prefix: '/accounting/receivables' })
      await api.register(foodSafetyRoutes, { prefix: '/food-safety' })
      await api.register(hrRoutes, { prefix: '/hr' })
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
      await api.register(timeClockRoutes,    { prefix: '/time-clock' })
      await api.register(locationRoutes,     { prefix: '/locations' })
      await api.register(paymentGatewayRoutes, { prefix: '/payment-gateways' })
      await api.register(marketingActivityRoutes, { prefix: '/marketing' })
      await api.register(opsReportRoutes,         { prefix: '/ops' })
      await api.register(tenantRoutes,            { prefix: '/tenants' })
      await api.register(domainRoutes,            { prefix: '/domains' })
      await api.register(financePlanningRoutes,   { prefix: '/finance' })
      await api.register(projectionsRoutes,       { prefix: '/projections' })
      await api.register(componentRoutes,         { prefix: '/components' })
      await api.register(setupRoutes,             { prefix: '/setup' })
      await api.register(crosschecksRoutes,       { prefix: '/crosschecks' })
      await api.register(trustopsRoutes,          { prefix: '/trustops' })
      await api.register(opexRoutes,              { prefix: '/opex' })
      await api.register(supplierChatRoutes,      { prefix: '/procurement' })
      await api.register(notificationRoutes,      { prefix: '/notifications' })
      await api.register(kdsRoutes,               { prefix: '/kds' })
      await api.register(positionRoutes,          { prefix: '/positions' })
      await api.register(expoRoutes,              { prefix: '/expo' })
      await api.register(parSheetRoutes,          { prefix: '/par-sheet' })
      await api.register(trackingRoutes,          { prefix: '/t' }) // public: campaign click/open tracking

      // Meta OAuth.
      //   GET /api/v1/integrations/social/status    → { configured, connected, page, ig } (authed)
      //   GET /api/v1/integrations/social/connect   → returns { url } (authenticated JSON)
      //   GET /api/v1/integrations/social/callback  → exchanges code + stores tokens (public — Facebook calls it)
      //
      // The connect step is JSON-not-redirect because the browser can't
      // attach an Authorization header when navigating top-level — so the
      // frontend fetches the OAuth URL with its bearer token, then
      // window.location.hrefs the browser to Facebook directly.
      // GET /api/v1/integrations/tax/status — honest state for FBR + SRB cards.
      // Both authorities are reported in one payload so the integrations page
      // can render parallel cards without two round-trips. Per authority:
      //   - configured: env vars present?
      //   - mode: 'production' | 'sandbox' (defaults sandbox)
      //   - conceptsRegistered: how many Concepts have a POSID for that authority
      //   - invoicesSubmitted: how many Orders have an invoice number recorded
      //     (fbrInvoiceNumber / srbInvoiceNumber lives on Order, not TaxInvoice
      //     — the earlier draft of this endpoint had the wrong model)
      api.get('/integrations/tax/status', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
        const tenantFilter = req.staffUser!.tenantFilter
        const conceptScope = { tenantId: tenantFilter, deletedAt: null } as const
        const orderConcept = { concept: { tenantId: tenantFilter } } as const

        const fbrConfigured = Boolean(process.env['FBR_USERNAME'] && process.env['FBR_PASSWORD'])
        const srbConfigured = Boolean(process.env['SRB_USERNAME'] && process.env['SRB_PASSWORD'])

        const [fbrConcepts, fbrInvoices, srbConcepts, srbInvoices] = await Promise.all([
          fbrConfigured ? prisma.concept.count({ where: { ...conceptScope, fbrPosId: { not: null } } }) : 0,
          fbrConfigured ? prisma.order.count({ where: { ...orderConcept, fbrInvoiceNumber: { not: null } } }) : 0,
          srbConfigured ? prisma.concept.count({ where: { ...conceptScope, srbPosId: { not: null } } }) : 0,
          srbConfigured ? prisma.order.count({ where: { ...orderConcept, srbInvoiceNumber: { not: null } } }) : 0,
        ])

        return {
          fbr: {
            configured: fbrConfigured,
            mode:               process.env['FBR_ENV'] === 'production' ? 'production' : 'sandbox',
            conceptsRegistered: fbrConcepts,
            invoicesSubmitted:  fbrInvoices,
          },
          srb: {
            configured: srbConfigured,
            mode:               process.env['SRB_ENV'] === 'production' ? 'production' : 'sandbox',
            conceptsRegistered: srbConcepts,
            invoicesSubmitted:  srbInvoices,
          },
        }
      })

      api.get('/integrations/social/status', { preHandler: requireAuth(...MANAGERS) }, async () => {
        // env-config check is what the operator forgets first — surfacing
        // it explicitly lets the UI tell them "go fill .env" instead of
        // hiding the failure behind a generic auth screen.
        const configured = Boolean(process.env['FACEBOOK_APP_ID'] && process.env['FACEBOOK_APP_SECRET'])
        const rows = await prisma.setting.findMany({
          where: { key: { in: ['fb_page_id', 'fb_page_name', 'fb_page_token', 'ig_user_id'] } },
          select: { key: true, value: true },
        })
        const map = new Map(rows.map((r) => [r.key, r.value]))
        const pageId    = map.get('fb_page_id')    ?? null
        const pageName  = map.get('fb_page_name')  ?? null
        const pageToken = map.get('fb_page_token') ?? null
        const igUserId  = map.get('ig_user_id')    ?? null
        return {
          configured,
          connected: Boolean(pageId && pageToken),
          page: pageId ? { id: pageId, name: pageName } : null,
          ig:   igUserId ? { userId: igUserId } : null,
          redirectUri: `${process.env['API_URL'] ?? 'http://localhost:3001'}/api/v1/integrations/social/callback`,
        }
      })
      api.get('/integrations/social/connect', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
        const redirectUri = `${process.env['API_URL'] ?? 'http://localhost:3001'}/api/v1/integrations/social/callback`
        // One-time CSRF state, tied to the operator who started the flow and
        // valid for 10 minutes. The callback refuses anything else.
        const state = randomBytes(32).toString('hex')
        await redis.setex(`social:oauth:${state}`, 600, req.staffUser!.id)
        const url = await getOAuthUrl(redirectUri, state)
        return { url }
      })
      api.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
        '/integrations/social/callback',
        async (req, reply) => {
          const web = process.env['WEB_URL'] ?? 'http://localhost:3000'
          if (req.query.error) return reply.redirect(`${web}/settings?social_error=${req.query.error}`)
          if (!req.query.code) return reply.redirect(`${web}/settings?social_error=no_code`)

          // Only finish a flow this server started. The state is consumed on
          // first use, so a replayed or forged callback is rejected.
          const state = req.query.state
          if (!state) return reply.redirect(`${web}/settings?social_error=missing_state`)
          let stateOwner: string | null = null
          try {
            stateOwner = await redis.get(`social:oauth:${state}`)
            if (stateOwner) await redis.del(`social:oauth:${state}`)
          } catch {
            stateOwner = null
          }
          if (!stateOwner) return reply.redirect(`${web}/settings?social_error=invalid_state`)

          try {
            const redirectUri = `${process.env['API_URL'] ?? 'http://localhost:3001'}/api/v1/integrations/social/callback`
            const result = await exchangeCodeForTokens(req.query.code, redirectUri)
            return reply.redirect(`${process.env['WEB_URL'] ?? 'http://localhost:3000'}/settings?social_connected=${result.pageName}`)
          } catch (err) {
            return reply.redirect(`${process.env['WEB_URL'] ?? 'http://localhost:3000'}/settings?social_error=${encodeURIComponent((err as Error).message)}`)
          }
        },
      )
      // Cron/job endpoints driven by an external scheduler (serverless has no
      // long-running workers). Guarded inside the module by CRON_SECRET.
      await api.register(internalRoutes,          { prefix: '/internal' })
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

    // Serverless with no REDIS_URL: redisFast points at localhost, which does
    // not exist on Vercel. Report it as a warning rather than pinging a socket
    // that can never open.
    const redisSkipped = serverless && !process.env['REDIS_URL']
    if (redisSkipped) {
      checks.redis = 'warn'
      details.redis = 'REDIS_URL is not set — running without Redis (serverless). Rate limits and caches are per-instance.'
    } else {
      try {
        // Ping on `redisFast`, not `redis`. The shared connection carries
        // BullMQ's `maxRetriesPerRequest: null`, so a ping issued while Redis is
        // down never resolves OR rejects — it waits forever in the offline queue.
        // /health then hangs instead of reporting the outage, which is precisely
        // backwards: the endpoint goes silent at the moment its answer matters,
        // and the deploy webhook that polls it hangs with it.
        await redisFast.ping()
        checks.redis = 'ok'
      } catch (err) {
        checks.redis = 'error'
        details.redis = (err as Error).message
      }
    }

    // Login rate limiting keeps working when Redis goes away, but on weaker,
    // per-process counters. That is a real reduction in protection, so say so
    // here rather than letting it pass silently.
    // Report it when the limiter HAS fallen back, and also when Redis is down
    // and it is therefore about to — an operator reading /health during an
    // outage should not have to wait for someone to attempt a login before the
    // reduced protection shows up.
    if (loginLimiterDegraded() || checks.redis === 'error' || redisSkipped) {
      checks.loginRateLimit = 'warn'
      details.loginRateLimit =
        'Redis unreachable — running on per-process in-memory counters. Limits still apply but are not shared across instances or preserved across restarts.'
    } else {
      checks.loginRateLimit = 'ok'
    }

    // Password recovery depends on being able to reach a person out-of-band.
    // Neither rail is checked at boot beyond a console warning, so an unset
    // SMTP_USER in production has exactly one visible symptom: somebody asks
    // for a reset link, is told one is on its way, and it never arrives. Say it
    // here instead, where it can be read before that happens.
    const emailConfigured    = await isEmailConfigured()
    // Effective config, not just the environment — the gateway can now be set
    // in admin, and a health check that only looks at env would keep crying
    // outage after the CEO has fixed it.
    const whatsappConfigured = await isWhatsappConfigured()
    if (emailConfigured && whatsappConfigured) {
      checks.passwordRecovery = 'ok'
    } else if (!emailConfigured && !whatsappConfigured) {
      // Both rails down means a forgotten password has no self-service remedy
      // at all — it is back to an admin reissuing by hand.
      checks.passwordRecovery = 'error'
      details.passwordRecovery =
        'Neither email (SMTP_USER/SMTP_PASS) nor WhatsApp (WHATSAPP_API_URL/WHATSAPP_API_KEY) is configured — /auth/password/forgot cannot deliver a reset link to anyone.'
    } else {
      checks.passwordRecovery = 'warn'
      details.passwordRecovery = emailConfigured
        ? 'WhatsApp is not configured — reset links go by email only, so an account with no reachable inbox has no way back in.'
        : 'Email (SMTP_USER/SMTP_PASS) is not configured — reset links only reach accounts that have a phone number on file.'
    }

    // CUSTOMER SIGNUP. Every account on the consumer site is created by
    // verifying a phone with a WhatsApp code — there is no email path and no
    // skip. So an unset WHATSAPP_API_URL does not degrade signup, it stops it:
    // POST /auth/customer/request-otp answers 503 OTP_SEND_FAILED to every
    // visitor who tries.
    //
    // Reported on its own rather than folded into passwordRecovery. That check
    // was already red for the same reason, and because it is named after
    // password resets nobody reading it knew the storefront could not take a
    // single new customer.
    checks.customerSignup = whatsappConfigured ? 'ok' : 'error'
    if (!whatsappConfigured) {
      details.customerSignup =
        'WhatsApp (WHATSAPP_API_URL/WHATSAPP_API_KEY) is not configured. Customer signup is DOWN: the verification code cannot be sent, so nobody can create an account on the storefront.'
    }

    // Floor staff have NO password — a WhatsApp code is their whole credential.
    // So an unset WHATSAPP_API_URL is not an inconvenience for them the way it
    // is for password recovery: it is the difference between a cashier being
    // able to open a till at the start of a shift and not. Reported separately
    // from passwordRecovery, and only as an error once there is somebody it can
    // actually strand — a count, not a guess.
    try {
      const floorStaff = await prisma.user.count({
        where: { role: { in: OTP_LOGIN_ROLES }, isActive: true, deletedAt: null, accountStatus: 'active' },
      })
      if (whatsappConfigured) {
        checks.staffCodeLogin = 'ok'
      } else if (floorStaff === 0) {
        checks.staffCodeLogin = 'warn'
        details.staffCodeLogin =
          'WhatsApp is not configured, so code sign-in cannot deliver. No floor-role staff exist yet, so nobody is locked out — but the first cashier created will be.'
      } else {
        checks.staffCodeLogin = 'error'
        details.staffCodeLogin =
          `WhatsApp (WHATSAPP_API_URL/WHATSAPP_API_KEY) is not configured and ${floorStaff} floor-role staff have no other way in. They cannot sign in at all.`
      }
      // A floor account with no phone can never receive a code, whatever the
      // gateway is doing.
      const noPhone = await prisma.user.count({
        where: { role: { in: OTP_LOGIN_ROLES }, isActive: true, deletedAt: null, accountStatus: 'active', phone: null },
      })
      if (noPhone > 0) {
        checks.staffCodeLogin = 'error'
        details.staffCodeLogin =
          `${noPhone} floor-role staff have no phone number on file, so no sign-in code can reach them.`
      }
    } catch (err) {
      checks.staffCodeLogin = 'error'
      details.staffCodeLogin = 'Could not determine floor-staff sign-in readiness.'
    }


    // Ledger readiness — every account code the posting engine references must
    // exist. If someone runs the API without seeding the CoA, postings will
    // fail at runtime; surfacing that here lets ALB pull the task before
    // customers feel it.
    // Each company keeps its own chart of accounts, so the check runs per
    // company: a company missing codes cannot post ITS orders, even if every
    // other company's books are fine.
    try {
      const tenants = await prisma.tenant.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, slug: true },
      })
      const found = await prisma.account.findMany({
        where: { code: { in: REQUIRED_ACCOUNT_CODES }, isActive: true },
        select: { code: true, tenantId: true },
      })
      const byTenant = new Map<string, Set<string>>()
      for (const a of found) {
        if (!a.tenantId) continue
        const set = byTenant.get(a.tenantId) ?? new Set<string>()
        set.add(a.code)
        byTenant.set(a.tenantId, set)
      }
      const gaps = tenants
        .map((t) => ({ slug: t.slug, missing: REQUIRED_ACCOUNT_CODES.filter((c) => !byTenant.get(t.id)?.has(c)) }))
        .filter((g) => g.missing.length > 0)
      const missing = gaps.flatMap((g) => g.missing.map((c) => `${g.slug}:${c}`))
      if (missing.length === 0) {
        checks.ledger = 'ok'
      } else if (missing.length <= 3) {
        checks.ledger = 'warn'
        details.ledger = `missing accounts: ${missing.join(',')}`
      } else {
        checks.ledger = 'error'
        details.ledger = `${missing.length} required accounts missing across ${gaps.length} company(ies)`
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

  return fastify
}
