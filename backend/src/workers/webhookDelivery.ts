// Outbound webhook delivery worker.
// Picks up jobs from the `webhook-delivery` queue and POSTs them to the
// subscriber's URL with an HMAC-SHA256 signature. Records delivery status
// on the WebhookSubscription row for visibility.
//
// Retries: 5 attempts with exponential backoff (configured at queue level).
// On final failure we increment `failureCount` so operators can spot dead
// endpoints at a glance.

import { Worker } from 'bullmq'
import { createHmac } from 'crypto'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import type { WebhookDeliveryJob } from '../lib/queue.js'

const TIMEOUT_MS = 10_000

export function startWebhookDeliveryWorker(): Worker<WebhookDeliveryJob> {
  const worker = new Worker<WebhookDeliveryJob>(
    'webhook-delivery',
    async (job) => {
      const { subscriptionId, event, payload, emittedAt } = job.data

      const sub = await prisma.webhookSubscription.findUnique({ where: { id: subscriptionId } })
      if (!sub || !sub.isActive || sub.deletedAt) {
        return { skipped: 'inactive' }
      }

      const body = JSON.stringify({ event, emittedAt, payload })
      const signature = createHmac('sha256', sub.secret).update(body).digest('hex')

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

      let status: string
      try {
        const res = await fetch(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Servd-Event': event,
            'X-Servd-Signature': `sha256=${signature}`,
            'X-Servd-Subscription': sub.id,
            'X-Servd-Timestamp': emittedAt,
          },
          body,
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        status = res.ok
          ? 'success'
          : res.status >= 500
          ? 'failed_5xx'
          : 'failed_4xx'

        await prisma.webhookSubscription.update({
          where: { id: sub.id },
          data: {
            lastSentAt: new Date(),
            lastStatus: status,
            ...(status === 'success'
              ? { failureCount: 0 }
              : { failureCount: { increment: 1 } }),
          },
        })

        if (!res.ok) {
          throw new Error(`Webhook ${sub.url} returned ${res.status}`)
        }
        return { delivered: true, status }
      } catch (err) {
        clearTimeout(timeoutId)
        if ((err as Error).name === 'AbortError') status = 'timeout'
        else status = 'error'
        await prisma.webhookSubscription.update({
          where: { id: sub.id },
          data: { lastSentAt: new Date(), lastStatus: status, failureCount: { increment: 1 } },
        }).catch(() => {})
        throw err
      }
    },
    { connection: redis, concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[webhook-delivery] failed ${job?.data.event} → ${job?.data.subscriptionId}: ${err.message}`)
  })

  return worker
}
