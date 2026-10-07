'use client'
// Flipd microsite sections (brand:flipd), ported from
// components/brand/layouts/FlipdLayout.tsx — rebuilt from the GS Foods brand
// book (Sept 2026). Mustard field, Flipd Blue marks, navy/bone checker as the
// rule, bone panels for long reads. Restraint over decoration: no gradients,
// no glows, no drop-shadowed type. Brand book: "Not about padel: we happen to
// be there, we never borrow the court's identity."
//
// Each section paints its own `.flipd-page` wrapper (the brand's mustard field
// and type scope), so they stack seamlessly in any order.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { locationFromConcept } from '../../lib/brandLocations'
import { CrossBrandStrip } from '../../components/brand/parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../../components/brand/parts/OpenStatusBadge'
import type { SectionProps } from '../types'
import { safeHref, safeSrc, str, link, list, color } from '../safe'

const BRAND_BOOK_SIZE = 22

/** The navy/bone checker band. The brand's edge, used as a rule. */
export function FlipdChecker({ fields }: SectionProps) {
  const n = typeof fields.size === 'number' ? fields.size : Number(fields.size)
  const size = Number.isFinite(n) && n > 0 ? Math.min(48, Math.max(10, Math.round(n))) : BRAND_BOOK_SIZE
  const style: CSSProperties | undefined = size === BRAND_BOOK_SIZE
    ? undefined
    : { height: `${size}px`, backgroundSize: `${size}px ${size}px` }
  return (
    <div className="flipd-page">
      <div aria-hidden className="flipd-checker" {...(style && { style })} />
    </div>
  )
}

/** A bone panel so the long read is comfortable on the mustard field. */
export function FlipdMission({ fields }: SectionProps) {
  const panelBg = color(fields.panelBg)
  return (
    <div className="flipd-page">
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div
          className="flipd-panel"
          style={{ maxWidth: '54rem', margin: '0 auto', padding: 'clamp(2rem, 5vw, 3.25rem)', ...(panelBg && { background: panelBg }) }}
        >
          {str(fields.eyebrow) && <span className="flipd-eyebrow">{str(fields.eyebrow)}</span>}
          <h2 className="flipd-display" style={{ fontSize: 'clamp(1.7rem, 3.6vw, 2.5rem)', margin: '0.7rem 0 1.4rem' }}>
            {str(fields.headline)}
          </h2>
          <p style={{ fontSize: '1.02rem', lineHeight: 1.75, color: 'var(--flipd-blue-dim)', margin: 0, maxWidth: '62ch', whiteSpace: 'pre-line' }}>
            {str(fields.body)}
          </p>
        </div>
      </section>
    </div>
  )
}

/** Core values on the inverted band: Flipd Blue field, mustard type. */
export function FlipdValues({ fields }: SectionProps) {
  const bg = color(fields.bg) ?? 'var(--flipd-blue)'
  const fg = color(fields.fg)
  const items = list<{ title?: unknown; body?: unknown }>(fields.items)
  const text = fg ?? 'var(--flipd-mustard)'
  return (
    <div className="flipd-page">
      <section
        style={{
          background: bg,
          color: text,
          padding: 'clamp(3.5rem, 9vh, 5.5rem) clamp(1.5rem, 5vw, 3rem)',
        }}
      >
        <div style={{ maxWidth: '68rem', margin: '0 auto' }}>
          <h2
            className="flipd-display"
            style={{ fontSize: 'clamp(1.9rem, 4vw, 2.8rem)', margin: '0 0 2rem', color: text }}
          >
            {str(fields.headline)}
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))', gap: 'clamp(1.5rem, 3vw, 2.5rem)' }}>
            {items.map((v, i) => (
              <div key={i}>
                <span
                  className="flipd-display"
                  style={{
                    fontSize: '1.6rem', display: 'block', lineHeight: 1,
                    ...(fg ? { color: fg, opacity: 0.38 } : { color: 'rgba(254,213,97,0.38)' }),
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0.6rem 0 0.5rem', color: text }}>
                  {str(v.title)}
                </h3>
                <p
                  style={{
                    fontSize: '0.88rem', lineHeight: 1.65, margin: 0,
                    ...(fg ? { color: fg, opacity: 0.74 } : { color: 'rgba(254,213,97,0.74)' }),
                  }}
                >
                  {str(v.body)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

const contactLink: CSSProperties = { color: 'var(--flipd-blue)', textDecoration: 'none', borderBottom: '1px solid currentColor' }

/** Hours (live open/closed + the week) and where to find us (live contact). */
export function FlipdVisit({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const hoursData = useHoursData(concept?.slug ?? 'flipd')
  const reservations = concept ? concept.reservationsEnabled !== false : false

  const address = str(fields.address).trim() || concept?.address || str(fields.addressMissing)
  const phone = str(fields.phone).trim() || concept?.phone || ''
  // The brand's guest email (admin → Brands → Contact); the bundled default
  // only fills in when the API is down.
  const email = str(fields.email).trim() || (concept ? locationFromConcept(concept).email : '')
  const book = link(fields.book)

  return (
    <div className="flipd-page">
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div
          className="flipd-visit-grid"
          style={{ maxWidth: '68rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }}
        >
          <div>
            {str(fields.hoursEyebrow) && <span className="flipd-eyebrow">{str(fields.hoursEyebrow)}</span>}
            <h2 className="flipd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.5rem' }}>
              {str(fields.hoursHeadline)}
            </h2>
            <div style={{ marginBottom: '1.4rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
            <div style={{ fontSize: '0.92rem', color: 'var(--flipd-blue-dim)' }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hoursData={hoursData} />
              ) : (
                <p style={{ opacity: 0.7 }}>{str(fields.hoursEmpty)}</p>
              )}
            </div>
          </div>

          <div>
            {str(fields.whereEyebrow) && <span className="flipd-eyebrow">{str(fields.whereEyebrow)}</span>}
            <h2 className="flipd-display" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', margin: '0.7rem 0 1.5rem' }}>
              {str(fields.whereHeadline)}
            </h2>
            <p style={{ fontSize: '1.05rem', lineHeight: 1.5, margin: '0 0 1rem', fontWeight: 500 }}>
              {address}
            </p>
            {phone && (
              <p style={{ fontSize: '0.92rem', margin: 0 }}>
                <a href={safeHref(`tel:${phone.replace(/\s/g, '')}`)} style={contactLink}>{phone}</a>
              </p>
            )}
            {email && (
              <p style={{ fontSize: '0.92rem', margin: '0.5rem 0 0' }}>
                <a href={safeHref(`mailto:${email}`)} style={contactLink}>{email}</a>
              </p>
            )}
            {reservations && book.text && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={safeHref(book.href)} className="flipd-btn flipd-btn-ghost">{book.text}</Link>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

/** Sibling kitchens from the same company (the shared strip, live data). */
export function FlipdCrossBrand({ fields, ctx }: SectionProps) {
  if (!ctx.concept) return null
  const kicker = str(fields.kicker)
  const heading = str(fields.heading)
  return (
    <div className="flipd-page">
      <CrossBrandStrip
        current={ctx.concept}
        concepts={ctx.concepts}
        accent={color(fields.accent) ?? 'var(--flipd-blue)'}
        {...(kicker && { kicker })}
        {...(heading && { heading })}
        subtitle={str(fields.subtitle)}
        allLabel={link(fields.allLink).text}
        allHref={safeHref(link(fields.allLink).href, '/home#kitchens')}
        {...(str(fields.cardCta).trim() && { cardCta: str(fields.cardCta) })}
      />
    </div>
  )
}

/** The badge again to close, on the blue band. No order button: BrandShell
    renders its own CTA directly below. */
export function FlipdSignOff({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  // Field first, then operator-uploaded artwork, then the copy in this build.
  // `||` not `??` — a cleared admin field sends '', which must fall back too.
  const own = safeSrc(fields.badge) || concept?.wordmarkUrl || ''
  const badge = own || '/brand/flipd-badge.png'
  const badgeIsFallback = !own
  const caption = str(fields.caption).trim() || concept?.address || str(fields.captionMissing)
  return (
    <div className="flipd-page">
      <section
        style={{
          background: color(fields.bg) ?? 'var(--flipd-blue)',
          padding: 'clamp(3.5rem, 10vh, 6rem) clamp(1.5rem, 5vw, 3rem)',
          textAlign: 'center',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={badge}
          alt=""
          aria-hidden="true"
          {...(badgeIsFallback ? { width: 1200, height: 1200 } : {})}
          style={{ display: 'block', width: 'min(11rem, 40vw)', height: 'auto', margin: '0 auto 1.25rem' }}
        />
        {caption && (
          <p className="flipd-eyebrow" style={{ color: 'rgba(254,213,97,0.6)' }}>
            {caption}
          </p>
        )}
      </section>
    </div>
  )
}
