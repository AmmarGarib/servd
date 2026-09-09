'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'

// Operator-driven announcement strip.
//   • If `concept.announcementBanner` is set, that string renders (operator
//     controls the message from admin → Marketing → Brands → Storefront).
//   • If not, falls back to the legacy "Rs. 200 off FRESH200" copy keyed
//     on `brandName` + `brandSlug` for the older brand layouts that still
//     ship the platform-wide promo. Pass `concept` to opt out of the
//     legacy fallback when a brand should stay quiet by default.
//   • Returns null when nothing should render.
//
// The per-brand Simmer / Stackd / Flipd layouts render their own
// announcement strip inline (styled to match their visual language) so
// they pass `concept` directly and skip this fallback path entirely.

interface Props {
  concept?: Concept
  brandName?: string
  brandSlug?: string
  accent: string
}

export function PromoBar({ concept, brandName, brandSlug, accent }: Props) {
  const banner = concept?.announcementBanner?.trim()

  if (banner) {
    return (
      <div
        role="status"
        style={{
          background: 'var(--servd-black)',
          color: 'white',
          padding: '0.6rem 1rem',
          textAlign: 'center',
          fontSize: '0.85rem',
          fontWeight: 600,
          letterSpacing: '0.02em',
          borderBottom: `2px solid ${accent}`,
        }}
      >
        {banner}
      </div>
    )
  }

  // No banner set AND no legacy brand info → render nothing.
  const name = brandName ?? concept?.name
  const slug = brandSlug ?? concept?.slug
  if (!name || !slug) return null

  // Legacy platform-wide promo. Older brand layouts still rely on this.
  return (
    <div
      style={{
        background: 'var(--servd-black)',
        color: 'white',
        padding: '0.6rem 1rem',
        textAlign: 'center',
        fontSize: '0.85rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        borderBottom: `2px solid ${accent}`,
      }}
    >
      <span style={{ color: 'var(--servd-green)' }}>RS. 200 OFF</span> your first order with{' '}
      <code style={{ background: 'rgba(58,14,105,0.18)', color: 'var(--servd-green)', padding: '0.1rem 0.4rem', borderRadius: '4px', fontWeight: 800 }}>FRESH200</code>
      {' · '}
      <span style={{ opacity: 0.8 }}>Free delivery over Rs. 1,500</span>
      {' · '}
      <Link href={`/${slug}`} style={{ color: 'var(--servd-green)', textDecoration: 'underline', fontWeight: 800 }}>
        Order from {name} →
      </Link>
    </div>
  )
}
