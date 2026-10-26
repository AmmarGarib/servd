// Campaign broadcast — the ONE sender of a campaign, used by "Send now"
// (POST /crm/campaigns/:id/send) and by the scheduled-campaign worker
// (workers/campaignSchedule.ts; owner B9, 2026-10-26: scheduled campaigns used
// to stay drafts forever).
//
//  - Audience = the campaign's segment / brands INSIDE its own company
//    (campaignAudienceWhere: reachable at that company — marketing opt-out and
//    its bans — ∩ its brands ∩ the segment ∩ a contact for the channel). Never
//    another company's customers.
//  - Exactly once: the conditional claim (status → sent) runs before anything
//    is counted or sent; a second press, or a press racing the worker, is 409.
//  - One CampaignSend row per recipient (queued → sent | failed), the unit of
//    click / open tracking and unsubscribe.
//  - Channels: EMAIL only, through lib/notify.ts sendEmail (which asks the
//    practice-copy block in lib/mailer.ts and skips a test company). WhatsApp
//    (and a legacy 'sms' campaign, which went over the same gateway) is refused
//    with 422 WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER (owner C19, 2026-10-26: "I'll
//    add per brand numbers as we scale ops") — campaigns must never go out on
//    the shared login-code WhatsApp number. Re-open it only with a separate
//    campaign number.
//  - Paced: a short pause every SEND_BATCH messages (CAMPAIGN_SEND_PAUSE_MS,
//    default 500 ms) so a big list never floods the mail server.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { sendEmail } from '../../lib/notify.js'
import { sandboxBlocks } from '../../lib/sandbox.js'
import { reachableAtCompany, companyAudience, unsubscribeUrl } from '../../lib/marketingAudience.js'
import { testCompanyBlocks, customerScope } from '../../lib/outboundScope.js'
import { WAITLIST_AUDIENCE, waitlistMemberWhere } from '../waitlist/service.js'
import { isSegmentSlug, segmentMemberIds } from './segmentComputation.js'

// ─── Campaign link / open tracking helpers ────────────────────────────────────
// Rewrite links in outbound campaign content to route through the public
// /t/c/:sendId redirect (records a click, then forwards), and embed a 1x1 open
// pixel in email. Per-recipient sendId attributes engagement → CTR / open rate.

const URL_RX = /(https?:\/\/[^\s<>"')]+)/g
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function trackUrl(target: string, sendId: string, apiBase: string): string {
  return `${apiBase}/api/v1/t/c/${sendId}?u=${encodeURIComponent(target)}`
}
export function trackedHtml(body: string, sendId: string, apiBase: string): string {
  let out = ''
  let last = 0
  body.replace(URL_RX, (m: string, _g1: string, offset: number) => {
    out += escapeHtml(body.slice(last, offset))
    out += `<a href="${trackUrl(m, sendId, apiBase)}">${escapeHtml(m)}</a>`
    last = offset + m.length
    return m
  })
  out += escapeHtml(body.slice(last))
  const pixel = `<img src="${apiBase}/api/v1/t/o/${sendId}" width="1" height="1" alt="" style="display:none" />`
  return `<p>${out}</p>${pixel}`
}

// A campaign's segment is a computed customer segment OR the servd-level
// new-brand waitlist (modules/waitlist). Anything else is refused — an unknown
// slug must never widen to "everyone".
export const isCampaignSegment = (slug: string): boolean => isSegmentSlug(slug) || slug === WAITLIST_AUDIENCE

/** The customer segment a campaign targets: null = none, 'legacy' = an old saved filter. */
export function campaignSegmentOf(segment: { filters: unknown } | null | undefined): string | null | 'legacy' {
  if (!segment) return null
  const f = segment.filters as { customerSegment?: unknown } | null
  return typeof f?.customerSegment === 'string' && isCampaignSegment(f.customerSegment) ? f.customerSegment : 'legacy'
}

export async function companyConceptIds(tenantId: string | null): Promise<string[]> {
  if (!tenantId) return []
  const rows = await prisma.concept.findMany({ where: { tenantId, deletedAt: null }, select: { id: true } })
  return rows.map((r) => r.id)
}

/**
 * The recipient filter for a campaign — reachable at the owning company
 * (lib/marketingAudience.ts: opt-out model, this company's bans) ∩ the
 * company's brand audience ∩ the segment's members ∩ has a contact for the
 * channel. Shared by the audience preview and the real send so the number
 * shown is the number sent. An empty `conceptIds` means every brand of the
 * company, never the platform.
 */
export async function campaignAudienceWhere(c: {
  tenantId: string
  companyConcepts: string[]
  conceptIds?: string[] | null
  segment?: string | null
  channel?: string | null
}): Promise<Prisma.CustomerWhereInput> {
  // The waitlist audience is ONLY the list's members (servd-level, not limited
  // to this company's customers), still under the sending company's
  // reachability rules: marketing opt-out and that company's bans.
  const audience = c.segment === WAITLIST_AUDIENCE ? waitlistMemberWhere() : companyAudience(c.companyConcepts, c.conceptIds)
  const and: Prisma.CustomerWhereInput[] = [await reachableAtCompany(c.tenantId), audience]
  if (c.channel === 'email') and.push({ email: { not: null } })
  if (c.channel === 'sms' || c.channel === 'whatsapp') and.push({ phone: { not: null } })
  if (c.segment && c.segment !== WAITLIST_AUDIENCE) and.push({ id: { in: await segmentMemberIds(c.segment, [c.tenantId]) } })
  return { AND: and }
}

/** 422 unless the channel may carry a campaign today (email only — see the header). */
export function assertCampaignChannel(channel: string): void {
  if (channel === 'whatsapp' || channel === 'sms') {
    throw new AppError('WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER',
      'WhatsApp campaigns are off until a separate campaign number is added — the shared servd number carries sign-in codes. Send this campaign by email.', 422)
  }
  if (channel !== 'email') throw new AppError('CHANNEL_NOT_SUPPORTED', `Campaigns cannot be sent by ${channel}`, 422)
}

export interface CampaignRow {
  id: string
  tenantId: string | null
  status: string
  channel: string
  name: string
  subject: string | null
  body: string
  conceptIds: string[]
  segment: { tenantId: string | null; filters: unknown } | null
}

/** The segment slug to send to; 422 LEGACY_SEGMENT for an old saved filter (or another company's segment row). */
export function sendableSegment(c: CampaignRow): string | null {
  const seg = c.segment && c.segment.tenantId !== c.tenantId ? 'legacy' : campaignSegmentOf(c.segment)
  if (seg === 'legacy') {
    throw new AppError('LEGACY_SEGMENT', 'This campaign targets an old saved filter. Create it again with a segment from /crm/segments.', 422)
  }
  return seg
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void }

const SEND_BATCH = 25
const pauseMs = () => {
  const n = Number(process.env['CAMPAIGN_SEND_PAUSE_MS'])
  return Number.isFinite(n) && n >= 0 ? n : 500
}

/**
 * Claim and broadcast one campaign. `claimWhere` narrows the claim (send now:
 * draft or scheduled; the worker: scheduled and due). Returns the recipient
 * count and the running broadcast (the route does not wait for it; the worker
 * does). 409 CAMPAIGN_ALREADY_SENT when the claim lost.
 */
export async function claimAndBroadcast(
  c: CampaignRow & { tenantId: string },
  claimWhere: Prisma.CampaignWhereInput,
  log: Log,
): Promise<{ recipientCount: number; run: Promise<void> }> {
  assertCampaignChannel(c.channel)
  const seg = sendableSegment(c)
  const where = await campaignAudienceWhere({
    tenantId: c.tenantId,
    companyConcepts: await companyConceptIds(c.tenantId),
    conceptIds: c.conceptIds,
    segment: seg,
    channel: c.channel,
  })
  // Claim BEFORE anything is counted or sent (W3A-RV-01): the conditional
  // update is the single flight — only one caller moves it to sent.
  const claimed = await prisma.campaign.updateMany({
    where: { AND: [{ id: c.id, tenantId: c.tenantId }, claimWhere] },
    data: { status: 'sent', sentAt: new Date() },
  })
  if (claimed.count === 0) throw new AppError('CAMPAIGN_ALREADY_SENT', 'This campaign has already been sent', 409)
  let recipientCount: number
  try {
    recipientCount = await prisma.customer.count({ where })
  } catch (err) {
    // Nothing went out yet — give it back so it can be sent again.
    await prisma.campaign.update({ where: { id: c.id }, data: { status: c.status as 'draft', sentAt: null } }).catch(() => {})
    throw err
  }
  const run = broadcast(c, where, recipientCount, log)
  return { recipientCount, run }
}

async function broadcast(c: CampaignRow & { tenantId: string }, where: Prisma.CustomerWhereInput, recipientCount: number, log: Log): Promise<void> {
  const campaignId = c.id
  const apiBase = process.env['API_URL'] ?? 'http://localhost:3001'
  // A test company never messages customers (lib/outboundScope.ts): every
  // recipient is recorded as not sent, with the reason, and nothing goes out.
  const scope = customerScope(c.tenantId)
  const testCompany = await testCompanyBlocks('email', scope)
  const pause = pauseMs()
  let sent = 0
  let attempted = 0
  try {
    let cursor: string | undefined
    for (;;) {
      // Walk the audience in pages rather than loading it whole.
      const page = await prisma.customer.findMany({
        where,
        select: { id: true, email: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]!.id
      for (const cust of page) {
        let send: { id: string }
        try {
          send = await prisma.campaignSend.create({ data: { campaignId, customerId: cust.id, status: 'queued' }, select: { id: true } })
        } catch (err) {
          log.warn({ customerId: cust.id, err }, 'CampaignSend row create failed')
          continue
        }
        if (testCompany) {
          await prisma.campaignSend.update({ where: { id: send.id }, data: { status: 'failed', errorMsg: 'Test company: not sent to customers' } })
          continue
        }
        if (!cust.email) {
          await prisma.campaignSend.update({ where: { id: send.id }, data: { status: 'failed', errorMsg: 'no contact for channel' } })
          continue
        }
        // Practice copy: nothing leaves; the recipient is recorded as not sent, with the reason.
        if (sandboxBlocks('email', { to: cust.email, summary: `campaign ${campaignId}` })) {
          await prisma.campaignSend.update({ where: { id: send.id }, data: { status: 'failed', errorMsg: 'Practice copy: not sent to customers' } })
          continue
        }
        try {
          const stop = unsubscribeUrl(send.id)
          const html = trackedHtml(c.body, send.id, apiBase) +
            `<p style="font-size:11px;color:#888;margin-top:24px">Don't want these? <a href="${stop}">Unsubscribe</a>.</p>`
          await sendEmail(cust.email, c.subject ?? c.name, html, 'campaign', scope)
          sent++
          await prisma.campaignSend.update({ where: { id: send.id }, data: { status: 'sent', sentAt: new Date() } })
        } catch (err) {
          await prisma.campaignSend
            .update({ where: { id: send.id }, data: { status: 'failed', errorMsg: String((err as Error).message).slice(0, 280) } })
            .catch(() => { /* ignore */ })
          log.warn({ customerId: cust.id, err }, 'Campaign send failed for customer')
        }
        attempted++
        if (pause > 0 && attempted % SEND_BATCH === 0) await new Promise((r) => setTimeout(r, pause))
      }
    }
    // Status and sentAt were set by the claim; only the count lands here.
    await prisma.campaign.update({ where: { id: campaignId }, data: { recipientCount } })
    log.info({ campaignId, sent, total: recipientCount }, 'Campaign broadcast complete')
  } catch (err) {
    // Part of the audience may already have it: mark it failed, never back to
    // draft, so it cannot be re-sent to the same people.
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'failed', recipientCount } }).catch(() => {})
    log.error({ campaignId, sent, err }, 'Campaign broadcast aborted')
  }
}

/** Campaign rows the broadcast needs (a select usable on every client). */
export const CAMPAIGN_SEND_SELECT = {
  id: true, tenantId: true, status: true, channel: true, name: true, subject: true, body: true, conceptIds: true,
  segment: { select: { tenantId: true, filters: true } },
} as const
