// Scheduled campaigns (owner B9, 2026-10-26: "a campaign can only be a draft;
// nothing sends at the scheduled time").
//
// Every minute: the campaigns whose scheduledAt has passed are sent, company
// by company, one campaign at a time, through the ONE sender
// (modules/crm/campaignBroadcast.ts claimAndBroadcast — the same claim as
// "Send now", so a campaign goes out exactly once however many processes run
// this, or race a manual press). The audience is the campaign's segment inside
// its own company. A campaign that can no longer be sent (WhatsApp before a
// campaign number exists, an old saved-filter segment) is marked failed with
// nothing sent, so it is not retried every minute.

import { serviceClient } from '../lib/prisma.js'
import { runWithRlsContext } from '../lib/rlsContext.js'
import { AppError } from '../lib/errors.js'
import { claimAndBroadcast, assertCampaignChannel, sendableSegment, CAMPAIGN_SEND_SELECT } from '../modules/crm/campaignBroadcast.js'

const RUN_EVERY_MS = 60_000
/** At most this many due campaigns per company per tick (the rest wait a minute). */
const PER_COMPANY_PER_TICK = 5

const log = {
  info: (o: object, m: string) => console.info(`[campaignSchedule] ${m}`, o),
  warn: (o: object, m: string) => console.warn(`[campaignSchedule] ${m}`, o),
  error: (o: object, m: string) => console.error(`[campaignSchedule] ${m}`, o),
}

/** Send every due scheduled campaign once. Returns how many were sent (claimed). */
export async function sendDueCampaigns(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const due = await serviceClient.campaign.findMany({
    where: { status: 'scheduled', scheduledAt: { lte: now }, tenantId: { not: null } },
    select: { ...CAMPAIGN_SEND_SELECT, scheduledAt: true },
    orderBy: [{ tenantId: 'asc' }, { scheduledAt: 'asc' }],
    take: 500,
  })
  const byCompany = new Map<string, typeof due>()
  for (const c of due) {
    const list = byCompany.get(c.tenantId!) ?? []
    if (list.length < PER_COMPANY_PER_TICK) list.push(c)
    byCompany.set(c.tenantId!, list)
  }
  let sent = 0
  let failed = 0
  for (const [tenantId, list] of byCompany) {
    for (const c of list) {
      try {
        // Refused before any claim: mark failed (nothing sent), conditional on still being scheduled.
        try {
          assertCampaignChannel(c.channel)
          sendableSegment(c)
        } catch (err) {
          if (err instanceof AppError) {
            await serviceClient.campaign.updateMany({ where: { id: c.id, status: 'scheduled' }, data: { status: 'failed' } })
            log.warn({ campaignId: c.id, tenantId, code: err.code }, 'scheduled campaign refused, nothing sent')
            failed++
            continue
          }
          throw err
        }
        const res = await runWithRlsContext({ tenantIds: [tenantId] }, () =>
          claimAndBroadcast({ ...c, tenantId }, { status: 'scheduled', scheduledAt: { lte: now } }, log))
        await res.run // one campaign at a time: the broadcast paces itself
        sent++
      } catch (err) {
        if (err instanceof AppError && err.code === 'CAMPAIGN_ALREADY_SENT') continue // a manual press or another process won
        log.warn({ campaignId: c.id, tenantId, err: (err as Error).message }, 'scheduled campaign send failed')
      }
    }
  }
  return { sent, failed }
}

export function startCampaignScheduleWorker(): NodeJS.Timeout {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await sendDueCampaigns()
      if (r.sent || r.failed) console.info(`[campaignSchedule] sent ${r.sent}, refused ${r.failed} scheduled campaign(s)`)
    } catch (err) {
      console.warn('[campaignSchedule] sweep failed:', (err as Error).message)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void tick() }, RUN_EVERY_MS)
  timer.unref()
  void tick()
  return timer
}
