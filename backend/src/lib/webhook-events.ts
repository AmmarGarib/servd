// Outbound webhook fan-out. Call `emitDomainEvent(event, payload, tenantId)`
// from any place where a meaningful state change happens; we look up the
// OWNING COMPANY's active WebhookSubscription rows that subscribe to the event
// and enqueue one delivery job per subscription. The worker
// (workers/webhookDelivery.ts) HMAC-signs and POSTs.
//
// Company scope: a subscription is company master data. The event's company
// is REQUIRED and must be resolved from the entity itself (order →
// concept.tenantId, inventory item → item.tenantId, shift → shiftTenantId,
// reservation → concept.tenantId) — never from the caller's session. When the
// company cannot be resolved (null) the event is dropped: fanning it out to
// every company's endpoints is exactly the leak this guards against.
//
// Failure isolation: failures here NEVER block the underlying transaction —
// they are wrapped in catches and log warnings only.

import { serviceClient as prisma } from './prisma.js'
import { getWebhookQueue } from './queue.js'
import { sandboxBlocks } from './sandbox.js'

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

/** The company that owns a brand, or null when unknown. For order/reservation events. */
export async function tenantIdOfConcept(conceptId: string | null | undefined): Promise<string | null> {
  if (!conceptId) return null
  const row = await prisma.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } }).catch(() => null)
  return row?.tenantId ?? null
}

export async function emitDomainEvent(event: DomainEvent, payload: unknown, tenantId: string | null): Promise<void> {
  try {
    if (!tenantId) {
      console.warn(`[webhook-events] ${event} dropped — no owning company resolved`)
      return
    }
    const subs = await prisma.webhookSubscription.findMany({
      where: { tenantId, isActive: true, deletedAt: null, events: { has: event } },
      select: { id: true },
    })
    if (subs.length === 0) return
    // Practice copy: the copied subscriptions are real endpoints. Logged, never queued.
    if (sandboxBlocks('webhook', { summary: `${event} → ${subs.length} endpoint(s)` })) return
    const queue = getWebhookQueue()
    if (!queue) return
    const emittedAt = new Date().toISOString()
    // No custom jobId: the old `${id}:${event}:${emittedAt}` carried the ISO
    // timestamp's colons, which BullMQ rejects ("Custom Id cannot contain :"),
    // so every add threw into the catch below and no webhook was ever queued.
    // A timestamp-derived id would also collapse two events for different
    // orders emitted in the same millisecond into one delivery.
    await Promise.all(subs.map((s) =>
      queue.add('deliver', { subscriptionId: s.id, event, payload, emittedAt }),
    ))
  } catch (err) {
    console.warn(`[webhook-events] emit failed for ${event}:`, (err as Error).message)
  }
}
