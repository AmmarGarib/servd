// servd.locationDetails — the /locations/[loc] Find-us and Visit cards plus
// the embedded map. Address, phone, WhatsApp, email and whether the brand
// takes reservations are live (ctx.params.loc); every label is a field.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { addressLine, whatsappLink } from '../../lib/brandLocations'
import { formatBrandName } from '../../lib/concept'
import type { SectionProps } from '../types'
import { str } from '../safe'
import { fillLocation, findLocation } from './location'

const quiet: CSSProperties = { background: 'var(--servd-surface)', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)' }

export async function LocationDetails({ fields, ctx }: SectionProps) {
  const brand = await findLocation(ctx.params?.loc)
  if (!brand) return null
  const name = formatBrandName(brand.name)
  const mapsQuery = encodeURIComponent(`${brand.name} ${brand.area} ${brand.city}`)
  const t = (k: string) => str(fields[k])
  const visitBody = fillLocation(brand.acceptsReservations ? t('reservationsBody') : t('walkInBody'), brand)

  return (
    <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
      <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        {/* NAP card */}
        <div className="servd-card" style={{ padding: '1.5rem' }}>
          {t('findTitle') && <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>{t('findTitle')}</p>}
          <p style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.25rem' }}>{addressLine(brand)}</p>
          {!brand.street.startsWith('TODO') && (
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', marginBottom: '1rem' }}>{brand.street}</p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
            {t('mapsText') && (
              <a href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
                target="_blank" rel="noopener noreferrer"
                className="brand-pill"
                style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
                {t('mapsText')}
              </a>
            )}
            {t('callText') && (
              <a href={`tel:${brand.phone.replace(/\s/g, '')}`} className="brand-pill" style={quiet}>
                {t('callText')}
              </a>
            )}
            {t('whatsappText') && (
              <a href={whatsappLink(brand, fillLocation(t('whatsappGreeting'), brand) || undefined)}
                target="_blank" rel="noopener noreferrer"
                className="brand-pill"
                style={{ background: '#25D366', color: 'white' }}>
                {t('whatsappText')}
              </a>
            )}
            {brand.email && t('emailText') && (
              <a href={`mailto:${brand.email}`} className="brand-pill" style={quiet}>
                {t('emailText')}
              </a>
            )}
          </div>
        </div>

        {/* Actions card */}
        <div className="servd-card" style={{ padding: '1.5rem' }}>
          {t('visitTitle') && <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>{t('visitTitle')}</p>}
          {visitBody && (
            <p style={{ fontSize: '0.95rem', color: 'var(--servd-mute)', lineHeight: 1.5, marginBottom: '1rem' }}>
              {visitBody}
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {t('menuText') && (
              <Link href={`/brand/${brand.slug}/menu`} className="brand-pill" style={{ background: 'var(--servd-ink)', color: 'white' }}>
                {t('menuText')}
              </Link>
            )}
            {brand.acceptsReservations && t('bookText') && (
              <Link href={`/reserve/${brand.slug}`} className="brand-pill" style={quiet}>
                {t('bookText')}
              </Link>
            )}
            {t('orderText') && (
              <Link href={`/${brand.slug}`} className="brand-pill" style={quiet}>
                {t('orderText')}
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Embedded Google map */}
      {fields.showMap === true && (
        <div className="container" style={{ marginTop: '2rem' }}>
          <div style={{ aspectRatio: '16/9', borderRadius: '1rem', overflow: 'hidden', border: '1px solid var(--servd-line)' }}>
            <iframe
              src={`https://www.google.com/maps?q=${mapsQuery}&output=embed`}
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
