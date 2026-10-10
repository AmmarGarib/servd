'use client'
// stackd.crossBrand — the shared cross-brand strip (components/brand/parts,
// owned by the brand pages) in Stackd's frame. All of its copy is fields;
// the cards themselves are the company's other brands (live).

import type { SectionProps } from '../types'
import { str, color, link } from '../safe'
import { CrossBrandStrip, type CrossBrandTheme } from '../../components/brand/parts/CrossBrandStrip'
import { StackdFrame, stackdConcept, fill, stackdHref } from './shared'

// The strip in Stackd's palette. The page's cream type is inherited, so on
// the servd white card the brand names were cream on white; the cards are
// cream with Red Plum ink instead (7.8:1), the line under the heading is the
// dimmed cream (servd's grey-purple vanished into the plum), and the button
// is Stackd's own ghost button rather than servd's purple pill.
const STACKD_THEME: CrossBrandTheme = {
  muted: 'var(--stackd-cream-dim)',
  line: 'var(--stackd-line-faint)',
  cardBg: 'var(--stackd-cream)',
  cardText: 'var(--stackd-plum)',
  cardMuted: 'var(--stackd-plum-dark)',
  cardBorder: '1px solid var(--stackd-cream)',
  cardCta: 'var(--stackd-plum)',
  badgeBg: 'var(--stackd-cream)',
  badgeText: 'var(--stackd-plum)',
  allClassName: 'stackd-btn stackd-btn-ghost',
}

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
        theme={STACKD_THEME}
      />
    </StackdFrame>
  )
}
