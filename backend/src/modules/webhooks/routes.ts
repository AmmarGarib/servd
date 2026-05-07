// Inbound webhook receivers
// Each verifies HMAC signature, normalises payload, queues for ingestion.

import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { orderIngestionQueue } from '../../lib/queue.js'
import { AppError } from '../../lib/errors.js'
import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { handleWaMessage, type WaIncomingMessage } from '../../adapters/whatsapp/conversation.js'
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

function verifyHmac(secret: string, signature: string, payload: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

/**
 * Idempotency check using Redis SETNX with 24h TTL. Returns true if this is the
 * first time we've seen this key (caller should process), false if duplicate.
 * Fails open on Redis outage — better to risk a re-process than to drop a real
 * webhook. (Stateful side effects downstream are themselves idempotent on
 * source_externalId via the order ingestion queue.)
 */
async function claimIdempotency(key: string): Promise<boolean> {
  try {
    const result = await redis.set(`webhook:dedup:${key}`, '1', 'EX', 24 * 60 * 60, 'NX')
    return result === 'OK'
  } catch {
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

  // POST /webhooks/foodpanda — order notifications from Foodpanda
  // Tight per-IP cap: a misconfigured retry storm shouldn't drown the API.
  fastify.post('/foodpanda', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { parsed, raw } = req.body as { parsed: unknown; raw: string }
    const sig = req.headers['x-foodpanda-signature'] as string ?? ''
    const secret = process.env['FOODPANDA_WEBHOOK_SECRET']

    if (!secret) throw new AppError('WEBHOOK_NOT_CONFIGURED', 'FOODPANDA_WEBHOOK_SECRET is not set', 500)
    if (!verifyHmac(secret, sig, raw)) {
      throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 401)
    }

    // Idempotency — Foodpanda retries on transient failures; double-processing
    // creates duplicate orders + duplicate inventory deductions. Key by their
    // own request signature so legitimate distinct events are still ingested.
    const dedupKey = (parsed as any)?.event_id ?? (parsed as any)?.order_id ?? sig
    const fresh = await claimIdempotency(`foodpanda:${dedupKey}`)
    if (!fresh) return reply.status(200).send({ received: true, dedup: true })

    await orderIngestionQueue.add('foodpanda-order', { source: 'foodpanda', payload: parsed })
    return reply.status(200).send({ received: true })
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

  // POST /webhooks/careem — order notifications from Careem Food
  fastify.post('/careem', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { parsed, raw } = req.body as { parsed: unknown; raw: string }
    const sig = req.headers['x-careem-signature'] as string ?? ''
    const secret = process.env['CAREEM_WEBHOOK_SECRET']

    if (!secret) throw new AppError('WEBHOOK_NOT_CONFIGURED', 'CAREEM_WEBHOOK_SECRET is not set', 500)
    if (!verifyHmac(secret, sig, raw)) {
      throw new AppError('INVALID_SIGNATURE', 'Careem webhook signature verification failed', 401)
    }

    const dedupKey = (parsed as any)?.event_id ?? (parsed as any)?.order?.order_code ?? sig
    const fresh = await claimIdempotency(`careem:${dedupKey}`)
    if (!fresh) return reply.status(200).send({ received: true, dedup: true })

    await orderIngestionQueue.add('careem-order', { source: 'careem', payload: parsed })
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
    const wrapped = req.body as { parsed?: any } | undefined
    const body = (wrapped?.parsed ?? req.body) as any

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
