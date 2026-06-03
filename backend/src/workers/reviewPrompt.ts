// Post-order review prompt worker.
//
// Fires every 5 minutes. For every order that:
//   • has status='completed'
//   • completed at least 30 minutes ago
//   • has not yet been reviewed
//   • has not yet received a prompt (reviewPromptSentAt is null)
//   • has a customer with a phone OR email on file (not a pure walk-in)
//
// …send a single SMS + email asking them to rate the meal. Stamps
// reviewPromptSentAt so we don't re-prompt on the next tick.
//
// Why 30 minutes: we want the meal experience to settle in their memory.
// Too soon and they're still in the parking lot; too late and they've moved on.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendSms, sendEmail } from '../lib/notify.js'

const QUEUE_NAME = 'review-prompts'
const RUN_EVERY_MS = 5 * 60_000
const PROMPT_DELAY_MIN = 30

export function startReviewPromptWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'review-prompts-recurring',
    }).catch((err: Error) => console.warn('[reviewPrompt] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, runPromptSweep, { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[reviewPrompt] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[reviewPrompt] worker disabled:', (err as Error).message)
    return null
  }
}

async function runPromptSweep(): Promise<void> {
  const cutoff = new Date(Date.now() - PROMPT_DELAY_MIN * 60_000)
  const STOREFRONT_URL = process.env['STOREFRONT_URL'] ?? 'https://order.servd.pk'

  const due = await prisma.order.findMany({
    where: {
      status: 'completed',
      completedAt: { lt: cutoff },
      reviewPromptSentAt: null,
      customerId: { not: null },
    },
    take: 100,
    select: {
      id: true,
      conceptId: true,
      completedAt: true,
      customer: { select: { id: true, name: true, email: true, phone: true } },
      concept:  { select: { name: true, slug: true } },
    },
  })

  for (const order of due) {
    if (!order.customer) continue
    if (!order.customer.email && !order.customer.phone) continue

    // Independent existence check — race-safe even if the include above
    // mis-typed.
    const review = await prisma.orderReview.findUnique({
      where: { orderId: order.id },
      select: { id: true },
    })
    if (review) {
      // They already reviewed; just stamp the field so we stop re-checking.
      await prisma.order.update({
        where: { id: order.id },
        data: { reviewPromptSentAt: new Date() },
      })
      continue
    }

    const reviewUrl = `${STOREFRONT_URL}/orders/${order.id}/review`
    const brand = order.concept.name
    const name  = order.customer.name ?? 'there'

    const sms  = `${brand}: how was your meal, ${name}? Rate it in 30 seconds (+50 loyalty pts): ${reviewUrl}`
    const html = `<p>Hi ${name},</p>
      <p>Hope the meal at <strong>${brand}</strong> hit the spot.</p>
      <p>If you've got 30 seconds, we'd love to know how it went. Reviewers within 24h get <strong>+50 loyalty points</strong> — that's PKR 50 off your next order.</p>
      <p><a href="${reviewUrl}" style="background:#22c55e;color:#000;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Rate my meal →</a></p>
      <p style="color:#666;font-size:12px">Honest feedback only — we read every word, and we use it to make things better.</p>`

    if (order.customer.phone) {
      await sendSms(order.customer.phone, sms).catch((err) => {
        console.error(`[reviewPrompt] SMS failed for order ${order.id}:`, (err as Error).message)
      })
    }
    if (order.customer.email) {
      await sendEmail(order.customer.email, `${brand}: how was your meal?`, html).catch((err) => {
        console.error(`[reviewPrompt] email failed for order ${order.id}:`, (err as Error).message)
      })
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { reviewPromptSentAt: new Date() },
    })
  }
}
