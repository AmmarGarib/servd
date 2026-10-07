'use client'
// stackd.room — the long story on one large seal: same language as the
// stickers, calmer angle.

import type { SectionProps } from '../types'
import { str, color } from '../safe'
import { StackdFrame, stackdConcept, fill } from './shared'

export function StackdRoom({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  return (
    <StackdFrame>
      <section style={{ padding: 'clamp(3rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div
          className="stackd-sticker-lg"
          style={{
            maxWidth: '58rem', margin: '0 auto', padding: 'clamp(2.25rem, 5vw, 3.5rem)',
            ...(color(fields.bg) && { background: color(fields.bg) }),
          }}
        >
          {str(fields.spec) && <span className="stackd-spec">{fill(fields.spec, concept)}</span>}
          {str(fields.heading) && (
            <h2 className="stackd-display" style={{ fontSize: 'clamp(1.9rem, 4vw, 2.8rem)', margin: '0.75rem 0 1.5rem' }}>
              {fill(fields.heading, concept)}
            </h2>
          )}
          {str(fields.body) && (
            <p
              style={{
                fontFamily: 'var(--stackd-body)',
                fontSize: '1.05rem',
                lineHeight: 1.75,
                color: 'rgba(61,17,34,0.78)',
                margin: 0,
                maxWidth: '62ch',
                whiteSpace: 'pre-line',
              }}
            >
              {fill(fields.body, concept)}
            </p>
          )}
        </div>
      </section>
    </StackdFrame>
  )
}
