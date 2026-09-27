// Reservation reminder worker.
//
// Runs every 5 minutes. For every booked/confirmed reservation:
//   • 24h before startTime → send 24h reminder (once)
//   •  2h before startTime → send  2h reminder (once)
//   • after endTime + 30m, status still 'confirmed' → flip to no_show
//
// Reminder flags on the row prevent double-sends. A failed send leaves the
// flag null and we'll retry next tick.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendSms, sendEmail } from '../lib/notify.js'

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

    const worker = new Worker(QUEUE_NAME, runReminderSweep, { connection: redis, concurrency: 1 })
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

async function runReminderSweep(): Promise<void> {
  const now = new Date()

  // Sweep expired waitlist promotion offers first — clears the offer fields
  // and tries to roll the slot to the next eligible candidate.
  try {
    const { sweepExpiredPromotions } = await import('../modules/reservations/waitlistPromotion.js')
    await sweepExpiredPromotions()
  } catch (err) {
    console.error('[reservationReminders] promotion sweep failed:', (err as Error).message)
  }

  // 24h reminders — startTime within (24h±2.5min)
  const window24Start = new Date(now.getTime() + 24 * 3600_000 - 150_000)
  const window24End   = new Date(now.getTime() + 24 * 3600_000 + 150_000)
  const due24 = await prisma.reservation.findMany({
    where: {
      status: { in: ['booked', 'confirmed'] },
      reminder24hSentAt: null,
      startTime: { gte: window24Start, lte: window24End },
    },
    include: { concept: { select: { name: true } } },
  })
  for (const r of due24) {
    await sendReminder(r, '24h')
    await prisma.reservation.update({ where: { id: r.id }, data: { reminder24hSentAt: new Date() } })
  }

  // 2h reminders — startTime within (2h±2.5min)
  const window2Start = new Date(now.getTime() + 2 * 3600_000 - 150_000)
  const window2End   = new Date(now.getTime() + 2 * 3600_000 + 150_000)
  const due2 = await prisma.reservation.findMany({
    where: {
      status: { in: ['booked', 'confirmed'] },
      reminder2hSentAt: null,
      startTime: { gte: window2Start, lte: window2End },
    },
    include: { concept: { select: { name: true } } },
  })
  for (const r of due2) {
    await sendReminder(r, '2h')
    await prisma.reservation.update({ where: { id: r.id }, data: { reminder2hSentAt: new Date() } })
  }

  // No-show sweep — confirmed/booked, endTime > 30 min ago, never seated.
  // Each row goes through markNoShow — the same path as a host's manual
  // no-show — so deposit capture, the strike, rollups, waitlist promotion and
  // the socket event are identical either way (D4). markNoShow claims the row
  // conditionally, so a host marking it in the same minute is not doubled.
  const noShowCutoff = new Date(now.getTime() - 30 * 60_000)
  const stale = await prisma.reservation.findMany({
    where: {
      status: { in: ['booked', 'confirmed'] },
      seatedAt: null,
      endTime: { lt: noShowCutoff },
    },
    select: { id: true },
  })
  if (stale.length === 0) return

  const { markNoShow } = await import('../modules/reservations/noShow.js')
  for (const r of stale) {
    try {
      await markNoShow(r.id, { reason: 'Auto: no-show after window', actorId: null, auto: true })
    } catch (err) {
      console.error(`[reservationReminders] auto no-show failed for ${r.id}:`, (err as Error).message)
    }
  }
}

async function sendReminder(
  r: { id: string; guestName: string; guestPhone: string | null; guestEmail: string | null; partySize: number; startTime: Date; confirmToken: string | null; concept: { name: string } },
  kind: '24h' | '2h',
) {
  const when = r.startTime.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const confirmUrl = r.confirmToken ? `${STOREFRONT_URL}/reserve/confirm/${r.confirmToken}` : null
  const lead = kind === '24h' ? 'tomorrow' : 'in 2 hours'
  const sms  = `${r.concept.name}: reminder — your reservation for ${r.partySize} is ${lead} (${when} PKT).${confirmUrl ? ' Cancel: ' + confirmUrl : ''}`

  if (r.guestPhone) {
    await sendSms(r.guestPhone, sms).catch(() => {})
  }
  if (r.guestEmail) {
    const html = `<p>Hi ${r.guestName},</p>
      <p>Just a reminder — your table for ${r.partySize} at <strong>${r.concept.name}</strong> is <strong>${lead}</strong> (${when} PKT).</p>
      ${confirmUrl ? `<p><a href="${confirmUrl}">Cancel if you can't make it →</a></p>` : ''}`
    await sendEmail(r.guestEmail, `${r.concept.name}: reservation reminder`, html).catch(() => {})
  }
}
