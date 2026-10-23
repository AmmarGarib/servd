import 'dotenv/config'

// Keep the process alive even if Redis/BullMQ throws an unhandled rejection
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err instanceof Error ? err.message : err)
})

import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { rateLimitSubject } from './lib/rateLimitKey.js'
import { isInternalRequest } from './lib/internalRequest.js'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

import { initWebSocket } from './lib/ws.js'
import { serviceClient as prisma } from './lib/prisma.js'
import { runWithRlsContext } from './lib/rlsContext.js'
import { redis, redisFast } from './lib/redis.js'
import { redisHealthProbe, staffCodeLoginHealth } from './lib/healthProbes.js'
import { AppError, errorResponse } from './lib/errors.js'
import { ZodError } from 'zod'
import { startCartReleaseWorker } from './lib/reservation.js'
import { startCoursePacingWorker } from './workers/coursePacing.js'
import { startPreOrderReleaseWorker } from './workers/preOrderRelease.js'
import { startLoyaltyTriggerWorker } from './workers/loyaltyTriggers.js'
import { startLoyaltyExpirationWorker } from './workers/loyaltyExpiration.js'
import { startGiftCardExpiryWorker } from './workers/giftCardExpiry.js'
import { startReservationReminderWorker } from './workers/reservationReminders.js'
import { startDeliveryWatch } from './workers/deliveryWatch.js'
import { startReviewPromptWorker } from './workers/reviewPrompt.js'
// Fiscal filing goes ONLY through the POS connector (connectors/, spec §12):
// the direct FBR/SRB workers are gone. drainLegacyTaxQueues empties their old
// BullMQ queues once, before the connector workers start.
import { startFiscalConnectorWorker } from './workers/fiscalConnector.js'
import { startTerminalConnectorWorker } from './workers/terminalConnector.js'
// Raast QR (spec §6, §7.3): intent expiry / bank-SMS backstop, and the daily
// unmatched-receipt flag. Both run without Redis.
import { startRaastConnectorWorker } from './workers/raastConnector.js'
import { startRaastStatementFlagsWorker } from './workers/raastStatementFlags.js'
import { drainLegacyTaxQueues } from './connectors/legacyDrain.js'
import { connectorHealthChecks } from './connectors/health.js'
import { registerConnectorPlugins } from './modules/connectors/index.js'
import { maskSmsTokenInUrl } from './modules/connectors/webhookRoutes.js'
import { registerPreBillPlugins } from './modules/prebills/index.js'
import { registerApprovalsPlugin } from './modules/approvals/index.js'
import { registerTrashPlugin } from './modules/trash/index.js'
import { CONNECTOR_ADMINS } from './lib/connectorRoles.js'
import { startWebhookDeliveryWorker } from './workers/webhookDelivery.js'
import { startScheduledReportsWorker, carryOverDigestRecipient } from './workers/scheduledReports.js'
import { startShrinkageTrendWorker } from './workers/shrinkageTrend.js'
import { startRiderScoringWorker } from './workers/riderScoring.js'
import { startOrderAutoCancelWorker } from './workers/orderAutoCancel.js'
import { startSitePublishWorker } from './workers/sitePublish.js'
import { startPaymentRetryWorker } from './workers/paymentRetry.js'
import { startRiderDispatchWorker } from './workers/riderDispatch.js'
// Finance wave B (2026-10-14).
import { startDepreciationWorker } from './workers/depreciation.js'
import { startIntercompanyFleetWorker } from './workers/intercompanyFleet.js'
import { startCashAdvanceOverdueWorker } from './workers/cashAdvanceOverdue.js'
import { analyticsRoutes } from './modules/analytics/routes.js'
import { startSegmentComputationWorker } from './workers/segmentComputation.js'
import { calendarRoutes } from './modules/calendar/routes.js'
import { supplierChatRoutes } from './modules/procurement/chat.js'
import { startSocialPublishWorker } from './workers/socialPublish.js'
import { randomBytes } from 'crypto'
import { getOAuthUrl, exchangeCodeForTokens } from './lib/meta-social.js'
import { assertSandboxBoot, sandboxHealthFields, sandboxMetaRoutes, registerPracticeAccessGuard, sandboxScrub } from './lib/sandbox.js'
import { requireAuth, MANAGERS, OTP_LOGIN_ROLES } from './modules/auth/middleware.js'

// Modules
import { authRoutes } from './modules/auth/routes.js'
import { conceptRoutes } from './modules/concepts/routes.js'
import { stationRoutes } from './modules/stations/routes.js'
import { orderRoutes, orderItemRoutes, orderCourseRoutes } from './modules/orders/routes.js'
import { menuRoutes } from './modules/menu/routes.js'
import { posRoutes } from './modules/pos/routes.js'
import posBoxGivenRoutes from './modules/pos/boxGivenRoutes.js'
import { registerHeadOfficePlugins } from './modules/headOffices/index.js'
import { hrHeadOfficeTransferRoutes } from './modules/hr/transferRoutes.js'
import emergencyOverridesRoutes from './modules/emergencyOverrides/routes.js'
import banAppealRoutes from './modules/storefront/banAppealRoutes.js'
import { customerAccountRoutes } from './modules/receivables/customerAccounts.js'
import posOnAccountRoutes from './modules/pos/onAccountRoutes.js'
import { tillClearingRoutes } from './modules/accounting/tillClearingRoutes.js'
import { startHeadOfficeRechargeWorker } from './workers/headOfficeRecharge.js'
import { startCodCustodyWorker } from './workers/codCustody.js'
import { startNightAuditSettleWorker } from './workers/nightAuditSettle.js'
import { startShiftCorrectionSweepWorker, runShiftCorrectionSweepOnce } from './workers/shiftCorrectionSweep.js'
import { startTillClearingSweepWorker } from './workers/tillClearingSweep.js'
import { startOnAccountDailyWorker } from './workers/onAccountDaily.js'
import { startStaffNotificationsWorker } from './workers/staffNotifications.js'
import { inventoryRoutes } from './modules/inventory/routes.js'
import { tableRoutes } from './modules/tables/routes.js'
import { reportRoutes } from './modules/reports/routes.js'
import { tillReportRoutes } from './modules/reports/tillReportsRoutes.js'
import foodCostRoutes from './modules/reports/foodCostRoutes.js'
import { directorRoutes } from './modules/director/routes.js'
import { managementRoutes } from './modules/management/routes.js'
import { trackingRoutes } from './modules/tracking/routes.js'
import { accountingRoutes } from './modules/accounting/routes.js'
import { withholdingRoutes } from './modules/accounting/withholdingRoutes.js'
import { statutoryRoutes } from './modules/accounting/statutoryRoutes.js'
import { paymentsRoutes } from './modules/accounting/paymentsRoutes.js'
import { nightAuditRoutes } from './modules/nightAudit/routes.js'
import { servdFilingRoutes } from './modules/accounting/servdFilings.js'
import { posTillFlowRoutes } from './modules/pos/tillFlowRoutes.js'
import { orderSummaryRoutes } from './modules/pos/orderSummary.js'
import { shiftCorrectionRoutes } from './modules/shiftCorrections/routes.js'
import { intercompanyRoutes } from './modules/intercompany/routes.js'
import { stockDifferenceRoutes } from './modules/stockDifferences/routes.js'
import { crmRoutes } from './modules/crm/routes.js'
import { waitlistRoutes } from './modules/waitlist/routes.js'
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
import { riderAuthRoutes } from './modules/riderAuth/routes.js'
import { riderAppRoutes } from './modules/rider/routes.js'
import { promoRoutes } from './modules/promos/routes.js'
import { walletRoutes } from './modules/wallet/routes.js'
import { discountRoutes } from './modules/discounts/routes.js'
import { qrCodeRoutes } from './modules/qrcodes/routes.js'
import { recipeRoutes } from './modules/recipes/routes.js'
import { procurementRoutes } from './modules/procurement/routes.js'
import { grniRoutes } from './modules/procurement/grniRoutes.js'
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
import cron from 'node-cron'
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
import { recordFileRoutes } from './modules/recordFiles/routes.js'
import { opexRoutes } from './modules/opex/routes.js'
import { notificationRoutes } from './modules/notifications/routes.js'
import { kdsRoutes } from './modules/kds/routes.js'
import { positionRoutes } from './modules/positions/routes.js'
import { expoRoutes } from './modules/expo/routes.js'
import { parSheetRoutes } from './modules/par-sheet/routes.js'
import { CHART_OF_ACCOUNTS, ensureChartOfAccounts, retireAggregatorAccounts, REQUIRED_ACCOUNT_CODES } from './lib/chartOfAccounts.js'
import { isDegraded as loginLimiterDegraded } from './lib/loginRateLimit.js'
import { whatsappConfigured as isWhatsappConfigured, whatsappSecretHealth } from './lib/whatsapp.js'
import { emailConfigured as isEmailConfigured } from './lib/mailer.js'
import { registerBrandScope } from './lib/brandScope.js'
import { registerEmptyJsonBody } from './lib/jsonBody.js'

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
        // needed. A counter phone's bank-SMS token in the path
        // (/webhooks/pos/sms/<token>, Raast S2) is masked, never logged.
        req(req: { method: string; url: string; remoteAddress?: string }) {
          return { method: req.method, url: maskSmsTokenInUrl(req.url), ip: req.remoteAddress }
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
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  })

  // ─── Plugins ───────────────────────────────────────────────────────────────

  await fastify.register(helmet, { contentSecurityPolicy: false })

  // Nothing the API serves belongs in a search index — JSON, CSV exports,
  // the HTML receipts/invoices/tracking pages, errors. A header rather than a
  // robots.txt Disallow on purpose: Googlebot's renderer has to FETCH this
  // JSON to render the client-side storefront pages (a brand's menu,
  // /reserve/<brand>), and a Disallow would leave those pages empty for it.
  fastify.addHook('onSend', (_req, reply, payload, done) => {
    reply.header('X-Robots-Tag', 'noindex')
    done(null, payload)
  })

  // RLS context bootstrap — every request runs inside an AsyncLocalStorage
  // bubble so auth middleware can stash tenant_id / customer_id once the
  // JWT clears, and the Prisma extension picks those up to scope queries.
  // Workers and webhooks don't go through this — they import `serviceClient`.
  fastify.addHook('onRequest', (_req, _reply, done) => {
    runWithRlsContext({}, () => done())
  })

  // A JSON content type with no body (the admin's DELETEs) is a body-less
  // request, not a 400 FST_ERR_CTP_EMPTY_JSON_BODY. See lib/jsonBody.ts.
  registerEmptyJsonBody(fastify)

  // CORS allowlist lives in lib/corsAllowlist.ts — handles the canonical
  // servd hosts AND each brand's custom domain (stackd.pk, simmer.pk,
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

  // Practice copy only: every request from the internet must have come
  // through Cloudflare Access (lib/sandbox.ts). After CORS, so the refusal is
  // readable by the practice admin. Live: registers nothing.
  registerPracticeAccessGuard(fastify)

  // Global default rate limit. Hot routes override via { config: { rateLimit } }.
  // Authenticated requests get a higher allowance keyed on user ID; anon falls
  // back to IP. This keeps a single staff iPad from sharing a quota with the
  // whole café Wi-Fi.
  await fastify.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // The storefront's server-side renders (private network, no forwarding
    // headers) are not visitors; see lib/internalRequest.ts.
    allowList: (req) => isInternalRequest(req),
    // This runs at onRequest, BEFORE requireAuth sets req.staffUser — so the
    // per-person key above never applied and a whole office behind one
    // internet connection shared 200/min. A page opens with 15–20 calls, a few
    // staff navigating used it up, /auth/refresh got a 429 and the admin signed
    // everyone out (owner, 2026-10-17). The key now comes from the caller's own
    // token (Bearer, else the session / refresh cookie), signature VERIFIED —
    // an unsigned or forged token can never pick someone else's bucket.
    // Expiry is ignored for bucketing only (an expired access token still names
    // its own person on the way to /auth/refresh); auth itself is unchanged.
    keyGenerator: (req) => {
      const staffId = req.staffUser?.id
      const customerId = req.customer?.id
      if (staffId) return `staff:${staffId}`
      if (customerId) return `customer:${customerId}`
      const sub = rateLimitSubject(req)
      return sub ? `sub:${sub}` : `ip:${req.ip}`
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
      // "Box given" (the packaging rule, wave B): a dine-in plate line served
      // in a box takes its recipe's packaging. Its own plugin under /pos
      // (ungated by module; the route's role list decides).
      await api.register(posBoxGivenRoutes, { prefix: '/pos' })
      // On account (resumed 2026-10-15): a named client's QR card charges the whole bill at the till.
      await api.register(posOnAccountRoutes, { prefix: '/pos' })
      // Till flow (owner, 2026-10-20; modules/pos/TILL_FLOW.md)
      await api.register(posTillFlowRoutes, { prefix: '/pos' })
      await api.register(orderSummaryRoutes, { prefix: '/pos' })
      // Shift corrections (owner, 2026-10-21): finance's fixes on a closed drawer, the CEO approves (module accounting).
      await api.register(shiftCorrectionRoutes, { prefix: '/pos/shift-corrections' })
      // POS connector (spec §8): /connectors (config, module api_pos), /pos
      // (card machine + an order's fiscal documents), /webhooks/pos (vendor
      // events, own raw-body parser).
      await registerConnectorPlugins(api)
      // Pre-bills (§17): /pos/orders/:id/pre-bill + /pos/pre-bills/:id/html
      // (till) and /pre-bills (Finance → Voided pre bills, module-gated).
      await registerPreBillPlugins(api)
      // CEO → Approvals (owner decision D3): GET /approvals + /approvals/counts.
      // Reads each module's own queue by injecting GET requests as the caller
      // (modules/approvals/README.md); approving goes through each module's
      // existing route.
      await registerApprovalsPlugin(api)
      // The Trash bin (owner, 2026-10-15; modules/trash/README.md): open to
      // every login, each type gated by its own module + roles; only the CEO
      // empties it.
      await registerTrashPlugin(api)
      await api.register(inventoryRoutes, { prefix: '/inventory' })
      await api.register(tableRoutes, { prefix: '/tables' })
      // Reports → Food cost variance (wave B; THE food-cost report — GET
      // /recipes/food-cost is gone). Before reportRoutes; gated on module
      // food_cost (accounting may read it) in moduleAccess.ts.
      await api.register(foodCostRoutes, { prefix: '/reports/food-cost' })
      // The till's Reports (owner, 2026-10-22; reports/TILL_REPORTS.md) — same readers and '/reports' module gate as /reports/till-sales.
      await api.register(tillReportRoutes, { prefix: '/reports/till' })
      await api.register(reportRoutes, { prefix: '/reports' })
      // Director logins (owner, 2026-10-18): the read-only brand view.
      await api.register(directorRoutes, { prefix: '/director' })
      await api.register(managementRoutes, { prefix: '/management' })
      await api.register(accountingRoutes, { prefix: '/accounting' })
      // Finance wave B (2026-10-14), all under the '/accounting' module gate:
      // the company's WHT rates + register (lib/withholding.ts is the one
      // resolver), statutory payables 2042/2043/2044 (accrued vs paid + the
      // one-time reclass), inter-company pairs and the shared-fleet recharge.
      await api.register(withholdingRoutes, { prefix: '/accounting/withholding' })
      await api.register(statutoryRoutes, { prefix: '/accounting/statutory' })
      // Payments register + the internal payment classification (owner, 2026-10-20): a reporting label only.
      await api.register(paymentsRoutes, { prefix: '/accounting/payments' })
      // Night audit (owner, 2026-10-16; SALES module only): lock each sales day, close it when its money settles.
      await api.register(nightAuditRoutes, { prefix: '/accounting/night-audit' })
      await api.register(servdFilingRoutes, { prefix: '/accounting/servd-filings' })
      await api.register(intercompanyRoutes, { prefix: '/accounting/intercompany' })
      // Head office (D1/D3): /head-offices (CEO) + the recharge runs.
      await registerHeadOfficePlugins(api)
      // On-account clients and till clearing (resumed 2026-10-15).
      await api.register(customerAccountRoutes, { prefix: '/accounting/customer-accounts' })
      await api.register(tillClearingRoutes, { prefix: '/accounting/till-clearing' })
      // Finance → Stock differences (H20): waste and count differences wait
      // in 1290 with their reason until the CEO approves them into cost of
      // sales.
      await api.register(stockDifferenceRoutes, { prefix: '/accounting/stock-differences' })
      // Base layers (2026-09-23). Under /accounting so the accounting module
      // permission gates them like the rest of the books.
      await api.register(fixedAssetRoutes, { prefix: '/accounting/fixed-assets' })
      await api.register(receivableRoutes, { prefix: '/accounting/receivables' })
      await api.register(foodSafetyRoutes, { prefix: '/food-safety' })
      await api.register(hrRoutes, { prefix: '/hr' })
      // Moving staff between a head office and its companies (HO-C2, CEO only).
      await api.register(hrHeadOfficeTransferRoutes, { prefix: '/hr' })
      await api.register(crmRoutes, { prefix: '/crm' })
      await api.register(waitlistRoutes, { prefix: '/waitlist' })
      await api.register(loyaltyRoutes, { prefix: '/loyalty' })
      await api.register(storefrontRoutes, { prefix: '/storefront' })
      // A banned customer's own view of their blocks + appeals (resumed 2026-10-15).
      await api.register(banAppealRoutes, { prefix: '/storefront' })
      // Emergency overrides: send the hand-over code to the rider; food a rider brought back.
      await api.register(emergencyOverridesRoutes, { prefix: '/emergency-overrides' })
      await api.register(reviewRoutes, { prefix: '/reviews' })
      await api.register(complaintRoutes, { prefix: '/complaints' })
      await api.register(feedbackRoutes, { prefix: '/feedback' })
      await api.register(stockTransferRoutes, { prefix: '/stock-transfers' })
      await api.register(riderRoutes, { prefix: '/riders' })
      // Rider app (docs/rider-app.md): its own sign-in and its own token type —
      // a rider is not a staff User.
      await api.register(riderAuthRoutes, { prefix: '/rider-auth' })
      await api.register(riderAppRoutes, { prefix: '/rider' })
      await api.register(promoRoutes, { prefix: '/promos' })
      await api.register(walletRoutes, { prefix: '/wallet' })
      await api.register(discountRoutes, { prefix: '/discounts' })
      await api.register(qrCodeRoutes, { prefix: '/qrcodes' })
      await api.register(recipeRoutes, { prefix: '/recipes' })
      await api.register(procurementRoutes, { prefix: '/procurement' })
      // Received, not billed (GRNI 2015): open receipt lines, CEO write-offs.
      await api.register(grniRoutes, { prefix: '/procurement/grni' })
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
      // Record files (owner, 2026-10-16): the one private store for supporting documents on any record.
      await api.register(recordFileRoutes,        { prefix: '/record-files' })
      await api.register(opexRoutes,              { prefix: '/opex' })
      await api.register(supplierChatRoutes,      { prefix: '/procurement' })
      await api.register(notificationRoutes,      { prefix: '/notifications' })
      await api.register(kdsRoutes,               { prefix: '/kds' })
      await api.register(positionRoutes,          { prefix: '/positions' })
      await api.register(expoRoutes,              { prefix: '/expo' })
      await api.register(parSheetRoutes,          { prefix: '/par-sheet' })
      await api.register(trackingRoutes,          { prefix: '/t' }) // public: campaign click/open tracking
      await api.register(sandboxMetaRoutes,       { prefix: '/meta' }) // public: GET /meta/sandbox (practice copy?)

      // Meta OAuth.
      //   GET /api/v1/integrations/social/status    → { configured, connected, page, ig } (authed)
      //   GET /api/v1/integrations/social/connect   → returns { url } (authenticated JSON)
      //   GET /api/v1/integrations/social/callback  → exchanges code + stores tokens (public — Facebook calls it)
      //
      // The connect step is JSON-not-redirect because the browser can't
      // attach an Authorization header when navigating top-level — so the
      // frontend fetches the OAuth URL with its bearer token, then
      // window.location.hrefs the browser to Facebook directly.
      // (GET /integrations/tax/status is gone with direct FBR/SRB filing — the
      // POS connector page reads GET /connectors instead, spec §8.4.)

      // Status (no secrets: page/ig names + flags) is also IT's — the Dev
      // workspace's Integrations page (wave 3, UI-08). Connecting the Meta page
      // token stays with the managers.
      api.get('/integrations/social/status', { preHandler: requireAuth(...MANAGERS, ...CONNECTOR_ADMINS) }, async () => {
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
      await api.register(webhookRoutes,           { prefix: '/webhooks' })
      await api.register(webhookManagementRoutes, { prefix: '/webhooks' })
    },
    { prefix: '/api/v1' },
  )

  // ─── Health check ──────────────────────────────────────────────────────────

  fastify.get('/health', async (_req, reply) => {
    // 'off' = a feature nobody has switched on yet (POS connector); it neither
    // warns nor degrades.
    const checks: Record<string, 'ok' | 'error' | 'warn' | 'off'> = {}
    const details: Record<string, string> = {}

    try {
      await prisma.$queryRaw`SELECT 1`
      checks.db = 'ok'
    } catch (err) {
      checks.db = 'error'
      details.db = (err as Error).message
    }

    try {
      // Ping on `redisFast`, not `redis`. The shared connection carries
      // BullMQ's `maxRetriesPerRequest: null`, so a ping issued while Redis is
      // down never resolves OR rejects — it waits forever in the offline queue.
      // /health then hangs instead of reporting the outage, which is precisely
      // backwards: the endpoint goes silent at the moment its answer matters,
      // and the deploy webhook that polls it hangs with it.
      //
      // And not a bare PING (ONL-R2-08): with an out-of-range DB index in
      // REDIS_URL the connect-time SELECT fails, the socket stays on db 0 and
      // PING / GET still answer — while BullMQ's connections, which re-SELECT,
      // fail every command. So re-issue the SELECT this connection was
      // configured with (a no-op when it is valid) and read a sentinel key, all
      // under a short timeout so a wedged server reports instead of hanging.
      await redisHealthProbe(redisFast)
      checks.redis = 'ok'
    } catch (err) {
      checks.redis = 'error'
      details.redis = (err as Error).message
    }

    // Login rate limiting keeps working when Redis goes away, but on weaker,
    // per-process counters. That is a real reduction in protection, so say so
    // here rather than letting it pass silently.
    // Report it when the limiter HAS fallen back, and also when Redis is down
    // and it is therefore about to — an operator reading /health during an
    // outage should not have to wait for someone to attempt a login before the
    // reduced protection shows up.
    if (loginLimiterDegraded() || checks.redis === 'error') {
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

    // Floor staff have NO password — a code is their whole credential. Without
    // WhatsApp the code cannot be SENT, but a manager can hand one over in
    // person (POST /auth/staff/:id/sign-in-code), so that is 'warn' naming the
    // way in, not an outage (PPL-R2-05). A floor login with no phone is
    // 'error': both paths key the code on the phone. lib/healthProbes.ts.
    try {
      const floorWhere = { role: { in: OTP_LOGIN_ROLES }, isActive: true, deletedAt: null, accountStatus: 'active' as const }
      const [floorStaff, floorStaffWithoutPhone] = await Promise.all([
        prisma.user.count({ where: floorWhere }),
        prisma.user.count({ where: { ...floorWhere, phone: null } }),
      ])
      const s = staffCodeLoginHealth({ whatsappConfigured, floorStaff, floorStaffWithoutPhone })
      checks.staffCodeLogin = s.check
      if (s.detail) details.staffCodeLogin = s.detail
    } catch (err) {
      checks.staffCodeLogin = 'error'
      details.staffCodeLogin = 'Could not determine floor-staff sign-in readiness.'
    }

    // WhatsApp key at rest (lib/secretBox): warn when it is plaintext because
    // SERVD_SECRET_KEY is missing, or encrypted but unreadable here.
    try {
      const wa = await whatsappSecretHealth()
      if (wa.check !== 'off') { checks.whatsappKeyAtRest = wa.check; details.whatsappKeyAtRest = wa.detail }
    } catch {
      checks.whatsappKeyAtRest = 'warn'
      details.whatsappKeyAtRest = 'Could not check how the WhatsApp gateway key is stored.'
    }

    // SMTP password at rest (lib/mailer, ops round 5) — the same levels and
    // wording as the WhatsApp key: warn when plain text (no SERVD_SECRET_KEY;
    // saving email settings is never blocked by that) or encrypted but
    // unreadable here; off when none is stored in the database.
    try {
      const { smtpSecretHealth } = await import('./lib/mailer.js')
      const smtp = await smtpSecretHealth()
      if (smtp.check !== 'off') { checks.smtpPassAtRest = smtp.check; details.smtpPassAtRest = smtp.detail }
    } catch {
      checks.smtpPassAtRest = 'warn'
      details.smtpPassAtRest = 'Could not check how the SMTP password is stored.'
    }

    // POS connector (spec §8.4): fiscal POS, card machine, the secret key for
    // stored connector secrets. ok / warn / off — never an error: a fiscal POS
    // or card machine being down must not mark the API unhealthy (sales keep
    // working; filing catches up).
    try {
      const conn = await connectorHealthChecks()
      Object.assign(checks, conn.checks)
      Object.assign(details, conn.details)
    } catch (err) {
      checks.fiscalConnector = 'warn'
      details.fiscalConnector = `POS connector check failed: ${(err as Error).message}`
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

    // ── Finance wave B (2026-10-14): the books' tie-outs and one-time steps.
    // Each is 'ok' or 'warn', never 'error' — a register that does not tie to
    // the ledger needs finance's attention, it does not make the API
    // unhealthy — and a check that cannot run says 'warn' with the reason.
    // They run side by side; each reads every company it applies to.
    // /health is PUBLIC (no auth: api.servd.pk/health): its details carry a
    // COUNT and where to look — never an amount, a company name, a company
    // slug or an item name. The figures live behind the finance pages each
    // detail names (petty-cash tie-out, card payouts, statutory payments, the
    // fixed-asset register, the FIFO cut-over).
    {
      const warnOf = (key: string, err: unknown) => { checks[key] = 'warn'; details[key] = `Could not run: ${(err as Error).message}` }
      let companies: Array<{ id: string; slug: string; isActive: boolean }> = []
      try {
        companies = await prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true, slug: true, isActive: true }, orderBy: { createdAt: 'asc' } })
      } catch (err) {
        for (const k of ['fixedAssets', 'pettyCash', 'fifoCutover', 'chartTemplateTypes', 'statutoryReclass', 'cardPayouts', 'unregisteredProvince']) warnOf(k, err)
      }
      const active = companies.filter((t) => t.isActive)
      if (companies.length > 0) {
        await Promise.all([
          // Fixed-asset register vs ledger (per class, cost and accumulated)
          // and the automatic depreciation worker's last run per company.
          (async () => {
            try {
              const { fixedAssetTieOut } = await import('./modules/fixedAssets/reports.js')
              const off = (await fixedAssetTieOut(prisma, companies.map((t) => t.id))).filter((r) => !r.ok)
              const runs = await Promise.all(companies.map((t) => prisma.fixedAssetRun.findFirst({
                where: { tenantId: t.id, kind: 'depreciation' }, orderBy: { startedAt: 'desc' },
                select: { tenantId: true, startedAt: true, failedCount: true },
              })))
              const failed = runs.filter((r) => r && r.failedCount > 0)
              const stale = runs.filter((r) => r && Date.now() - r.startedAt.getTime() > 36 * 3_600_000)
              checks.fixedAssets = off.length || failed.length || stale.length ? 'warn' : 'ok'
              if (checks.fixedAssets === 'warn') {
                const companiesOff = new Set(off.map((r) => r.tenantId)).size
                details.fixedAssets = `register≠ledger: ${companiesOff} company(ies); last depreciation run failed: ${failed.length} company(ies); `
                  + `no depreciation run in 36h: ${stale.length} company(ies) — Accounting → Fixed assets`
              }
            } catch (err) { warnOf('fixedAssets', err) }
          })(),
          // Petty cash: box floats vs 1011, open legacy advances vs 1355,
          // movements not yet on the books.
          (async () => {
            try {
              const { pettyCashTieOut } = await import('./modules/accounting/pettyCashPosting.js')
              const off = (await pettyCashTieOut(companies.map((t) => t.id))).filter((r) => !r.ok)
              checks.pettyCash = off.length ? 'warn' : 'ok'
              if (off.length) {
                details.pettyCash = `${new Set(off.map((r) => r.tenantId)).size} company(ies) where the petty-cash boxes or advances do not tie to 1011 / 1355 — Accounting → Petty cash tie-out`
              }
            } catch (err) { warnOf('pettyCash', err) }
          })(),
          // FIFO: every active company cut over to lots (boot runs it), and no
          // company-less item still holding stock (it never gets lots).
          (async () => {
            try {
              const { readFifoCutoverAt } = await import('./lib/stockLedger.js')
              const { companyLessStockItems } = await import('./modules/inventory/fifoCutover.js')
              const notCut: string[] = []
              for (const t of active) if (!(await readFifoCutoverAt(prisma, t.id))) notCut.push(t.slug)
              const loose = await companyLessStockItems()
              checks.fifoCutover = notCut.length || loose.length ? 'warn' : 'ok'
              if (checks.fifoCutover === 'warn') {
                details.fifoCutover = [
                  notCut.length ? `${notCut.length} company(ies) not cut over to FIFO lots` : '',
                  loose.length ? `${loose.length} item(s) with stock and no company (no lots until assigned) — Inventory` : '',
                ].filter(Boolean).join('; ')
              }
            } catch (err) { warnOf('fifoCutover', err) }
          })(),
          // A template code whose existing row has another type: the posting
          // families that need it refuse (assertTemplateAccounts) until the
          // operator's account is renamed.
          (async () => {
            try {
              const typeOf = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a.type]))
              const rows = await prisma.account.findMany({
                where: { tenantId: { in: companies.map((t) => t.id) }, code: { in: [...typeOf.keys()] } },
                select: { tenantId: true, code: true, type: true },
              })
              const bad = rows.filter((r) => r.type !== typeOf.get(r.code))
              checks.chartTemplateTypes = bad.length ? 'warn' : 'ok'
              if (bad.length) {
                details.chartTemplateTypes = `${bad.length} account(s) whose type is not what servd expects (codes ${[...new Set(bad.map((r) => r.code))].join(', ')}) — Configuration → Chart of accounts`
              }
            } catch (err) { warnOf('chartTemplateTypes', err) }
          })(),
          // Brands still set to a province whose tax authority the company is
          // not registered with (PRA / KPRA / BRA removed 2026-10-15): their
          // sales cannot post until the province is changed.
          (async () => {
            try {
              const n = await prisma.concept.count({
                where: { tenantId: { in: companies.map((t) => t.id) }, deletedAt: null, province: { in: ['PB', 'KP', 'BL'] } },
              })
              checks.unregisteredProvince = n ? 'warn' : 'ok'
              if (n) details.unregisteredProvince = `${n} brand(s) set to Punjab, KP or Balochistan (not registered there) — CEO → Brands, change the province`
            } catch (err) { warnOf('unregisteredProvince', err) }
          })(),
          // Statutory payables (H7): HR's EOBI / SESSI / salary tax still on
          // 2090 / 2040 until the one-time reclass to 2042/2043/2044 is posted.
          (async () => {
            try {
              const { reclassPreview } = await import('./modules/accounting/statutory.js')
              let pending = 0
              for (const t of active) {
                const p = await reclassPreview(prisma, t.id)
                const cents = p.suggested.eobiCents + p.suggested.sessiCents + p.suggested.salaryTaxCents
                if (!p.done && cents > 0) pending++
              }
              checks.statutoryReclass = pending ? 'warn' : 'ok'
              if (pending) details.statutoryReclass = `${pending} company(ies) with the statutory reclass not posted — Accounting → Statutory payments`
            } catch (err) { warnOf('statutoryReclass', err) }
          })(),
          // Card payouts (H12): card days past the payout lag with no Keenu
          // payout matched (only where matching is switched on).
          (async () => {
            try {
              const { unsettledCardDaysThrough } = await import('./modules/reconciliation/cardPayouts.js')
              let late = 0
              for (const t of active) {
                const r = await unsettledCardDaysThrough(prisma, t.id, new Date())
                if (r.count) late++
              }
              checks.cardPayouts = late ? 'warn' : 'ok'
              if (late) details.cardPayouts = `${late} company(ies) with card days past the payout lag and no bank payout — Reconciliation → Card payouts`
            } catch (err) { warnOf('cardPayouts', err) }
          })(),
          // Head office (D1/D3): recharges ON whose last month is not done, open pair mismatches. Counts only.
          (async () => {
            try {
              const { headOfficeHealth } = await import('./modules/headOffices/health.js')
              const h = await headOfficeHealth()
              checks.headOffice = h.status
              if (h.detail) details.headOffice = h.detail
            } catch (err) { warnOf('headOffice', err) }
          })(),
          // Suppliers with no company (the one-time GS Foods assignment, owner
          // 2026-10-16). Counts only.
          (async () => {
            try {
              const { companylessSupplierHealth } = await import('./modules/procurement/companylessSuppliers.js')
              const h = await companylessSupplierHealth()
              checks.supplierCompanies = h.status
              if (h.detail) details.supplierCompanies = h.detail
            } catch (err) { warnOf('supplierCompanies', err) }
          })(),
          // Till clearing / on account (resumed 2026-10-15): open unexplained till-clearing lines and overdue
          // on-account clients. Counts only — never an amount or a name.
          (async () => {
            try {
              const open = { status: { in: ['open', 'acknowledged'] as Array<'open' | 'acknowledged'> } }
              const tc = await prisma.exceptionFlag.count({ where: { kind: 'till_clearing_unexpected', ...open } })
              checks.tillClearing = tc ? 'warn' : 'ok'
              if (tc) details.tillClearing = `${tc} unexplained till-clearing line(s) — Accounting → Till clearing`
              const od = await prisma.exceptionFlag.count({ where: { kind: 'on_account_overdue', ...open } })
              checks.onAccount = od ? 'warn' : 'ok'
              if (od) details.onAccount = `${od} overdue on-account client flag(s) — Accounting → Receivables → On-account clients`
            } catch (err) { warnOf('tillClearing', err) }
          })(),
        ])
      }
    }

    // Upload storage. Every upload (menu photos, the Storefront Library, brand
    // artwork) goes straight from the browser to Cloudflare R2 via a URL the
    // API presigns (lib/storage.ts). With the R2 settings unset the presigner
    // still answers, so the first sign of trouble is "upload to storage
    // failed" in the Library. A warning, never an error: nothing else depends
    // on it. (Whether the bucket's CORS lets admin.servd.pk PUT can't be seen
    // from here.)
    {
      const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL']
        .filter((k) => !process.env[k]?.trim())
      if (missing.length === 0) {
        checks.uploadStorage = 'ok'
      } else {
        checks.uploadStorage = 'warn'
        details.uploadStorage =
          `Upload storage (Cloudflare R2) is not configured: ${missing.join(', ')} unset. File uploads (menu photos, the Storefront Library, brand artwork) will fail.`
      }
    }

    const hasError = Object.values(checks).some((v) => v === 'error')
    const status = hasError ? 'degraded' : Object.values(checks).some((v) => v === 'warn') ? 'warn' : 'ok'
    const body = { status, checks, details, ts: new Date().toISOString(), ...sandboxHealthFields() } // practice copy adds sandbox + sandboxBlocked

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

  // (The role × permission matrix seed is gone with the matrix — owner
  // decision 34. The role_permissions table is kept as history.)

  // Tenants bootstrap: if no tenant exists, create a "main" tenant and attach
  // every existing concept + user to it. Idempotent — safe to run on every boot.
  try {
    const tenantCount = await prisma.tenant.count({ where: { deletedAt: null } })
    if (tenantCount === 0) {
      const main = await prisma.tenant.create({
        data: { slug: 'main', name: 'Main Tenant', isActive: true },
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

  // Locations bootstrap: if no locations exist yet, create one default
  // location PER COMPANY and link that company's brands to it. Locations are
  // company master data — one shared "Main Location" linking every brand
  // across every company is exactly the cross-company overlap the Locations
  // page used to show. Existing orders stay locationId=null; POS/storefront
  // paths populate locationId on new orders going forward.
  try {
    const count = await prisma.location.count({ where: { deletedAt: null } })
    if (count === 0) {
      const tenants = await prisma.tenant.findMany({
        where: { deletedAt: null, isActive: true, kind: 'company' }, // a head office has no outlet
        orderBy: { createdAt: 'asc' },
        select: { id: true, slug: true },
      })
      for (const [idx, tenant] of tenants.entries()) {
        const concepts = await prisma.concept.findMany({
          where: { deletedAt: null, tenantId: tenant.id }, select: { id: true },
        })
        const loc = await prisma.location.create({
          data: {
            slug: idx === 0 ? 'main' : `main-${tenant.slug}`,
            name: 'Main Location', isActive: true, tenantId: tenant.id,
          },
        })
        if (concepts.length > 0) {
          await prisma.conceptLocation.createMany({
            data: concepts.map((c) => ({ conceptId: c.id, locationId: loc.id, isPrimary: true })),
            skipDuplicates: true,
          })
        }
        fastify.log.info(`[locations] seeded default location for "${tenant.slug}" with ${concepts.length} concept links`)
      }
    }
  } catch (err) {
    fastify.log.warn(`[locations] seed skipped: ${(err as Error).message}`)
  }

  // Ledger bootstrap: every company needs its own chart of accounts before a
  // single order can post (Account.tenantId; codes are unique per company).
  // Adds only what a company is missing, so operator edits are never touched.
  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, slug: true },
    })
    for (const t of tenants) {
      const added = await ensureChartOfAccounts(t.id)
      if (added > 0) fastify.log.info(`[ledger] seeded ${added} account(s) for "${t.slug}"`)
      const retired = await retireAggregatorAccounts(t.id)
      if (retired.length > 0) fastify.log.info(`[ledger] deactivated zero-balance aggregator account(s) ${retired.join(', ')} for "${t.slug}"`)
    }
  } catch (err) {
    fastify.log.warn(`[ledger] chart-of-accounts bootstrap skipped: ${(err as Error).message}`)
  }
  // One sales account per brand (owner, 2026-10-17): every live brand with a
  // company and no sales account gets "Sales — <brand>" (4010–4089) in its
  // company's chart. Idempotent — brands that have one are skipped — so it
  // runs every boot and catches a brand created by any path. History stays
  // where it was booked (4090 sales are refunded from 4090).
  try {
    const { ensureBrandRevenueAccounts } = await import('./modules/accounting/brandRevenueAccount.js')
    const assigned = await ensureBrandRevenueAccounts()
    for (const a of assigned) {
      if (a.code) fastify.log.info(`[ledger] brand ${a.conceptId} sales account ${a.code}${a.created ? ' (created)' : ''}`)
      else fastify.log.warn(`[ledger] brand ${a.conceptId} has no sales account (no free code in 4010–4089) — posting to 4090`)
    }
  } catch (err) {
    fastify.log.error({ err }, '[ledger] brand sales accounts boot step failed')
  }
  // Fixed assets v2 (wave B): each company's asset classes (adds only the
  // missing keys — the CEO's edits survive), then the one-time move of the
  // legacy accumulated depreciation off 1590 onto each class's 159x (H27; a
  // rerun finds nothing). The depreciation worker repeats both nightly.
  try {
    const { ensureAssetClasses } = await import('./modules/fixedAssets/classes.js')
    const { reclassLegacyAccumulated } = await import('./modules/fixedAssets/service.js')
    const tenants = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true, slug: true } })
    for (const t of tenants) {
      try {
        const added = await ensureAssetClasses(t.id)
        if (added > 0) fastify.log.info(`[fixedAssets] seeded ${added} asset class(es) for "${t.slug}"`)
      } catch (err) {
        fastify.log.error({ err, tenantId: t.id }, '[fixedAssets] asset classes failed')
        continue
      }
      try {
        const r = await reclassLegacyAccumulated(t.id)
        if (r.posted) fastify.log.info(`[fixedAssets] legacy accumulated depreciation ${r.cents} paisa moved off 1590 for "${t.slug}"`)
      } catch (err) {
        fastify.log.error({ err, tenantId: t.id }, '[fixedAssets] legacy 1590 reclass failed')
      }
    }
  } catch (err) {
    fastify.log.warn(`[fixedAssets] boot steps skipped: ${(err as Error).message}`)
  }
  // OpEx categories that predate OpexCategory.expenseAccountCode get the account
  // their name maps to, where that company's chart has it (finance gaps 17d).
  // Idempotent: only categories with no account; never overwrites a pick.
  try {
    const { backfillOpexCategoryAccounts } = await import('./modules/opex/categoryAccounts.js')
    const r = await backfillOpexCategoryAccounts()
    if (r.mapped) fastify.log.info(`[opex] ${r.mapped} categor${r.mapped === 1 ? 'y' : 'ies'} given an expense account from the name map; ${r.unmapped} still ask on their first payment`)
  } catch (err) {
    fastify.log.warn(`[opex] category expense-account backfill skipped: ${(err as Error).message}`)
  }
  // New default modules reach saved Module Access rows once (MODULE_GRANTS),
  // so GET /permissions/role-modules shows them from the first request. The
  // lazy run in roleOverrides() covers it if this fails.
  try {
    const { applyModuleGrants } = await import('./lib/moduleAccess.js')
    const g = await applyModuleGrants()
    if (g.applied.length) fastify.log.info(`[access] module grants ${g.applied.join(', ')} applied to saved rows: ${g.roles.join(', ') || 'none'}`)
  } catch (err) {
    fastify.log.warn(`[access] module grants skipped: ${(err as Error).message}`)
  }
  // HR requests raised by HR that are already waiting on an HR step (owner,
  // 2026-10-21): HR's raising was its sign-off — move them on once.
  try {
    const { signWaitingHrStepsRaisedByHr } = await import('./modules/hr/routes.js')
    const n = await signWaitingHrStepsRaisedByHr()
    if (n) fastify.log.info(`[hr] ${n} request(s) raised by HR moved past their HR step`)
  } catch (err) {
    fastify.log.warn(`[hr] HR-raised step sweep skipped: ${(err as Error).message}`)
  }
  // Modules taken away from every non-admin role (MODULE_REVOKES — e.g.
  // 'brands', CEO only since 2026-10-14) leave the saved rows and users'
  // moduleAllow once. Enforcement never waits on this (CEO_ONLY_MODULES are
  // dropped on every read); the lazy run in roleOverrides() retries.
  try {
    const { applyModuleRevokes } = await import('./lib/moduleAccess.js')
    const r = await applyModuleRevokes()
    if (r.applied.length) fastify.log.info(`[access] module revokes ${r.applied.join(', ')} applied: ${r.roleRows} role row(s), ${r.users} user(s)`)
  } catch (err) {
    fastify.log.warn(`[access] module revokes skipped: ${(err as Error).message}`)
  }
  // Completion recovery (W4-FISCAL-2) counts only orders completed after this
  // marker — written once, by the first boot of this code — so history from
  // before the fiscal outbox is never re-completed or late-filed.
  try {
    const { completionRecoverySince } = await import('./modules/orders/service.js')
    const since = await completionRecoverySince()
    fastify.log.info(`[complete] completion recovery counts orders completed since ${since.toISOString()}`)
  } catch (err) {
    fastify.log.warn(`[complete] completion recovery marker skipped: ${(err as Error).message}`)
  }
  // Company-less suppliers → GS Foods, ONCE (owner, 2026-10-16: "All to GS
  // Foods"; marker Setting procurement.companylessSuppliersAssignedAt). Before
  // the opening-balance sync so a moved supplier's opening posts this boot.
  // Not exactly one 'GS Foods' company → nothing changes (and /health says
  // so); a supplier with records in another company is skipped and flagged.
  try {
    const { assignCompanylessSuppliers } = await import('./modules/procurement/companylessSuppliers.js')
    const r = await assignCompanylessSuppliers()
    if (r.status === 'done' && (r.assigned.length || r.skipped.length || r.failed)) {
      fastify.log.info(`[suppliers] company-less suppliers: ${r.assigned.length} assigned, ${r.skipped.length} left for the CEO (flagged)${r.failed ? `, ${r.failed} failed (retried next boot)` : ''}`)
    } else if (r.status === 'no_target') {
      fastify.log.warn(`[suppliers] company-less supplier assignment waiting: ${r.targetCount} target companies (expected exactly 1)`)
    }
  } catch (err) {
    fastify.log.warn(`[suppliers] company-less supplier assignment skipped: ${(err as Error).message}`)
  }
  // Supplier opening balances live in the ledger (Dr 3020 / Cr 2010). Post any
  // that predate this, so AP aging and the ledger agree from the first boot.
  try {
    const { syncAllSupplierOpeningBalances } = await import('./modules/procurement/openingBalance.js')
    const r = await syncAllSupplierOpeningBalances()
    if (r.synced || r.failed.length) fastify.log.info(`[ap] supplier opening balances: ${r.synced} posted, ${r.failed.length} failed`)
  } catch (err) {
    fastify.log.warn(`[ap] supplier opening-balance sync skipped: ${(err as Error).message}`)
  }
  // FIFO cut-over (wave B, once per company): stock becomes FIFO lots and
  // receipts open GRNI (2015). After the chart and the supplier opening
  // balances, before listen and the workers. Idempotent — a company already
  // cut over costs one Setting read. Until it runs, lib/stockLedger.ts
  // ensureFifoReady runs it on that company's first stock write.
  try {
    const { ensureFifoCutover } = await import('./modules/inventory/fifoCutover.js')
    const activeTenants = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true, slug: true } })
    for (const t of activeTenants) {
      try {
        const r = await ensureFifoCutover(t.id)
        if (r.ran) fastify.log.info(`[fifo] "${t.slug}" cut over to FIFO lots at ${r.at.toISOString()}`)
      } catch (err) {
        fastify.log.error({ err, tenantId: t.id }, 'FIFO cut-over failed')
      }
    }
  } catch (err) {
    fastify.log.warn(`[fifo] cut-over skipped: ${(err as Error).message}`)
  }

  // Cash vouchers still held on 1357 (the 2026-10-15 hold flow) become ONE
  // expense entry each, once (owner, 2026-10-16: 1357 retired). Keyed per
  // voucher ('cashvoucher.hold_convert:<id>'), so every boot re-tries only
  // what is still held; one that cannot convert is flagged for finance.
  try {
    const { convertHeldVouchers } = await import('./modules/trustops/voucherHoldConversion.js')
    for (const r of await convertHeldVouchers()) {
      fastify.log.info(`[cashVoucher] held vouchers of ${r.tenantId}: ${r.converted} booked as one entry, ${r.refused} flagged for finance`)
    }
  } catch (err) {
    fastify.log.warn(`[cashVoucher] hold conversion skipped: ${(err as Error).message}`)
  }

  // Shift corrections whose apply died mid-way (left 'approved' with no
  // progress for 5 minutes) → 'failed', so the CEO's Retry finishes them.
  try {
    await runShiftCorrectionSweepOnce()
  } catch (err) {
    fastify.log.warn(`[shiftCorrection] stale-apply sweep skipped: ${(err as Error).message}`)
  }

  if (workersEnabled) {
    startShiftCorrectionSweepWorker()
    startCartReleaseWorker()
    startLoyaltyTriggerWorker()
    startLoyaltyExpirationWorker()
    // Gift cards past their expiry are expired daily at 00:10 PKT and their unused value is booked as
    // breakage (H11: 'giftcard.expire' Dr 2080 / Cr 4200 sold, Cr 6060 promotional); held breakage is retried each run.
    startGiftCardExpiryWorker()
    startReservationReminderWorker()
    // The daily sales email is a per-company scheduled report now; a box that
    // still sets DIGEST_EMAIL gets that address carried over once.
    carryOverDigestRecipient()
      .then((slugs) => { if (slugs.length > 0) fastify.log.info(`[scheduledReports] daily sales schedule carried over from DIGEST_EMAIL for ${slugs.join(', ')}`) })
      .catch((err: Error) => fastify.log.warn(`[scheduledReports] digest carry-over skipped: ${err.message}`))
    startDeliveryWatch()
    startReviewPromptWorker()
    // POS connector (spec §9): empty the old FBR/SRB queues ONCE (idempotent,
    // never blocks boot — every step is try/catch inside), THEN start the
    // fiscal sender/sweeper and the card-machine reconciler, so no legacy job
    // can ever run next to the connector.
    void drainLegacyTaxQueues()
      .then((r) => {
        if (r.ran) fastify.log.info(`[fiscal] legacy tax queues drained: ${r.jobs} job(s), ${r.held} order(s) held${r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''}`)
      })
      .catch((err: Error) => fastify.log.warn(`[fiscal] legacy drain failed: ${err.message}`))
      .finally(() => {
        startFiscalConnectorWorker()
        startTerminalConnectorWorker()
      })
    // Raast QR: expiry + bank-SMS backstop every 30 s, escalation flags every
    // 10 min, SMS-text retention daily; unmatched-receipt flag daily 09:05 PKT.
    startRaastConnectorWorker()
    startRaastStatementFlagsWorker()
    // W4-FISCAL-2: a completed order whose completion claim (or its fiscal
    // sale document) never committed is completed / enqueued now — never
    // left silent. Every two minutes; one run at a time per process (the
    // order lock + claim make concurrent runs on several boxes harmless).
    let recovering = false
    cron.schedule('*/2 * * * *', () => {
      if (recovering) return
      recovering = true
      import('./modules/orders/service.js')
        .then((m) => m.recoverIncompleteCompletions())
        .then((s) => {
          if (s.completed || s.saleEnqueued || s.flagged) {
            fastify.log.warn(`[complete] recovery: ${s.completed} completion(s) run, ${s.saleEnqueued} sale document(s) queued, ${s.flagged} flagged`)
          }
        })
        .catch((err: Error) => fastify.log.warn(`[complete] recovery sweep failed: ${err.message}`))
        .finally(() => { recovering = false })
    })
    startSegmentComputationWorker()
    startSocialPublishWorker()
    startCoursePacingWorker()
    // Pre-orders reach the kitchen (order:new + stock) at their prep window.
    startPreOrderReleaseWorker()
    startWebhookDeliveryWorker()
    startScheduledReportsWorker()
    startShrinkageTrendWorker()
    // HR nightly: effects due today, missing punches, leavers' logins.
    cron.schedule('15 19 * * *', () => {
      import('./modules/hr/daily.js').then((m) => m.runHrDaily()).catch((err: Error) => fastify.log.warn(`[hr] nightly sweep failed: ${err.message}`))
    })
    startRiderScoringWorker()
    // Resumed 2026-10-15: head-office recharges (OFF per head office until the CA confirms), COD custody
    // flags, the till-clearing sweep (companies cut over only) and on-account overdue / unbilled flags.
    startHeadOfficeRechargeWorker()
    startCodCustodyWorker()
    // Night audit (2026-10-16): settle audited sales days hourly; flag yesterday's unrun audit after 06:00 PKT.
    startNightAuditSettleWorker()
    startTillClearingSweepWorker()
    startOnAccountDailyWorker()
    startStaffNotificationsWorker()   // the bell: exception claim-poller + retention
    startOrderAutoCancelWorker()
    startPaymentRetryWorker()
    startRiderDispatchWorker()
    startSitePublishWorker()
    // Finance wave B (2026-10-14), node-cron, per company:
    //   03:20 PKT automatic monthly depreciation + prepaid releases + the
    //         fixed-asset flags (there is no switch — owner, 2026-10-13);
    //   03:40 PKT shared-fleet recharges between companies + the pair check;
    //   09:10 PKT cash requests whose receipts are overdue (a flag; H3 books
    //         nothing here).
    startDepreciationWorker()
    startIntercompanyFleetWorker()
    startCashAdvanceOverdueWorker()
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
  assertSandboxBoot() // practice copy: refuses a malformed SERVD_SANDBOX or a live DB / Redis host
  // Practice copy: scrub the copied live data once per copy, before serving
  // (lib/sandbox.ts). Live: does nothing. A copy that can't be scrubbed is
  // not served.
  try {
    await sandboxScrub()
  } catch (err) {
    console.error(`[sandbox] FATAL: could not scrub the copied live data: ${(err as Error).message}`)
    process.exit(1)
  }
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
