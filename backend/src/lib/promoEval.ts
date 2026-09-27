// Promo code evaluation — THE rules, used by the checkout preview
// (GET /storefront/promo-preview) and by checkout itself (POST
// /storefront/orders). POST /promos/validate, the third copy, is gone.
//
// The three copies disagreed on what a percentage applies to: the preview was
// fed the food total while checkout applied it to food + GST + delivery +
// service charge, so the discount shown was never the discount charged. The
// minimum-order check used the same two different bases, so a code could pass
// the preview and fail checkout (or the reverse).
//
// Owner decision 10: a percentage promo discounts the FOOD SUBTOTAL only —
// never GST, the delivery fee or the service charge. The food subtotal is
// also the base for the minimum order, and caps a fixed-amount promo.
//
// Company scope: a code belongs to one company (PromoCode.tenantId). Another
// company's code answers exactly like an unknown one. A brand-less code is
// valid at every brand of its own company.
//
// Usage claiming (the atomic usedCount increment and the per-customer lock) is
// not evaluation — it stays with checkout, which holds the order.

import type { PromoCode } from '@prisma/client'
import { prisma } from './prisma.js'

export interface PromoEvalInput {
  code: string
  tenantId: string | null
  conceptId: string | null
  /** Items + modifiers, before GST, delivery, service charge and tip. */
  foodSubtotalCents: number
  /** From the session only — never a request body. Enables the per-customer limit. */
  customerId?: string | null
  now?: Date
}

export type PromoEvalFailure =
  | 'INVALID_PROMO' | 'PROMO_NOT_STARTED' | 'PROMO_EXPIRED' | 'PROMO_WRONG_CONCEPT'
  | 'PROMO_MIN_ORDER' | 'PROMO_EXHAUSTED' | 'PROMO_LIMIT_REACHED'

export type PromoEval =
  | { ok: true; promo: PromoCode; discountCents: number; description: string }
  | { ok: false; reason: PromoEvalFailure; message: string }

/** The discount a promo gives on a food subtotal (decision 10). */
export function promoDiscountCents(
  promo: Pick<PromoCode, 'discountType' | 'discountValue' | 'maxDiscountCents'>,
  foodSubtotalCents: number,
): number {
  const base = Math.max(0, foodSubtotalCents)
  let discount: number
  if (promo.discountType === 'percentage') {
    discount = Math.round(base * (promo.discountValue / 100))
    if (promo.maxDiscountCents != null) discount = Math.min(discount, promo.maxDiscountCents)
  } else {
    discount = Math.round(promo.discountValue * 100)
  }
  return Math.max(0, Math.min(discount, base))
}

function describe(promo: PromoCode): string {
  if (promo.description) return promo.description
  const expiry = promo.endAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const type = promo.discountType === 'percentage' ? `${promo.discountValue}% off food` : `PKR ${promo.discountValue.toFixed(0)} off`
  return `${type} · expires ${expiry}`
}

export async function evaluatePromo(input: PromoEvalInput): Promise<PromoEval> {
  const code = input.code.trim().toUpperCase()
  const fail = (reason: PromoEvalFailure, message: string): PromoEval => ({ ok: false, reason, message })
  if (!code || !input.tenantId) return fail('INVALID_PROMO', 'Promo code is invalid or expired')

  const promo = await prisma.promoCode.findFirst({ where: { code, tenantId: input.tenantId } })
  const now = input.now ?? new Date()
  if (!promo || !promo.isActive) return fail('INVALID_PROMO', 'Promo code is invalid or expired')
  if (promo.startAt > now) return fail('PROMO_NOT_STARTED', 'Promo code is not yet active')
  if (promo.endAt < now) return fail('PROMO_EXPIRED', 'Promo code has expired')
  if (promo.conceptId && promo.conceptId !== input.conceptId) {
    return fail('PROMO_WRONG_CONCEPT', 'Promo code not valid for this brand')
  }
  if (promo.minOrderCents != null && input.foodSubtotalCents < promo.minOrderCents) {
    return fail('PROMO_MIN_ORDER', `Minimum order of PKR ${(promo.minOrderCents / 100).toFixed(0)} required`)
  }
  if (promo.maxUsageCount != null && promo.usedCount >= promo.maxUsageCount) {
    return fail('PROMO_EXHAUSTED', 'Promo code usage limit reached')
  }
  if (input.customerId) {
    const used = await prisma.promoCodeUsage.count({ where: { promoCodeId: promo.id, customerId: input.customerId } })
    if (used >= promo.perCustomerLimit) return fail('PROMO_LIMIT_REACHED', 'You have already used this promo code')
  }
  return { ok: true, promo, discountCents: promoDiscountCents(promo, input.foodSubtotalCents), description: describe(promo) }
}
