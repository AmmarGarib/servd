'use client'

// servd.visit — "Come by." (anchor #visit): one card per kitchen with the live
// open-now pill, area, and Order / WhatsApp / Email links. The brand data is
// live; the heading and link labels are fields.

import Link from 'next/link'
import { formatBrandName } from '../../lib/concept'
import { locationFromConcept, whatsappLink } from '../../lib/brandLocations'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import { OpenNowPill } from '../../components/brand/parts/OpenNowPill'
import type { SectionProps } from '../types'
import { list, str } from '../safe'
import { brandsInOrder } from './brands'
import { Chevron } from './icons'

export function Visit({ fields, ctx }: SectionProps) {
  const ref = useScrollReveal<HTMLElement>()
  const heading = str(fields.heading)
  const slugs = list<{ brand?: unknown }>(fields.brands).map((b) => str(b.brand).trim()).filter(Boolean)
  const brands = brandsInOrder(slugs, ctx.concepts)
  const orderText = str(fields.orderText)
  const whatsappText = str(fields.whatsappText)
  const emailText = str(fields.emailText)
  const greeting = str(fields.whatsappGreeting)
  const pillFallback = str(fields.pillFallback)

  return (
    <section ref={ref} id="visit" className="sv-section" style={{ scrollMarginTop: 52 }}>
      <div className="sv-wrap">
        {heading && (
          <div className="sv-section-head reveal-on-scroll">
            <h2 className="sv-section-title">{heading}</h2>
          </div>
        )}
        <div className="sv-visit reveal-on-scroll">
          {brands.map((c) => {
            const name = formatBrandName(c.name)
            const loc = locationFromConcept(c)
            const email = c.email || loc.email
            return (
              <div key={c.slug} className="sv-visit-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h3>{name}</h3>
                  <span style={{ marginLeft: 'auto' }}><OpenNowPill slug={c.slug} fallback={pillFallback} /></span>
                </div>
                {!loc.area.startsWith('TODO') && <p>{loc.area}, {loc.city}</p>}
                <div className="sv-visit-links">
                  {orderText && <Link href={`/${c.slug}`} className="sv-link">{orderText} <Chevron /></Link>}
                  {whatsappText && (
                    <a href={whatsappLink(loc, greeting.replace(/\{brand\}/g, name) || undefined)}
                      target="_blank" rel="noopener noreferrer" className="sv-link">
                      {whatsappText} <Chevron />
                    </a>
                  )}
                  {email && emailText && <a href={`mailto:${email}`} className="sv-link">{emailText} <Chevron /></a>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
