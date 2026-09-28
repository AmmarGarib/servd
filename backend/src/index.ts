import 'dotenv/config'

// Keep the process alive even if Redis/BullMQ throws an unhandled rejection
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err instanceof Error ? err.message : err)
})

// Long-running entry point (Docker / `npm start` / `npm run dev`).
// The HTTP app itself lives in ./app.ts so the Vercel function (api/index.js)
// can serve the very same routes; this file adds what only a persistent
// process can do — socket.io, boot-time seeds, background workers, listen.

import { buildApp } from './app.js'
import { runBootstrap } from './bootstrap.js'
import { initWebSocket } from './lib/ws.js'
import { serviceClient as prisma } from './lib/prisma.js'
import cron from 'node-cron'
import { startCartReleaseWorker } from './lib/reservation.js'
import { startCoursePacingWorker } from './workers/coursePacing.js'
import { startLoyaltyTriggerWorker } from './workers/loyaltyTriggers.js'
import { startLoyaltyExpirationWorker } from './workers/loyaltyExpiration.js'
import { startReservationReminderWorker } from './workers/reservationReminders.js'
import { startDeliveryWatch } from './workers/deliveryWatch.js'
import { startReviewPromptWorker } from './workers/reviewPrompt.js'
import { startFbrSubmissionWorker } from './workers/fbrSubmission.js'
import { startSrbSubmissionWorker } from './workers/srbSubmission.js'
import { startWebhookDeliveryWorker } from './workers/webhookDelivery.js'
import { startScheduledReportsWorker, carryOverDigestRecipient } from './workers/scheduledReports.js'
import { startShrinkageTrendWorker } from './workers/shrinkageTrend.js'
import { startRiderScoringWorker } from './workers/riderScoring.js'
import { startOrderAutoCancelWorker } from './workers/orderAutoCancel.js'
import { startSitePublishWorker } from './workers/sitePublish.js'
import { startPaymentRetryWorker } from './workers/paymentRetry.js'
import { startRiderDispatchWorker } from './workers/riderDispatch.js'
import { startSegmentComputationWorker } from './workers/segmentComputation.js'
import { startSocialPublishWorker } from './workers/socialPublish.js'

const PORT = parseInt(process.env['PORT'] ?? '3001', 10)
const HOST = '0.0.0.0'

async function build() {
  const fastify = await buildApp({ serverless: false })

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  initWebSocket(fastify)

  // ─── Background workers ────────────────────────────────────────────────────
  // Workers connect to Redis (rate-limit-prone) and hammer Postgres on boot.
  // Default: enabled in production, disabled in dev. Force with ENABLE_WORKERS=true|false.

  const workersEnabled =
    process.env['ENABLE_WORKERS'] != null
      ? process.env['ENABLE_WORKERS'] === 'true'
      : process.env['NODE_ENV'] === 'production'

  // Idempotent seeds (tenants, locations, chart of accounts, supplier opening
  // balances) — see ./bootstrap.ts.
  await runBootstrap(fastify.log)

  if (workersEnabled) {
    startCartReleaseWorker()
    startLoyaltyTriggerWorker()
    startLoyaltyExpirationWorker()
    startReservationReminderWorker()
    // The daily sales email is a per-company scheduled report now; a box that
    // still sets DIGEST_EMAIL gets that address carried over once.
    carryOverDigestRecipient()
      .then((slugs) => { if (slugs.length > 0) fastify.log.info(`[scheduledReports] daily sales schedule carried over from DIGEST_EMAIL for ${slugs.join(', ')}`) })
      .catch((err: Error) => fastify.log.warn(`[scheduledReports] digest carry-over skipped: ${err.message}`))
    startDeliveryWatch()
    startReviewPromptWorker()
    startFbrSubmissionWorker()
    startSrbSubmissionWorker()
    startSegmentComputationWorker()
    startSocialPublishWorker()
    startCoursePacingWorker()
    startWebhookDeliveryWorker()
    startScheduledReportsWorker()
    startShrinkageTrendWorker()
    // HR nightly: effects due today, missing punches, leavers' logins.
    cron.schedule('15 19 * * *', () => {
      import('./modules/hr/daily.js').then((m) => m.runHrDaily()).catch((err: Error) => fastify.log.warn(`[hr] nightly sweep failed: ${err.message}`))
    })
    startRiderScoringWorker()
    startOrderAutoCancelWorker()
    startPaymentRetryWorker()
    startRiderDispatchWorker()
    startSitePublishWorker()
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
