// The ONE answer to "which channel did this order come from?" for reports
// (owner, 2026-10-26, B10: "WhatsApp orders as their own channel in reports").
//
// A WhatsApp order is stored with source 'servd' (the customer channel) and
// rawPayload.channel = 'whatsapp' (adapters/whatsapp/conversation.ts). Reports
// used to show it as the website; every channel breakdown reads this instead.
import type { Prisma } from '@prisma/client'

export const WHATSAPP_CHANNEL = 'whatsapp'

export function orderChannelOf(o: { source: string; rawPayload?: unknown }): string {
  if (o.source === 'servd') {
    const p = o.rawPayload
    if (p && typeof p === 'object' && !Array.isArray(p) && (p as { channel?: unknown }).channel === WHATSAPP_CHANNEL) return WHATSAPP_CHANNEL
  }
  return o.source
}

/** Prisma filter for orders that came in over WhatsApp. */
export const whatsappOrderWhere: Prisma.OrderWhereInput = {
  source: 'servd',
  rawPayload: { path: ['channel'], equals: WHATSAPP_CHANNEL },
}
