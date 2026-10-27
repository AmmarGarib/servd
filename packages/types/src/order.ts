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
  /**
   * The menu Modifier this add-on is, so its own recipe (RecipeKind
   * 'modifier') depletes stock and costs the line. ingestOrder keeps it only
   * when it belongs to a live modifier group of the line's menu item, else
   * stores null. Optional; absent means a free-text modifier.
   */
  modifierId?: string | null
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
  /**
   * Ingredients the customer asked to leave out ("No onions") — each names a line of the dish's approved plate
   * recipe by its servd master, stock item or sub-recipe (backend lib/lineRemovals.ts). Checked against the recipe
   * (422 INGREDIENT_NOT_ON_RECIPE); the sale draws none of them; the price is unchanged.
   */
  removedIngredients?: OrderLineRemovalDTO[]
}

export interface OrderLineRemovalDTO {
  masterIngredientId?: string | null
  inventoryItemId?: string | null
  prepRecipeId?: string | null
  key?: string | null
  name?: string | null
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
  /**
   * The delivery zone's fee BEFORE GST, in cents — charged on top of the food
   * (owner, 2026-10-13). Persisted to Order.deliveryFeeCents. ingestOrder
   * takes it from the channel's price (lib/pricing.ts priceOrder); absent
   * means no fee.
   */
  deliveryFeeCents?: number
  /**
   * The GST on the delivery fee, in cents, at the order's tender rate. It is
   * INSIDE tax_cents (food GST + this), never added again. Persisted to
   * Order.deliveryFeeTaxCents; absent means none.
   */
  deliveryFeeTaxCents?: number
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
