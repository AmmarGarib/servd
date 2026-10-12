// The till's tender set — ONE definition (Raast QR, 2026-10-12, owner
// decision). Tills take exactly Cash, Card – Keenu and Raast QR (plus staff
// meal and comp, which are not money tenders). 'keenu_qr' is RETIRED: it stays
// in the PaymentMethod enum so old rows read and refund the way they were
// paid, but new code never writes it. Tax: 'card' and 'raast' are the one
// digital tax group (lib/pricing.ts CARD_TENDERS → Concept.taxRateCard).

import type { PaymentMethod } from '@prisma/client'

/** Money tenders a till takes for a NEW payment. */
export const TILL_TENDERS = ['cash', 'card', 'raast'] as const
export type TillTender = (typeof TILL_TENDERS)[number]

/** Retired tenders: readable and refundable, never written by new code. */
export const LEGACY_TENDERS = ['keenu_qr'] as const

/** Tenders a refund may go back on (only the way the sale was paid). */
export const REFUND_TENDERS = ['cash', 'card', 'raast', 'keenu_qr'] as const
export type RefundTender = (typeof REFUND_TENDERS)[number]

/**
 * Pending payment rows a processor may still confirm (online card / Keenu QR
 * callbacks, the retry worker). NOT raast: a Raast payment is recorded paid
 * at the till (reference typed or SMS-confirmed) or not at all.
 */
export const PENDING_GATEWAY_TENDERS = ['card', 'keenu_qr'] as const

export const TENDER_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card – Keenu',
  raast: 'Raast QR',
  keenu_qr: 'Keenu QR (retired)',
  comp: 'Comp',
  split: 'Split',
  wallet: 'Wallet',
  gift_card: 'Gift card',
}

/** The receipt / report label for a payment method. */
export function tenderLabel(method: string | null | undefined): string {
  if (!method) return ''
  return TENDER_LABEL[method] ?? method
}

export function isTillTender(m: unknown): m is TillTender {
  return typeof m === 'string' && (TILL_TENDERS as readonly string[]).includes(m)
}

export function isRefundTender(m: unknown): m is RefundTender {
  return typeof m === 'string' && (REFUND_TENDERS as readonly string[]).includes(m)
}

/**
 * Ring-up and quotes accept 'keenu_qr' only as a legacy alias of the digital
 * rate, so an offline-queued pre-deploy ring-up never 400s: it is priced and
 * stored as 'raast'. Payments, settles, splits and intents refuse it
 * (422 KEENU_QR_RETIRED).
 */
export function legacyRingUpTender<T extends string>(m: T): T | 'raast' {
  return m === 'keenu_qr' ? 'raast' : m
}

/** The refusal for a new keenu_qr payment / settle / split / intent. */
export const KEENU_QR_RETIRED = {
  code: 'KEENU_QR_RETIRED',
  message: 'Keenu QR is retired — take Raast QR or Card – Keenu',
  status: 422,
} as const

// Compile-time check: every tender here is a real PaymentMethod value.
const _methods: readonly PaymentMethod[] = [...TILL_TENDERS, ...LEGACY_TENDERS]
void _methods
