// 404 page. Browsers will land here on any unmatched route — including
// stale brand slugs after a concept rename.

import Link from 'next/link'

export const metadata = {
  title: 'Not found',
}

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '1.25rem',
        textAlign: 'center',
      }}
    >
      <p style={{
        color: 'rgba(0,0,0,0.4)',
        fontSize: 'clamp(0.7rem, 1.8vw, 0.85rem)',
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        margin: 0,
      }}>
        404
      </p>
      <h1 style={{
        fontSize: 'clamp(2rem, 6vw, 3.5rem)',
        fontWeight: 900,
        letterSpacing: '-0.04em',
        margin: 0,
      }}>
        We couldn&rsquo;t find that.
      </h1>
      <p style={{ color: 'rgba(0,0,0,0.5)', maxWidth: '28rem', margin: 0 }}>
        The page may have moved, or the brand may no longer be on servd.
      </p>
      <Link
        href="/order"
        style={{
          display: 'inline-block',
          background: '#4ade80',
          color: '#000',
          fontWeight: 800,
          fontSize: '1rem',
          padding: '0.75rem 2rem',
          borderRadius: '999px',
          textDecoration: 'none',
          marginTop: '0.5rem',
        }}
      >
        See all brands
      </Link>
    </div>
  )
}
