'use client'
// Other kitchens — simmer's own cross-brand strip.
//
// The shared CrossBrandStrip paints white cards, a photo gradient and title-
// case marketing copy, none of which the simmer bible allows. This is the same
// strip, set like the last page of a printed programme: the sibling brands as
// a list of names, each underlined as you reach for it.
//
// Same rule as the shared strip for WHO appears: siblings from the same
// operating company only. With no tenantId (static fallback, older cached
// response) it shows nothing rather than guessing.

import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { formatBrandName } from '../../../lib/concept'
import { Reveal, Line } from './reveal'
import s from './simmer.module.css'

export function OtherKitchens({ current, concepts }: { current: Concept, concepts: Concept[] }) {
  const others = concepts
    .filter((c) => c.slug !== current.slug)
    .filter((c) => (current.tenantId ? c.tenantId === current.tenantId : false))
    .slice(0, 6)
  if (others.length === 0) return null

  return (
    <section data-ground="bone" className={s.bone} aria-labelledby="simmer-other-kitchens"
             style={{ padding: 'clamp(4rem, 10vh, 6.5rem) clamp(1.25rem, 5vw, 3rem)' }}>
      <Reveal style={{ maxWidth: '44rem', margin: '0 auto' }}>
        <div className={s.eyebrow}>
          <h2 id="simmer-other-kitchens" className={s.utility} style={{ margin: 0, fontWeight: 400 }}>other kitchens</h2>
          <span className={s.utility}>same operator</span>
        </div>
        <p className={s.amarante} style={{ fontSize: 'clamp(1.6rem, 4vw, 2.4rem)', lineHeight: 1.15, margin: '2rem 0 1.4rem' }}>
          <Line>more from the operator.</Line>
        </p>
        <ul className={s.kitchens}>
          {others.map((c, i) => (
            <li key={c.id} className={s.rise} style={{ ['--i' as string]: i + 1 } as React.CSSProperties}>
              <Link href={`/brand/${c.slug}`} className={s.kitchen}>
                <span>
                  <span className={s.kitchenName}>{formatBrandName(c.name)}</span>
                  {c.description && (
                    <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.95rem', lineHeight: 1.55, maxWidth: '30rem' }}>
                      {c.description}
                    </span>
                  )}
                </span>
                <span aria-hidden="true" className={s.arrow} style={{ fontSize: '1.4rem' }}>→</span>
              </Link>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  )
}
