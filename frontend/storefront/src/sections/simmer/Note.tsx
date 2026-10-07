// simmer.note — "what's next". A short forward-looking note from the kitchen
// (Caption voice). The date stamp in the header is the section's only orange
// accent; everything else stays bone/mute. Ported from SimmerLayout.

import { Fragment } from 'react'
import type { SectionProps } from '../types'
import { simmerLines, simmerText, stampOr, surface } from './shared'

export function Note({ fields: f }: SectionProps) {
  const s = surface(f['surface'], 'green')
  const body = simmerLines(f['body'])
  const signature = simmerText(f['signature'])
  return (
    <div className="simmer-page">
      <section style={{ background: s.background, color: s.color, padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          <div style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            paddingBottom: '0.9rem',
            marginBottom: '2rem',
            borderBottom: `1px solid ${s.line}`,
          }}>
            <span className="utility" style={{ fontSize: '0.78rem' }}>{simmerText(f['eyebrow'])}</span>
            <span className="utility signal" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{stampOr(f['stamp'])}</span>
          </div>
          {body.some((l) => l.trim()) && (
            <p style={{
              fontFamily: 'var(--simmer-body)',
              fontSize: 'clamp(1.05rem, 1.5vw, 1.2rem)',
              lineHeight: 1.75,
              letterSpacing: '0.02em',
              margin: 0,
              color: s.color,
            }}>
              {body.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{l}</Fragment>)}
            </p>
          )}
          {signature && (
            <p className="amarante" style={{
              fontSize: '1.05rem',
              fontStyle: 'italic',
              marginTop: '2rem',
              opacity: 0.7,
              letterSpacing: '0.02em',
            }}>
              {signature}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
