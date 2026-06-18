'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, formatBrandName } from '../../../lib/concept'

interface Props {
  current: Concept
  concepts: Concept[]
  accent: string
  /** Override the heading kicker — defaults to "Other GS Foods kitchens". */
  kicker?: string
  /** Override the heading line. */
  heading?: string
}

export function CrossBrandStrip({ current, concepts, accent, kicker, heading }: Props) {
  const others = concepts.filter((c) => c.slug !== current.slug).slice(0, 6)
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
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', marginTop: '0.4rem', maxWidth: '32rem' }}>
              Same operator, same standards. Different cuisine, different vibe — and you can pair them in one cart.
            </p>
          </div>
          <Link href="/browse" className="servd-btn-secondary" style={{ padding: '0.7rem 1.25rem', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
            See all kitchens →
          </Link>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
          {others.map((c) => (
            <Link
              key={c.id}
              href={`/brand/${c.slug}`}
              aria-label={`Visit ${formatBrandName(c.name)}`}
              className="servd-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column' }}
            >
              <div style={{
                aspectRatio: '4/3',
                background: `${c.primaryColor ?? 'var(--servd-green-dark)'} url(${conceptHeroImage(c)}) center/cover`,
                position: 'relative',
              }}>
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
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800 }}>{formatBrandName(c.name)}</h3>
                {c.description && (
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.875rem', lineHeight: 1.4 }}>
                    {c.description}
                  </p>
                )}
                <span style={{ marginTop: '0.4rem', fontSize: '0.85rem', fontWeight: 800, color: c.primaryColor ?? 'var(--servd-green-dark)' }}>
                  Visit {formatBrandName(c.name)} →
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
