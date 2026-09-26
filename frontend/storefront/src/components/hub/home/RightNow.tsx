'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { ArrowRight, MapPin, MessageCircle } from 'lucide-react'
import { OpenNowPill } from '../../brand/parts/OpenNowPill'
import { locationFor, whatsappLink } from '../../../lib/brandLocations'
import { Reveal, RevealGroup, RevealItem } from '../motion'
import type { HomeBrand } from './types'
import s from './home.module.css'

// Right now — live status + area per brand. Hours wrong on Google is the #1
// Karachi mistake; surface them on the home so the customer never has to
// wonder which one's open. OpenNowPill always renders a text label, so status
// is never carried by colour alone.

export function RightNow({ brands }: { brands: HomeBrand[] }) {
  return (
    <section id="right-now" className="hub-section hub-section--raised" aria-labelledby="right-now-title">
      <div className="hub-container">
        <Reveal className={s.sectionHead}>
          <div>
            <p className="hub-eyebrow hub-eyebrow--accent" style={{ margin: 0 }}>Right now</p>
            <h2 id="right-now-title" className={`hub-display ${s.h2}`}>
              Who&rsquo;s cooking <em>right now.</em>
            </h2>
          </div>
          <p className="hub-lead" style={{ margin: 0 }}>
            Live hours from each kitchen, checked against your clock. Order ahead or message the kitchen directly.
          </p>
        </Reveal>

        <RevealGroup className={s.statusGrid}>
          {brands.map((b) => {
            const loc = locationFor(b.slug)
            return (
              <RevealItem key={b.id}>
                <div className={`hub-card ${s.statusCard}`} style={{ '--accent': b.accent } as CSSProperties}>
                  <div className={s.statusHead}>
                    <h3 className={s.statusName}>
                      <span aria-hidden className={s.dot} />
                      {b.name}
                    </h3>
                    <span className={s.statusPill}>
                      <OpenNowPill slug={b.slug} fallback="Today" />
                    </span>
                  </div>
                  {loc && !loc.area.startsWith('TODO') && (
                    <p className={s.statusArea}>
                      <MapPin aria-hidden />
                      {loc.area}
                    </p>
                  )}
                  <div className={s.statusActions}>
                    <Link href={`/${b.slug}`} className="hub-btn-ghost" aria-label={`Order from ${b.name}`}>
                      Order <ArrowRight aria-hidden />
                    </Link>
                    {loc && (
                      <a
                        href={whatsappLink(loc, `hi ${b.rawName.toLowerCase()}`)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hub-btn-ghost"
                        aria-label={`Message ${b.name} on WhatsApp (opens in a new tab)`}
                      >
                        <MessageCircle aria-hidden /> WhatsApp
                      </a>
                    )}
                  </div>
                </div>
              </RevealItem>
            )
          })}
        </RevealGroup>
      </div>
    </section>
  )
}
