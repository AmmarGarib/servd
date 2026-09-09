'use client'
import type { Concept } from '../../lib/concept'
import { StackdLayout }         from './layouts/StackdLayout'
import { SimmerLayout }       from './layouts/SimmerLayout'
import { FlipdLayout }        from './layouts/FlipdLayout'
import { GenericBrandLayout } from './layouts/GenericBrandLayout'

// BrandFallback — dispatches to a per-brand layout when the operator hasn't
// customised the CMS blocks for this brand yet. GS Foods runs three live
// consumer brands: Stackd, Simmer, Flipd. Each has its own bespoke layout
// (typography, colour palette, section composition, brand-unique modules)
// so /brand/<slug> reads as that brand's website, not a servd template
// with the colour swapped. Any unknown slug renders through the generic
// fallback (operator-provided concept content only).

interface Props {
  concept: Concept
  concepts: Concept[]
}

export function BrandFallback({ concept, concepts }: Props) {
  switch (concept.slug) {
    case 'stackd':
      return <StackdLayout    concept={concept} concepts={concepts} />
    case 'simmer':
      return <SimmerLayout  concept={concept} concepts={concepts} />
    case 'flipd':
      return <FlipdLayout   concept={concept} concepts={concepts} />
    default:
      return <GenericBrandLayout concept={concept} concepts={concepts} />
  }
}
