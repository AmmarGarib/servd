// servd.locationDetails — the /locations/[loc] Find-us and Visit cards plus
// the embedded map. Address, phone, WhatsApp, email and whether the brand
// takes reservations are live (ctx.params.loc); every label is a field.
//
// Only real NAP reaches the page: Call needs a phone, WhatsApp a number (wa.me
// with none opens the share sheet), and the Maps link + embed come from the
// operator's Maps link / the pin, else a query built from the filled address
// parts — never a TODO_FILL placeholder. With none of those there is no map.
// "See the menu" goes to the brand's own domain (stackd.pk/menu), the
// canonical home of its microsite.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { addressLine, filled, mapsLinkFor, whatsappLink, type BrandLocation } from '../../lib/brandLocations'
import { brandCanonical } from '../../lib/brandDomains'
import { formatBrandName } from '../../lib/concept'
import type { SectionProps } from '../types'
import { str } from '../safe'
import { fillLocation, findLocation } from './location'

const quiet: CSSProperties = { background: 'var(--servd-surface)', color: 'var(--servd-ink)' }

/** Where the Maps button goes and what the embed shows ('' = nothing to show). */
function mapsFor(brand: BrandLocation, name: string): { href: string; embedQuery: string } {
  const street = filled(brand.street)
  const area = filled(brand.area)
  // A name + city query finds nothing in particular: only search by address
  // when there is a street or an area to search for.
  const query = street || area ? [name, street, area, filled(brand.city)].filter(Boolean).join(', ') : ''
  // Only a sourced pin: mapsUrl is set exactly when there is one (a live pin
  // from the kitchen / brand row, or the operator's share link behind the
  // bundled Simmer / Stackd pins). Flipd's unverified fallback pin and the
  // Karachi-centroid default for a new brand carry no mapsUrl, so they never
  // become an "Open in Maps" target or an embedded map.
  const geo: BrandLocation['geo'] | undefined = filled(brand.mapsUrl) ? brand.geo : undefined
  const pin = geo ? `${geo.lat},${geo.lng}` : ''
  const href = filled(brand.mapsUrl)
    || (geo ? mapsLinkFor(geo) : '')
    || (query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '')
  return { href, embedQuery: pin || query }
}

export async function LocationDetails({ fields, ctx }: SectionProps) {
  const brand = await findLocation(ctx.params?.loc)
  if (!brand) return null
  const name = formatBrandName(brand.name)
  const maps = mapsFor(brand, name)
  const street = filled(brand.street)
  const phone = filled(brand.phone).replace(/\s/g, '')
  const hasWhatsapp = filled(brand.whatsapp) !== ''
  const t = (k: string) => str(fields[k])
  const visitBody = fillLocation(brand.acceptsReservations ? t('reservationsBody') : t('walkInBody'), brand)

  return (
    <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
      <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        {/* NAP card */}
        <div className="servd-card sv-hard-card" style={{ padding: '1.5rem' }}>
          {t('findTitle') && <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>{t('findTitle')}</p>}
          <p style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.25rem' }}>{addressLine(brand)}</p>
          {street && (
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', marginBottom: '1rem' }}>{street}</p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
            {t('mapsText') && maps.href && (
              <a href={maps.href}
                target="_blank" rel="noopener noreferrer"
                className="brand-pill sv-hard-btn"
                style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
                {t('mapsText')}
              </a>
            )}
            {t('callText') && phone && (
              <a href={`tel:${phone}`} className="brand-pill sv-hard-btn" style={quiet}>
                {t('callText')}
              </a>
            )}
            {t('whatsappText') && hasWhatsapp && (
              <a href={whatsappLink(brand, fillLocation(t('whatsappGreeting'), brand) || undefined)}
                target="_blank" rel="noopener noreferrer"
                className="brand-pill sv-hard-btn"
                style={{ background: '#25D366', color: 'white' }}>
                {t('whatsappText')}
              </a>
            )}
            {brand.email && t('emailText') && (
              <a href={`mailto:${brand.email}`} className="brand-pill sv-hard-btn" style={quiet}>
                {t('emailText')}
              </a>
            )}
          </div>
        </div>

        {/* Actions card */}
        <div className="servd-card sv-hard-card" style={{ padding: '1.5rem' }}>
          {t('visitTitle') && <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>{t('visitTitle')}</p>}
          {visitBody && (
            <p style={{ fontSize: '0.95rem', color: 'var(--servd-mute)', lineHeight: 1.5, marginBottom: '1rem' }}>
              {visitBody}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {t('menuText') && (
              // The brand's own domain: a plain cross-origin link.
              <a href={brandCanonical(brand.slug, 'menu')} className="brand-pill sv-hard-btn" style={{ background: 'var(--servd-ink)', color: 'white' }}>
                {t('menuText')}
              </a>
            )}
            {brand.acceptsReservations && t('bookText') && (
              <Link href={`/reserve/${brand.slug}`} className="brand-pill sv-hard-btn" style={quiet}>
                {t('bookText')}
              </Link>
            )}
            {t('orderText') && (
              <Link href={`/${brand.slug}`} className="brand-pill sv-hard-btn" style={quiet}>
                {t('orderText')}
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Embedded Google map — the pin, else the address; none without either. */}
      {fields.showMap === true && maps.embedQuery && (
        <div className="container" style={{ marginTop: '2rem' }}>
          <div style={{ aspectRatio: '16/9', borderRadius: '1rem', overflow: 'hidden', border: '1px solid var(--servd-line)' }}>
            <iframe
              src={`https://www.google.com/maps?q=${encodeURIComponent(maps.embedQuery)}&output=embed`}
              width="100%" height="100%" style={{ border: 0 }}
              loading="lazy" referrerPolicy="no-referrer-when-downgrade"
              title={`${name} on Google Maps`}
            />
          </div>
        </div>
      )}
    </section>
  )
}
