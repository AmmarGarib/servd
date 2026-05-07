// Outbound webhook fan-out. Call `emitDomainEvent(event, payload)` from any
// place where a meaningful state change happens; we look up active
// WebhookSubscription rows that subscribe to the event and enqueue one
// delivery job per subscription. The worker (workers/webhookDelivery.ts)
// HMAC-signs and POSTs.
//
// Failure isolation: failures here NEVER block the underlying transaction —
// they are wrapped in catches and log warnings only.

import { prisma } from './prisma.js'
import { getWebhookQueue } from './queue.js'

export type DomainEvent =
  | 'order.placed'
  | 'order.confirmed'
  | 'order.dispatched'
  | 'order.delivered'
  | 'order.refunded'
  | 'shift.opened'
  | 'shift.closed'
  | 'inventory.low_stock'
  | 'reservation.confirmed'
  | 'reservation.no_show'
  | 'payment.completed'
  | 'payment.failed'

export async function emitDomainEvent(event: DomainEvent, payload: unknown): Promise<void> {
  try {
    const subs = await prisma.webhookSubscription.findMany({
      where: { isActive: true, deletedAt: null, events: { has: event } },
      select: { id: true },
    })
    if (subs.length === 0) return
    const queue = getWebhookQueue()
    if (!queue) return
    const emittedAt = new Date().toISOString()
    await Promise.all(subs.map((s) =>
      queue.add('deliver', { subscriptionId: s.id, event, payload, emittedAt }, { jobId: `${s.id}:${event}:${emittedAt}` }),
    ))
  } catch (err) {
    console.warn(`[webhook-events] emit failed for ${event}:`, (err as Error).message)
  }
}
