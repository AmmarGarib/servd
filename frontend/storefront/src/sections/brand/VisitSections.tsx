// The brand Visit page (`brand:<slug>:visit`) as sections: a page header,
// the live address / map / hours block, and the questions & answers. Address,
// phone, email, pin, kitchens and hours are live (Admin → Brands / Locations);
// the labels, questions and answers are fields.

import Link from 'next/link'
import type { ServiceHourSlot } from '../../lib/concept'
import { typeLabel } from '../../lib/concept'
import { locationFromConcept, fetchBrandKitchens, mapsLinkFor, type BrandKitchen } from '../../lib/brandLocations'
import type { SectionProps } from '../types'
import { color, link, str } from '../safe'
import { TEXT_SURFACE, brandHref, brandNameOf, fill, orLive } from './util'
import { faqEntries } from './faq'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** brand.pageHeader — eyebrow, headline, one line, an optional button. */
export function PageHeader({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const name = brandNameOf(ctx)
  const live = concept
    ? `We’re a ${typeLabel(concept.type).toLowerCase()} kitchen — order in, walk in, or grab to go.`
    : ''
  const body = orLive(fields.body, live, ctx, name)
  const cta = link(fields.cta)
  const to = brandHref(cta.href, ctx)
  return (
    <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)', background: color(fields.bg) ?? TEXT_SURFACE }}>
      <div className="container">
        {str(fields.eyebrow) && (
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            {fill(fields.eyebrow, ctx, name)}
          </p>
        )}
        <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', marginBottom: '0.5rem' }}>
          {fill(fields.headline, ctx, name)}
        </h1>
        {body && <p style={{ color: 'var(--servd-mute)', maxWidth: '32rem' }}>{body}</p>}
        {to && cta.text && (
          <Link href={to.href} className="servd-btn-primary" style={{ marginTop: '1.5rem', padding: '0.85rem 1.75rem' }}>
            {fill(cta.text, ctx, name)}
          </Link>
        )}
      </div>
    </section>
  )
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Collapse per-day slots into one row per day-of-week, Monday first. No
// serviceHours rows → null (show nothing rather than fake data).
function buildHoursTable(slots: ServiceHourSlot[]): Array<{ day: string; hours: string }> | null {
  if (!slots || slots.length === 0) return null
  const byDay: Record<number, ServiceHourSlot[]> = {}
  for (const s of slots) {
    ;(byDay[s.dayOfWeek] ??= []).push(s)
  }
  const rows: Array<{ day: string; hours: string }> = []
  for (let d = 1; d <= 7; d++) {
    const dow = d % 7  // 1=Mon … 6=Sat, 0=Sun
    const daySlots = byDay[dow]
    if (!daySlots) continue
    const windows = [...daySlots]
      .sort((a, b) => a.openMin - b.openMin)
      .map((s) => `${minToTime(s.openMin)} – ${minToTime(s.closeMin)}`)
      .join(', ')
    rows.push({ day: DAY_LABELS[dow]!, hours: windows })
  }
  return rows.length > 0 ? rows : null
}

/** brand.visitInfo — address, contact, map, other kitchens, opening hours. */
export async function VisitInfo({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  if (!concept) return null
  const name = brandNameOf(ctx)

  // Where the brand cooks: its kitchens (Locations), primary first. The
  // address and pin are the kitchen's, not the brand's (owner decision 18);
  // the concept row carries a mirror of the primary kitchen for when the
  // kitchen list is unavailable.
  let kitchens: BrandKitchen[] = []
  try { kitchens = await fetchBrandKitchens(API_URL, concept.slug) } catch { kitchens = [] }
  const primary = kitchens[0] ?? null
  const address = primary?.address ?? concept.address ?? null
  const lat = primary?.latitude ?? concept.latitude ?? null
  const lng = primary?.longitude ?? concept.longitude ?? null
  const hasGeo = lat != null && lng != null
  const otherKitchens = kitchens.slice(1)
  const hoursTable = buildHoursTable(concept.serviceHours ?? [])
  const loc = locationFromConcept(concept, primary)
  const cta = link(fields.cta)
  const to = brandHref(cta.href, ctx)
  // The brand's servd location page (absolute on the brand's own domain).
  const locLink = link(fields.locationLink)
  const locTo = locLink.text.trim() ? brandHref(locLink.href, ctx) : null
  const accent = color(fields.linkColor) ?? 'var(--servd-green-dark)'

  return (
    <section className="section" style={{ background: color(fields.bg) ?? TEXT_SURFACE }}>
      <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '2.5rem' }}>

        {/* Address + map */}
        <div>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{fill(fields.addressHeading, ctx, name)}</h2>

          {address ? (
            <p style={{ color: 'var(--servd-ink)', fontSize: '1rem', lineHeight: 1.6, marginBottom: '0.75rem' }}>
              {address.split('\n').map((line, i, all) => (
                <span key={i}>{line}{i < all.length - 1 && <br />}</span>
              ))}
              {primary?.city ? <><br />{primary.city}</> : null}
            </p>
          ) : (
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
              {fill(fields.noAddress, ctx, name)}
            </p>
          )}

          {concept.phone && (
            <p style={{ marginBottom: '0.5rem' }}>
              <a href={`tel:${concept.phone}`}
                style={{ color: accent, fontWeight: 600, fontSize: '0.95rem' }}>
                {concept.phone}
              </a>
            </p>
          )}

          {loc.email && (
            <p style={{ marginBottom: '0.5rem' }}>
              <a href={`mailto:${loc.email}`}
                style={{ color: accent, fontWeight: 600, fontSize: '0.95rem' }}>
                {loc.email}
              </a>
            </p>
          )}

          {locTo && (
            <p style={{ marginBottom: '0.5rem' }}>
              <a href={locTo.href}
                {...(locTo.external && { target: '_blank', rel: 'noopener noreferrer' })}
                style={{ color: accent, fontWeight: 600, fontSize: '0.95rem' }}>
                {fill(locLink.text, ctx, name)}
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
                title={`${name} location`}
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
              <h3 style={{ fontSize: '1rem', marginBottom: '0.6rem' }}>{fill(fields.alsoAtHeading, ctx, name)}</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.6rem' }}>
                {otherKitchens.map((k) => (
                  <li key={k.slug} style={{ fontSize: '0.95rem', color: 'var(--servd-ink)' }}>
                    <strong>{k.name}</strong>
                    {(k.address || k.city) && <span style={{ color: 'var(--servd-mute)' }}> · {[k.address, k.city].filter(Boolean).join(', ')}</span>}
                    {k.latitude != null && k.longitude != null && (
                      <> · <a href={mapsLinkFor({ lat: k.latitude, lng: k.longitude })} target="_blank" rel="noopener noreferrer"
                        style={{ color: accent, fontWeight: 600 }}>{fill(fields.directionsLabel, ctx, name)}</a></>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Hours */}
        <div>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{fill(fields.hoursHeading, ctx, name)}</h2>

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
              {str(fields.hoursNote) && (
                <p style={{ color: 'var(--servd-dim)', fontSize: '0.8rem', marginTop: '0.85rem' }}>
                  {fill(fields.hoursNote, ctx, name)}
                </p>
              )}
            </>
          ) : (
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem' }}>
              {fill(fields.noHours, ctx, name)}
            </p>
          )}
        </div>
      </div>

      {to && cta.text && (
        <div className="container" style={{ marginTop: '3rem', textAlign: 'center' }}>
          <Link href={to.href} className="servd-btn-primary" style={{ padding: '1rem 2.25rem' }}>
            {fill(cta.text, ctx, name)}
          </Link>
        </div>
      )}
    </section>
  )
}

/** brand.faq — questions and answers, all visible (the Visit page's FAQPage
 *  structured data is built from these same entries). */
export function Faq({ fields, ctx }: SectionProps) {
  const name = brandNameOf(ctx)
  const items = faqEntries(fields, ctx)
  if (items.length === 0) return null
  return (
    <section className="section" style={{ borderTop: '1px solid var(--servd-line)', background: color(fields.bg) ?? TEXT_SURFACE }}>
      <div className="container-narrow">
        {str(fields.eyebrow) && (
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            {fill(fields.eyebrow, ctx, name)}
          </p>
        )}
        {str(fields.heading) && (
          <h2 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', marginBottom: '2rem' }}>
            {fill(fields.heading, ctx, name)}
          </h2>
        )}
        <div style={{ display: 'grid', gap: '1.75rem' }}>
          {items.map((q, i) => (
            <div key={i}>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '0.45rem' }}>{q.question}</h3>
              <p style={{ color: 'var(--servd-mute)', fontSize: '1rem', lineHeight: 1.6 }}>
                {q.answer}
                {q.link && (
                  <>
                    {' '}
                    <a href={q.link.href}
                      {...(q.link.external && { target: '_blank', rel: 'noopener noreferrer' })}
                      style={{ color: 'var(--servd-green-dark)', fontWeight: 600 }}>
                      {q.link.text}
                    </a>
                  </>
                )}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
