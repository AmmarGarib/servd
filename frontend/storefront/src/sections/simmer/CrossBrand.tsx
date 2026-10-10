// simmer.crossBrand — the shared CrossBrandStrip (brand parts, owned by the
// brand group) on a Simmer surface with an orange accent. All of its copy is
// fields; the cards are the company's other brands (live).
import type { SectionProps } from '../types'
import { link, safeHref, str } from '../safe'
import { CrossBrandStrip } from '../../components/brand/parts/CrossBrandStrip'
import { simmerConcept, simmerText, surface } from './shared'

export function CrossBrand({ fields: f, ctx }: SectionProps) {
  const s = surface(f['surface'], 'bone')
  const kicker = simmerText(f['kicker']).trim()
  const heading = simmerText(f['heading']).trim()
  return (
    <div className="simmer-page">
      <div style={{ background: s.background, color: s.color }}>
        <CrossBrandStrip
          current={simmerConcept(ctx)}
          concepts={ctx.concepts}
          accent="var(--simmer-orange)"
          {...(kicker && { kicker })}
          {...(heading && { heading })}
          subtitle={str(f.subtitle)}
          allLabel={link(f.allLink).text}
          allHref={safeHref(link(f.allLink).href, '/home#kitchens')}
          {...(str(f.cardCta).trim() && { cardCta: str(f.cardCta) })}
          // On simmer.pk the "all kitchens" link (a servd page) is made
          // absolute on servd's origin, so it never lands on a copy of it.
          onBrandHost={!!ctx.onBrandHost}
        />
      </div>
    </div>
  )
}
