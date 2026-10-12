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

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { decryptSecret } from '../../lib/secretBox.js'
import { verifySignature, withTimeout } from '../../connectors/util.js'
import { connectorNow } from '../../connectors/registry.js'
import { parseInboundEvent, handleInboundEvent } from '../../connectors/inbound.js'

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
    // An event of the other kind on this connector is not this connector's to apply.
    if ((event.type === 'terminal.charge.updated') !== (conn.kind === 'terminal')) {
      return reply.status(200).send({ ignored: true, reason: 'wrong connector kind' })
    }
    if (!(await firstDelivery(conn.id, event.id))) return reply.status(200).send({ ok: true, duplicate: true })

    const result = await handleInboundEvent(conn.tenantId, event, 'webhook')
    return reply.status(200).send(result === 'applied' ? { ok: true } : { ignored: true })
  })
}
