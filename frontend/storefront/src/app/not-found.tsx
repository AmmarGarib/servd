// 404 page. Browsers will land here on any unmatched route — including
// stale brand slugs after a concept rename.

import Link from 'next/link'
import { SERVD_LINK_ORIGIN } from '../lib/brandDomains'
import { NotFoundTitle } from './NotFoundTitle'

export const metadata = {
  title: 'Not found',
  // Explicit, so a 404 never carries an inherited 'index, follow'.
  robots: { index: false, follow: true },
}

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '70dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '1.25rem',
        textAlign: 'center',
      }}
    >
      <NotFoundTitle />
      <p style={{
        color: 'var(--servd-mute)',
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
      <p style={{ color: 'var(--servd-mute)', maxWidth: '28rem', margin: 0 }}>
        The page may have moved, or the brand may no longer be on servd.
      </p>
      {/* The kitchens list on servd's home (absolute when this 404 is served
          on a brand domain). /order only redirected there. */}
      <Link
        href={`${SERVD_LINK_ORIGIN}/home#kitchens`}
        style={{
          display: 'inline-block',
          background: 'var(--servd-green)',
          color: 'var(--servd-on-green)',
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
