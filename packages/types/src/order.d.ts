export type OrderSource = 'servd' | 'pos' | 'cart' | 'manual';
export interface OrderModifierDTO {
    name: string;
    priceDeltaCents: number;
}
export interface OrderItemDTO {
    externalItemId: string;
    menuItemId: string | null;
    name: string;
    quantity: number;
    unitPriceCents: number;
    modifiers: OrderModifierDTO[];
    notes?: string;
    course?: number;
}
export interface OrderPaymentDTO {
    provider: 'keenu' | 'jazzcash' | 'easypaisa' | 'platform' | 'cash' | 'wallet' | null;
    amountCents: number;
    status: 'paid' | 'pending' | 'refunded';
}
export interface OrderDTO {
    source: OrderSource;
    external_id: string;
    concept_id: string;
    placed_at: string;
    customer_id: string | null;
    customer_name: string | null;
    items: OrderItemDTO[];
    payment: OrderPaymentDTO;
    loyalty_points_earned: number | null;
    delivery_notes: string | null;
    estimated_pickup: string | null;
    table_id?: string | null;
    pos_staff_id?: string | null;
    shift_id?: string | null;
    raw_payload?: unknown;
    scheduled_for?: string | null;
    is_pre_order?: boolean;
    promo_code_id?: string | null;
    promo_discount_cents?: number;
    wallet_amount_cents?: number;
}
export type OrderStatus = 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled' | 'refunded' | 'rejected';
export type ItemStatus = 'pending' | 'preparing' | 'ready' | 'bumped' | 'held' | 'recalled' | 'voided';
//# sourceMappingURL=order.d.ts.map