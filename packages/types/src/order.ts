// Canonical Order DTO — all integration adapters must output this shape
// before the order is persisted. See spec §5.2.

// Legacy values 'foodpanda' and 'careem' remain in the database enum so
// historical orders can still be loaded, but no new code may emit them —
// servd is operator-direct only (own delivery fleet, no aggregators).
export type OrderSource =
  | 'servd'
  | 'pos'
  | 'cart'
  | 'manual'

export interface OrderModifierDTO {
  name: string
  priceDeltaCents: number
}

export interface OrderItemDTO {
  externalItemId: string
  menuItemId: string | null // null if not yet mapped
  name: string              // raw platform name
  quantity: number
  unitPriceCents: number
  modifiers: OrderModifierDTO[]
  notes?: string
  course?: number
}

export interface OrderPaymentDTO {
  provider: 'keenu' | 'jazzcash' | 'easypaisa' | 'platform' | 'cash' | 'wallet' | null
  amountCents: number
  status: 'paid' | 'pending' | 'refunded'
}

export interface OrderDTO {
  source: OrderSource
  external_id: string              // platform-assigned ID (unique per source)
  concept_id: string
  placed_at: string                // ISO 8601 UTC
  customer_id: string | null       // populated for 'servd' source only
  customer_name: string | null     // raw name for non-direct orders
  items: OrderItemDTO[]
  payment: OrderPaymentDTO
  loyalty_points_earned: number | null
  delivery_notes: string | null
  estimated_pickup: string | null  // ISO 8601 UTC
  table_id?: string | null
  pos_staff_id?: string | null
  shift_id?: string | null
  raw_payload?: unknown
  // Pre-order / scheduling
  scheduled_for?: string | null    // ISO 8601 UTC
  is_pre_order?: boolean
  // Promo code
  promo_code_id?: string | null
  promo_discount_cents?: number
  // Wallet payment
  wallet_amount_cents?: number
}

export type OrderStatus =
  | 'received'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'rejected'

export type ItemStatus =
  | 'pending'
  | 'preparing'
  | 'ready'
  | 'bumped'
  | 'held'
  | 'recalled'
  | 'voided'
