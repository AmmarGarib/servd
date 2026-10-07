// servd.pageHeader — eyebrow, a big title (optional italic second line) and an
// intro. Used by /press and /reserve, and offered on custom pages.

import type { SectionProps } from '../types'
import { str } from '../safe'

export function PageHeader({ fields }: SectionProps) {
  const eyebrow = str(fields.eyebrow)
  const title = str(fields.title)
  const accent = str(fields.titleAccent)
  const body = str(fields.body)
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
