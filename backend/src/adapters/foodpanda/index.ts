// Foodpanda Order Adapter (Pakistan market)
// Normalises Foodpanda Order Notification webhook → canonical OrderDTO
// Requires: Foodpanda Vendor Portal API key + webhook secret

import type { OrderDTO } from '@servd/types'
import { prisma } from '../../lib/prisma.js'
import { ingestOrder } from '../../modules/orders/service.js'

interface FoodpandaWebhookPayload {
  event: string
  order: FoodpandaOrder
}

interface FoodpandaOrder {
  order_code: string
  vendor_code: string
  created_at: string
  estimated_delivery_time: string
  customer: {
    name: string
    phone: string
    delivery_address?: string
  }
  items: FoodpandaItem[]
  subtotal: number        // in paisa
  delivery_fee: number    // in paisa
  discount: number        // in paisa
  total_amount: number    // in paisa
  payment_method: string  // online | cash_on_delivery
  special_instruction?: string
}

interface FoodpandaItem {
  id: string
  name: string
  quantity: number
  unit_price: number      // in paisa
  total_price: number
  modifiers?: Array<{ name: string; price: number }>
  special_instructions?: string
}

export function normaliseFoodpandaOrder(
  payload: FoodpandaWebhookPayload,
  conceptId: string,
): OrderDTO | null {
  if (payload.event !== 'order_notification' && payload.event !== 'new_order') return null
  if (!payload.order) return null

  const o = payload.order

  const items = o.items.map((item) => ({
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
  }))

  return {
    source: 'foodpanda',
    external_id: o.order_code,
    concept_id: conceptId,
    placed_at: new Date(o.created_at).toISOString(),
    customer_id: null,
    customer_name: o.customer.name,
    items,
    payment: {
      provider: o.payment_method === 'cash_on_delivery' ? 'platform' : 'platform',
      amountCents: o.total_amount,
      status: o.payment_method === 'cash_on_delivery' ? 'pending' : 'paid',
    },
    loyalty_points_earned: null,
    delivery_notes: o.special_instruction ?? null,
    estimated_pickup: new Date(o.estimated_delivery_time).toISOString(),
    raw_payload: payload,
  }
}

export async function processFoodpandaJob(payload: unknown) {
  const data = payload as FoodpandaWebhookPayload
  const vendorCode = data.order?.vendor_code ?? 'default'
  const setting = await prisma.setting.findUnique({ where: { key: `foodpanda_vendor_${vendorCode}` } })
  if (!setting?.value) throw new Error(`No concept mapped for Foodpanda vendor ${vendorCode}`)
  const dto = normaliseFoodpandaOrder(data, setting.value)
  if (!dto) return { skipped: true, reason: 'non-order event' }
  return ingestOrder(dto)
}
