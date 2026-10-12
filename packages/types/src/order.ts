// Canonical Order DTO — all integration adapters must output this shape
// before the order is persisted. See spec §5.2.
//
// servd is operator-direct only: own delivery fleet, no third-party
// aggregators. The DB enum matches; legacy foodpanda/careem rows were
// remapped to 'servd' in migration 20260603100000.
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
  /** GST charged on this order, in cents. Persisted to Order.taxCents. */
  tax_cents?: number
  promo_discount_cents?: number
  // Wallet payment
  wallet_amount_cents?: number
  /**
   * The part of the bill that is a tip, in cents — written to Order.tipCents
   * in the same insert as the total. It is already inside
   * payment.amountCents (never added on top); ingestOrder refuses a tip
   * larger than that. Optional; absent means no tip.
   */
  tip_cents?: number
  /** How the order leaves the kitchen. Inferred from table_id when absent. */
  fulfilment_type?: 'dine_in' | 'takeout' | 'delivery'
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
