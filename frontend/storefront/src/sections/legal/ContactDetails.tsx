// legal.contactDetails — how to reach servd and each kitchen: the company's
// email (and phone / WhatsApp when the owner types them), then one card per
// live kitchen with its phone, WhatsApp, email and address, read from the
// brand records (Admin → Marketing → Brands; the address is the kitchen's).
// A value the brand has not filled in is left out — never a placeholder, never
// a made-up number (lib/brandLocations.ts `filled`).

import type { CSSProperties } from 'react'
import { brandCanonical } from '../../lib/brandDomains'
import { addressLine, filled, locationFromConcept, mapLinkOf } from '../../lib/brandLocations'
import { formatBrandName } from '../../lib/concept'
import { inBrandOrder } from '../../lib/liveConcepts'
import type { SectionProps } from '../types'
import { safeHref, str } from '../safe'

const row: CSSProperties = { margin: '0.35rem 0 0', fontSize: '0.95rem', lineHeight: 1.5 }
const anchor: CSSProperties = { color: 'inherit', fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: '3px' }
const label: CSSProperties = { color: 'var(--servd-mute)', fontWeight: 600, marginRight: '0.4rem' }

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`
const waDigits = (v: string) => v.replace(/\D/g, '')

export function ContactDetails({ fields, ctx }: SectionProps) {
  const heading = str(fields.heading).trim()
  const intro = str(fields.intro).trim()
  const company = str(fields.companyName).trim()
  const companyPhone = filled(str(fields.phone))
  const companyWa = waDigits(filled(str(fields.whatsapp)))
  const companyEmail = filled(str(fields.email))
  const companyAddress = str(fields.address).trim()
  const kitchensHeading = str(fields.kitchensHeading).trim()
  const showKitchens = fields.showKitchens !== false

  const kitchens = showKitchens
    ? inBrandOrder(ctx.concepts.filter((c) => !c.isTestCompany)).map((c) => {
        const loc = locationFromConcept(c)
        return {
          slug: c.slug,
          name: formatBrandName(c.name),
          phone: filled(loc.phone),
          whatsapp: waDigits(filled(loc.whatsapp)),
          email: filled(loc.email),
          street: filled(loc.street),
          area: addressLine(loc),
          map: mapLinkOf(loc),
        }
      })
    : []

  return (
    <section style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>
      <div className="container" style={{ paddingTop: 'clamp(3.5rem, 8vw, 6rem)', paddingBottom: 'clamp(1.5rem, 3vw, 2.5rem)' }}>
        {str(fields.eyebrow) && <p className="eyebrow eyebrow-accent">{str(fields.eyebrow)}</p>}
        {heading && (
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 4.5rem)', margin: '0.5rem 0 1rem', letterSpacing: '-0.04em' }}>
            {heading}
          </h1>
        )}
        {intro && <p style={{ fontSize: '1.1rem', lineHeight: 1.6, maxWidth: '40rem', margin: '0 0 2rem' }}>{intro}</p>}

        <div className="servd-card" style={{ maxWidth: '40rem', marginBottom: '2rem' }}>
          {company && <p style={{ margin: 0, fontWeight: 800, fontSize: '1.1rem' }}>{company}</p>}
          {companyAddress && <p style={row}>{companyAddress}</p>}
          {companyEmail && (
            <p style={row}><span style={label}>{str(fields.emailLabel) || 'Email'}</span>
              <a href={safeHref(`mailto:${companyEmail}`)} style={anchor}>{companyEmail}</a></p>
          )}
          {companyPhone && (
            <p style={row}><span style={label}>{str(fields.phoneLabel) || 'Phone'}</span>
              <a href={safeHref(telHref(companyPhone))} style={anchor}>{companyPhone}</a></p>
          )}
          {companyWa && (
            <p style={row}><span style={label}>{str(fields.whatsappLabel) || 'WhatsApp'}</span>
              <a href={`https://wa.me/${companyWa}`} target="_blank" rel="noopener noreferrer" style={anchor}>+{companyWa}</a></p>
          )}
        </div>

        {kitchens.length > 0 && (
          <>
            {kitchensHeading && (
              <h2 className="display" style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', margin: '0 0 1rem' }}>{kitchensHeading}</h2>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem' }}>
              {kitchens.map((k) => (
                <div key={k.slug} className="servd-card">
                  <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.1rem' }}>
                    <a href={brandCanonical(k.slug)} style={{ color: 'inherit', textDecoration: 'none' }}>{k.name}</a>
                  </h3>
                  {(k.street || k.area) && (
                    <p style={row}>
                      <span style={label}>{str(fields.addressLabel) || 'Address'}</span>
                      {[k.street, k.area].filter(Boolean).join(', ')}
                      {k.map && (<> · <a href={safeHref(k.map)} target="_blank" rel="noopener noreferrer" style={anchor}>{str(fields.mapLabel) || 'Map'}</a></>)}
                    </p>
                  )}
                  {k.phone && (
                    <p style={row}><span style={label}>{str(fields.phoneLabel) || 'Phone'}</span>
                      <a href={safeHref(telHref(k.phone))} style={anchor}>{k.phone}</a></p>
                  )}
                  {k.whatsapp && (
                    <p style={row}><span style={label}>{str(fields.whatsappLabel) || 'WhatsApp'}</span>
                      <a href={`https://wa.me/${k.whatsapp}`} target="_blank" rel="noopener noreferrer" style={anchor}>+{k.whatsapp}</a></p>
                  )}
                  {k.email && (
                    <p style={row}><span style={label}>{str(fields.emailLabel) || 'Email'}</span>
                      <a href={safeHref(`mailto:${k.email}`)} style={anchor}>{k.email}</a></p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
