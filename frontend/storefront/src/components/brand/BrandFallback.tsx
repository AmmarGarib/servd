'use client'
import type { Concept } from '../../lib/concept'
import { KineticBrandLayout } from './layouts/KineticBrandLayout'

// BrandFallback — dispatches to a per-brand layout when the operator hasn't
// customised the CMS blocks for this brand yet. As of the kinetic-redesign
// every brand uses the shared KineticBrandLayout so the customer experience
// reads as one design language across Stax / Simmer / Flipd. Per-brand
// identity comes through:
//   - concept.primaryColor → --brand-accent on BrandShell, used by every
//     kinetic shape, pill, eyebrow label, and underline
//   - BRAND_VOICE map inside KineticBrandLayout → per-brand emoji + signature
//     dish list + voice line
//
// The old per-brand bespoke layouts (Stax/Simmer/Flipd/etc) are still in
// layouts/ — kept for reference and as fast-restore options if we ever want
// a brand to reclaim its own bespoke microsite. They're not wired here.
//
// Add a per-brand override: import the bespoke layout and add a case above
// the default return. That brand will diverge from the shared language.

interface Props {
  concept:  Concept
  concepts: Concept[]
}

export function BrandFallback({ concept, concepts }: Props) {
  return <KineticBrandLayout concept={concept} concepts={concepts} />
}
