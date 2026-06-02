// B19: explicit state machine for Order + OrderItem status transitions.
// Before this, any update could move a record into any state — the bug-prone
// path was "completed → received" from a stale webhook retry, which would
// re-fire financial entries and loyalty earns. The transition table here
// codifies the legal moves so the service layer can reject bad inputs at
// the boundary (`ApiError('INVALID_TRANSITION', 409)`).

import type { OrderStatus, ItemStatus } from '@prisma/client'

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // The spec's lifecycle: incoming → confirmed → preparing → ready → completed.
  // Cancellations can fork from any pre-completion state; rejections happen
  // at intake when staff (or an automated rule) declines an order.
  received:  ['confirmed', 'cancelled', 'rejected', 'preparing'],
  confirmed: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready:     ['completed', 'cancelled'],
  // Terminal-with-one-exit states: completed orders may still be refunded.
  // Refunded / cancelled / rejected are absorbing — no further transitions.
  completed: ['refunded'],
  cancelled: [],
  rejected:  [],
  refunded:  [],
}

export const ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  // Standard kitchen flow. `held` and `recalled` are escape hatches for the
  // KDS — a held item can be unheld back to preparing, a bumped item can be
  // pulled back if the customer flags a problem.
  //
  // pending → bumped / ready is allowed too: a line cook can finish an item
  // before expo has formally fired it (or before the legacy-fire path got
  // around to flipping its status), and we shouldn't punish them with a
  // 409 when the physical food is already plated. Skipping `preparing` is
  // harmless — `bumped` is still the canonical "done" state downstream.
  pending:   ['preparing', 'ready', 'bumped', 'held', 'voided'],
  preparing: ['ready', 'bumped', 'held', 'voided'],
  ready:     ['bumped', 'recalled', 'voided'],
  bumped:    ['recalled'],
  held:      ['preparing', 'voided'],
  recalled:  ['preparing', 'voided'],
  voided:    [],
}

/**
 * Returns true if moving `from` → `to` is allowed. Callers throw
 * `ApiError('INVALID_TRANSITION', 409)` when this returns false so the
 * client sees a 409 (not a 500) and the audit log captures the attempt.
 *
 * Same-state moves are always legal — repeated writes (gateway webhook
 * retries on the "confirmed" callback) shouldn't blow up, just no-op.
 */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  if (from === to) return true
  return ITEM_TRANSITIONS[from]?.includes(to) ?? false
}
