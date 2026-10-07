'use client'
// brand.footer — the brand microsite's footer (SiteLayout
// `brand:<slug>:footer`). Themed from the brand's surface + accent in code;
// every word, link and social on it is a field. Replaces the old
// `brandFooter` block (lib/brandFooterConfig.ts).

import Link from 'next/link'
import { brandSurface } from '../../lib/concept'
import { useBrandSlug } from '../../lib/host'
import type { SectionProps } from '../types'
import { link, list, str } from '../safe'
import { brandHref, brandNameOf, fill, orLive, servdHref } from './util'

export function BrandFooter({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const onBrandHost = useBrandSlug(ctx.onBrandHost ? (concept?.slug ?? '') : null) !== null
  if (!concept) return null

  const name = brandNameOf(ctx, fields.name)
  const accent = concept.primaryColor || 'var(--servd-green)'
  const surface = brandSurface(concept.slug)
  const linkStyle: React.CSSProperties = {
    color: surface.text, opacity: 0.85, textDecoration: 'none', fontSize: '0.95rem', fontWeight: 500,
  }
  // servd pages: absolute on the brand's own domain.
  const servd = (v: unknown, fallback: string) => {
    const l = link(v)
    return { text: fill(l.text, ctx, name), href: servdHref(brandHref(l.href, ctx)?.href ?? fallback, onBrandHost) }
  }
  const servdLink = servd(fields.servdLink, '/home')
  const allKitchens = servd(fields.allKitchens, '/home#kitchens')
  const backLink = servd(fields.backLink, '/home')

  const cta = link(fields.ctaButton)
  const ctaTo = brandHref(cta.href, ctx)
  const ctaText = fill(cta.text, ctx, name)

  // Socials: the owner's list. @whatsapp / @email resolve to the brand's own
  // contact (Concept.whatsapp / Concept.email, admin → Brands → Contact) and
  // disappear when it is not set.
  const socials = list(fields.socials).flatMap((item) => {
    const l = link(item)
    const to = brandHref(l.href, ctx)
    const label = fill(l.text, ctx, name)
    return to && label ? [{ label, ...to }] : []
  })
  const links = list(fields.links).flatMap((item) => {
    const l = link(item)
    const to = brandHref(l.href, ctx, { mode: 'host', onBrandHost })
    const label = fill(l.text, ctx, name)
    return to && label ? [{ label, ...to }] : []
  })

  return (
    <footer className="relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 1.75rem',
        marginTop: '4rem',
        color: surface.text,
      }}>
      <div className="container relative z-10">
        {/* Brand-CTA banner at the top — where the eye lands when leaving a page. */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          <p className="eyebrow" style={{ color: accent, marginBottom: '1rem' }}>
            {fill(fields.ctaEyebrow, ctx, name)}
          </p>
          <h2 className="display" style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            color: surface.text,
            marginBottom: '1.5rem',
          }}>
            {fill(fields.ctaHeadline, ctx, name)}
            <span className="display-italic" style={{ color: accent }}> {fill(fields.ctaAccent, ctx, name)}</span>
          </h2>
          {ctaTo && ctaText && (
            <Link href={ctaTo.href} className="brand-pill">
              {ctaText}
            </Link>
          )}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2.5rem',
          paddingTop: '2.5rem',
          borderTop: `1px solid ${surface.border}`,
        }}>
          <div>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.8rem',
              fontWeight: 800,
              letterSpacing: '-0.035em',
              color: surface.text,
              marginBottom: '0.5rem',
            }}>
              {name}
              <span style={{ color: accent }}>.</span>
            </div>
            <p style={{ fontSize: '0.95rem', color: surface.muted, maxWidth: '20rem', lineHeight: 1.5 }}>
              {orLive(fields.tagline, concept.description, ctx, name)}
            </p>
            {socials.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem', marginTop: '1.1rem' }}>
                {socials.map((s, i) => (
                  <a key={`${s.href}-${i}`} href={s.href}
                    {...(s.href.startsWith('mailto:') ? { title: s.href.slice(7) } : { target: '_blank', rel: 'noreferrer' })}
                    style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: surface.muted, textDecoration: 'none' }}>
                    {s.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: surface.muted, marginBottom: '1rem' }}>
              {orLive(fields.linksHeading, name, ctx, name)}
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              {links.map((l, i) => (
                <li key={`${l.href}-${i}`}>
                  {l.external
                    ? <a href={l.href} target="_blank" rel="noopener noreferrer" style={linkStyle}>{l.label}</a>
                    : <Link href={l.href} style={linkStyle}>{l.label}</Link>}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="eyebrow" style={{ color: surface.muted, marginBottom: '1rem' }}>
              {fill(fields.poweredHeading, ctx, name)}
            </h3>
            <Link href={servdLink.href} style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '0.1rem',
              fontFamily: 'var(--font-display)',
              color: surface.text,
              fontWeight: 800,
              fontSize: '1.8rem',
              letterSpacing: '-0.045em',
              textDecoration: 'none',
            }}>
              {servdLink.text}<span style={{ color: accent }}>.</span>
            </Link>
            <p style={{ fontSize: '0.86rem', color: surface.muted, marginTop: '0.4rem' }}>
              {fill(fields.servdTagline, ctx, name)}
            </p>
            {allKitchens.text && (
              <Link href={allKitchens.href} className="kinetic-caret" style={{
                display: 'inline-block',
                marginTop: '1rem',
                color: accent,
                fontWeight: 700,
                fontSize: '0.9rem',
                textDecoration: 'none',
              }}>
                {allKitchens.text}
              </Link>
            )}
          </div>
        </div>

        <div style={{
          marginTop: '3rem',
          paddingTop: '1.25rem',
          borderTop: `1px solid ${surface.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          fontSize: '0.78rem',
          color: surface.muted,
        }}>
          <span>© {new Date().getFullYear()} {name}{str(fields.legal).trim() ? ` · ${fill(fields.legal, ctx, name)}` : ''}</span>
          {backLink.text && (
            <Link href={backLink.href} style={{ color: surface.muted, textDecoration: 'none' }}>
              {backLink.text}<span style={{ color: accent }}>.</span> →
            </Link>
          )}
        </div>
      </div>
    </footer>
  )
}
