'use client'
// simmer.elsewhere — off-platform reach: icon-only outbound links (socials,
// WhatsApp, maps, email) under an "elsewhere" eyebrow, with the handle as the
// section's one orange signal. Ported from SimmerLayout.
//
// Live data stays live: a button with no link uses Simmer's own accounts
// (below) for socials, and the kitchen's WhatsApp / map pin / email from the
// brand row through lib/brandLocations. Set a button's link to override.

import type { ReactNode } from 'react'
import { locationFromConcept, whatsappLink } from '../../lib/brandLocations'
import type { SectionProps } from '../types'
import { list, safeHref, str } from '../safe'
import type { ResolvedLink } from '../brand/util'
import { HEADING_RESET, simmerConcept, simmerHref, simmerText, surface } from './shared'

// Simmer's accounts — what an empty social button links to.
const FALLBACK_SOCIAL = {
  instagram: 'https://instagram.com/simmer_down',
  tiktok:    'https://tiktok.com/@simmer_down',
  facebook:  'https://facebook.com/simmerdown',
}

type IconName = 'instagram' | 'tiktok' | 'facebook' | 'whatsapp' | 'maps' | 'email'
interface Button { icon?: unknown; href?: unknown; label?: unknown }

export function Elsewhere({ fields: f, ctx }: SectionProps) {
  const concept = simmerConcept(ctx)
  const s = surface(f['surface'], 'green')
  const buttons = list<Button>(f['buttons'])
  const eyebrow = simmerText(f['eyebrow'])
  const handle = simmerText(f['handle'])

  // Canonical NAP from the live brand row, so these links match the
  // Restaurant schema on this page and the GBP listing.
  const loc = locationFromConcept(concept)
  const live: Record<IconName, string> = {
    instagram: FALLBACK_SOCIAL.instagram,
    tiktok:    FALLBACK_SOCIAL.tiktok,
    facebook:  FALLBACK_SOCIAL.facebook,
    whatsapp:  loc.whatsapp ? whatsappLink(loc, str(f['whatsappText']).trim() || `hi ${concept.name}`) : '',
    maps:      loc.mapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${loc.name} ${loc.area} ${loc.city}`)}`,
    email:     `mailto:${loc.email || 'simmer@gsfoods.pk'}`,
  }
  const liveTo = (icon: IconName): ResolvedLink | null => {
    const href = safeHref(live[icon], '')
    return href ? { href, external: /^https?:\/\//i.test(href) } : null
  }

  return (
    <div className="simmer-page">
      <section style={{ background: s.background, color: s.color, padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          {(eyebrow || handle) && (
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              paddingBottom: '0.9rem',
              marginBottom: '1.6rem',
              borderBottom: `1px solid ${s.line}`,
              gap: '1rem',
              flexWrap: 'wrap',
            }}>
              {/* The section's heading, set as the eyebrow it always was. */}
              {eyebrow.trim()
                ? <h2 className="utility" style={{ ...HEADING_RESET, fontSize: '0.78rem' }}>{eyebrow}</h2>
                : <span />}
              <span className="utility signal" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{handle}</span>
            </div>
          )}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 'clamp(1rem, 4vw, 2rem)',
          }}>
            {buttons.map((b, i) => {
              const icon = (ICONS[str(b.icon) as IconName] ? str(b.icon) : 'instagram') as IconName
              // An owner link goes through the brand resolver (tokens; a servd
              // path is absolute from simmer.pk); empty = the live target.
              const own = str(b.href).trim()
              const to = own ? simmerHref(own, ctx) : liveTo(icon)
              if (!to) return null   // e.g. no WhatsApp number on file
              return (
                <ElsewhereButton key={i} href={to.href} external={to.external} ariaLabel={simmerText(b.label) || icon} ink={s.color} icon={ICONS[icon]} />
              )
            })}
          </div>
        </div>
      </section>
    </div>
  )
}

// Outbound icon-only link. Off-site URLs open in a new tab; mailto:/tel:,
// site paths and servd pages stay in place.
function ElsewhereButton({ href, external: isExternal, ariaLabel, ink, icon }: { href: string; external: boolean; ariaLabel: string; ink: string; icon: ReactNode }) {
  return (
    <a
      href={href}
      {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '2.5rem',
        height: '2.5rem',
        color: ink,
        opacity: 0.78,
        transition: 'opacity 160ms ease, color 160ms ease',
        textDecoration: 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '1'
        e.currentTarget.style.color = 'var(--simmer-orange)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '0.78'
        e.currentTarget.style.color = ink
      }}
    >
      {icon}
    </a>
  )
}

// ─── Outbound icon set — minimal strokes at 22px, colour from the link ──
const svgProps = {
  width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
}

const ICONS: Record<IconName, ReactNode> = {
  maps: (
    <svg {...svgProps}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  ),
  instagram: (
    <svg {...svgProps}>
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
    </svg>
  ),
  tiktok: (
    <svg {...svgProps}>
      <path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/>
    </svg>
  ),
  facebook: (
    <svg {...svgProps}>
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
    </svg>
  ),
  whatsapp: (
    <svg {...svgProps}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  ),
  email: (
    <svg {...svgProps}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  ),
}
