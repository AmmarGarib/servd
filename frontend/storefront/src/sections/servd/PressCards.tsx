// servd.pressCards — the /press cards: what's on offer, what we don't do, and
// how to get in touch. A button linked to #whatsapp messages the press
// contact's live WhatsApp number — and is hidden while there is none (wa.me
// without a number opens the share sheet, not a chat with us).

import Link from 'next/link'
import type { SectionProps } from '../types'
import { lines, link, list, safeHref, str } from '../safe'
import { fetchBrandLocations, filled, locationFor, whatsappLink } from '../../lib/brandLocations'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Card { title?: unknown; bullets?: unknown; body?: unknown; button?: unknown }

export async function PressCards({ fields }: SectionProps) {
  const cards = list<Card>(fields.cards)
  const needsWhatsapp = cards.some((c) => link(c.button).href.trim() === '#whatsapp')

  // Live-edited values win; the bundled fallback if the API is unreachable.
  let whatsappHref = ''
  if (needsWhatsapp) {
    const slug = str(fields.whatsappBrand).trim() || 'simmer'
    const brands = await fetchBrandLocations(API_URL)
    const contact = brands[slug] ?? locationFor(slug)
    if (contact && filled(contact.whatsapp)) whatsappHref = whatsappLink(contact, str(fields.whatsappMessage) || undefined)
  }

  return (
    <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
      <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        {cards.map((c, i) => {
          const title = str(c.title)
          const bullets = str(c.bullets).split('\n').map((l) => l.trim()).filter(Boolean)
          const body = str(c.body)
          const button = link(c.button)
          const isWhatsapp = button.href.trim() === '#whatsapp'
          return (
            <div key={i} className="servd-card" style={{ padding: '1.5rem' }}>
              {title && <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>{title}</p>}
              {bullets.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.65 }}>
                  {bullets.map((b, j) => <li key={j}>{b}</li>)}
                </ul>
              )}
              {body && (
                <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.55, marginBottom: '1rem' }}>
                  {lines(body).map((l, j) => <span key={j}>{j > 0 && <br />}{l}</span>)}
                </p>
              )}
              {button.text && (isWhatsapp
                ? whatsappHref && (
                  <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="brand-pill"
                    style={{ background: '#25D366', color: 'white' }}>
                    {button.text}
                  </a>
                )
                : (
                  <Link href={safeHref(button.href)} className="brand-pill"
                    style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
                    {button.text}
                  </Link>
                ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
