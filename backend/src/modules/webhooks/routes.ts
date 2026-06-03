// Inbound webhook receivers
// Each verifies HMAC signature, normalises payload, queues for ingestion.
// Also: outbound webhook subscription management (MANAGERS).

import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { z } from 'zod'
import { AppError } from '../../lib/errors.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { handleWaMessage, type WaIncomingMessage } from '../../adapters/whatsapp/conversation.js'
import { promises as dns } from 'dns'
import {
  parseConversationIdFromAddress,
  findSupplierByEmail,
  findSupplierByWhatsapp,
  findOrCreateInboundConversation,
} from '../../lib/supplier-channels.js'
import {
  parseCustomerConversationId,
  findCustomerByEmail,
  findCustomerByPhone,
  findOrCreateCustomerConversation,
  hasOpenCustomerConversation,
} from '../../lib/customer-channels.js'

// B04: gateways send signatures in a handful of shapes — `sha256=<hex>`,
// `hmac-sha256=<hex>`, raw `<hex>`, sometimes uppercase. Compare bytes (not
// hex strings) so a mixed-case signature still verifies, and decode to a
// Buffer first so `timingSafeEqual` doesn't barf on differing string lengths.
function verifyHmac(secret: string, signature: string | undefined, payload: string | Buffer): boolean {
  if (!signature || !secret) return false
  const cleaned = signature.toLowerCase()
    .replace(/^sha256=/, '')
    .replace(/^hmac-sha256=/, '')
    .trim()
  if (!/^[0-9a-f]+$/.test(cleaned)) return false
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  try {
    const a = Buffer.from(cleaned, 'hex')
    const b = Buffer.from(expected, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * B14: durable webhook idempotency. Redis is checked first (cache hit returns
 * in <1ms), and on miss we insert a row in `webhook_events` — the unique
 * (source, eventId) PK is what actually prevents reprocessing. If Redis is
 * down, we fall through to Postgres alone (the comment "fails open" is
 * wrong now: we fail *closed*, because losing exactly-once on webhooks
 * means double-charging customers).
 *
 * `key` is "source:eventId". We split it back out at the boundary.
 */
async function claimIdempotency(key: string): Promise<boolean> {
  const [source, eventId] = key.includes(':') ? key.split(':', 2) : ['unknown', key]
  if (!source || !eventId) return true                       // malformed → don't block legitimate webhook

  // Fast path: Redis SETNX with 24h TTL. Hit = duplicate, miss = falls through
  // to Postgres so we still record it durably.
  try {
    const cached = await redis.set(`webhook:dedup:${key}`, '1', 'EX', 24 * 60 * 60, 'NX')
    if (cached !== 'OK') return false                         // Redis says we've seen it
  } catch {
    // Redis down — proceed to Postgres without caching.
  }

  // Authoritative path: try to insert. P2002 on the composite PK means
  // somebody else got there first (or the row's been seen before).
  try {
    await prisma.webhookEvent.create({ data: { source, eventId } })
    return true
  } catch (e: unknown) {
    const code = (e as { code?: string }).code
    if (code === 'P2002') return false                        // duplicate
    // Some other DB error — let the webhook re-process rather than swallowing
    // a real failure silently.
    return true
  }
}

export async function webhookRoutes(fastify: FastifyInstance) {
  // All webhook bodies need raw string access for HMAC verification
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { parsed: JSON.parse(body as string), raw: body as string })
    } catch (err) {
      done(err as Error)
    }
  })

  // POST /webhooks/keenu — payment confirmation callback
  fastify.post('/keenu', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { parsed, raw } = req.body as { parsed: unknown; raw: string }
    const sig = req.headers['x-keenu-signature'] as string ?? ''
    const secret = process.env['KEENU_WEBHOOK_SECRET']

    if (!secret) throw new AppError('WEBHOOK_NOT_CONFIGURED', 'KEENU_WEBHOOK_SECRET is not set', 500)
    if (!verifyHmac(secret, sig, raw)) {
      throw new AppError('INVALID_SIGNATURE', 'Keenu signature verification failed', 401)
    }

    const payload = parsed as { transaction_id?: string; order_id?: string; status?: string; amount?: number }
    fastify.log.info({ payload }, 'Keenu payment webhook received')

    // Idempotency on (txn_id, status). Keenu retries on timeout — without dedup
    // a single SUCCESS payload can be applied multiple times (idempotent for
    // status field, but logs/audit trail get duplicated).
    if (payload.transaction_id && payload.status) {
      const fresh = await claimIdempotency(`keenu:${payload.transaction_id}:${payload.status}`)
      if (!fresh) return reply.status(200).send({ received: true, dedup: true })
    }

    if (payload.order_id && payload.transaction_id && payload.status) {
      const statusMap: Record<string, string> = { SUCCESS: 'paid', FAILED: 'failed', REFUNDED: 'refunded' }
      const mappedStatus = statusMap[payload.status] ?? 'pending'

      await prisma.payment.updateMany({
        where: { orderId: payload.order_id, gatewayRef: payload.transaction_id },
        data: { status: mappedStatus as never },
      })
    }

    return reply.status(200).send({ received: true })
  })

  // GET /webhooks/whatsapp — Meta webhook verification challenge
  fastify.get<{ Querystring: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string } }>(
    '/whatsapp',
    async (req, reply) => {
      const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
      const expected = process.env['WHATSAPP_VERIFY_TOKEN']
      if (mode === 'subscribe' && token === expected && challenge) {
        return reply.status(200).send(challenge)
      }
      throw new AppError('FORBIDDEN', 'WhatsApp verification failed', 403)
    },
  )

  // POST /webhooks/whatsapp — incoming messages from customers OR suppliers
  fastify.post('/whatsapp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    // The global content-type parser above wraps JSON bodies as { parsed, raw }.
    // Unwrap to get at the actual Meta payload.
    const wrapped = req.body as { parsed?: any; raw?: string } | undefined
    const body = (wrapped?.parsed ?? req.body) as any
    const raw  = wrapped?.raw ?? ''

    // Verify Meta's `x-hub-signature-256` HMAC over the raw body. Without this,
    // anyone on the internet could POST `{from:"+92<victim>",interactive:{...}}`
    // and place orders, send messages, or trigger the reorder-last flow as
    // any registered customer. The app secret is the same one issued in the
    // Meta dashboard alongside the verify token.
    const appSecret = process.env['WHATSAPP_APP_SECRET']
    if (!appSecret) {
      // Fail closed in production. In dev the secret may not be configured;
      // skip verification only when NODE_ENV !== 'production'.
      if (process.env['NODE_ENV'] === 'production') {
        fastify.log.error('[WhatsApp] WHATSAPP_APP_SECRET not set — refusing inbound')
        return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'WhatsApp webhook signature secret missing' } })
      }
    } else {
      const sig = req.headers['x-hub-signature-256'] as string | undefined
      if (!verifyHmac(appSecret, sig, raw)) {
        fastify.log.warn({ ip: req.ip }, '[WhatsApp] invalid signature, rejecting')
        return reply.status(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'WhatsApp signature verification failed' } })
      }
    }

    // Ack immediately — Meta requires < 5s response
    reply.status(200).send({ received: true })

    try {
      const entry = body?.entry?.[0]
      const change = entry?.changes?.[0]
      const messages = change?.value?.messages as any[] | undefined
      if (!messages?.length) return

      for (const msg of messages) {
        const phone = msg.from as string

        // ── Routing priority ──────────────────────────────────────────────
        // 1. Supplier match → supplier chat
        // 2. Customer match WITH an open CRM thread → customer chat reply
        // 3. Otherwise → fall through to the customer ORDER flow (handleWaMessage)
        //
        // Rationale: a customer with an open complaint/feedback conversation
        // typing "hi" probably wants to reply to staff, not start a new
        // order. The order flow's greeting regex would otherwise hijack their
        // intent. Once the CRM thread is closed (future feature), they'd
        // fall through to ordering on their next "hi".
        const supplierMatch = await findSupplierByWhatsapp(phone).catch(() => null)
        if (supplierMatch) {
          ingestSupplierWhatsApp(phone, msg).catch((err) =>
            console.error(`[WhatsApp/supplier] Handler error for ${phone}:`, err.message),
          )
          continue
        }

        const customerMatch = await findCustomerByPhone(phone).catch(() => null)
        if (customerMatch && (await hasOpenCustomerConversation(customerMatch.id).catch(() => false))) {
          ingestCustomerWhatsApp(phone, msg, customerMatch.id).catch((err) =>
            console.error(`[WhatsApp/customer-chat] Handler error for ${phone}:`, err.message),
          )
          continue
        }

        const waMsg: WaIncomingMessage = {
          from: phone,
          type: msg.type,
          text: msg.text,
          interactive: msg.interactive,
          button_reply: msg.interactive?.button_reply,
          list_reply: msg.interactive?.list_reply,
        }
        handleWaMessage(phone, waMsg).catch((err) =>
          console.error(`[WhatsApp] Handler error for ${phone}:`, err.message),
        )
      }
    } catch (err) {
      console.error('[WhatsApp] Webhook parse error:', (err as Error).message)
    }
  })

  // ─── POST /webhooks/postmark-inbound ──────────────────────────────────────
  // Inbound email parsing for supplier-chat replies. Postmark posts JSON with
  // pre-parsed fields including StrippedTextReply (quoted-trail removed).
  //
  // Routing: the conversation id is encoded in the local-part of the recipient
  // address — we send mail with Reply-To: chat-<convId>@INBOUND_EMAIL_DOMAIN.
  // When the supplier hits reply, Postmark POSTs us this webhook with `To`
  // set to that same address; we extract the id and append the reply to the
  // matching SupplierConversation.
  //
  // Auth model: Postmark doesn't sign payloads with HMAC by default — the
  // recommended pattern is a shared secret in the URL or basic-auth. We
  // accept either: an opaque `?secret=` query param, OR an
  // `Authorization: Bearer <token>` header. If POSTMARK_INBOUND_SECRET is not
  // set in env, we fail closed (returns 503) — better than silently allowing
  // anyone on the internet to inject supplier messages.
  fastify.post('/postmark-inbound', { config: { rateLimit: { max: 200, timeWindow: '1 minute' } } }, async (req, reply) => {
    const expected = process.env['POSTMARK_INBOUND_SECRET']
    if (!expected) {
      // Fail closed: prod must opt in by setting the secret. Returning 503
      // means Postmark will retry — which is what we want, the moment ops
      // sets the env var the queue drains automatically.
      return reply.status(503).send({ error: 'POSTMARK_INBOUND_SECRET not configured' })
    }
    const provided =
      (req.query as { secret?: string })?.secret ??
      (req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '')

    if (!provided || !timingSafeEqualString(provided, expected)) {
      return reply.status(401).send({ error: 'invalid secret' })
    }

    const { parsed } = req.body as { parsed: PostmarkInboundPayload }
    const messageId   = parsed.MessageID
    const fromEmail   = parsed.FromFull?.Email ?? parsed.From
    const fromName    = parsed.FromFull?.Name ?? null
    const toAddresses = (parsed.ToFull ?? []).map((t) => t.Email)
    const subject     = parsed.Subject ?? null
    // Postmark gives us a pre-stripped reply for free — Gmail-style "On <date>,
    // <name> wrote:" trail is already removed. Falls back to TextBody if the
    // strip heuristic fails (rare; happens with non-standard reply quoting).
    const body        = (parsed.StrippedTextReply ?? parsed.TextBody ?? '').trim()

    if (!body || !fromEmail) {
      return reply.status(200).send({ received: true, ignored: 'empty body or no sender' })
    }

    // Routing decision — the recipient address tells us which side of the
    // platform this message is for:
    //   chat-<id>@<domain>  → supplier conversation
    //   crm-<id>@<domain>   → customer (CRM outreach) conversation
    //   neither             → fall back: try supplier-by-email, then customer-by-email
    let targetSide: 'supplier' | 'customer' | null = null
    let hintedConvId: string | null = null
    for (const to of toAddresses) {
      const supId = parseConversationIdFromAddress(to)
      if (supId) { targetSide = 'supplier'; hintedConvId = supId; break }
      const custId = parseCustomerConversationId(to)
      if (custId) { targetSide = 'customer'; hintedConvId = custId; break }
    }

    // Dedup on Postmark MessageID across BOTH tables (rare but possible if
    // someone forwards the same message thread to both sides).
    if (messageId) {
      const supDup = await prisma.supplierMessage.findUnique({ where: { externalMessageId: messageId } })
      if (supDup) return reply.status(200).send({ received: true, dedup: true })
      const custDup = await prisma.customerMessage.findUnique({ where: { externalMessageId: messageId } })
      if (custDup) return reply.status(200).send({ received: true, dedup: true })
    }

    // Branch on inferred side
    const senderLabel = fromName ? `${fromName} <${fromEmail}>` : fromEmail

    if (targetSide === 'customer') {
      const customer = await findCustomerByEmail(fromEmail)
      if (!customer) {
        console.warn(`[postmark-inbound] crm-* address but no customer matched email=${fromEmail}`)
        return reply.status(200).send({ received: true, ignored: 'no matching customer' })
      }
      const conversationId = await findOrCreateCustomerConversation({
        customer, hintedConversationId: hintedConvId, channelHint: 'email', initialSubject: subject ?? undefined,
      })
      await prisma.customerMessage.create({
        data: {
          conversationId, fromStaff: false, senderId: null, body,
          channel: 'email', externalMessageId: messageId ?? null, inboundFromAddress: senderLabel,
        },
      })
      await prisma.customerConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
      return reply.status(200).send({ received: true, side: 'customer', conversationId })
    }

    // Default branch — supplier (either explicitly via chat-* hint, or by
    // email match when there's no hint). Fall through to customer match if
    // no supplier exists with this email.
    const supplier = await findSupplierByEmail(fromEmail)
    if (supplier) {
      const conversationId = await findOrCreateInboundConversation({
        supplier, hintedConversationId: hintedConvId, channelHint: 'email', initialSubject: subject ?? undefined,
      })
      await prisma.supplierMessage.create({
        data: {
          conversationId, fromStaff: false, senderId: null, body,
          channel: 'email', externalMessageId: messageId ?? null, inboundFromAddress: senderLabel,
        },
      })
      await prisma.supplierConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
      return reply.status(200).send({ received: true, side: 'supplier', conversationId })
    }

    // Last resort — try customer (covers replies where the operator forgot
    // to use the per-conversation reply-to and the customer just replied to
    // a generic outreach mail).
    const customer = await findCustomerByEmail(fromEmail)
    if (customer) {
      const conversationId = await findOrCreateCustomerConversation({
        customer, hintedConversationId: null, channelHint: 'email', initialSubject: subject ?? undefined,
      })
      await prisma.customerMessage.create({
        data: {
          conversationId, fromStaff: false, senderId: null, body,
          channel: 'email', externalMessageId: messageId ?? null, inboundFromAddress: senderLabel,
        },
      })
      await prisma.customerConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
      return reply.status(200).send({ received: true, side: 'customer', conversationId })
    }

    // No match anywhere. Drop with 200 (don't make Postmark retry forever).
    console.warn(`[postmark-inbound] No supplier or customer matched email=${fromEmail}; dropping message_id=${messageId}`)
    return reply.status(200).send({ received: true, ignored: 'no match on either side' })
  })
}

// ─── Outbound webhook management (MANAGERS) ───────────────────────────────────
// These endpoints let operators register, inspect and test the outbound
// webhook subscriptions that fan out domain events to their own integrations.
// They live here rather than /setup so they're accessible to managers (not
// just admins) and co-located with the inbound webhook logic for discoverability.

// Outbound URLs from operator input MUST be vetted before we fetch them — the
// API server sits inside our VPC and can reach internal services, cloud
// metadata, and admin panels that the public internet can't. A naive fetch()
// would let any manager exfiltrate AWS IAM creds via http://169.254.169.254/
// or pivot through localhost services.
//
// Rules:
//   - https only (no http, file, ftp, gopher, etc.)
//   - hostname must resolve only to public IPs (no loopback, link-local,
//     RFC1918, or AWS/GCP metadata addresses)
//   - revalidate at fetch time too — DNS rebinding could otherwise flip the
//     answer between the check and the request
function isPrivateIp(ip: string): boolean {
  // IPv4
  const m4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m4) {
    const [a, b] = [parseInt(m4[1]!, 10), parseInt(m4[2]!, 10)]
    if (a === 10) return true                                       // 10.0.0.0/8
    if (a === 127) return true                                      // loopback
    if (a === 169 && b === 254) return true                         // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true                // 172.16/12
    if (a === 192 && b === 168) return true                         // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true               // CG-NAT
    if (a === 0) return true                                        // 0.0.0.0/8
    if (a >= 224) return true                                       // multicast + reserved
    return false
  }
  // IPv6
  const lower = ip.toLowerCase()
  if (lower === '::1') return true                                  // loopback
  if (lower.startsWith('fe80:')) return true                        // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7))
  return false
}

async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let u: URL
  try { u = new URL(rawUrl) } catch { throw new AppError('INVALID_URL', 'URL is malformed', 400) }
  if (u.protocol !== 'https:') {
    throw new AppError('INVALID_URL', 'Webhook URL must use https://', 400)
  }
  // Resolve all A/AAAA records — any one private IP fails the check.
  const host = u.hostname
  let addrs: { address: string }[] = []
  try {
    addrs = await dns.lookup(host, { all: true })
  } catch {
    throw new AppError('UNRESOLVABLE_HOST', `Could not resolve ${host}`, 400)
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new AppError('PRIVATE_HOST', `${host} resolves to a private address (${a.address}); webhooks must target public hosts`, 400)
    }
  }
}

export async function webhookManagementRoutes(fastify: FastifyInstance) {
  const ENDPOINT_EVENTS = [
    'order.placed', 'order.confirmed', 'order.dispatched', 'order.delivered',
    'order.refunded', 'shift.opened', 'shift.closed', 'inventory.low_stock',
    'reservation.confirmed', 'reservation.no_show', 'payment.completed', 'payment.failed',
  ]

  // GET /webhooks/endpoints — list active subscriptions
  fastify.get('/endpoints', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const list = await prisma.webhookSubscription.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, url: true, events: true, isActive: true,
        lastSentAt: true, lastStatus: true, failureCount: true,
        notes: true, createdAt: true,
      },
    })
    return list
  })

  // POST /webhooks/endpoints — register a new endpoint
  fastify.post('/endpoints', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      url:    z.string().url('Must be a valid HTTPS URL'),
      events: z.array(z.string()).min(1, 'Subscribe to at least one event'),
      secret: z.string().min(16).optional(),
      notes:  z.string().max(200).nullable().optional(),
    }).parse(req.body)

    await assertSafeOutboundUrl(body.url)

    const secret = body.secret ?? crypto.randomBytes(32).toString('hex')
    const endpoint = await prisma.webhookSubscription.create({
      data: {
        url: body.url,
        events: body.events,
        secret,
        notes: body.notes ?? null,
        createdById: req.staffUser!.id,
      },
    })
    // Return the full secret on creation — shown once, then truncated in list
    return reply.status(201).send({ ...endpoint, secret })
  })

  // PATCH /webhooks/endpoints/:id — update url / events / active state / notes
  fastify.patch<{ Params: { id: string } }>(
    '/endpoints/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        url:      z.string().url().optional(),
        events:   z.array(z.string()).min(1).optional(),
        isActive: z.boolean().optional(),
        notes:    z.string().max(200).nullable().optional(),
      }).parse(req.body)

      if (body.url) await assertSafeOutboundUrl(body.url)

      const existing = await prisma.webhookSubscription.findFirst({
        where: { id: req.params.id, deletedAt: null },
      })
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } })
      }

      const updated = await prisma.webhookSubscription.update({
        where: { id: req.params.id },
        data: body,
        select: {
          id: true, url: true, events: true, isActive: true,
          lastSentAt: true, lastStatus: true, failureCount: true, notes: true,
        },
      })
      return updated
    },
  )

  // DELETE /webhooks/endpoints/:id — soft-delete (deactivate)
  fastify.delete<{ Params: { id: string } }>(
    '/endpoints/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await prisma.webhookSubscription.findFirst({
        where: { id: req.params.id, deletedAt: null },
      })
      if (!existing) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } })
      }
      await prisma.webhookSubscription.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date(), isActive: false },
      })
      return reply.status(204).send()
    },
  )

  // POST /webhooks/endpoints/:id/test — send a signed ping payload
  fastify.post<{ Params: { id: string } }>(
    '/endpoints/:id/test',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const sub = await prisma.webhookSubscription.findFirst({
        where: { id: req.params.id, deletedAt: null },
      })
      if (!sub) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } })
      }

      // Re-validate the URL at fetch time. The check at create/update protects
      // against simple cases, but DNS rebinding could otherwise flip the
      // answer between persistence and dispatch. Re-running blocks that race.
      try {
        await assertSafeOutboundUrl(sub.url)
      } catch (err) {
        return reply.status(400).send({ error: { code: (err as AppError).code ?? 'INVALID_URL', message: (err as Error).message } })
      }

      const pingPayload = { event: 'ping', timestamp: new Date().toISOString(), subscriptionId: sub.id }
      const body = JSON.stringify(pingPayload)
      const signature = crypto.createHmac('sha256', sub.secret).update(body).digest('hex')

      const controller = new AbortController()
      const timeout    = setTimeout(() => controller.abort(), 10_000)
      const startMs    = Date.now()

      try {
        const res = await fetch(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Servd-Event': 'ping',
            'X-Servd-Signature': `sha256=${signature}`,
            'X-Servd-Subscription': sub.id,
          },
          body,
          signal: controller.signal,
          // Disable redirects — otherwise the SSRF allowlist is trivially
          // bypassed by a public URL that 302s to http://169.254.169.254.
          redirect: 'manual',
        })
        clearTimeout(timeout)
        const responseMs = Date.now() - startMs
        // Persist the raw body to the delivery record so operators can debug
        // their integration, but DO NOT return it to the API caller — that
        // would turn this endpoint into an unauthenticated HTTP read primitive
        // for whatever the upstream URL responds with.
        const respBodyForLog = (await res.text().catch(() => '')).slice(0, 500)

        await prisma.webhookDelivery.create({
          data: {
            subscriptionId: sub.id,
            event: 'ping',
            url: sub.url,
            requestBody: body,
            responseCode: res.status,
            responseBody: respBodyForLog,
            status: res.ok ? 'success' : res.status >= 500 ? 'failed_5xx' : 'failed_4xx',
            durationMs: responseMs,
            attemptNumber: 1,
          },
        })

        return { success: res.ok, statusCode: res.status, responseMs }
      } catch (err) {
        clearTimeout(timeout)
        const responseMs = Date.now() - startMs
        const isTimeout = (err as Error).name === 'AbortError'

        await prisma.webhookDelivery.create({
          data: {
            subscriptionId: sub.id,
            event: 'ping',
            url: sub.url,
            requestBody: body,
            status: isTimeout ? 'timeout' : 'error',
            durationMs: responseMs,
            attemptNumber: 1,
          },
        }).catch(() => {})

        return {
          success: false,
          statusCode: null,
          responseMs,
          error: isTimeout ? 'timeout' : (err as Error).message,
        }
      }
    },
  )

  // GET /webhooks/deliveries — last 50 delivery attempts across all endpoints
  fastify.get('/deliveries', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { subscriptionId, limit } = (req.query as { subscriptionId?: string; limit?: string })
    const take = Math.min(Number(limit ?? 50), 200)

    const records = await prisma.webhookDelivery.findMany({
      where: subscriptionId ? { subscriptionId } : undefined,
      orderBy: { attemptedAt: 'desc' },
      take,
      select: {
        id: true, event: true, url: true, responseCode: true,
        status: true, durationMs: true, attemptNumber: true, attemptedAt: true,
        subscriptionId: true,
      },
    })
    return records
  })

  // GET /webhooks/events — list of supported event names (for UI dropdowns)
  fastify.get('/events', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return { events: ENDPOINT_EVENTS }
  })
}

// ─── WhatsApp customer-chat ingestion helper ───────────────────────────────────

async function ingestCustomerWhatsApp(phone: string, msg: any, customerId: string): Promise<void> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } })
  if (!customer) return  // defensive

  const externalId = msg.id as string | undefined
  if (externalId) {
    const dup = await prisma.customerMessage.findUnique({ where: { externalMessageId: externalId } })
    if (dup) return
  }

  // Same body extraction logic as supplier — kept inlined per side because
  // they're short and inlined logic stays readable in webhook context.
  let body: string | null = null
  if (msg.type === 'text') body = msg.text?.body ?? null
  else if (msg.interactive?.button_reply) body = `[button] ${msg.interactive.button_reply.title}`
  else if (msg.interactive?.list_reply)   body = `[list] ${msg.interactive.list_reply.title}`
  else if (msg.image)    body = '[image] ' + (msg.image.caption ?? '(no caption)')
  else if (msg.document) body = '[document] ' + (msg.document.filename ?? '(file)')
  else if (msg.audio)    body = '[voice note]'
  else                   body = `[${msg.type ?? 'unknown'}] (unsupported message type)`
  if (!body) return

  const conversationId = await findOrCreateCustomerConversation({
    customer,
    channelHint: 'whatsapp',
  })

  await prisma.customerMessage.create({
    data: {
      conversationId,
      fromStaff:          false,
      senderId:           null,
      body,
      channel:            'whatsapp',
      externalMessageId:  externalId ?? null,
      inboundFromAddress: phone,
    },
  })
  await prisma.customerConversation.update({
    where: { id: conversationId },
    data:  { updatedAt: new Date() },
  })
}

// ─── WhatsApp supplier ingestion helper ────────────────────────────────────────

async function ingestSupplierWhatsApp(phone: string, msg: any): Promise<void> {
  const supplier = await findSupplierByWhatsapp(phone)
  if (!supplier) return  // routing already checked, but stay defensive

  // Dedup by Meta's `wamid` — the message id Meta assigns to every send.
  const externalId = msg.id as string | undefined
  if (externalId) {
    const existing = await prisma.supplierMessage.findUnique({ where: { externalMessageId: externalId } })
    if (existing) return
  }

  // Extract a usable text body. WA messages can be plain text, button replies,
  // or list selections; surface each as something readable in the chat.
  let body: string | null = null
  if (msg.type === 'text') body = msg.text?.body ?? null
  else if (msg.interactive?.button_reply) body = `[button] ${msg.interactive.button_reply.title}`
  else if (msg.interactive?.list_reply)   body = `[list] ${msg.interactive.list_reply.title}`
  else if (msg.image)    body = '[image] ' + (msg.image.caption ?? '(no caption)')
  else if (msg.document) body = '[document] ' + (msg.document.filename ?? msg.document.caption ?? '(file)')
  else if (msg.audio)    body = '[voice note]'
  else                   body = `[${msg.type ?? 'unknown'}] (unsupported message type)`

  if (!body) return

  const conversationId = await findOrCreateInboundConversation({
    supplier,
    channelHint: 'whatsapp',
  })

  await prisma.supplierMessage.create({
    data: {
      conversationId,
      fromStaff:          false,
      senderId:           null,
      body,
      channel:            'whatsapp',
      externalMessageId:  externalId ?? null,
      inboundFromAddress: phone,
    },
  })
  await prisma.supplierConversation.update({
    where: { id: conversationId },
    data:  { updatedAt: new Date() },
  })
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

// Postmark inbound webhook payload (the subset we care about). Full schema
// at https://postmarkapp.com/developer/webhooks/inbound-webhook
interface PostmarkInboundPayload {
  MessageID?: string
  From?: string
  FromName?: string
  FromFull?: { Email: string; Name?: string }
  ToFull?: Array<{ Email: string; Name?: string }>
  Subject?: string
  TextBody?: string
  HtmlBody?: string
  StrippedTextReply?: string
}
