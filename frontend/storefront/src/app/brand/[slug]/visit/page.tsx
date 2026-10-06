import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Concept, ServiceHourSlot } from '../../../../lib/concept'
import { typeLabel, formatBrandName } from '../../../../lib/concept'
import { faqSchema, jsonLdScript } from '../../../../lib/jsonLd'
import { locationFromConcept, fetchBrandKitchens, mapsLinkFor } from '../../../../lib/brandLocations'

// force-dynamic + cache: 'no-store' so a single API outage at deploy
// time can't poison the ISR cache and return 404s for the lifetime of
// the container (see CLAUDE.md "Fetch caching gotcha").
export const dynamic = 'force-dynamic'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcept(slug: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
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

  // Where the brand cooks: its kitchens (Locations), primary first. The
  // address and pin are the kitchen's, not the brand's (owner decision 18);
  // the concept row carries a mirror of the primary kitchen for when the
  // kitchen list is unavailable.
  const kitchens = await fetchBrandKitchens(API_URL, slug)
  const primary = kitchens[0] ?? null
  const address = primary?.address ?? concept.address ?? null
  const lat = primary?.latitude ?? concept.latitude ?? null
  const lng = primary?.longitude ?? concept.longitude ?? null
  const hasGeo = lat != null && lng != null
  const otherKitchens = kitchens.slice(1)
  const hoursTable = buildHoursTable(concept.serviceHours ?? [])

  // FAQ schema — LLMs (Perplexity, ChatGPT, Google AI Overviews) lift
  // these verbatim when answering "best small plates Karachi parking" or
  // "is simmer halal" / "what's the dress code at simmer". This is the
  // AI-citation move from the ai-seo skill. Per concept, tuned to the
  // brand's actual posture; falls back to generic restaurant FAQ if
  // brandLocations isn't filled in.
  const loc = locationFromConcept(concept, primary)
  const placeKnown = !loc.area.startsWith('TODO')
  const faq = [
    { question: `Where is ${formatBrandName(concept.name)} located?`,
      answer:    placeKnown ? `${formatBrandName(concept.name)} is at ${loc.area}, ${loc.city}.` : `${formatBrandName(concept.name)} is in ${loc.city}.` },
    { question: `Does ${formatBrandName(concept.name)} take reservations?`,
      answer:    loc.acceptsReservations
        ? `Yes — book a table at /reserve/${slug}, or message us on WhatsApp.`
        : `${formatBrandName(concept.name)} is walk-in friendly. For delivery and pickup, order at /${slug}.` },
    { question: `Is the food halal?`,
      answer:    `All ${formatBrandName(concept.name)} kitchens serve halal-only meat. No pork, no alcohol on the cooking line.` },
    { question: `Does ${formatBrandName(concept.name)} deliver?`,
      answer:    loc.acceptsReservations === false
        ? `Yes — order at /${slug} for delivery, pickup, or curbside.`
        : `${formatBrandName(concept.name)} is primarily dine-in. For delivery from our sister kitchens, see /browse.` },
    { question: `What's the dress code?`,
      answer:    `Smart casual works everywhere. ${formatBrandName(concept.name) === 'Simmer' ? 'Simmer is a dimly-lit room; the dressier you are the more it suits the space.' : 'No formal requirement.'}` },
    { question: `Is there parking?`,
      answer:    `Street parking is available around the venue. We recommend arriving 10 minutes early on weekends.` },
  ]

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqSchema(faq)) }} />
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            Visit
          </p>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', marginBottom: '0.5rem' }}>
            Find {formatBrandName(concept.name)}.
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

            {address ? (
              <p style={{ color: 'var(--servd-ink)', fontSize: '1rem', lineHeight: 1.6, marginBottom: '0.75rem' }}>
                {address.split('\n').map((line, i, all) => (
                  <span key={i}>{line}{i < all.length - 1 && <br />}</span>
                ))}
                {primary?.city ? <><br />{primary.city}</> : null}
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
                  src={`https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`}
                  width="100%"
                  height="300"
                  style={{ border: 0, borderRadius: '1rem', display: 'block' }}
                  allowFullScreen
                  loading="lazy"
                  title={`${formatBrandName(concept.name)} location`}
                />
              ) : address ? (
                <div style={{
                  padding: '1.25rem',
                  borderRadius: '1rem',
                  border: '1px solid var(--servd-line)',
                  background: 'var(--servd-green-soft)',
                  fontSize: '0.95rem',
                  color: 'var(--servd-ink)',
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--servd-green-dark)"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    style={{ display: 'inline-block', verticalAlign: '-3px', marginRight: '0.5rem' }}>
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                  </svg>
                  {address}
                </div>
              ) : null}
            </div>

            {/* A brand cooked in more than one kitchen lists the others too. */}
            {otherKitchens.length > 0 && (
              <div style={{ marginTop: '1.5rem' }}>
                <h3 style={{ fontSize: '1rem', marginBottom: '0.6rem' }}>Also at</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.6rem' }}>
                  {otherKitchens.map((k) => (
                    <li key={k.slug} style={{ fontSize: '0.95rem', color: 'var(--servd-ink)' }}>
                      <strong>{k.name}</strong>
                      {(k.address || k.city) && <span style={{ color: 'var(--servd-mute)' }}> · {[k.address, k.city].filter(Boolean).join(', ')}</span>}
                      {k.latitude != null && k.longitude != null && (
                        <> · <a href={mapsLinkFor({ lat: k.latitude, lng: k.longitude })} target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--servd-green-dark)', fontWeight: 600 }}>Directions</a></>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
