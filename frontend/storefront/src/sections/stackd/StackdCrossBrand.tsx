'use client'
// stackd.crossBrand — the shared cross-brand strip (components/brand/parts,
// owned by the brand pages) in Stackd's frame. All of its copy is fields;
// the cards themselves are the company's other brands (live).

import type { SectionProps } from '../types'
import { str, color, link } from '../safe'
import { CrossBrandStrip } from '../../components/brand/parts/CrossBrandStrip'
import { StackdFrame, stackdConcept, fill, stackdHref } from './shared'

export function StackdCrossBrand({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  const kicker = str(fields.kicker)
  const heading = str(fields.heading)
  const all = link(fields.allLink)
  return (
    <StackdFrame>
      <CrossBrandStrip
        current={concept}
        concepts={ctx.concepts}
        accent={color(fields.accent) ?? 'var(--stackd-cream)'}
        {...(kicker && { kicker: fill(kicker, concept) })}
        {...(heading && { heading: fill(heading, concept) })}
        subtitle={str(fields.subtitle)}
        allLabel={all.text}
        allHref={stackdHref(all.href, ctx, concept) ?? '/home#kitchens'}
        {...(str(fields.cardCta).trim() && { cardCta: str(fields.cardCta) })}
        onBrandHost={!!ctx.onBrandHost}
      />
    </StackdFrame>
  )
}
