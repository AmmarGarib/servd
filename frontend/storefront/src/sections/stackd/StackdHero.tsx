'use client'
// stackd.hero — the wordmark, set the way the brand sets it: lowercase, cream,
// with the full stop, and the italic lockup line underneath. Nothing else
// competes with it above the fold.

import Link from 'next/link'
import type { SectionProps } from '../types'
import { str, link, color } from '../safe'
import { StackdFrame, stackdConcept, fill, wordmark, stackdHref, SR_ONLY } from './shared'

export function StackdHero({ fields, ctx }: SectionProps) {
  const concept = stackdConcept(ctx)
  const mark = wordmark(fields.wordmark, concept, ctx)
  const primary = link(fields.primaryCta)
  const secondary = link(fields.secondaryCta)
  const primaryTo = stackdHref(primary.href, ctx, concept)
  const secondaryTo = stackdHref(secondary.href, ctx, concept)
  const specLeft = str(fields.specLeft)
  const specRight = str(fields.specRight)

  return (
    <StackdFrame>
      <section style={{ padding: 'clamp(4.5rem, 14vh, 9rem) clamp(1.5rem, 5vw, 3rem) clamp(3rem, 7vh, 4.5rem)' }}>
        <div style={{ maxWidth: '76rem', margin: '0 auto' }}>
          {(specLeft || specRight) && (
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '2rem', flexWrap: 'wrap', marginBottom: '3rem' }}>
              <span className="stackd-spec">{fill(specLeft, concept)}</span>
              <span className="stackd-spec">{fill(specRight, concept)}</span>
            </div>
          )}

          {/* The supplied wordmark asset, not a webfont approximation. The <h1>
              stays real text for search and screen readers (what and where:
              the page's one h1); the image is decorative on top of it. It
              sits below the slip, well past the first screen, so it loads
              lazily rather than being preloaded against the slip artwork. */}
          <h1 style={{ margin: '0 0 2.75rem', position: 'relative', display: 'block', maxWidth: 'min(34rem, 78vw)' }}>
            <span style={SR_ONLY}>{fill(fields.headingText, concept)}</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mark.src}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              {...mark.dims}
              style={{ display: 'block', width: '100%', height: 'auto' }}
            />
          </h1>

          <hr className="stackd-line" style={color(fields.lineColor) ? { background: color(fields.lineColor) } : undefined} />

          {str(fields.tagline) && (
            <p
              className="stackd-display"
              style={{ fontSize: 'clamp(1.5rem, 2.8vw, 2.3rem)', maxWidth: '30ch', margin: '2rem 0 0', fontWeight: 500, lineHeight: 1.15 }}
            >
              {fill(fields.tagline, concept)}
            </p>
          )}

          {str(fields.body) && (
            <p
              style={{
                fontFamily: 'var(--stackd-body)',
                fontSize: '1rem',
                lineHeight: 1.65,
                maxWidth: '52ch',
                margin: '1.25rem 0 0',
                color: 'var(--stackd-cream-dim)',
                whiteSpace: 'pre-line',
              }}
            >
              {fill(fields.body, concept)}
            </p>
          )}

          {((primary.text && primaryTo) || (secondary.text && secondaryTo)) && (
            <div style={{ marginTop: '3rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {primary.text && primaryTo && <Link href={primaryTo} className="stackd-btn">{fill(primary.text, concept)}</Link>}
              {secondary.text && secondaryTo && <Link href={secondaryTo} className="stackd-btn stackd-btn-ghost">{fill(secondary.text, concept)}</Link>}
            </div>
          )}
        </div>
      </section>
    </StackdFrame>
  )
}
