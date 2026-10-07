import Link from 'next/link'
import type { KitchensBlock } from '../../lib/blocks'
import type { Concept } from '../../lib/concept'
import { typeLabel, conceptHeroImage, heroCover, formatBrandName } from '../../lib/concept'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function fetchConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { next: { revalidate: 60 } })
    if (!res.ok) return []
    return res.json()
  } catch { return [] }
}

export async function Kitchens({ block }: { block: KitchensBlock }) {
  const concepts = await fetchConcepts()
  const visible = concepts.slice(0, block.max ?? 6)
  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          {block.kicker && (
            <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
              {block.kicker}
            </p>
          )}
          {block.title && (
            <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', color: 'inherit' }}>{block.title}</h2>
          )}
        </div>
        {block.showAllLink && (
          <Link href="/home#kitchens" className="servd-btn-secondary" style={{ padding: '0.6rem 1.1rem', fontSize: '0.9rem' }}>
            See all →
          </Link>
        )}
      </div>

      {visible.length === 0 ? (
        <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '2rem' }}>
          No kitchens available.
        </p>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1.25rem',
        }}>
          {visible.map((c) => (
            <Link key={c.id} href={`/brand/${c.slug}`} className="servd-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column' }}>
              <div style={{
                aspectRatio: '4/3',
                background: `${c.primaryColor ?? 'var(--servd-green-dark)'}${heroCover(conceptHeroImage(c))}`,
                position: 'relative',
              }}>
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.55) 100%)' }} />
                <div style={{
                  position: 'absolute', top: '0.85rem', left: '0.85rem',
                  background: 'rgba(255,255,255,0.92)', color: 'var(--servd-black)',
                  fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: '0.3rem 0.65rem', borderRadius: '999px',
                }}>
                  {typeLabel(c.type)}
                </div>
              </div>
              <div style={{ padding: '1.25rem 1.4rem' }}>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--servd-ink)' }}>{formatBrandName(c.name)}</h3>
                {c.description && (
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.875rem', lineHeight: 1.4, marginTop: '0.4rem' }}>
                    {c.description}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
