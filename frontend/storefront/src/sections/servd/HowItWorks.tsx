'use client'

// servd.howItWorks — a heading over icon + title + line columns.

import type { ReactNode } from 'react'
import { useScrollReveal } from '../../components/kinetic/motionHooks'
import type { SectionProps } from '../types'
import { list, str } from '../safe'
import { IconClock, IconStack, IconStar } from './icons'

const ICONS: Record<string, () => ReactNode> = { stack: IconStack, clock: IconClock, star: IconStar }

export function HowItWorks({ fields }: SectionProps) {
  const ref = useScrollReveal<HTMLElement>()
  const heading = str(fields.heading)
  const items = list<{ icon?: unknown; title?: unknown; body?: unknown }>(fields.items)
  return (
    <section ref={ref} className="sv-section">
      <div className="sv-wrap">
        {heading && (
          <div className="sv-section-head reveal-on-scroll">
            <h2 className="sv-section-title">{heading}</h2>
          </div>
        )}
        <div className="sv-trio reveal-on-scroll">
          {items.map((it, i) => {
            const Icon = ICONS[str(it.icon)]
            const title = str(it.title)
            const body = str(it.body)
            return (
              <div key={i}>
                {Icon && <div className="sv-trio-icon" aria-hidden><Icon /></div>}
                {title && <h3>{title}</h3>}
                {body && <p>{body}</p>}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
