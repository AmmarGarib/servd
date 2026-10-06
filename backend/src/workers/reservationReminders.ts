// Reservation reminder worker.
//
// Runs every 5 minutes. Timings come from the owning company's
// ReservationPolicy (admin → Configuration → Reservation policy), never from
// constants here:
//   • remindersEnabled     — off = no reminders for that company's bookings
//   • reminderHoursBefore  — the reminder goes out this many hours before
//                            startTime (once; stamped on reminder24hSentAt,
//                            which is the "reminder sent" flag whatever the
//                            lead time is)
//   • noShowGraceMinutes   — a booked/confirmed party not seated by
//                            startTime + grace is marked no-show
//
// This used to hardcode a 24h and a 2h reminder and an auto no-show at
// endTime + 30 min, while the policy screen let the operator edit values that
// nothing read. The auto no-show also records a strike and captures a
// deposit, so the company's own grace window must be what decides it.
//
// The phone reminder goes over WhatsApp (owner decision 17: WhatsApp and
// email only, no SMS). Reminder flags prevent double-sends; a reminder is
// stamped after a send attempt so a dead channel cannot spam on every tick.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendEmail } from '../lib/notify.js'
import { sendText as sendWhatsApp } from '../lib/whatsapp.js'
import { getReservationPolicy } from '../lib/setup-config.js'
import { formatBrandName } from '../lib/brandName.js'

const QUEUE_NAME = 'reservation-reminders'
const RUN_EVERY_MS = 5 * 60_000

export function startReservationReminderWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'reservation-reminders-recurring',
    }).catch((err: Error) => console.warn('[reservationReminders] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, () => runReminderSweep(), { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[reservationReminders] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[reservationReminders] worker disabled:', (err as Error).message)
    return null
  }
}

const STOREFRONT_URL = process.env['STOREFRONT_URL'] ?? 'https://order.servd.pk'

type Policy = { remindersEnabled: boolean; reminderHoursBefore: number; noShowGraceMinutes: number }

/** Policy per company for one sweep (setup-config caches across sweeps too). */
function policyReader() {
  const memo = new Map<string, Promise<Policy>>()
  return (tenantId: string | null | undefined): Promise<Policy> => {
    const key = tenantId ?? '-'
    let p = memo.get(key)
    if (!p) {
      p = getReservationPolicy(tenantId ?? null).then((row) => ({
        remindersEnabled:    row?.remindersEnabled ?? true,
        reminderHoursBefore: row?.reminderHoursBefore ?? 24,
        noShowGraceMinutes:  row?.noShowGraceMinutes ?? 15,
      }))
      memo.set(key, p)
    }
    return p
  }
}

/** One sweep. Exported for tests; `now` is injectable for the same reason. */
export async function runReminderSweep(now: Date = new Date()): Promise<{ reminded: string[]; noShows: string[] }> {
  const reminded: string[] = []
  const noShows: string[] = []
  const policyFor = policyReader()

  // Sweep expired waitlist promotion offers first — clears the offer fields
  // and tries to roll the slot to the next eligible candidate.
  try {
    const { sweepExpiredPromotions } = await import('../modules/reservations/waitlistPromotion.js')
    await sweepExpiredPromotions()
  } catch (err) {
    console.error('[reservationReminders] promotion sweep failed:', (err as Error).message)
  }

  // ── Reminders ────────────────────────────────────────────────────────────
  // Candidates: upcoming, not yet reminded, starting within the LONGEST lead
  // time any company uses. Each row is then held to its own company's policy.
  const longest = await prisma.reservationPolicy.aggregate({ _max: { reminderHoursBefore: true } })
  const maxLeadH = Math.max(longest._max.reminderHoursBefore ?? 24, 24)
  const upcoming = await prisma.reservation.findMany({
    where: {
      status: { in: ['booked', 'confirmed'] },
      reminder24hSentAt: null,
      startTime: { gt: now, lte: new Date(now.getTime() + maxLeadH * 3600_000) },
    },
    include: { concept: { select: { name: true, tenantId: true } } },
  })
  for (const r of upcoming) {
    const policy = await policyFor(r.concept.tenantId)
    if (!policy.remindersEnabled) continue
    const dueAt = r.startTime.getTime() - policy.reminderHoursBefore * 3600_000
    if (now.getTime() < dueAt) continue
    // A booking made after its reminder would have gone out (e.g. booked
    // tonight for tonight) has just been confirmed — no "reminder" for it.
    if (r.createdAt.getTime() > dueAt) continue
    await sendReminder(r, policy.reminderHoursBefore)
    await prisma.reservation.update({ where: { id: r.id }, data: { reminder24hSentAt: new Date() } })
    reminded.push(r.id)
  }

  // ── No-show sweep ────────────────────────────────────────────────────────
  // booked/confirmed, never seated, and past startTime + the company's grace.
  // Each row goes through markNoShow — the same path as a host's manual
  // no-show — so deposit capture, the strike, rollups, waitlist promotion and
  // the socket event are identical either way (D4). markNoShow claims the row
  // conditionally, so a host marking it in the same minute is not doubled.
  const started = await prisma.reservation.findMany({
    where: {
      status: { in: ['booked', 'confirmed'] },
      seatedAt: null,
      startTime: { lt: now },
    },
    select: { id: true, startTime: true, concept: { select: { tenantId: true } } },
  })
  if (started.length === 0) return { reminded, noShows }

  const { markNoShow } = await import('../modules/reservations/noShow.js')
  for (const r of started) {
    const policy = await policyFor(r.concept.tenantId)
    const cutoff = r.startTime.getTime() + policy.noShowGraceMinutes * 60_000
    if (now.getTime() <= cutoff) continue
    try {
      const res = await markNoShow(r.id, {
        reason: `Auto: not seated within ${policy.noShowGraceMinutes} min of the booking`,
        actorId: null,
        auto: true,
      })
      if (res.marked) noShows.push(r.id)
    } catch (err) {
      console.error(`[reservationReminders] auto no-show failed for ${r.id}:`, (err as Error).message)
    }
  }
  return { reminded, noShows }
}

function leadLabel(hours: number): string {
  if (hours >= 20 && hours <= 28) return 'tomorrow'
  if (hours === 1) return 'in 1 hour'
  if (hours < 48) return `in ${hours} hours`
  return `in ${Math.round(hours / 24)} days`
}

async function sendReminder(
  r: { id: string; guestName: string; guestPhone: string | null; guestEmail: string | null; partySize: number; startTime: Date; confirmToken: string | null; concept: { name: string } },
  leadHours: number,
) {
  const when = r.startTime.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const confirmUrl = r.confirmToken ? `${STOREFRONT_URL}/reserve/confirm/${r.confirmToken}` : null
  const lead = leadLabel(leadHours)
  const text = `${formatBrandName(r.concept.name)}: reminder — your reservation for ${r.partySize} is ${lead} (${when} PKT).${confirmUrl ? ' Cancel: ' + confirmUrl : ''}`

  const digits = (r.guestPhone ?? '').replace(/[^\d]/g, '')
  if (digits) {
    await sendWhatsApp(digits, text).catch((err: Error) => {
      console.warn(`[reservationReminders] WhatsApp reminder failed for ${r.id}:`, err.message)
    })
  }
  if (r.guestEmail) {
    const html = `<p>Hi ${r.guestName},</p>
      <p>Just a reminder — your table for ${r.partySize} at <strong>${formatBrandName(r.concept.name)}</strong> is <strong>${lead}</strong> (${when} PKT).</p>
      ${confirmUrl ? `<p><a href="${confirmUrl}">Cancel if you can't make it →</a></p>` : ''}`
    await sendEmail(r.guestEmail, `${formatBrandName(r.concept.name)}: reservation reminder`, html).catch(() => {})
  }
}
