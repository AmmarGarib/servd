// Careem Food Order Adapter (Pakistan market)
// Normalises Careem Order webhook → canonical OrderDTO
// Careem's payload mirrors Foodpanda's structure.

import type { OrderDTO } from '@servd/types'
import { prisma } from '../../lib/prisma.js'
import { ingestOrder } from '../../modules/orders/service.js'

interface CareemWebhookPayload {
  event: string
  order: CareemOrder
}

interface CareemOrder {
  order_code: string
  vendor_id: string
  created_at: string
  estimated_delivery_time: string
  customer: {
    name: string
    phone: string
    delivery_address?: string
  }
  items: CareemItem[]
  subtotal: number
  delivery_fee: number
  discount: number
  total_amount: number
  payment_method: string  // online | cash_on_delivery
  special_instruction?: string
}

interface CareemItem {
  id: string
  name: string
  quantity: number
  unit_price: number
  total_price: number
  modifiers?: Array<{ name: string; price: number }>
  special_instructions?: string
}

export function normaliseCareemOrder(
  payload: CareemWebhookPayload,
  conceptId: string,
): OrderDTO | null {
  if (payload.event !== 'order_notification' && payload.event !== 'new_order') return null
  if (!payload.order) return null

  const o = payload.order

  return {
    source: 'careem',
    external_id: o.order_code,
    concept_id: conceptId,
    placed_at: new Date(o.created_at).toISOString(),
    customer_id: null,
    customer_name: o.customer.name,
    items: o.items.map((item) => ({
      externalItemId: item.id,
      menuItemId: null,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unit_price,
      modifiers: (item.modifiers ?? []).map((mod) => ({
        name: mod.name,
        priceDeltaCents: mod.price,
      })),
      notes: item.special_instructions,
    })),
    payment: {
      provider: 'platform',
      amountCents: o.total_amount,
      status: o.payment_method === 'cash_on_delivery' ? 'pending' : 'paid',
    },
    loyalty_points_earned: null,
    delivery_notes: o.special_instruction ?? null,
    estimated_pickup: new Date(o.estimated_delivery_time).toISOString(),
    raw_payload: payload,
  }
}

export async function processCareemJob(payload: unknown) {
  const data = payload as CareemWebhookPayload
  const vendorId = data.order?.vendor_id ?? 'default'
  const setting = await prisma.setting.findUnique({ where: { key: `careem_vendor_${vendorId}` } })
  if (!setting?.value) throw new Error(`No concept mapped for Careem vendor ${vendorId}`)
  const dto = normaliseCareemOrder(data, setting.value)
  if (!dto) return { skipped: true, reason: 'non-order event' }
  return ingestOrder(dto)
}
