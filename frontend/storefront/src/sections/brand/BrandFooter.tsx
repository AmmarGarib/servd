'use client'
// brand.footer — the brand microsite's footer (SiteLayout
// `brand:<slug>:footer`). Themed from the brand's surface + accent in code;
// every word, link and social on it is a field. Replaces the old
// `brandFooter` block (lib/brandFooterConfig.ts).

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { brandSurface } from '../../lib/concept'
import { useBrandSlug } from '../../lib/host'
import type { SectionProps } from '../types'
import { isHiddenLegalHref, link, list, str } from '../safe'
import { brandHref, brandNameOf, fill, orLive, servdHref } from './util'
import './brand.css'

/**
 * The footer sits on the brand's dark band (brandSurface), so its signal
 * colour has to read on that band. Two brands need their own:
 *   flipd  — its brand colour IS the band (Flipd Blue on Flipd Blue): the
 *            eyebrow, "Let's eat.", the Order button, the dots and "See all
 *            kitchens" all vanished. It signals in Smash Mustard, and the
 *            button is mustard with Flipd Blue ink (6.9:1).
 *   simmer — one orange signal per viewport (SKILL rules), and the page's
 *            sign-off ends on its orange full stop right above. The footer is
 *            bone on tiber with no orange; the button is bone with tiber ink,
 *            as on its servd home tile (never white text, no glow).
 * Everyone else keeps the brand colour on its band.
 */
interface FooterTone { signal: string; eyebrow: string; pillBg: string; pillInk: string; pillShadow?: string }
const FOOTER_TONE: Record<string, FooterTone> = {
  flipd: {
    signal: 'var(--flipd-mustard)', eyebrow: 'var(--flipd-mustard)',
    pillBg: 'var(--flipd-mustard)', pillInk: 'var(--flipd-blue)',
  },
  simmer: {
    signal: 'var(--simmer-bone)', eyebrow: 'color-mix(in srgb, var(--simmer-bone) 72%, transparent)',
    pillBg: 'var(--simmer-bone)', pillInk: 'var(--simmer-green)', pillShadow: 'none',
  },
}

export function BrandFooter({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const onBrandHost = useBrandSlug(ctx.onBrandHost ? (concept?.slug ?? '') : null) !== null
  if (!concept) return null

  const name = brandNameOf(ctx, fields.name)
  const tone = FOOTER_TONE[concept.slug]
  // The signal colour on the band (eyebrow, accent words, dots, links).
  const accent = tone?.signal ?? (concept.primaryColor || 'var(--servd-green)')
  const pillStyle: CSSProperties | undefined = tone && {
    ['--brand-accent' as string]: tone.pillBg,
    ['--brand-ink' as string]: tone.pillInk,
    ...(tone.pillShadow && { boxShadow: tone.pillShadow }),
  } as CSSProperties
  const surface = brandSurface(concept.slug)
  const linkStyle: React.CSSProperties = {
    color: surface.text, opacity: 0.85, textDecoration: 'none', fontSize: '0.95rem', fontWeight: 500,
  }
  // Every link resolves for the host this render is on: microsite pages at
  // the domain root on the brand's own domain, servd pages absolute there.
  const to = (href: unknown) => brandHref(href, ctx, { mode: 'host', onBrandHost })
  // servd pages: absolute on the brand's own domain. servd's home is /home
  // (a stored '/' 308s there, so it is mapped here).
  const servd = (v: unknown, fallback: string) => {
    const l = link(v)
    const href = l.href.trim() === '/' ? '/home' : l.href
    return { text: fill(l.text, ctx, name), href: servdHref(to(href)?.href ?? fallback, onBrandHost) }
  }
  const servdLink = servd(fields.servdLink, '/home')
  const allKitchens = servd(fields.allKitchens, '/home#kitchens')
  const backLink = servd(fields.backLink, '/home')

  const cta = link(fields.ctaButton)
  const ctaTo = to(cta.href)
  const ctaText = fill(cta.text, ctx, name)

  // Socials: the owner's list. @whatsapp / @email resolve to the brand's own
  // contact (Concept.whatsapp / Concept.email, admin → Brands → Contact) and
  // disappear when it is not set.
  const socials = list(fields.socials).flatMap((item) => {
    const l = link(item)
    const target = isHiddenLegalHref(l.href) ? null : to(l.href)
    const label = fill(l.text, ctx, name)
    return target && label ? [{ label, ...target }] : []
  })
  const links = list(fields.links).flatMap((item) => {
    const l = link(item)
    const target = isHiddenLegalHref(l.href) ? null : to(l.href)
    const label = fill(l.text, ctx, name)
    return target && label ? [{ label, ...target }] : []
  })

  // Privacy / terms / contact: servd's pages (one policy for every kitchen),
  // absolute on servd's origin from a brand domain (brandHref's servd path).
  const legalLinks = list(fields.legalLinks).flatMap((item) => {
    const l = link(item)
    const target = isHiddenLegalHref(l.href) ? null : to(l.href)
    const label = fill(l.text, ctx, name)
    return target && label ? [{ label, ...target }] : []
  })

  return (
    <footer className="relative overflow-hidden"
      style={{
        padding: 'clamp(4rem, 7vw, 6rem) 0 1.75rem',
        marginTop: '4rem',
        color: surface.text,
      }}>
      <div className="container relative z-10">
        {/* Brand-CTA banner at the top — where the eye lands when leaving a page.
            A sign-off line, not a heading: it repeats on every page, so it
            stays out of each page's outline (.display sets the same weight
            and line height on a <p> as it did on the <h2>). */}
        <div style={{ marginBottom: 'clamp(3rem, 5vw, 4rem)', maxWidth: '900px' }}>
          <p className="eyebrow" style={{ color: tone?.eyebrow ?? accent, marginBottom: '1rem' }}>
            {fill(fields.ctaEyebrow, ctx, name)}
          </p>
          <p className="display" style={{
            fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
            color: surface.text,
            marginBottom: '1.5rem',
          }}>
            {fill(fields.ctaHeadline, ctx, name)}
            <span className="display-italic" style={{ color: accent }}> {fill(fields.ctaAccent, ctx, name)}</span>
          </p>
          {ctaTo && ctaText && (
            <Link href={ctaTo.href} className="brand-pill" {...(pillStyle && { style: pillStyle })}>
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
                  <a key={`${s.href}-${i}`} href={s.href} className="brand-footer-tap"
                    {...(s.href.startsWith('mailto:') ? { title: s.href.slice(7) } : { target: '_blank', rel: 'noreferrer' })}
                    style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: surface.muted, textDecoration: 'none' }}>
                    {s.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="eyebrow" style={{ color: surface.muted, marginBottom: '1rem' }}>
              {orLive(fields.linksHeading, name, ctx, name)}
            </h2>
            <ul className="brand-footer-list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              {links.map((l, i) => (
                <li key={`${l.href}-${i}`}>
                  {l.external
                    ? <a href={l.href} target="_blank" rel="noopener noreferrer" className="brand-footer-tap" style={linkStyle}>{l.label}</a>
                    : <Link href={l.href} className="brand-footer-tap" style={linkStyle}>{l.label}</Link>}
                </li>
              ))}
            </ul>
          </div>

          <div>
            {/* A label, not a heading (line height as the heading had). */}
            <p className="eyebrow" style={{ color: surface.muted, marginBottom: '1rem', lineHeight: 1.1 }}>
              {fill(fields.poweredHeading, ctx, name)}
            </p>
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
              <Link href={allKitchens.href} className="kinetic-caret brand-footer-tap" style={{
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
          {legalLinks.length > 0 && (
            <nav aria-label="Legal" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.1rem' }}>
              {legalLinks.map((l, i) => (
                <a key={`${l.href}-${i}`} href={l.href} className="brand-footer-tap" style={{ color: surface.muted, textDecoration: 'none' }}>{l.label}</a>
              ))}
            </nav>
          )}
          {backLink.text && (
            <Link href={backLink.href} className="brand-footer-tap" style={{ color: surface.muted, textDecoration: 'none' }}>
              {backLink.text}<span style={{ color: accent }}>.</span> →
            </Link>
          )}
        </div>
      </div>
    </footer>
  )
}
