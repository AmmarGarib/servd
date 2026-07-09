'use client'
import type { Concept } from '../../lib/concept'
import { StaxLayout }         from './layouts/StaxLayout'
import { FlipdLayout }        from './layouts/FlipdLayout'
import { GenericBrandLayout } from './layouts/GenericBrandLayout'

// BrandFallback — dispatches to a per-brand layout when the operator hasn't
// customised the CMS blocks for this brand yet. Each live brand has its own
// bespoke layout (typography, colour palette, section composition,
// brand-unique modules) so /brand/<slug> reads as that brand's website, not
// a servd template with the colour swapped. Any unknown slug renders through
// the generic fallback (operator-provided concept content only).

interface Props {
  concept: Concept
  concepts: Concept[]
}

export function BrandFallback({ concept, concepts }: Props) {
  switch (concept.slug) {
    case 'stax':
      return <StaxLayout    concept={concept} concepts={concepts} />
    case 'flipd':
      return <FlipdLayout   concept={concept} concepts={concepts} />
    default:
      return <GenericBrandLayout concept={concept} concepts={concepts} />
  }
}
