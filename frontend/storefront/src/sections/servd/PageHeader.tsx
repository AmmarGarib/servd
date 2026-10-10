// servd.pageHeader — eyebrow, a big title (optional italic second line) and an
// intro. Used by /press and /reserve, and offered on custom pages.
//
// `{bookable}` in any of its words is the live list of kitchens that take
// reservations ("Simmer", "Simmer or Stackd"), the same list the reservation
// picker shows and the /reserve title names — so /reserve never says "pick
// the kitchen" over a single kitchen. The list is only fetched when used.

import type { SectionProps } from '../types'
import { str } from '../safe'
import { BOOKABLE_FALLBACK, bookableNames, reservableConcepts } from './reservable'

const BOOKABLE = /\{bookable\}/g

export async function PageHeader({ fields }: SectionProps) {
  let eyebrow = str(fields.eyebrow)
  let title = str(fields.title)
  let accent = str(fields.titleAccent)
  let body = str(fields.body)
  if ([eyebrow, title, accent, body].some((s) => s.includes('{bookable}'))) {
    const names = bookableNames(await reservableConcepts()) || BOOKABLE_FALLBACK
    ;[eyebrow, title, accent, body] = [eyebrow, title, accent, body].map((s) => s.replace(BOOKABLE, names)) as [string, string, string, string]
  }
  return (
    <section className="section" style={{ paddingTop: 'clamp(4rem, 9vw, 6rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)' }}>
      <div className="container">
        {eyebrow && <p className="eyebrow eyebrow-accent">{eyebrow}</p>}
        {(title || accent) && (
          <h1 className="display" style={{
            fontSize: 'clamp(2.5rem, 7vw, 5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem',
            ...(fields.tight === true && { letterSpacing: '-0.04em' }),
          }}>
            {title}
            {accent && <>{title && <br />}<span className="display-italic">{accent}</span></>}
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
