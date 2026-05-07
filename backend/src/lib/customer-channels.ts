// ─── CRM outreach: multi-channel delivery for customer chat ────────────────────
// Sibling of lib/supplier-channels.ts. Same shape, different table names.
// Kept as a separate file (rather than a generic helper parameterised by
// "supplier" vs "customer") because the inbound routing rules are subtly
// different per side — customers can be auto-matched on `email` or `phone`,
// suppliers also on `whatsappPhone`; copy-paste-and-adapt is clearer than a
// single 80-line helper with 6 boolean flags.

import type { Customer, CustomerConversation } from '@prisma/client'
import { prisma } from './prisma.js'
import { sendText as sendWhatsApp } from './whatsapp.js'

// ─── Outbound fan-out ─────────────────────────────────────────────────────────

interface DeliveryContext {
  conversation: Pick<CustomerConversation, 'id' | 'subject'>
  customer: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
  body: string
  fromStaffName: string
  isFirstMessage?: boolean
}

interface DeliveryResult {
  email: 'sent' | 'skipped' | 'failed'
  whatsapp: 'sent' | 'skipped' | 'failed'
  errors: string[]
}

/** Best-effort fan-out — never throws. See supplier-channels.ts for rationale. */
export async function deliverToCustomer(ctx: DeliveryContext): Promise<DeliveryResult> {
  const result: DeliveryResult = { email: 'skipped', whatsapp: 'skipped', errors: [] }
  const tasks: Array<Promise<void>> = []

  if (ctx.customer.email) {
    tasks.push(
      sendChatEmail(ctx)
        .then(() => { result.email = 'sent' })
        .catch((err: Error) => { result.email = 'failed'; result.errors.push(`email: ${err.message}`) }),
    )
  }
  if (ctx.customer.phone) {
    tasks.push(
      sendChatWhatsApp(ctx, ctx.customer.phone)
        .then(() => { result.whatsapp = 'sent' })
        .catch((err: Error) => { result.whatsapp = 'failed'; result.errors.push(`whatsapp: ${err.message}`) }),
    )
  }

  await Promise.all(tasks)
  if (result.errors.length > 0) {
    console.warn(`[customer-channels] partial delivery for conv=${ctx.conversation.id}:`, result.errors.join('; '))
  }
  return result
}

async function sendChatEmail(ctx: DeliveryContext): Promise<void> {
  if (!ctx.customer.email) return
  const replyTo = buildCustomerReplyTo(ctx.conversation.id)
  const subject = ctx.isFirstMessage
    ? `${ctx.fromStaffName} from servd${ctx.conversation.subject ? ': ' + ctx.conversation.subject : ' got back to you'}`
    : `Re: ${ctx.conversation.subject ?? 'Message from ' + ctx.fromStaffName}`

  const html = renderChatEmailHtml({
    customerName: ctx.customer.name,
    fromStaffName: ctx.fromStaffName,
    body: ctx.body,
    conversationSubject: ctx.conversation.subject ?? null,
    replyTo,
  })

  await sendEmailWithReplyTo(ctx.customer.email, subject, html, replyTo)
}

async function sendChatWhatsApp(ctx: DeliveryContext, toNumber: string): Promise<void> {
  const normalized = toNumber.replace(/[^0-9]/g, '')
  if (!normalized) return
  const prefix = ctx.isFirstMessage
    ? `*${ctx.fromStaffName}* (servd):\n\n`
    : `*${ctx.fromStaffName}*:\n\n`
  await sendWhatsApp(normalized, prefix + ctx.body)
}

// ─── Reply-address routing (mirror of supplier-channels) ─────────────────────
// Distinct prefix `crm-` vs the supplier `chat-` — one webhook, two thread
// types, prefix tells us which table to look in. Keeps a single mailbox /
// single Postmark inbound route.
export function buildCustomerReplyTo(conversationId: string): string | null {
  const domain = process.env['INBOUND_EMAIL_DOMAIN']
  if (!domain) return null
  return `crm-${conversationId}@${domain}`
}

export function parseCustomerConversationId(toAddress: string): string | null {
  const match = /crm-([a-z0-9]+)@/i.exec(toAddress)
  return match?.[1] ?? null
}

// ─── Inbound resolution ───────────────────────────────────────────────────────

export async function findCustomerByEmail(emailAddress: string): Promise<Customer | null> {
  const normalized = emailAddress.trim().toLowerCase()
  if (!normalized) return null
  const rows = await prisma.$queryRaw<Customer[]>`
    SELECT * FROM customers WHERE LOWER(email) = ${normalized} AND "deletedAt" IS NULL LIMIT 1
  `
  return rows[0] ?? null
}

export async function findCustomerByPhone(fromDigits: string): Promise<Customer | null> {
  const digits = fromDigits.replace(/[^0-9]/g, '')
  if (!digits) return null
  const rows = await prisma.$queryRaw<Customer[]>`
    SELECT * FROM customers
    WHERE "deletedAt" IS NULL
      AND regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g') = ${digits}
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Find or open a customer conversation. Strategy mirrors supplier-channels:
 *   1. Use explicit hint id if it belongs to this customer.
 *   2. Latest conversation for this customer.
 *   3. Create a fresh thread, attached to the first available admin staff.
 */
export async function findOrCreateCustomerConversation(opts: {
  customer: Customer
  hintedConversationId?: string | null
  channelHint: 'email' | 'whatsapp'
  initialSubject?: string
}): Promise<string> {
  if (opts.hintedConversationId) {
    const hinted = await prisma.customerConversation.findUnique({ where: { id: opts.hintedConversationId } })
    if (hinted && hinted.customerId === opts.customer.id) return hinted.id
  }

  const latest = await prisma.customerConversation.findFirst({
    where: { customerId: opts.customer.id },
    orderBy: { updatedAt: 'desc' },
  })
  if (latest) return latest.id

  // Inbound-initiated thread (no staff yet started one) — attach to an admin
  const admin = await prisma.user.findFirst({ where: { role: 'admin', deletedAt: null }, orderBy: { createdAt: 'asc' } })
  if (!admin) throw new Error('No staff user available to attach inbound customer conversation to')

  const created = await prisma.customerConversation.create({
    data: {
      customerId: opts.customer.id,
      staffId:    admin.id,
      subject:    opts.initialSubject ?? (opts.channelHint === 'whatsapp' ? 'WhatsApp message' : 'Email reply'),
      source:     'manual',
    },
  })
  return created.id
}

/**
 * True iff this customer has an active CRM thread right now — used by the
 * WhatsApp router to decide whether an inbound "hi" is a chat reply vs the
 * start of a new order.
 *
 * "Active" means activity in the last 24 hours. Critical: without a time
 * decay, a member who once had a complaint thread would never be able to
 * place a WhatsApp order again, because every greeting would route to the
 * stale thread instead of the order flow. 24h is short enough that an
 * actively-replying customer keeps it alive (replies bump `updatedAt`),
 * long enough that staff have a window to follow up before the thread
 * "expires" back to ordering.
 *
 * When we add an explicit `closedAt` field this should also exclude closed
 * threads — but the time-decay alone is the right primary signal.
 */
export async function hasOpenCustomerConversation(customerId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const count = await prisma.customerConversation.count({
    where: { customerId, updatedAt: { gte: cutoff } },
  })
  return count > 0
}

// ─── Helpers (kept local — small enough to not warrant a shared module) ──────

async function sendEmailWithReplyTo(to: string, subject: string, html: string, replyTo: string | null): Promise<void> {
  if (!process.env['SMTP_USER'] || !process.env['SMTP_PASS']) {
    console.log(`[customer-channels] EMAIL (no SMTP) to ${to}: ${subject}${replyTo ? ` (Reply-To: ${replyTo})` : ''}`)
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
    to, subject, html, ...(replyTo ? { replyTo } : {}),
  })
}

function renderChatEmailHtml(opts: {
  customerName: string
  fromStaffName: string
  body: string
  conversationSubject: string | null
  replyTo: string | null
}): string {
  const escaped = opts.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  const replyHint = opts.replyTo
    ? `<p style="color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px">
         Reply directly to this email and we'll see it.
       </p>`
    : ''
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <div style="background:#16a34a;padding:20px 24px">
        <p style="color:#bbf7d0;margin:0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase">servd · message</p>
        <h1 style="color:#fff;margin:6px 0 0 0;font-size:18px;font-weight:800">${opts.fromStaffName}</h1>
        ${opts.conversationSubject ? `<p style="color:#dcfce7;margin:4px 0 0 0;font-size:13px">${opts.conversationSubject}</p>` : ''}
      </div>
      <div style="padding:24px">
        <p style="color:#374151;margin:0 0 8px 0">Hi ${opts.customerName},</p>
        <div style="color:#111827;font-size:15px;line-height:1.55">${escaped}</div>
        ${replyHint}
      </div>
    </div>`
}
