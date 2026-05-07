'use client'
import Link from 'next/link'

interface Props {
  brandName: string
  brandSlug: string
  accent: string
}

export function PromoBar({ brandName, brandSlug, accent }: Props) {
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
      <code style={{ background: 'rgba(34,197,94,0.18)', color: 'var(--servd-green)', padding: '0.1rem 0.4rem', borderRadius: '4px', fontWeight: 800 }}>FRESH200</code>
      {' · '}
      <span style={{ opacity: 0.8 }}>Free delivery over Rs. 1,500</span>
      {' · '}
      <Link href={`/${brandSlug}`} style={{ color: 'var(--servd-green)', textDecoration: 'underline', fontWeight: 800 }}>
        Order from {brandName} →
      </Link>
    </div>
  )
}
