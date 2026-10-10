// servd.footer — the servd global footer (SiteLayout `servd:footer`): the
// "Hungry now? Let's go." band, link columns and the copyright line. Where it
// shows (not on brand microsites) is decided by StorefrontFooter.
//
// Outline: the slogan is a paragraph (same look), not a heading — it closed
// every page with an h2 "Hungry now? Let's go." — and the column labels are
// h2 so a page whose last heading is its h1 does not jump to h3.
//
// Links: '/' (a 307 to /home) goes straight to /home, and a kitchen's
// /brand/<slug>[/page] goes to the brand's own domain (stackd.pk[/page]),
// the canonical home of the microsite — stored and published layouts too.

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { formatBrandName } from '../../lib/concept'
import { brandCanonical, brandOrigin, SERVD_ORIGIN } from '../../lib/brandDomains'
import type { SectionProps } from '../types'
import { color, link, list, safeHref, str } from '../safe'
import './servd.css'

interface LinkItem { text?: unknown; href?: unknown }

/** A footer link target: safe, with the redirecting / and the canonicalised
 *  /brand/<slug> paths replaced by where they end up. */
function footerHref(v: unknown, fallback = '#'): string {
  const href = safeHref(v, fallback)
  if (href === '/') return '/home'
  const m = /^\/brand\/([a-z0-9-]+)(?:\/([^?#]*?))?\/?$/i.exec(href)
  if (m) {
    const slug = m[1]!.toLowerCase()
    // A brand with no domain of its own really lives under /brand/<slug>.
    if (brandOrigin(slug) !== SERVD_ORIGIN) return brandCanonical(slug, m[2] ?? '')
  }
  return href
}

/** next/link for servd paths; a plain <a> for another origin (brand domains). */
function FooterLink({ href, style, className, children }: { href: string; style?: CSSProperties; className?: string; children: ReactNode }) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href)
    ? <a href={href} style={style} className={className}>{children}</a>
    : <Link href={href} style={style} className={className}>{children}</Link>
}

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
            // A slogan, not a section heading: <p>, with the heading font a
            // published layout's heading-font setting gave the old <h2>.
            // .display sets the weight, tracking and line-height either way.
            <p className="display" style={{
              fontFamily: 'var(--sv-heading-font, var(--font-display))',
              fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
              color: 'white',
              marginBottom: '1.5rem',
            }}>
              {headline}
              {accentText && <span className="display-italic" style={{ color: 'var(--brand-accent)' }}> {accentText}</span>}
            </p>
          )}
          {cta.text && (
            <FooterLink href={footerHref(cta.href)} className="brand-pill">
              {cta.text} <span style={{ opacity: 0.6 }}>→</span>
            </FooterLink>
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
            <FooterLink
              href={footerHref(fields.wordmarkHref, '/home')}
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
            </FooterLink>
            {blurb && (
              <p style={{ fontSize: '0.92rem', maxWidth: '20rem', color: 'rgba(255,255,255,0.55)', lineHeight: 1.55 }}>
                {blurb}
              </p>
            )}
          </div>

          {kitchens.length > 0 && (
            <div>
              <FooterHeading text={str(fields.kitchensHeading)} />
              <ul className="sv-footer-list" style={listStyle}>
                {kitchens.map((b, i) => (
                  <li key={i}>
                    <FooterLink
                      href={footerHref(b.href)}
                      className="kinetic-caret sv-footer-tap"
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
                    </FooterLink>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {customer.length > 0 && (
            <div>
              <FooterHeading text={str(fields.customerHeading)} />
              <ul className="sv-footer-list" style={listStyle}>
                {customer.map((l, i) => (
                  <li key={i}><FooterLink href={footerHref(l.href)} className="sv-footer-tap" style={footerLinkStyle}>{str(l.text)}</FooterLink></li>
                ))}
              </ul>
            </div>
          )}

          {company.length > 0 && (
            <div>
              <FooterHeading text={str(fields.companyHeading)} />
              <ul className="sv-footer-list" style={listStyle}>
                {company.map((l, i) => {
                  const href = str(l.href).trim()
                  return (
                    <li key={i}>
                      {href
                        ? <FooterLink href={footerHref(href)} className="sv-footer-tap" style={footerLinkStyle}>{str(l.text)}</FooterLink>
                        : <span className="sv-footer-tap" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.95rem' }}>{str(l.text)}</span>}
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
    <h2 className="eyebrow" style={{ color: 'rgba(255,255,255,0.45)', marginBottom: '1rem' }}>
      {text}
    </h2>
  )
}

const listStyle: CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }

const footerLinkStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.8)',
  textDecoration: 'none',
  fontSize: '0.95rem',
  fontWeight: 500,
}
