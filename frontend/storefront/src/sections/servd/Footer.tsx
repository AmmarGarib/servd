// servd.footer — the servd global footer (SiteLayout `servd:footer`): the
// "Hungry now? Let's go." band, link columns and the copyright line. Where it
// shows (not on brand microsites) is decided by StorefrontFooter.

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { formatBrandName } from '../../lib/concept'
import type { SectionProps } from '../types'
import { color, link, list, safeHref, str } from '../safe'

interface LinkItem { text?: unknown; href?: unknown }

export function Footer({ fields }: SectionProps) {
  const eyebrow = str(fields.eyebrow)
  const headline = str(fields.headline)
  const accentText = str(fields.headlineAccent)
  const cta = link(fields.cta)
  const kitchens = list<{ name?: unknown; href?: unknown; dot?: unknown }>(fields.kitchens)
  const customer = list<LinkItem>(fields.customerLinks)
  const company = list<LinkItem>(fields.companyLines)
  const copyright = str(fields.copyright).replace(/\{year\}/g, String(new Date().getFullYear()))
  const tagline = str(fields.tagline)
  const blurb = str(fields.blurb)

  return (
    <footer
      className="surface-ink relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 2rem',
        marginTop: '4rem',
        // servd-purple footer. Accent is the servd green so the eyebrow /
        // "Let's go" / dot / pill read against the purple; text on the green
        // pill is purple (never white).
        background: 'linear-gradient(165deg, var(--servd-purple) 0%, var(--servd-black) 100%)',
        ['--brand-accent' as string]: color(fields.accent) ?? 'var(--servd-green)',
        ['--brand-ink' as string]:    'var(--servd-on-green)',
      } as CSSProperties}
    >
      <div className="container relative z-10">

        {/* Headline lockup */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          {eyebrow && (
            <p className="eyebrow" style={{ color: 'var(--brand-accent)', marginBottom: '1rem' }}>
              {eyebrow}
            </p>
          )}
          {(headline || accentText) && (
            <h2 className="display" style={{
              fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
              color: 'white',
              marginBottom: '1.5rem',
            }}>
              {headline}
              {accentText && <span className="display-italic" style={{ color: 'var(--brand-accent)' }}> {accentText}</span>}
            </h2>
          )}
          {cta.text && (
            <Link href={safeHref(cta.href)} className="brand-pill">
              {cta.text} <span style={{ opacity: 0.6 }}>→</span>
            </Link>
          )}
        </div>

        {/* Link columns */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2.5rem',
          paddingTop: '2.5rem',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div>
            <Link
              href={safeHref(fields.wordmarkHref, '/')}
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '2rem',
                fontWeight: 800,
                letterSpacing: '-0.045em',
                color: 'white',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: '0.1rem',
                marginBottom: '0.75rem',
              }}
            >
              {str(fields.wordmark)}<span style={{ color: 'var(--brand-accent)' }}>.</span>
            </Link>
            {blurb && (
              <p style={{ fontSize: '0.92rem', maxWidth: '20rem', color: 'rgba(255,255,255,0.55)', lineHeight: 1.55 }}>
                {blurb}
              </p>
            )}
          </div>

          {kitchens.length > 0 && (
            <div>
              <FooterHeading text={str(fields.kitchensHeading)} />
              <ul style={listStyle}>
                {kitchens.map((b, i) => (
                  <li key={i}>
                    <Link
                      href={safeHref(b.href)}
                      className="kinetic-caret"
                      style={{
                        color: 'rgba(255,255,255,0.85)',
                        textDecoration: 'none',
                        fontSize: '1rem',
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.55rem',
                      }}
                    >
                      <span style={{
                        width: '0.55rem', height: '0.55rem',
                        background: color(b.dot) ?? 'var(--brand-accent)', borderRadius: '999px',
                        display: 'inline-block',
                      }} />
                      {formatBrandName(str(b.name))}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {customer.length > 0 && (
            <div>
              <FooterHeading text={str(fields.customerHeading)} />
              <ul style={listStyle}>
                {customer.map((l, i) => (
                  <li key={i}><Link href={safeHref(l.href)} style={footerLinkStyle}>{str(l.text)}</Link></li>
                ))}
              </ul>
            </div>
          )}

          {company.length > 0 && (
            <div>
              <FooterHeading text={str(fields.companyHeading)} />
              <ul style={listStyle}>
                {company.map((l, i) => {
                  const href = str(l.href).trim()
                  return (
                    <li key={i}>
                      {href
                        ? <a href={safeHref(href)} style={footerLinkStyle}>{str(l.text)}</a>
                        : <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.95rem' }}>{str(l.text)}</span>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>

        {(copyright || tagline) && (
          <div style={{
            marginTop: '3rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.75rem',
            fontSize: '0.78rem',
            color: 'rgba(255,255,255,0.4)',
          }}>
            <span>{copyright}</span>
            <span>{tagline}</span>
          </div>
        )}
      </div>
    </footer>
  )
}

function FooterHeading({ text }: { text: string }) {
  if (!text) return null
  return (
    <h3 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
      {text}
    </h3>
  )
}

const listStyle: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }

const footerLinkStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.8)',
  textDecoration: 'none',
  fontSize: '0.95rem',
  fontWeight: 500,
}
