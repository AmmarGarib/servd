'use client'

import Link from 'next/link'
import { useEffect } from 'react'

export default function OrderHubError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[storefront/order] error:', error) }, [error])

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        minHeight: '60dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '1rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, margin: 0 }}>
        We can&rsquo;t load brands right now.
      </h1>
      <p style={{ color: 'var(--servd-mute)', maxWidth: '32rem', margin: 0 }}>
        Our kitchen system might be briefly unavailable. Try again in a moment, or come back to the home screen.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
        <button
          onClick={reset}
          style={{
            background: 'var(--servd-green)', color: 'var(--servd-on-green)', fontWeight: 800,
            padding: '0.7rem 1.75rem', borderRadius: '999px', border: 'none', cursor: 'pointer',
          }}
        >
          Try again
        </button>
        <Link
          href="/"
          style={{
            background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', fontWeight: 600,
            padding: '0.7rem 1.75rem', borderRadius: '999px', border: '1px solid var(--servd-purple)', textDecoration: 'none',
          }}
        >
          Home
        </Link>
      </div>
    </div>
  )
}
