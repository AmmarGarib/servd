// Inbound POS-connector webhooks (spec §5, §8.3):
//   POST /api/v1/webhooks/pos/:webhookToken
//
// The token selects the company's connector (unknown token → 404, no detail).
// The vendor signs `X-Servd-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret,
// t + "." + rawBody)>`; servd checks it in constant time with a 300 s window
// (bad / stale → 401) and fails CLOSED when no secret is configured (503).
// Rows are looked up with tenantId = the connector's company; a foreign or
// unknown id is answered 200 {ignored:true} and never touched. Replays are
// deduped best-effort in Redis (SET NX, 24 h) and always by forward-only
// state transitions. The reply is fast: payment recording runs in
// setImmediate, with the reconciler as the backstop.
//
// This plugin registers its own raw-body parser (encapsulated) — the shared
// webhooks/routes.ts is not touched.
//
// Bank SMS from a counter phone (Raast QR, 2026-10-12, spec §6.3, S2):
//   POST /api/v1/webhooks/pos/sms               Authorization: Bearer sms_<64 hex>
//   POST /api/v1/webhooks/pos/sms/:deviceToken  fallback for forwarders that
//        cannot set headers — only when the device allows it (a token in a
//        URL lands in request logs; this route logs nothing below 'error' and
//        index.ts masks the token in logged URLs).
// The token's FORMAT is checked before any database lookup; a bad or unknown
// token is 401 with no detail, and an address that keeps failing is throttled
// (429) — a malformed token from it before any lookup, a well-shaped one only
// when it fails too; a valid device is never refused for its address. Rate limit per device: 120/min keyed on
// sha256(token). Body ≤ 32 KB, JSON or form. The reply is immediate; the SMS
// is processed after it (setImmediate) with the worker as the backstop.

import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { decryptSecret } from '../../lib/secretBox.js'
import { verifySignature, withTimeout } from '../../connectors/util.js'
import { connectorNow } from '../../connectors/registry.js'
import { parseInboundEvent, handleInboundEvent } from '../../connectors/inbound.js'
import type { ConnectorKindT, InboundEvent } from '../../connectors/types.js'
import { deviceByToken, isDeviceTokenShape } from '../../connectors/raast/devices.js'
import { extractSmsFields, intakeSms, processAlertSoon } from '../../connectors/raast/intake.js'

/** The connector kind an inbound event type applies to — explicit, so a raast connector applies no fiscal / terminal event. */
export const EVENT_CONNECTOR_KIND: Record<InboundEvent['type'], ConnectorKindT> = {
  'terminal.charge.updated': 'terminal',
  'fiscal.document.updated': 'fiscal',
}

/** Mask a bank-SMS device token in a URL before it is logged (index.ts req serializer). */
export function maskSmsTokenInUrl(url: string): string {
  return String(url ?? '').replace(/(\/webhooks\/pos\/sms\/)[^/?#]+/g, '$1[REDACTED]')
}

/** The bearer token of a bank-SMS request: Authorization header, else the path (route decides if allowed). */
function smsTokenOf(req: FastifyRequest): string {
  const h = req.headers['authorization']
  const v = Array.isArray(h) ? h[0] : h
  const m = /^Bearer\s+(\S+)$/i.exec(String(v ?? '').trim())
  if (m) return m[1]!
  const p = (req.params as { deviceToken?: unknown } | undefined)?.deviceToken
  return typeof p === 'string' ? p : ''
}

// Failed-auth throttle per address (in-process, S2): 20 failures / 10 min.
const FAIL_WINDOW_MS = 10 * 60_000
const FAIL_MAX = 20
const failures = new Map<string, { count: number; resetAt: number }>()

function throttled(ip: string): boolean {
  const f = failures.get(ip)
  if (!f) return false
  if (Date.now() > f.resetAt) { failures.delete(ip); return false }
  return f.count >= FAIL_MAX
}

function noteFailure(ip: string): void {
  const now = Date.now()
  const f = failures.get(ip)
  if (!f || now > f.resetAt) failures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS })
  else f.count++
  if (failures.size > 10_000) for (const [k, v] of failures) if (now > v.resetAt) failures.delete(k)
}

/** Tests only. */
export function resetSmsAuthThrottle(): void {
  failures.clear()
}

const smsRateLimit = {
  max: 120,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest) => {
    const t = smsTokenOf(req)
    return isDeviceTokenShape(t) ? `rsms:${createHash('sha256').update(t).digest('hex')}` : `rsms-ip:${req.ip}`
  },
}

async function handleSms(req: FastifyRequest, reply: FastifyReply, viaPath: boolean) {
  const ip = req.ip ?? 'unknown'
  const tooMany = () => reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many failed attempts' } })
  const token = smsTokenOf(req)
  const shaped = isDeviceTokenShape(token)
  // The address throttle applies to FAILURES only (S2): a malformed token from
  // a throttled address is refused before any lookup, but a well-shaped token
  // is always looked up (one unique-index read, rate-limited per token) — a
  // working counter phone is never locked out because a stale phone, a guest
  // on the same Wi-Fi or another company's device behind the same carrier NAT
  // keeps failing from that address.
  if (!shaped && throttled(ip)) return tooMany()
  const device = shaped ? await deviceByToken(token) : null
  if (!device || (viaPath && !device.allowPathToken)) {
    noteFailure(ip)
    if (throttled(ip)) return tooMany()
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
  }
  try {
    const raw = typeof req.body === 'string' ? req.body : ''
    const fields = extractSmsFields(raw, req.headers['content-type'] ?? null)
    if (!fields) {
      await prisma.bankSmsDevice.update({ where: { id: device.id }, data: { lastSeenAt: connectorNow() } })
      return reply.status(400).send({ error: { code: 'BAD_BODY', message: 'Send the SMS sender and text (JSON or form fields from / text)' } })
    }
    const r = await intakeSms(device, fields)
    if ('ok' in r) processAlertSoon(r.id)
    return reply.status(200).send(r)
  } catch (err) {
    // Never a 500 with the request (and its URL) in the error log.
    console.error('[raast] SMS intake failed:', (err as Error).message)
    return reply.status(503).send({ error: { code: 'TRY_AGAIN', message: 'Could not store the SMS — the forwarder should retry' } })
  }
}

/** Best-effort replay dedupe; true = first time seen (or Redis unavailable). */
async function firstDelivery(connectorId: string, eventId: string): Promise<boolean> {
  try {
    const { redisFast } = await import('../../lib/redis.js')
    const r = await withTimeout(redisFast.set(`poswh:${connectorId}:${eventId}`, '1', 'EX', 86_400, 'NX'), 1000, 'webhook dedupe')
    return r === 'OK'
  } catch {
    return true // the forward-only state machine still holds
  }
}

export async function connectorWebhookRoutes(fastify: FastifyInstance) {
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  // ── Bank SMS (Raast QR) ──
  fastify.post('/sms', { config: { rateLimit: smsRateLimit }, bodyLimit: 32 * 1024 }, (req, reply) => handleSms(req, reply, false))
  fastify.post('/sms/:deviceToken', { config: { rateLimit: smsRateLimit }, bodyLimit: 32 * 1024, logLevel: 'error' }, (req, reply) => handleSms(req, reply, true))

  fastify.post('/:token', {
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (req: { params?: unknown }) => `poswh:${String((req.params as { token?: string } | undefined)?.token ?? '')}`,
      },
    },
    bodyLimit: 256 * 1024,
  }, async (req, reply) => {
    const { token } = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).catch({ token: '' }).parse(req.params)
    const conn = token ? await prisma.posConnector.findUnique({ where: { webhookToken: token } }) : null
    if (!conn) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } })

    if (!conn.webhookSecretEnc) {
      return reply.status(503).send({ error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'No webhook secret is configured for this connector' } })
    }
    let secret: string
    try {
      secret = decryptSecret(conn.webhookSecretEnc)
    } catch {
      return reply.status(503).send({ error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'The webhook secret cannot be read on this server' } })
    }
    const raw = typeof req.body === 'string' ? req.body : ''
    const header = req.headers['x-servd-signature']
    const nowSec = Math.floor(connectorNow().getTime() / 1000)
    if (!verifySignature(Array.isArray(header) ? header[0] : header, secret, raw, nowSec)) {
      return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Signature missing, invalid or stale' } })
    }

    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      return reply.status(400).send({ error: { code: 'BAD_BODY', message: 'Body is not JSON' } })
    }
    const event = parseInboundEvent(parsed)
    if (!event) return reply.status(200).send({ ignored: true, reason: 'unrecognised event' })
    // An event of another kind on this connector is not this connector's to
    // apply (explicit map: a raast connector applies no fiscal / terminal event).
    if (EVENT_CONNECTOR_KIND[event.type] !== conn.kind) {
      return reply.status(200).send({ ignored: true, reason: 'wrong connector kind' })
    }
    if (!(await firstDelivery(conn.id, event.id))) return reply.status(200).send({ ok: true, duplicate: true })

    const result = await handleInboundEvent(conn.tenantId, event, 'webhook')
    return reply.status(200).send(result === 'applied' ? { ok: true } : { ignored: true })
  })
}
