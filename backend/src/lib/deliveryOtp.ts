// The delivery hand-over code (docs/rider-app.md, "The hand-over code").
//
// A 4-digit code on every delivery order. The customer sees it on their order
// tracker and gets it on WhatsApp when the rider picks the order up; the rider
// types it in at the door to complete the delivery. It is the proof the food
// reached the customer, so:
//
//   - it is generated with crypto.randomInt (it used to be Math.random);
//   - it is compared in constant time;
//   - the rider gets DELIVERY_OTP_MAX_ATTEMPTS tries, then the order locks.
//     For a company with code-only delivery switched on (lib/deliveryRules.ts)
//     a manager then sends the code to the rider (Emergency overrides,
//     dispatch/service rerouteHandoverCode); for a switched-off company a
//     manager may still mark it delivered from admin -> Dispatch;
//   - staff do not see it in order payloads. Switched off: only admin /
//     management may read it (for support). Switched on: NO role reads it, the
//     CEO included — reading the code would be a disguised "Delivered"
//     override (owner rule 2026-10-13: a delivery completes only with the
//     customer's code).

import crypto from 'crypto'

/** Wrong codes a rider may enter before the order locks (423 OTP_LOCKED). */
export const DELIVERY_OTP_MAX_ATTEMPTS = 5

/**
 * Roles that may read a hand-over code (support) while the company's
 * code-only switch is OFF. With it ON nobody reads it (canReadDeliveryOtp).
 */
export const DELIVERY_OTP_READERS: readonly string[] = ['admin', 'management']

/** A fresh 4-digit code, 0000–9999, from a CSPRNG. */
export function generateDeliveryOtp(): string {
  return crypto.randomInt(0, 10_000).toString().padStart(4, '0')
}

/** Constant-time compare of the stored code against what was typed. */
export function deliveryOtpMatches(expected: string | null | undefined, provided: string | null | undefined): boolean {
  if (!expected || provided == null) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided.trim(), 'utf8')
  if (a.length !== b.length) {
    // Still spend a compare so a wrong-length guess costs the same.
    crypto.timingSafeEqual(a, a)
    return false
  }
  return crypto.timingSafeEqual(a, b)
}

/**
 * May this role read the hand-over code? `codeOnly` = the ORDER's company has
 * code-only delivery switched on (lib/deliveryRules.ts codeOnlyDelivery):
 * then no role may (CEO included). Callers that have not resolved the switch
 * pass nothing and get today's rule.
 */
export function canReadDeliveryOtp(role: string | null | undefined, codeOnly = false): boolean {
  if (codeOnly) return false
  return !!role && DELIVERY_OTP_READERS.includes(role)
}

/**
 * The order as a staff member may see it: `deliveryOtp` blanked for every role
 * except admin / management — and for every role when the order's company has
 * code-only delivery on (`codeOnly`). Works on any object that may carry the
 * field (a full row, a list row, a spread with extra keys).
 */
export function redactDeliveryOtp<T>(order: T, role: string | null | undefined, codeOnly = false): T {
  if (canReadDeliveryOtp(role, codeOnly)) return order
  if (!order || typeof order !== 'object' || !('deliveryOtp' in (order as object))) return order
  return { ...(order as object), deliveryOtp: null } as T
}
