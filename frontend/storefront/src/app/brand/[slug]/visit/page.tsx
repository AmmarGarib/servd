import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Concept } from '../../../../lib/concept'
import { typeLabel } from '../../../../lib/concept'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcept(slug: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const all: Concept[] = await res.json()
    return all.find((c) => c.slug === slug) ?? null
  } catch { return null }
}

const HOURS_DEFAULT = [
  { day: 'Mon', open: '11:00', close: '23:00' },
  { day: 'Tue', open: '11:00', close: '23:00' },
  { day: 'Wed', open: '11:00', close: '23:00' },
  { day: 'Thu', open: '11:00', close: '23:00' },
  { day: 'Fri', open: '11:00', close: '00:00' },
  { day: 'Sat', open: '11:00', close: '00:00' },
  { day: 'Sun', open: '12:00', close: '23:00' },
]

export default async function BrandVisitPage({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await getConcept(slug)
  if (!concept) notFound()

  const hasGeo = concept['latitude' as keyof Concept] && concept['longitude' as keyof Concept]
  // Concept type doesn't currently include lat/lng in the storefront DTO; we fall through to a placeholder map.

  return (
    <>
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            Visit
          </p>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', marginBottom: '0.5rem' }}>
            Find {concept.name}.
          </h1>
          <p style={{ color: 'var(--servd-mute)', maxWidth: '32rem' }}>
            We&rsquo;re a {typeLabel(concept.type).toLowerCase()} kitchen — order in, walk in, or grab to go.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '2.5rem' }}>

          {/* Address + map placeholder */}
          <div>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Our address</h2>
            <p style={{ color: 'var(--servd-ink)', fontSize: '1rem', lineHeight: 1.6, marginBottom: '0.5rem' }}>
              Plot 42, Industrial Area<br />
              Lahore, Pakistan
            </p>
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem' }}>
              <a href="tel:+9242XXXXXXXX" style={{ color: 'var(--servd-green-dark)', fontWeight: 600 }}>+92 42 XXX XXXX</a><br />
              <a href="mailto:hello@servd.pk" style={{ color: 'var(--servd-green-dark)', fontWeight: 600 }}>hello@servd.pk</a>
            </p>

            <div style={{
              marginTop: '1.5rem',
              aspectRatio: '4/3',
              borderRadius: '1rem',
              border: '1px solid var(--servd-line)',
              background: `linear-gradient(135deg, var(--servd-green-soft) 0%, white 100%)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--servd-mute)',
              fontSize: '0.85rem',
              textAlign: 'center',
              padding: '1.5rem',
            }}>
              <span>📍 Map placeholder<br /><span style={{ fontSize: '0.75rem', opacity: 0.7 }}>Wire up Google Maps / Mapbox once geo is set on this concept.</span></span>
            </div>
          </div>

          {/* Hours */}
          <div>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Opening hours</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
              <tbody>
                {HOURS_DEFAULT.map((h) => (
                  <tr key={h.day} style={{ borderBottom: '1px solid var(--servd-line)' }}>
                    <td style={{ padding: '0.7rem 0', color: 'var(--servd-mute)', fontWeight: 600, width: '6rem' }}>{h.day}</td>
                    <td style={{ padding: '0.7rem 0', color: 'var(--servd-ink)' }}>{h.open} – {h.close}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ color: 'var(--servd-dim)', fontSize: '0.8rem', marginTop: '0.85rem' }}>
              Times shown for delivery and pickup; dine-in may differ. We&rsquo;ll show live availability when you start an order.
            </p>
          </div>
        </div>

        <div className="container" style={{ marginTop: '3rem', textAlign: 'center' }}>
          <Link href={`/${concept.slug}`} className="servd-btn-primary" style={{ padding: '1rem 2.25rem' }}>
            Order Now →
          </Link>
        </div>
      </section>
    </>
  )
}
