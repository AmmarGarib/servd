'use client'

// servd.insiders — the purple Insiders band (anchor #insiders): headline,
// join buttons, perks and the sign-in line.

import Link from 'next/link'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import { filled, locationFor, locationFromConcept, whatsappLink } from '../../lib/brandLocations'
import type { SectionProps } from '../types'
import { color, link, list, safeHref, str } from '../safe'
import { Chevron } from './icons'

export function Insiders({ fields, ctx }: SectionProps) {
  const ref = useScrollReveal<HTMLElement>()
  const headline = str(fields.headline)
  const sub = str(fields.sub)
  const primary = link(fields.primaryCta)
  const secondary = link(fields.secondaryCta)
  const signIn = link(fields.signIn)
  const perks = list<{ tag?: unknown; head?: unknown; body?: unknown }>(fields.perks)
  const bg = color(fields.bg)

  // Empty link → WhatsApp the chosen brand's number (live, else the fallback).
  // No number on file → no link: wa.me without one opens the share sheet and
  // the message goes to whichever contact the visitor picks.
  let secondaryHref = ''
  let secondaryExternal = false
  if (secondary.text) {
    if (secondary.href.trim()) {
      secondaryHref = safeHref(secondary.href)
    } else {
      const slug = str(fields.whatsappBrand, 'simmer').trim() || 'simmer'
      const concept = ctx.concepts.find((c) => c.slug === slug)
      const loc = concept ? locationFromConcept(concept) : locationFor(slug)
      if (loc && filled(loc.whatsapp)) { secondaryHref = whatsappLink(loc, str(fields.whatsappMessage) || undefined); secondaryExternal = true }
    }
  }

  return (
    <section ref={ref} id="insiders" className="sv-band" style={{ scrollMarginTop: 64, ...(bg && { background: bg }) }}>
      <div className="sv-wrap">
        <div className="sv-section-head reveal-on-scroll" style={{ marginBottom: 0 }}>
          {headline && <h2 className="sv-section-title">{headline}</h2>}
          {sub && <p className="sv-sub">{sub}</p>}
          {(primary.text || secondaryHref) && (
            <div className="sv-ctas">
              {primary.text && <Link href={safeHref(primary.href)} className="sv-btn sv-btn-primary">{primary.text}</Link>}
              {secondaryHref && (
                <a href={secondaryHref} className="sv-link"
                  {...(secondaryExternal && { target: '_blank', rel: 'noopener noreferrer' })}>
                  {secondary.text} <Chevron />
                </a>
              )}
            </div>
          )}
        </div>
        {perks.length > 0 && (
          <div className="sv-perks reveal-on-scroll">
            {perks.map((p, i) => (
              <div key={i} className="sv-perk">
                {str(p.tag) && <p className="sv-perk-tag">{str(p.tag)}</p>}
                {str(p.head) && <h3>{str(p.head)}</h3>}
                {str(p.body) && <p>{str(p.body)}</p>}
              </div>
            ))}
          </div>
        )}
        {signIn.text && (
          <p style={{ textAlign: 'center', marginTop: 28 }}>
            <Link href={safeHref(signIn.href)} className="sv-link">{signIn.text} <Chevron /></Link>
          </p>
        )}
      </div>
    </section>
  )
}
