'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, formatBrandName } from '../../../lib/concept'
import { brandCanonical } from '../../../lib/brandDomains'
import { servdHref } from '../../../sections/brand/util'

interface Props {
  current: Concept
  concepts: Concept[]
  accent: string
  /** Override the heading kicker — defaults to "Other GS Foods kitchens". */
  kicker?: string
  /** Override the heading line. */
  heading?: string
  /** Override the line under the heading ('' hides it). */
  subtitle?: string
  /** Override the "See all kitchens →" button label ('' hides the button). */
  allLabel?: string
  /** Override the button's link (default /home#kitchens). */
  allHref?: string
  /** Each card's call to action; `{name}` = that brand (default 'Visit {name} →'). */
  cardCta?: string
  /** Rendered on a brand's own domain (pass `ctx.onBrandHost`): the "all
   *  kitchens" link is then absolute on servd's origin, so it does not land on
   *  a copy of the servd page on the brand domain. */
  onBrandHost?: boolean
}

const DEFAULT_SUBTITLE = 'Same operator, same standards. Different cuisine, different vibe — and you can pair them in one cart.'

export function CrossBrandStrip({ current, concepts, accent, kicker, heading, subtitle, allLabel, allHref, cardCta, onBrandHost }: Props) {
  const sub = subtitle ?? DEFAULT_SUBTITLE
  const all = allLabel ?? 'See all kitchens →'
  const allTo = servdHref(allHref || '/home#kitchens', !!onBrandHost)
  const cta = cardCta ?? 'Visit {name} →'
  // Only siblings from the SAME operating company. The storefront's concept
  // list spans every company on servd, and this strip claims "same operator,
  // same standards" and that you can pair the brands in one cart — both false
  // across companies, and the shared cart genuinely doesn't work that way. If
  // the API hasn't sent tenantId (older cached response, or the static
  // fallback list), fall back to showing nothing rather than guessing wrong.
  const others = concepts
    .filter((c) => c.slug !== current.slug)
    .filter((c) => (current.tenantId ? c.tenantId === current.tenantId : false))
    .slice(0, 6)
  if (others.length === 0) return null

  return (
    <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)' }}>
      <div className="container">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <p style={{ color: accent, fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
              {kicker ?? 'Other GS Foods kitchens'}
            </p>
            <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', letterSpacing: '-0.02em' }}>
              {heading ?? `Liked ${formatBrandName(current.name)}? Try one of these.`}
            </h2>
            {sub && (
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', marginTop: '0.4rem', maxWidth: '32rem' }}>
                {sub}
              </p>
            )}
          </div>
          {all && (
            <Link href={allTo} className="servd-btn-secondary" style={{ padding: '0.7rem 1.25rem', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
              {all}
            </Link>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
          {others.map((c) => {
            const name = formatBrandName(c.name)
            const art = conceptHeroImage(c, 'card')
            // Each brand on its own domain (the canonical microsite) — a plain
            // anchor, since it leaves this site.
            return (
            <a
              key={c.id}
              href={brandCanonical(c.slug)}
              aria-label={`Visit ${name}`}
              className="servd-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column' }}
            >
              <div style={{
                aspectRatio: '4/3',
                background: c.primaryColor ?? 'var(--servd-green-dark)',
                position: 'relative',
                overflow: 'hidden',
              }}>
                {/* The brand's card-sized art, lazy: the strip sits at the foot
                    of the page, and a CSS background could not wait. */}
                {art && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={art}
                    alt=""
                    width={640}
                    height={480}
                    loading="lazy"
                    decoding="async"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                )}
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.55) 100%)' }} />
                <div style={{
                  position: 'absolute',
                  top: '0.85rem',
                  left: '0.85rem',
                  background: 'rgba(255,255,255,0.92)',
                  color: 'var(--servd-black)',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  padding: '0.3rem 0.65rem',
                  borderRadius: '999px',
                }}>
                  {typeLabel(c.type)}
                </div>
              </div>
              <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800 }}>{name}</h3>
                {c.description && (
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.875rem', lineHeight: 1.4 }}>
                    {c.description}
                  </p>
                )}
                <span style={{ marginTop: '0.4rem', fontSize: '0.85rem', fontWeight: 800, color: c.primaryColor ?? 'var(--servd-green-dark)' }}>
                  {cta.replace(/\{name\}/g, name)}
                </span>
              </div>
            </a>
            )
          })}
        </div>
      </div>
    </section>
  )
}
