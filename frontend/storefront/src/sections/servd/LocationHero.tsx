// servd.locationHero — the /locations/[loc] header. The copy is fields with
// placeholders filled from the live location (ctx.params.loc).

import type { SectionProps } from '../types'
import { str } from '../safe'
import { fillLocation, findLocation } from './location'

export async function LocationHero({ fields, ctx }: SectionProps) {
  const brand = await findLocation(ctx.params?.loc)
  if (!brand) return null
  const eyebrow = fillLocation(str(fields.eyebrow), brand)
  const title = fillLocation(str(fields.title), brand)
  const body = fillLocation(str(fields.body), brand)
  return (
    <section className="section" style={{ paddingTop: 'clamp(4rem, 8vw, 6rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)' }}>
      <div className="container">
        {eyebrow && <p className="eyebrow eyebrow-accent">{eyebrow}</p>}
        {title && (
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem', letterSpacing: '-0.04em' }}>
            {title}
          </h1>
        )}
        {body && (
          <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
            {body}
          </p>
        )}
      </div>
    </section>
  )
}
