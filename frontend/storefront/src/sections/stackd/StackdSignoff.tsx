// stackd.signoff — the lockup again, on the deepest plum, to bookend the page.
// No order button here on purpose: BrandShell renders its own "ready when you
// are" CTA immediately below, and two order buttons a screen apart split the
// click. This closes the brand; the shell closes the sale.

import type { SectionProps } from '../types'
import { str, color } from '../safe'
import { StackdFrame, stackdConcept, fill, wordmark, SR_ONLY } from './shared'

export function StackdSignoff({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  const mark = wordmark(fields.wordmark, concept)
  const line = str(fields.address).trim() || concept.address || str(fields.addressMissing)
  return (
    <StackdFrame>
      <section
        style={{
          background: color(fields.bg) ?? 'var(--stackd-plum-dark)',
          color: color(fields.fg) ?? 'var(--stackd-cream)',
          padding: 'clamp(4.5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)',
        }}
      >
        <div style={{ maxWidth: '64rem', margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 2.5rem' }}>
            <span style={SR_ONLY}>{fill(fields.headingText, concept)}</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mark.src}
              alt=""
              aria-hidden="true"
              {...mark.dims}
              style={{ display: 'block', width: 'min(22rem, 70vw)', height: 'auto', margin: '0 auto' }}
            />
          </h2>
          {line && (
            <p className="stackd-spec" style={{ margin: 0, color: color(fields.lineColor) ?? 'var(--stackd-cream-faint)' }}>
              {line}
            </p>
          )}
        </div>
      </section>
    </StackdFrame>
  )
}
