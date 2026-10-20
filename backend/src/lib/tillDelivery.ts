// A delivery rung up at the till (till flow, owner 2026-10-20 — pos/TILL_FLOW.md).
//
// Stored as Order.source 'manual' with rawPayload.channel 'till_delivery': NOT a
// till sale (orders/service isTillSale is false), so it completes ON DELIVERY
// (completionDoor 'delivery'), is booked by its own 'order.complete' entry like
// an online delivery, and its cash on delivery is COD custody exactly as
// lib/cod.ts defines it. It is PRICED like a till sale (channel 'pos',
// re-priced for its tender — pos/service tenderPriceOf).

export const TILL_DELIVERY_CHANNEL = 'till_delivery'

export function isTillDelivery(order: { source: string; rawPayload?: unknown }): boolean {
  if (order.source !== 'manual') return false
  const raw = order.rawPayload as { channel?: unknown } | null | undefined
  return raw?.channel === TILL_DELIVERY_CHANNEL
}
