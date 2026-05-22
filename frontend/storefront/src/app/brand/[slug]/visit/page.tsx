import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Concept, ServiceHourSlot } from '../../../../lib/concept'
import { typeLabel } from '../../../../lib/concept'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcept(slug: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const all: Concept[] = await res.json()
    return all.find((c) => c.slug === slug) ?? null
  } catch { return null }
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Collapse per-day slots into a readable table row per day-of-week.
// If a concept has no serviceHours rows, return null (show nothing rather than fake data).
function buildHoursTable(slots: ServiceHourSlot[]): Array<{ day: string; hours: string }> | null {
  if (!slots || slots.length === 0) return null
  const byDay: Record<number, ServiceHourSlot[]> = {}
  for (const s of slots) {
    ;(byDay[s.dayOfWeek] ??= []).push(s)
  }
  // Emit rows for every day 0-6; only days with entries get listed.
  const rows: Array<{ day: string; hours: string }> = []
  for (let d = 1; d <= 7; d++) {
    const dow = d % 7  // 1=Mon … 6=Sat, 0=Sun
    const daySlots = byDay[dow]
    if (!daySlots) continue
    const windows = daySlots
      .sort((a, b) => a.openMin - b.openMin)
      .map((s) => `${minToTime(s.openMin)} – ${minToTime(s.closeMin)}`)
      .join(', ')
    rows.push({ day: DAY_LABELS[dow]!, hours: windows })
  }
  return rows.length > 0 ? rows : null
}

export default async function BrandVisitPage({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await getConcept(slug)
  if (!concept) notFound()

  const hasGeo = concept.latitude != null && concept.longitude != null
  const hoursTable = buildHoursTable(concept.serviceHours ?? [])

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

          {/* Address + map */}
          <div>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Our address</h2>

            {concept.address ? (
              <p style={{ color: 'var(--servd-ink)', fontSize: '1rem', lineHeight: 1.6, marginBottom: '0.75rem' }}>
                {concept.address.split('\n').map((line, i) => (
                  <span key={i}>{line}{i < concept.address!.split('\n').length - 1 && <br />}</span>
                ))}
              </p>
            ) : (
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                Address not set — check our socials for directions.
              </p>
            )}

            {concept.phone && (
              <p style={{ marginBottom: '0.5rem' }}>
                <a href={`tel:${concept.phone}`}
                  style={{ color: 'var(--servd-green-dark)', fontWeight: 600, fontSize: '0.95rem' }}>
                  {concept.phone}
                </a>
              </p>
            )}

            {/* Map — real embed when geo is set, address text otherwise */}
            <div style={{ marginTop: '1.5rem' }}>
              {hasGeo ? (
                <iframe
                  src={`https://maps.google.com/maps?q=${concept.latitude},${concept.longitude}&z=15&output=embed`}
                  width="100%"
                  height="300"
                  style={{ border: 0, borderRadius: '1rem', display: 'block' }}
                  allowFullScreen
                  loading="lazy"
                  title={`${concept.name} location`}
                />
              ) : concept.address ? (
                <div style={{
                  padding: '1.25rem',
                  borderRadius: '1rem',
                  border: '1px solid var(--servd-line)',
                  background: 'var(--servd-green-soft)',
                  fontSize: '0.95rem',
                  color: 'var(--servd-ink)',
                }}>
                  <span style={{ fontSize: '1.25rem', marginRight: '0.5rem' }}>📍</span>
                  {concept.address}
                </div>
              ) : null}
            </div>
          </div>

          {/* Hours */}
          <div>
            <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Opening hours</h2>

            {hoursTable ? (
              <>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
                  <tbody>
                    {hoursTable.map((h) => (
                      <tr key={h.day} style={{ borderBottom: '1px solid var(--servd-line)' }}>
                        <td style={{ padding: '0.7rem 0', color: 'var(--servd-mute)', fontWeight: 600, width: '6rem' }}>{h.day}</td>
                        <td style={{ padding: '0.7rem 0', color: 'var(--servd-ink)' }}>{h.hours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ color: 'var(--servd-dim)', fontSize: '0.8rem', marginTop: '0.85rem' }}>
                  Times shown for delivery and pickup; dine-in may differ. We&rsquo;ll show live availability when you start an order.
                </p>
              </>
            ) : (
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem' }}>
                Hours not configured yet — start an order to see live availability.
              </p>
            )}
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
