'use client'
// stackd.visit — hours + where. Hours, open/closed, address, phone, email and
// whether reservations are on are LIVE (admin → Brands); the words around them
// are fields.

import Link from 'next/link'
import type { SectionProps } from '../types'
import { str, link } from '../safe'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../../components/brand/parts/OpenStatusBadge'
import { locationFromConcept } from '../../lib/brandLocations'
import { StackdFrame, stackdConcept, fill, stackdHref } from './shared'

const CONTACT_LINK = { color: 'var(--stackd-cream)', textDecoration: 'none', borderBottom: '1px solid currentColor' } as const

export function StackdVisit({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  const hoursData = useHoursData(concept.slug)
  const reservations = concept.reservationsEnabled !== false
  const reserve = link(fields.reserveCta)
  // Booking is a servd page: absolute on servd's origin from stackd.pk.
  const reserveTo = stackdHref(reserve.href, ctx, concept)

  const address = str(fields.address).trim() || concept.address || str(fields.addressMissing)
  const phone = fields.showPhone !== false ? concept.phone : null
  // The brand's guest email (admin → Brands → Contact); the bundled default
  // only fills in when the API is down.
  const email = fields.showEmail !== false ? locationFromConcept(concept).email : null

  return (
    <StackdFrame>
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div
          className="stackd-visit-grid"
          style={{ maxWidth: '76rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }}
        >
          <div>
            {str(fields.hoursSpec) && <span className="stackd-spec">{fill(fields.hoursSpec, concept)}</span>}
            {str(fields.hoursHeading) && (
              <h2 className="stackd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.75rem' }}>
                {fill(fields.hoursHeading, concept)}
              </h2>
            )}
            <div style={{ marginBottom: '1.5rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
            <div className="stackd-mono" style={{ fontSize: '0.95rem' }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hoursData={hoursData} />
              ) : (
                <p style={{ opacity: 0.6 }}>{fill(fields.hoursEmpty, concept)}</p>
              )}
            </div>
          </div>

          <div>
            {str(fields.whereSpec) && <span className="stackd-spec">{fill(fields.whereSpec, concept)}</span>}
            {str(fields.whereHeading) && (
              <h2 className="stackd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.75rem' }}>
                {fill(fields.whereHeading, concept)}
              </h2>
            )}
            {address && (
              <p className="stackd-display" style={{ fontSize: '1.3rem', lineHeight: 1.45, margin: '0 0 1rem', fontWeight: 500, whiteSpace: 'pre-line' }}>
                {address}
              </p>
            )}
            {phone && (
              <p className="stackd-mono" style={{ fontSize: '0.95rem', margin: 0 }}>
                <a href={`tel:${phone.replace(/\s/g, '')}`} style={CONTACT_LINK}>{phone}</a>
              </p>
            )}
            {email && (
              <p className="stackd-mono" style={{ fontSize: '0.95rem', margin: '0.5rem 0 0' }}>
                <a href={`mailto:${email}`} style={CONTACT_LINK}>{email}</a>
              </p>
            )}
            {reservations && reserve.text && reserveTo && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={reserveTo} className="stackd-btn stackd-btn-ghost">{fill(reserve.text, concept)}</Link>
              </div>
            )}
          </div>
        </div>
      </section>
    </StackdFrame>
  )
}
