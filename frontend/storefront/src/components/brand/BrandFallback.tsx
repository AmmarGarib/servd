'use client'
import type { Concept } from '../../lib/concept'
import { StaxLayout }           from './layouts/StaxLayout'
import { SimmerLayout }         from './layouts/SimmerLayout'
import { StrataLayout }         from './layouts/StrataLayout'
import { FlipdLayout }          from './layouts/FlipdLayout'
import { BukhariLayout }        from './layouts/BukhariLayout'
import { CravemanLayout }       from './layouts/CravemanLayout'
import { GarnishStationLayout } from './layouts/GarnishStationLayout'
import { GenericBrandLayout }   from './layouts/GenericBrandLayout'

// BrandFallback — dispatches to a per-brand layout when the operator hasn't
// customised the CMS blocks for this brand yet. Each major brand has its own
// opinionated layout (typography, colour palette, section composition,
// brand-unique modules) so /brand/<slug> reads as that brand's website, not
// a servd template with the colour swapped. Concepts without a dedicated
// layout fall through to GenericBrandLayout.
//
// The kinetic 3D shape library + scroll-driven motion are layered INSIDE
// each bespoke layout so each brand keeps its identity (Stax cream/orange,
// Simmer dark green editorial, Flipd diner-energy) while picking up the
// modern flash. KineticBrandLayout still exists as a shortcut for new
// brands but it's no longer the default.

interface Props {
  concept: Concept
  concepts: Concept[]
}

export function BrandFallback({ concept, concepts }: Props) {
  switch (concept.slug) {
    case 'stax':
    case 'stax-padel':
      return <StaxLayout    concept={concept} concepts={concepts} />
    case 'simmer':
      return <SimmerLayout  concept={concept} concepts={concepts} />
    case 'strata':
      return <StrataLayout  concept={concept} concepts={concepts} />
    case 'flipd':
      return <FlipdLayout   concept={concept} concepts={concepts} />
    case 'bukhari':
      return <BukhariLayout concept={concept} concepts={concepts} />
    case 'craveman':
      return <CravemanLayout concept={concept} concepts={concepts} />
    case 'garnish-station':
      return <GarnishStationLayout concept={concept} concepts={concepts} />
    default:
      return <GenericBrandLayout concept={concept} concepts={concepts} />
  }
}
