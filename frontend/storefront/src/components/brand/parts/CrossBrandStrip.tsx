'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, formatBrandName } from '../../../lib/concept'
import { brandCanonical } from '../../../lib/brandDomains'
import { servdHref } from '../../../sections/brand/util'

/**
 * The strip's colours on a brand's own page. Every value is a CSS colour
 * (a brand token); anything left out keeps the servd look (white cards, the
 * purple button, each brand's colour on its card). Plain data, so a server
 * section can pass it.
 */
export interface CrossBrandTheme {
  /** The line under the heading. */
  muted?: string
  /** The rule under the strip. */
  line?: string
  cardBg?: string
  cardText?: string
  cardMuted?: string
  /** A full `border` value. */
  cardBorder?: string
  /** The card's call to action. Omitted = each brand's own colour. */
  cardCta?: string
  /** false = no art panel: a typographic card (Simmer — no placeholders,
   *  no gradients). The type badge then sits above the name. */
  panel?: boolean
  badgeBg?: string
  badgeText?: string
  /** A full `border` value for the badge. */
  badgeBorder?: string
  /** The "See all kitchens" button's class(es), from the brand's own button
   *  system (it keeps that system's hover). Omitted = servd's secondary pill. */
  allClassName?: string
}

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
  /** The host brand's palette (see CrossBrandTheme). */
  theme?: CrossBrandTheme
}

// Each brand has its own basket (opening another kitchen's menu starts a new
// one), so the line no longer says they pair in one cart.
const DEFAULT_SUBTITLE = 'Same operator, same standards. Different cuisine, different vibe.'

export function CrossBrandStrip({ current, concepts, accent, kicker, heading, subtitle, allLabel, allHref, cardCta, onBrandHost, theme = {} }: Props) {
  const sub = subtitle ?? DEFAULT_SUBTITLE
  const all = allLabel ?? 'See all kitchens →'
  const allTo = servdHref(allHref || '/home#kitchens', !!onBrandHost)
  const cta = cardCta ?? 'Visit {name} →'
  const showPanel = theme.panel !== false
  // Only siblings from the SAME operating company. The storefront's concept
  // list spans every company on servd, and this strip claims "same operator,
  // same standards" — false across companies. If the API hasn't sent tenantId
  // (older cached response, or the static fallback list), fall back to
  // showing nothing rather than guessing wrong.
  const others = concepts
    .filter((c) => c.slug !== current.slug)
    .filter((c) => (current.tenantId ? c.tenantId === current.tenantId : false))
    .slice(0, 6)
  if (others.length === 0) return null

  const badgeStyle: CSSProperties = {
    background: theme.badgeBg ?? 'rgba(255,255,255,0.92)',
    color: theme.badgeText ?? 'var(--servd-black)',
    ...(theme.badgeBorder && { border: theme.badgeBorder }),
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    padding: '0.3rem 0.65rem',
    borderRadius: '999px',
  }

  return (
    <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: `1px solid ${theme.line ?? 'var(--servd-line)'}` }}>
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
              <p style={{ color: theme.muted ?? 'var(--servd-mute)', fontSize: '0.95rem', marginTop: '0.4rem', maxWidth: '32rem' }}>
                {sub}
              </p>
            )}
          </div>
          {all && (
            theme.allClassName
              ? <Link href={allTo} className={theme.allClassName} style={{ whiteSpace: 'nowrap' }}>{all}</Link>
              : (
                <Link href={allTo} className="servd-btn-secondary" style={{ padding: '0.7rem 1.25rem', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                  {all}
                </Link>
              )
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
          {others.map((c) => {
            const name = formatBrandName(c.name)
            const art = showPanel ? conceptHeroImage(c, 'card') : null
            const brandColour = c.primaryColor ?? 'var(--servd-green-dark)'
            // Each brand on its own domain (the canonical microsite) — a plain
            // anchor, since it leaves this site.
            return (
            <a
              key={c.id}
              href={brandCanonical(c.slug)}
              aria-label={`Visit ${name}`}
              className="servd-card"
              style={{
                textDecoration: 'none',
                color: theme.cardText ?? 'inherit',
                display: 'flex',
                flexDirection: 'column',
                ...(theme.cardBg && { background: theme.cardBg }),
                ...(theme.cardBorder && { border: theme.cardBorder }),
              }}
            >
              {showPanel && (
              <div style={{
                aspectRatio: '4/3',
                background: brandColour,
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
                <div style={{ ...badgeStyle, position: 'absolute', top: '0.85rem', left: '0.85rem' }}>
                  {typeLabel(c.type)}
                </div>
              </div>
              )}
              <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {!showPanel && (
                  <span style={{ ...badgeStyle, alignSelf: 'flex-start', marginBottom: '0.35rem' }}>{typeLabel(c.type)}</span>
                )}
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800 }}>{name}</h3>
                {c.description && (
                  <p style={{ color: theme.cardMuted ?? 'var(--servd-mute)', fontSize: '0.875rem', lineHeight: 1.4 }}>
                    {c.description}
                  </p>
                )}
                <span style={{ marginTop: '0.4rem', fontSize: '0.85rem', fontWeight: 800, color: theme.cardCta ?? brandColour }}>
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
