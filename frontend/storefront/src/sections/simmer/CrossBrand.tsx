// simmer.crossBrand — the shared CrossBrandStrip (brand parts, owned by the
// brand group) on a Simmer surface with an orange accent. All of its copy is
// fields; the cards are the company's other brands (live).
//
// The strip is drawn in Simmer's palette (SKILL rules): bone-on-tiber cards on
// the bone surface (hairline cards on the green one), no white, no art panels
// or gradient placeholders, Simmer's own `.action` button — and the kicker as
// the one orange signal (the card links are bone, not each brand's colour).
import type { SectionProps } from '../types'
import { link, safeHref, str } from '../safe'
import { CrossBrandStrip, type CrossBrandTheme } from '../../components/brand/parts/CrossBrandStrip'
import { simmerConcept, simmerText, surface, type Surface } from './shared'
import './crossBrand.css'

const BONE_72 = 'color-mix(in srgb, var(--simmer-bone) 72%, transparent)'

function simmerTheme(s: Surface): CrossBrandTheme {
  const onBone = s.name === 'bone'
  return {
    muted: onBone ? 'color-mix(in srgb, var(--simmer-green) 78%, transparent)' : BONE_72,
    line: s.line,
    cardBg: onBone ? 'var(--simmer-green)' : 'transparent',
    cardText: 'var(--simmer-bone)',
    cardMuted: BONE_72,
    cardBorder: onBone ? '1px solid var(--simmer-green)' : `1px solid ${s.line}`,
    cardCta: 'var(--simmer-bone)',
    panel: false,
    badgeBg: 'transparent',
    badgeText: 'var(--simmer-bone)',
    badgeBorder: '1px solid rgba(237,230,211,0.4)',
    allClassName: onBone ? 'action action--ink' : 'action',
  }
}

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
          theme={simmerTheme(s)}
        />
      </div>
    </div>
  )
}
