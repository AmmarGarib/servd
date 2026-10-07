'use client'

// servd.waitlistStrip — "There's another kitchen coming." + a waitlist link.

import Link from 'next/link'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import type { SectionProps } from '../types'
import { link, safeHref, str } from '../safe'
import { Chevron } from './icons'

export function WaitlistStrip({ fields }: SectionProps) {
  const ref = useScrollReveal<HTMLElement>()
  const heading = str(fields.heading)
  const body = str(fields.body)
  const cta = link(fields.cta)
  return (
    <section ref={ref} className="sv-next">
      <div className="sv-wrap reveal-on-scroll">
        {heading && <h2 className="sv-section-title">{heading}</h2>}
        {body && <p>{body}</p>}
        {cta.text && (
          <div className="sv-ctas" style={{ marginTop: 20 }}>
            <Link href={safeHref(cta.href)} className="sv-link">{cta.text} <Chevron /></Link>
          </div>
        )}
      </div>
    </section>
  )
}
