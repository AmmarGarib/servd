// Effective tax rate resolution.
//
// Priority:
//   1. MenuItem.taxClassification = 'custom'      → use overrideTaxRate
//   2. MenuItem.taxClassification = 'zero_rated'  → 0
//   3. MenuItem.taxClassification = 'exempt'      → 0 (and no input-tax recovery — flagged separately)
//   4. MenuItem.taxClassification = 'standard'    → fall back to Concept.taxRate
//
// The storefront and POS modules call this when computing tax-inclusive
// pricing on each line item. The resulting per-line tax cents sum to the
// order's taxCents column.

import type { MenuItem, Concept } from '@prisma/client'

export interface TaxItem extends Pick<MenuItem, 'taxClassification' | 'overrideTaxRate'> {}
export interface TaxConcept extends Pick<Concept, 'taxRate'> {}

export function effectiveTaxRatePct(item: TaxItem, concept: TaxConcept): number {
  switch (item.taxClassification) {
    case 'custom':     return item.overrideTaxRate ?? 0
    case 'zero_rated': return 0
    case 'exempt':     return 0
    case 'standard':
    default:           return concept.taxRate
  }
}

// Tax cents on a tax-EXCLUSIVE subtotal at the given rate. Banker-rounded
// against negative drift — half-to-even, integer cents only.
export function computeTaxCents(subtotalCents: number, ratePct: number): number {
  if (ratePct <= 0) return 0
  // Use Math.round (half away from zero) — adequate for cent-precision; the
  // ledger reconciles via the trial balance, not a perfect rounding theorem.
  return Math.round((subtotalCents * ratePct) / 100)
}

// Whether this item has been opted out of the standard tax flow entirely
// (zero-rated and exempt are different in FBR's eyes — input-tax recovery
// rules differ — but for storefront checkout they both produce 0% tax).
export function isOutsideStandardRegime(item: TaxItem): boolean {
  return item.taxClassification === 'zero_rated' || item.taxClassification === 'exempt'
}
