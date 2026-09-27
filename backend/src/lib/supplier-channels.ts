// ─── Supplier chat: multi-channel delivery ─────────────────────────────────────
// Central fan-out for outbound supplier messages and helpers for inbound
// channel routing.
//
// On staff send (POST /procurement/conversations/:id/messages):
//   1. The canonical SupplierMessage row is created in chat.ts (channel="web_portal").
//   2. After the response is sent, we asynchronously call deliverToSupplier()
//      from here — it tries email + WhatsApp in parallel, swallows failures.
//   3. The supplier always sees the message in the web portal regardless of
//      whether email/WA delivery succeeded; those are best-effort notifications.
//
// On inbound (Postmark webhook, WhatsApp webhook):
//   findSupplierByEmail() / findSupplierByWhatsapp() resolve the sender to a
//   Supplier row. If no match, the message is dropped (we don't auto-create
//   suppliers from inbound — too risky; spam reaching the procurement team).

import type { Supplier, SupplierConversation } from '@prisma/client'
import { prisma } from './prisma.js'
import { sendEmail } from './notify.js'
import { sendText as sendWhatsApp } from './whatsapp.js'

// ─── Outbound fan-out ─────────────────────────────────────────────────────────

interface DeliveryContext {
  conversation: Pick<SupplierConversation, 'id' | 'subject'>
  supplier: Pick<Supplier, 'id' | 'name' | 'email' | 'whatsappPhone' | 'phone'>
  body: string
  fromStaffName: string
  /** First message of the conversation? Used to set a friendlier subject. */
  isFirstMessage?: boolean
}

interface DeliveryResult {
  email: 'sent' | 'skipped' | 'failed'
  whatsapp: 'sent' | 'skipped' | 'failed'
  errors: string[]
}

/**
 * Best-effort fan-out to email + WhatsApp. Never throws — caller (the API
 * route handler) has already sent its 201 response by the time this runs,
 * so an exception here would just be an unhandled promise rejection.
 *
 * Each channel is attempted independently; one failing doesn't block the other.
 */
export async function deliverToSupplier(ctx: DeliveryContext): Promise<DeliveryResult> {
  const result: DeliveryResult = { email: 'skipped', whatsapp: 'skipped', errors: [] }

  const tasks: Array<Promise<void>> = []

  if (ctx.supplier.email) {
    tasks.push(
      sendChatEmail(ctx)
        .then(() => { result.email = 'sent' })
        .catch((err: Error) => { result.email = 'failed'; result.errors.push(`email: ${err.message}`) }),
    )
  }

  // Use whatsappPhone if explicitly set, else fall back to the billing phone
  // (many small suppliers use the same number for both — and missing the
  // notification because they didn't fill in a duplicate field would surprise
  // operators who'd expect "phone present → WhatsApp works").
  const waNumber = ctx.supplier.whatsappPhone ?? ctx.supplier.phone ?? null
  if (waNumber) {
    tasks.push(
      sendChatWhatsApp(ctx, waNumber)
        .then(() => { result.whatsapp = 'sent' })
        .catch((err: Error) => { result.whatsapp = 'failed'; result.errors.push(`whatsapp: ${err.message}`) }),
    )
  }

  await Promise.all(tasks)

  if (result.errors.length > 0) {
    console.warn(`[supplier-channels] partial delivery for conv=${ctx.conversation.id}:`, result.errors.join('; '))
  }

  return result
}

async function sendChatEmail(ctx: DeliveryContext): Promise<void> {
  if (!ctx.supplier.email) return
  const replyTo = buildReplyToAddress(ctx.conversation.id)
  const subject = ctx.isFirstMessage
    ? `${ctx.fromStaffName} from servd${ctx.conversation.subject ? ': ' + ctx.conversation.subject : ' wants to chat'}`
    : `Re: ${ctx.conversation.subject ?? 'Message from ' + ctx.fromStaffName}`

  const html = renderChatEmailHtml({
    supplierName: ctx.supplier.name,
    fromStaffName: ctx.fromStaffName,
    body: ctx.body,
    conversationSubject: ctx.conversation.subject ?? null,
    replyTo,
  })

  // sendEmail uses the SMTP transport in lib/notify.ts; it no-ops in dev when
  // SMTP_USER/PASS aren't set (logs to console instead).
  await sendEmailWithReplyTo(ctx.supplier.email, subject, html, replyTo)
}

async function sendChatWhatsApp(ctx: DeliveryContext, toNumber: string): Promise<void> {
  // Strip non-digits — Meta accepts E.164 digits only, no "+", spaces, or dashes.
  const normalized = toNumber.replace(/[^0-9]/g, '')
  if (!normalized) return

  // Plain text format. Could promote to interactive template later (delivery
  // confirmation buttons, etc.) but text keeps the dev → prod flip simple.
  const prefix = ctx.isFirstMessage
    ? `*${ctx.fromStaffName}* (servd):\n\n`
    : `*${ctx.fromStaffName}*:\n\n`

  await sendWhatsApp(normalized, prefix + ctx.body)
}

/**
 * Per-conversation reply address. Routes back through the Postmark inbound
 * webhook which extracts the conversation id from the local part. Format:
 *   chat-<conversationId>@<INBOUND_EMAIL_DOMAIN>
 *
 * Pure function so the webhook handler can use the same regex to parse.
 */
export function buildReplyToAddress(conversationId: string): string | null {
  const domain = process.env['INBOUND_EMAIL_DOMAIN']
  if (!domain) return null
  return `chat-${conversationId}@${domain}`
}

/** Inverse of buildReplyToAddress — extracts conversation id from a `to` field. */
export function parseConversationIdFromAddress(toAddress: string): string | null {
  // Be lenient: handle "Name <addr>", "addr+tag@domain", weird casing
  const match = /chat-([a-z0-9]+)@/i.exec(toAddress)
  return match?.[1] ?? null
}

// ─── Inbound supplier resolution ───────────────────────────────────────────────

/**
 * Resolve a sender email address to a Supplier. Case-insensitive match on the
 * `email` column. Returns null if no supplier has that email on file —
 * inbound webhook should drop the message rather than auto-create.
 */
export async function findSupplierByEmail(emailAddress: string): Promise<Supplier | null> {
  const normalized = emailAddress.trim().toLowerCase()
  if (!normalized) return null
  // Postgres ILIKE for case-insensitive equality; sufficient for our scale.
  // The same vendor can be on file in more than one company with the same
  // address. Prefer the one with the most recent thread (that is who the
  // reply is to), then the oldest row — deterministic, never "whichever
  // Postgres returns first". A reply-to hint (chat-<id>@) is resolved to its
  // own thread by findOrCreateInboundConversation.
  const rows = await prisma.$queryRaw<Supplier[]>`
    SELECT s.* FROM suppliers s
    WHERE LOWER(s.email) = ${normalized} AND s."deletedAt" IS NULL
    ORDER BY (SELECT MAX(c."updatedAt") FROM supplier_conversations c WHERE c."supplierId" = s.id) DESC NULLS LAST,
             s."createdAt" ASC
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Resolve an incoming WhatsApp `from` field (E.164 digits, e.g. "923001234567")
 * to a Supplier. Compares against both `whatsappPhone` and `phone` (after
 * stripping non-digits) to match the operator's expectation that "the number
 * I put on the supplier card is the one they'll WhatsApp from."
 */
export async function findSupplierByWhatsapp(fromDigits: string): Promise<Supplier | null> {
  const digits = fromDigits.replace(/[^0-9]/g, '')
  if (!digits) return null

  // We can't index regexp_replace, so this falls back to a sequential scan
  // on the suppliers table. At realistic sizes (few hundred suppliers per
  // tenant) this is fine; if it ever becomes hot, denormalise to a
  // `whatsappPhoneE164` column and index it.
  // Same tie-break as findSupplierByEmail when the number is on file in
  // more than one company.
  const rows = await prisma.$queryRaw<Supplier[]>`
    SELECT s.* FROM suppliers s
    WHERE s."deletedAt" IS NULL
      AND (
        regexp_replace(COALESCE(s."whatsappPhone", ''), '[^0-9]', '', 'g') = ${digits}
        OR regexp_replace(COALESCE(s."phone", ''), '[^0-9]', '', 'g') = ${digits}
      )
    ORDER BY (SELECT MAX(c."updatedAt") FROM supplier_conversations c WHERE c."supplierId" = s.id) DESC NULLS LAST,
             s."createdAt" ASC
    LIMIT 1
  `
  return rows[0] ?? null
}

// ─── Conversation finding/creation for inbound messages ──────────────────────

/**
 * For an inbound supplier message (channel = email or whatsapp), find the
 * conversation it belongs to. Strategy:
 *   1. If we have a known conversationId (from email reply-to parsing): use it.
 *   2. Otherwise: most recently-updated conversation for this supplier.
 *   3. Fallback: create a fresh conversation, threaded to the supplier's
 *      assigned staff member (or the first admin we find).
 *
 * Always returns a conversation id we can append to.
 */
export async function findOrCreateInboundConversation(opts: {
  supplier: Supplier
  hintedConversationId?: string | null
  channelHint: 'email' | 'whatsapp'
  initialSubject?: string
}): Promise<string> {
  // Prefer the explicit hint — only valid if it's actually for this supplier,
  // or for the same vendor on file in another company (same email address).
  // The sender lookup picks one row per address; without this a reply to
  // company B's thread from a vendor both companies use could land in
  // company A's latest thread with that vendor.
  if (opts.hintedConversationId) {
    const hinted = await prisma.supplierConversation.findUnique({
      where:   { id: opts.hintedConversationId },
      include: { supplier: { select: { email: true, deletedAt: true } } },
    })
    const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
      !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
    if (hinted && (
      hinted.supplierId === opts.supplier.id ||
      (opts.channelHint === 'email' && !hinted.supplier.deletedAt && sameEmail(hinted.supplier.email, opts.supplier.email))
    )) return hinted.id
  }

  // Fallback: latest conversation for this supplier
  const latest = await prisma.supplierConversation.findFirst({
    where: { supplierId: opts.supplier.id },
    orderBy: { updatedAt: 'desc' },
  })
  if (latest) return latest.id

  // Brand-new — create one. Try to attach to assignedStaff, else the first
  // admin of the supplier's company (never another company's admin).
  let staffId = opts.supplier.assignedStaffId
  if (!staffId) {
    const tenantId = opts.supplier.tenantId
    const admin = await prisma.user.findFirst({
      where: {
        role: 'admin', deletedAt: null,
        ...(tenantId ? { OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] } : {}),
      },
      orderBy: { createdAt: 'asc' },
    })
    if (!admin) {
      throw new Error('No staff user available to attach inbound supplier conversation to')
    }
    staffId = admin.id
  }

  const created = await prisma.supplierConversation.create({
    data: {
      supplierId: opts.supplier.id,
      staffId,
      subject: opts.initialSubject ?? (opts.channelHint === 'whatsapp' ? 'WhatsApp message' : 'Email reply'),
    },
  })
  return created.id
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wrapper around sendEmail that adds a `Reply-To` header. We need to do this
 * by directly using nodemailer rather than the existing sendEmail() helper
 * because the helper signature doesn't accept extra headers. Imported lazily
 * to keep the dev-mode no-op path in lib/notify.ts honest (the warning fires
 * once at module load there, not here).
 */
async function sendEmailWithReplyTo(to: string, subject: string, html: string, replyTo: string | null): Promise<void> {
  if (!process.env['SMTP_USER'] || !process.env['SMTP_PASS']) {
    // Mirror lib/notify.ts behaviour — silently skip in dev with a console hint.
    console.log(`[supplier-channels] EMAIL (no SMTP) to ${to}: ${subject}${replyTo ? ` (Reply-To: ${replyTo})` : ''}`)
    return
  }
  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.default.createTransport({
    host: process.env['SMTP_HOST'] ?? 'email-smtp.eu-north-1.amazonaws.com',
    port: parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: false,
    auth: { user: process.env['SMTP_USER'] ?? '', pass: process.env['SMTP_PASS'] ?? '' },
  })
  await transporter.sendMail({
    from: `servd <${process.env['SMTP_FROM'] ?? 'noreply@servd.app'}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  })
}

function renderChatEmailHtml(opts: {
  supplierName: string
  fromStaffName: string
  body: string
  conversationSubject: string | null
  replyTo: string | null
}): string {
  const escapedBody = opts.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

  const replyHint = opts.replyTo
    ? `<p style="color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px">
         Reply directly to this email to continue the conversation.
       </p>`
    : ''

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <div style="background:#0f172a;padding:20px 24px">
        <p style="color:#94a3b8;margin:0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase">servd · supplier chat</p>
        <h1 style="color:#fff;margin:6px 0 0 0;font-size:18px;font-weight:800">${opts.fromStaffName}</h1>
        ${opts.conversationSubject ? `<p style="color:#cbd5e1;margin:4px 0 0 0;font-size:13px">${opts.conversationSubject}</p>` : ''}
      </div>
      <div style="padding:24px">
        <p style="color:#374151;margin:0 0 8px 0">Hi ${opts.supplierName},</p>
        <div style="color:#111827;font-size:15px;line-height:1.55">${escapedBody}</div>
        ${replyHint}
      </div>
    </div>`
}
