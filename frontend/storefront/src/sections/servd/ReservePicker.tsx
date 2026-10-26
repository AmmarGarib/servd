// servd.reservePicker — the /reserve index: one card per brand that takes
// reservations (live: reservationsEnabled !== false, dine-in), each linking to
// its /reserve/<slug> booking page. Labels are fields; the brands are live.
// The cards are servd home's trading cards (sections/servd/Kitchens.tsx
// KitchenCards, owner 2026-10-26: "same style brand cards as on servd home"),
// each brand in its own palette (Simmer's card keeps its own rules).
// pillFallback is kept in the spec for stored pages; the trading card shows
// the hours on its back instead of an open-now pill.

import Link from 'next/link'
import type { SectionProps } from '../types'
import { link, list, safeHref, str } from '../safe'
import { KitchenCards } from './Kitchens'
import { liveSectionFields } from '../liveFields'
import { inBrandOrder } from '../../lib/liveConcepts'
import { reservableConcepts } from './reservable'

export async function ReservePicker({ fields }: SectionProps) {
  // Its own read (not ctx.concepts): with the API down the page says nobody
  // is taking bookings rather than offering the bundled fallback brands.
  const concepts = await reservableConcepts()
  const emptyCta = link(fields.emptyCta)
  const cardCta = str(fields.cardCta)
  const tiles = list<Record<string, unknown>>((await liveSectionFields('servd:home', 'servd.kitchens'))['tiles'])

  return (
    <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
      <div className="container">
        {concepts.length === 0 ? (
          <div className="servd-card sv-hard-card" style={{ padding: '2.5rem 1.5rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--servd-mute)' }}>{str(fields.emptyText)}</p>
            {emptyCta.text && (
              <Link href={safeHref(emptyCta.href)} className="brand-pill sv-hard-btn" style={{ marginTop: '1.25rem', background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
                {emptyCta.text}
              </Link>
            )}
          </div>
        ) : (
          // The SAME trading cards as servd home's kitchens (owner, 2026-10-26),
          // with the home section's tiles; each card leads to /reserve/<slug>.
          <div style={{ paddingTop: '1rem' }}>
            <KitchenCards concepts={inBrandOrder(concepts)} tiles={tiles} hrefPrefix="/reserve/" ctaText={cardCta || 'Book at {brand}'} />
          </div>
        )}
      </div>
    </section>
  )
}
